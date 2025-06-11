
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation'; // Updated owner
const SIPS_REPO_NAME = 'sips';
const SIPS_REPO_PATH = 'sips';
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
  const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers, next: { revalidate: 300 } });
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
  const response = await fetch(url, { headers, next: { revalidate: 300 } });
  if (!response.ok) {
    throw new Error(`Failed to fetch raw content: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

function parseValidDate(dateStr: any, fallback?: string): string | undefined {
  if (!dateStr && fallback === undefined) return undefined;
  if (!dateStr) dateStr = fallback;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    // console.warn(`Invalid date string encountered: "${dateStr}". Using fallback or undefined.`);
    if (fallback && fallback !== dateStr) { // Avoid infinite recursion if fallback is also invalid
        const fallbackDate = new Date(fallback);
        return isNaN(fallbackDate.getTime()) ? undefined : fallbackDate.toISOString();
    }
    return undefined;
  }
  return date.toISOString();
}

function parseSipFile(content: string, fileName: string): SIP | null {
  try {
    const { data: frontmatter, content: body } = matter(content);
    let id: string;

    // Robust ID parsing: try 'sip', then 'sui_ip', then 'id' from frontmatter, then filename
    const fmSip = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    const fileNameNumMatch = fileName.match(/sip-(\d+)/i); // e.g., sip-1 from sip-1.md or sip-1-foo.md

    if (fmSip !== undefined) {
        id = `sip-${String(fmSip).padStart(3, '0')}`;
    } else if (fileNameNumMatch && fileNameNumMatch[1]) {
        id = `sip-${String(fileNameNumMatch[1]).padStart(3, '0')}`;
    } else {
        // Fallback if no SIP number in frontmatter or standard filename pattern
        id = fileName.replace(/\.md$/, '');
        // console.warn(`Could not determine SIP number for ${fileName}, using filename as ID: ${id}. Consider adding 'sip: <number>' to frontmatter.`);
    }
    
    const fmStatus = frontmatter.status as SipStatus | string;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived"];
    let status: SipStatus = 'Draft'; // Default status
    if (typeof fmStatus === 'string') {
        const foundStatus = validStatuses.find(s => s.toLowerCase() === fmStatus.toLowerCase());
        if (foundStatus) {
            status = foundStatus;
        } else {
            const lowerFmStatus = fmStatus.toLowerCase();
            if (lowerFmStatus === 'final' || lowerFmStatus === 'living standard' || lowerFmStatus === 'active') status = 'Live';
            else if (lowerFmStatus === 'review' || lowerFmStatus === 'last call') status = 'Proposed';
            // else console.warn(`Unknown SIP status: "${fmStatus}" for ${id}. Defaulting to Draft.`);
        }
    }

    let topics: string[] = [];
    if (frontmatter.category) topics.push(String(frontmatter.category));
    if (frontmatter.type && String(frontmatter.type).toLowerCase() !== String(frontmatter.category).toLowerCase()) {
      topics.push(String(frontmatter.type));
    }
    if (Array.isArray(frontmatter.tags)) {
      topics = [...new Set([...topics, ...frontmatter.tags.map(String)])];
    } else if (typeof frontmatter.tags === 'string') {
      topics = [...new Set([...topics, ...frontmatter.tags.split(/[,;]/).map((t: string) => t.trim()).filter(Boolean)])];
    }
    if (topics.length === 0) topics.push("General");

    const summary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || body.substring(0, 250).split('\n')[0] + "...");

    let prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
    if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
        prUrl = frontmatter.pr;
    } else if (typeof frontmatter.pr === 'number') {
        prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
    } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
        prUrl = frontmatter['discussions-to'];
    }

    const nowISO = new Date().toISOString();
    const createdAt = parseValidDate(frontmatter.created || frontmatter.date, nowISO)!; // Fallback to now if no valid date
    const updatedAt = parseValidDate(frontmatter.updated, createdAt)!; // Fallback to createdAt if no valid updated date
    const mergedAt = parseValidDate(frontmatter.merged, undefined);

    return {
      id,
      title: String(frontmatter.title || `SIP ${id.replace(/^sip-0*/, '')}`), // Clean up title fallback
      status,
      topics,
      summary,
      body,
      prUrl,
      createdAt,
      updatedAt,
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
    const filesOrDirs = await fetchFromGitHubAPI(repoContentsUrl) as (GitHubFile | any)[]; // API can return single object if path is to a file

    let files: GitHubFile[];
    if (Array.isArray(filesOrDirs)) {
        files = filesOrDirs;
    } else if (filesOrDirs && typeof filesOrDirs === 'object' && filesOrDirs.name) {
        // This case might happen if SIPS_REPO_PATH itself is a file, which is not expected here.
        // Or if the API returns a single directory object if the path is a directory but contains only one item (unlikely for 'contents' endpoint).
        // For safety, let's assume if it's not an array, it's an error or empty.
        console.warn("Fetched repository contents is not an array. Path:", SIPS_REPO_PATH, "Response:", filesOrDirs);
        files = [];
    } else {
        files = [];
    }


    const sipPromises = files
      .filter(file => file.type === 'file' && file.name.match(/^sip-\d+(?:-[\w-]+)?\.md$/i))
      .map(async (file) => {
        try {
            if (!file.download_url) {
                console.warn(`File ${file.name} has no download_url. Skipping.`);
                return null;
            }
            const rawContent = await fetchRawContent(file.download_url);
            return parseSipFile(rawContent, file.name);
        } catch (error) {
            console.error(`Failed to process file ${file.name}:`, error);
            return null;
        }
      });

    const sips = (await Promise.all(sipPromises)).filter(sip => sip !== null) as SIP[];
    
    sips.sort((a, b) => {
        const numA = parseInt(a.id.replace(/sip-/i, ''), 10);
        const numB = parseInt(b.id.replace(/sip-/i, ''), 10);
        if (isNaN(numA) || isNaN(numB)) return a.id.localeCompare(b.id); // Fallback sort if parsing fails
        return numA - numB; // Sort ascending by number (sip-001, sip-002, ...)
    });

    sipsCache = sips;
    cacheTimestamp = now;
    return sips;
  } catch (error) {
    console.error("Error fetching all SIPs from GitHub:", error);
    sipsCache = null; 
    return [];
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    // console.log("Cache miss or stale for getSipById, fetching all SIPs.");
    sipsToSearch = await getAllSips(); 
  }
  
  const normalizedId = id.toLowerCase().startsWith('sip-') ? id.toLowerCase() : `sip-${id.toLowerCase().padStart(3, '0')}`;
  const foundSip = sipsToSearch.find(sip => sip.id.toLowerCase() === normalizedId);
  
  if (foundSip) {
    return foundSip;
  }
  
  // If not found in cache, and cache might be stale, try a final fresh fetch
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) { // Check more eagerly than full duration
    // console.log("Potentially stale cache for getSipById, forcing refresh.");
     sipsToSearch = await getAllSips(); // Force refresh
     return sipsToSearch.find(sip => sip.id.toLowerCase() === normalizedId) || null;
  }

  return null;
}

