
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
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
  const response = await fetch(url, { headers, next: { revalidate: 300 } }); // Revalidate cache every 5 mins
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
  const response = await fetch(url, { headers, next: { revalidate: 300 } }); // Revalidate cache every 5 mins
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
    if (fallback && fallback !== dateStr) {
        const fallbackDate = new Date(fallback);
        return isNaN(fallbackDate.getTime()) ? undefined : fallbackDate.toISOString();
    }
    return undefined;
  }
  return date.toISOString();
}

async function parseSipFile(content: string, fileName: string): Promise<SIP | null> {
  try {
    const { data: frontmatter, content: body } = matter(content);
    let id: string;

    const fmSip = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    const fileNameNumMatch = fileName.match(/sip-(\d+)/i);

    if (fmSip !== undefined) {
        id = `sip-${String(fmSip).padStart(3, '0')}`;
    } else if (fileNameNumMatch && fileNameNumMatch[1]) {
        id = `sip-${String(fileNameNumMatch[1]).padStart(3, '0')}`;
    } else {
        id = fileName.replace(/\.md$/, '');
    }
    
    const fmStatus = frontmatter.status as SipStatus | string;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived"];
    let status: SipStatus = 'Draft';
    if (typeof fmStatus === 'string') {
        const foundStatus = validStatuses.find(s => s.toLowerCase() === fmStatus.toLowerCase());
        if (foundStatus) {
            status = foundStatus;
        } else {
            const lowerFmStatus = fmStatus.toLowerCase();
            if (lowerFmStatus === 'final' || lowerFmStatus === 'living standard' || lowerFmStatus === 'active') status = 'Live';
            else if (lowerFmStatus === 'review' || lowerFmStatus === 'last call') status = 'Proposed';
        }
    }

    let topics: string[] = [];
    const category = frontmatter.category || frontmatter.Category || frontmatter.type || frontmatter.Type;
    if (typeof category === 'string') {
      switch (category.toLowerCase()) {
        case 'framework':
          topics.push('dev-tools');
          break;
        case 'tokenomics':
          topics.push('gas', 'fees');
          break;
        case 'consensus':
          topics.push('core', 'validators');
          break;
        case 'staking':
          topics.push('staking');
          break;
        case 'storage':
          topics.push('data', 'object');
          break;
        default:
          topics.push('general');
      }
    }
    
    if (Array.isArray(frontmatter.tags)) {
      topics = [...new Set([...topics, ...frontmatter.tags.map(String).map(t => t.toLowerCase())])];
    } else if (typeof frontmatter.tags === 'string') {
      topics = [...new Set([...topics, ...frontmatter.tags.split(/[,;]/).map((t: string) => t.trim().toLowerCase()).filter(Boolean)])];
    }

    if (topics.length === 0) {
      topics.push('general');
    }
    topics = [...new Set(topics)]; // Ensure uniqueness

    let aiSummary = "Summary not available.";
    try {
      const summaryResult = await summarizeSipContent({ sipBody: body });
      aiSummary = summaryResult.summary;
    } catch (e) {
      console.error(`Failed to generate AI summary for ${id}:`, e);
      // Fallback to basic summary if AI fails
      aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || body.substring(0, 150).split('\n')[0] + "...");
    }


    let prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
    if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
        prUrl = frontmatter.pr;
    } else if (typeof frontmatter.pr === 'number') {
        prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
    } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
        prUrl = frontmatter['discussions-to'];
    }

    const nowISO = new Date().toISOString();
    const createdAt = parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    const updatedAt = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated, createdAt)!;
    const mergedAt = parseValidDate(frontmatter.merged, undefined);

    return {
      id,
      title: String(frontmatter.title || `SIP ${id.replace(/^sip-0*/, '')}`),
      status,
      topics,
      summary: aiSummary,
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
    const filesOrDirs = await fetchFromGitHubAPI(repoContentsUrl) as (GitHubFile | any)[];

    let files: GitHubFile[];
    if (Array.isArray(filesOrDirs)) {
        files = filesOrDirs;
    } else if (filesOrDirs && typeof filesOrDirs === 'object' && filesOrDirs.name) {
        console.warn("Fetched repository contents is not an array. Path:", SIPS_REPO_PATH, "Response:", filesOrDirs);
        files = []; // Or handle as a single file/dir if appropriate
    } else {
        files = [];
    }

    const sipPromises = files
      .filter(file => file.type === 'file' && file.name.match(/^sip-[\w\d-]+(?:\.md)$/i)) // Loosened regex to catch e.g. sip-001-foobar.md
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
    
    // Default sort by mergedAt descending, then by ID ascending for those without mergedAt or with same mergedAt
    sips.sort((a, b) => {
      if (a.mergedAt && b.mergedAt) {
        return new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime();
      }
      if (a.mergedAt) return -1; // a has mergedAt, b does not, so a comes first
      if (b.mergedAt) return 1;  // b has mergedAt, a does not, so b comes first

      // If neither has mergedAt, sort by ID
      const numA = parseInt(a.id.replace(/sip-/i, ''), 10);
      const numB = parseInt(b.id.replace(/sip-/i, ''), 10);
      if (isNaN(numA) || isNaN(numB)) return a.id.localeCompare(b.id);
      return numA - numB;
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
    sipsToSearch = await getAllSips(); 
  }
  
  const normalizedId = id.toLowerCase().startsWith('sip-') ? id.toLowerCase() : `sip-${id.toLowerCase().padStart(3, '0')}`;
  const foundSip = sipsToSearch.find(sip => sip.id.toLowerCase() === normalizedId);
  
  if (foundSip) {
    return foundSip;
  }
  
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) {
     sipsToSearch = await getAllSips(); 
     return sipsToSearch.find(sip => sip.id.toLowerCase() === normalizedId) || null;
  }

  return null;
}
