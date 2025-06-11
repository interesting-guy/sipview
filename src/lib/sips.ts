
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_REPO_PATH = 'sips'; // Corrected path
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
  const response = await fetch(url, { headers, next: { revalidate: 300 } }); // Revalidate every 5 minutes
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
  const response = await fetch(url, { headers, next: { revalidate: 300 } }); // Revalidate every 5 minutes
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

    // Prioritize 'sip' or 'sui_ip' frontmatter field for the SIP number
    const fmSip = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    const fileNameNumMatch = fileName.match(/sip-(\d+)/i); // Match 'sip-NUMBER' in filename

    if (fmSip !== undefined && String(fmSip).match(/^\d+$/)) {
        // If frontmatter 'sip' is a number, use it
        id = `sip-${String(fmSip).padStart(3, '0')}`;
    } else if (fileNameNumMatch && fileNameNumMatch[1]) {
        // Otherwise, if filename has 'sip-NUMBER', use that number
        id = `sip-${String(fileNameNumMatch[1]).padStart(3, '0')}`;
    } else {
        // Fallback to the filename itself (e.g., 'sip-template' becomes 'sip-template')
        id = fileName.replace(/\.md$/, '');
    }
    
    // For SIPs from the folder, status is "Final" and source is "folder"
    const status: SipStatus = 'Final';
    const source: 'folder' | 'pull_request' = 'folder';

    let aiSummary = "Summary not available.";
    if (body && body.trim().length > 10) { // Only generate summary if body has meaningful content
      try {
        const summaryResult = await summarizeSipContent({ sipBody: body });
        aiSummary = summaryResult.summary;
      } catch (e) {
        console.error(`Failed to generate AI summary for ${id}:`, e);
        // Fallback summary if AI fails
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || body.substring(0, 150).split('\n')[0] + "...");
      }
    } else {
        // Fallback summary if body is too short or missing
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || "No content available for summary.");
    }

    // Construct PR URL
    // Default to a search query for the SIP ID in PRs
    let prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
    if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
        prUrl = frontmatter.pr; // Use explicit PR link if available and valid
    } else if (typeof frontmatter.pr === 'number') {
        prUrl = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
    } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
        prUrl = frontmatter['discussions-to']; // Use discussions-to if it's a GitHub PR/issue link
    }


    const nowISO = new Date().toISOString();
    // Prefer 'created' or 'date' for createdAt, fallback to now.
    const createdAt = parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    // Prefer 'updated', 'last-call-deadline', or 'lastUpdated' for updatedAt, fallback to createdAt.
    const updatedAt = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAt)!;
    const mergedAt = parseValidDate(frontmatter.merged, undefined);


    return {
      id,
      title: String(frontmatter.title || `SIP ${id.replace(/^sip-0*/, '')}`), // Fallback title if missing
      status,
      summary: aiSummary,
      body,
      prUrl,
      source,
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
    // Fetching files from the SIPS_REPO_PATH
    const repoContentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/contents/${SIPS_REPO_PATH}?ref=${SIPS_REPO_BRANCH}`;
    const filesOrDirs = await fetchFromGitHubAPI(repoContentsUrl) as (GitHubFile | any)[]; // Type assertion

    let files: GitHubFile[];
    if (Array.isArray(filesOrDirs)) {
        files = filesOrDirs;
    } else if (filesOrDirs && typeof filesOrDirs === 'object' && filesOrDirs.name) {
        // Handle case where path points to a single file/directory object instead of an array
        console.warn("Fetched repository contents is not an array. This might happen if SIPS_REPO_PATH points to a file or an empty/non-existent directory. Path:", SIPS_REPO_PATH, "Response:", filesOrDirs);
        files = []; // No files to process
    } else {
        files = []; // Default to empty if unexpected response
    }

    const sipPromises = files
      .filter(file => file.type === 'file' && file.name.match(/^sip-[\w\d-]+(?:\.md)$/i) && !file.name.toLowerCase().includes('template')) // Ensure it's a file, matches sip-*.md pattern, and not a template
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
    
    // Default sort: by mergedAt (desc), then by SIP ID (asc numeric part)
    sips.sort((a, b) => {
      // Sort by mergedAt descending first (most recent first)
      if (a.mergedAt && b.mergedAt) {
        return new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime();
      }
      if (a.mergedAt) return -1; // a has mergedAt, b doesn't, so a comes first
      if (b.mergedAt) return 1;  // b has mergedAt, a doesn't, so b comes first

      // If mergedAt is same or both null, sort by SIP ID (numeric part, ascending)
      const numA = parseInt(a.id.replace(/sip-/i, ''), 10);
      const numB = parseInt(b.id.replace(/sip-/i, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      // Fallback to string comparison if IDs are not purely numeric after 'sip-'
      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    return sips;
  } catch (error) {
    console.error("Error fetching all SIPs from GitHub:", error);
    sipsCache = null; // Invalidate cache on error
    return []; // Return empty array on error to prevent breaking the app
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  // If cache is old or doesn't exist, refresh it by calling getAllSips
  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    sipsToSearch = await getAllSips(); // This will repopulate the cache
  }
  
  // Normalize ID for comparison (e.g., '1' -> 'sip-001', 'sip-1' -> 'sip-001')
  const normalizedId = id.toLowerCase().startsWith('sip-') ? 
    `sip-${id.toLowerCase().replace('sip-', '').padStart(3, '0')}` : 
    `sip-${id.toLowerCase().padStart(3, '0')}`;
  
  const foundSip = sipsToSearch.find(sip => {
    const sipNormalizedId = sip.id.toLowerCase().startsWith('sip-') ?
      `sip-${sip.id.toLowerCase().replace('sip-', '').padStart(3, '0')}` :
      `sip-${sip.id.toLowerCase().padStart(3, '0')}`;
    return sipNormalizedId === normalizedId;
  });
  
  if (foundSip) {
    return foundSip;
  }
  
  // If not found and cache is stale (e.g., older than half its duration), try one more refresh.
  // This handles cases where a new SIP was added and the cache is about to expire.
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) {
     sipsToSearch = await getAllSips(); // Force refresh
     // Repeat find logic with the newly refreshed cache
     return sipsToSearch.find(sip => {
        const sipNormalizedId = sip.id.toLowerCase().startsWith('sip-') ?
        `sip-${sip.id.toLowerCase().replace('sip-', '').padStart(3, '0')}` :
        `sip-${sip.id.toLowerCase().padStart(3, '0')}`;
        return sipNormalizedId === normalizedId;
     }) || null;
  }

  return null;
}
