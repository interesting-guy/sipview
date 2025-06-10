import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'MystenLabs';
const SIPS_REPO_NAME = 'sips';
const SIPS_REPO_PATH = ''; // SIPs are in the root directory
const SIPS_REPO_BRANCH = 'main';

let sipsCache: SIP[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: 'file' | 'dir';
}

async function fetchFromGitHubAPI(url: string): Promise<any> {
  const headers: HeadersInit = {
    'Accept': 'application/vnd.github.v3+json',
  };
  // It's recommended to use a GitHub token to avoid rate limits,
  // especially during build or frequent revalidations.
  // Store it in NEXT_PUBLIC_GITHUB_TOKEN or GITHUB_TOKEN environment variable.
  const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers, next: { revalidate: 300 } }); // Revalidate every 5 mins for API calls
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}. Body: ${errorBody}`);
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function fetchRawContent(url: string): Promise<string> {
  const headers: HeadersInit = {};
  const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers, next: { revalidate: 300 } }); // Revalidate every 5 mins for raw content
  if (!response.ok) {
    throw new Error(`Failed to fetch raw content: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

function parseSipFile(content: string, fileName: string): SIP | null {
  try {
    const { data: frontmatter, content: body } = matter(content);

    let id: string;
    if (frontmatter.sip) {
      id = `sip-${String(frontmatter.sip).padStart(3, '0')}`;
    } else if (frontmatter.id) {
      id = String(frontmatter.id);
    } else {
      const match = fileName.match(/^(sip(?:-\d+)?)/i); // Match "sip-001" or "sip-1"
      if (match && match[1]) {
        const parts = match[1].split('-');
        if (parts.length > 1 && parts[1]) {
           id = `sip-${parts[1].padStart(3,'0')}`;
        } else {
            id = fileName.replace(/\.md$/, ''); // fallback to filename without .md
        }
      } else {
        id = fileName.replace(/\.md$/, ''); // fallback to filename without .md
      }
    }
    
    const fmStatus = frontmatter.status as SipStatus | string;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived"];
    let status: SipStatus = 'Draft';
    if (typeof fmStatus === 'string' && validStatuses.some(s => s.toLowerCase() === fmStatus.toLowerCase())) {
        status = validStatuses.find(s => s.toLowerCase() === fmStatus.toLowerCase())!;
    } else if (typeof fmStatus === 'string') {
        // Basic mapping for common alternative statuses
        const lowerFmStatus = fmStatus.toLowerCase();
        if (lowerFmStatus === 'final' || lowerFmStatus === 'living standard') status = 'Live';
        else if (lowerFmStatus === 'review' || lowerFmStatus === 'last call') status = 'Proposed';
        else {
            // console.warn(`Unknown SIP status: "${fmStatus}" for ${id}. Defaulting to Draft.`);
        }
    }


    let topics: string[] = [];
    if (frontmatter.category) topics.push(String(frontmatter.category));
    if (frontmatter.type && String(frontmatter.type) !== String(frontmatter.category)) {
      topics.push(String(frontmatter.type));
    }
    if (Array.isArray(frontmatter.tags)) {
      topics = [...new Set([...topics, ...frontmatter.tags.map(String)])];
    } else if (typeof frontmatter.tags === 'string') {
      topics = [...new Set([...topics, ...frontmatter.tags.split(',').map((t: string) => t.trim())])];
    }
    if (topics.length === 0) topics.push("General");

    const summary = String(frontmatter.summary || frontmatter.abstract || body.substring(0, 250).split('\n')[0] + "...");

    let prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
    if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
        prUrl = frontmatter.pr;
    } else if (typeof frontmatter.pr === 'number') {
        prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
    } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
        prUrl = frontmatter['discussions-to'];
    }


    const now = new Date().toISOString();
    const createdAt = frontmatter.created ? new Date(frontmatter.created).toISOString() : now;
    
    // Use 'updated' if available, otherwise 'created' or now
    let updatedAtDateStr: string;
    if (frontmatter.updated) {
      updatedAtDateStr = new Date(frontmatter.updated).toISOString();
    } else if (frontmatter.created) {
      updatedAtDateStr = new Date(frontmatter.created).toISOString();
    } else {
      updatedAtDateStr = now;
    }

    const mergedAt = frontmatter.merged ? new Date(frontmatter.merged).toISOString() : undefined;

    return {
      id,
      title: String(frontmatter.title || `SIP ${id}`),
      status,
      topics,
      summary,
      body,
      prUrl,
      createdAt,
      updatedAt: updatedAtDateStr,
      mergedAt,
    };
  } catch (e) {
    console.error(`Error parsing SIP file ${fileName}:`, e);
    return null;
  }
}

export async function getAllSips(): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
    return sipsCache;
  }

  try {
    const repoContentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/contents/${SIPS_REPO_PATH}?ref=${SIPS_REPO_BRANCH}`;
    const files = await fetchFromGitHubAPI(repoContentsUrl) as GitHubFile[];

    const sipPromises = files
      .filter(file => file.type === 'file' && file.name.match(/^sip-\d+(?:-[\w-]+)?\.md$/i))
      .map(async (file) => {
        try {
            const rawContent = await fetchRawContent(file.download_url);
            return parseSipFile(rawContent, file.name);
        } catch (error) {
            console.error(`Failed to process file ${file.name}:`, error);
            return null; // Skip this file on error
        }
      });

    const sips = (await Promise.all(sipPromises)).filter(sip => sip !== null) as SIP[];
    
    sips.sort((a, b) => {
        const numA = parseInt(a.id.replace(/sip-/i, ''), 10);
        const numB = parseInt(b.id.replace(/sip-/i, ''), 10);
        if (isNaN(numA) || isNaN(numB)) return b.id.localeCompare(a.id);
        return numB - numA;
    });

    sipsCache = sips;
    cacheTimestamp = now;
    return sips;
  } catch (error) {
    console.error("Error fetching all SIPs from GitHub:", error);
    sipsCache = null; 
    return []; // Fallback to empty array on error
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    sipsToSearch = await getAllSips(); // This will fetch and update the cache
  }
  
  const foundSip = sipsToSearch.find(sip => sip.id.toLowerCase() === id.toLowerCase());
  
  if (foundSip) {
    return foundSip;
  }
  
  // If not found in cache, and cache might be stale, try a fresh fetch
  // This handles cases where a new SIP was added since last cache
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION)) {
     sipsToSearch = await getAllSips(); // Force refresh
     return sipsToSearch.find(sip => sip.id.toLowerCase() === id.toLowerCase()) || null;
  }

  return null;
}
