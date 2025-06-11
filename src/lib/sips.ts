
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips'; // Path to SIPs on the main branch (e.g., 'sips' if files are in 'sips/sip-X.md')
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
  download_url: string | null;
  type: 'file' | 'dir';
  // For PR files
  raw_url?: string; 
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'; // Status of the file in a PR
  filename?: string; // Alternative for path, sometimes used in PR file listings
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  state: 'open' | 'closed' | 'all';
  head: { sha: string }; // SHA of the head commit of the PR
}

async function fetchFromGitHubAPI(url: string, revalidateTime: number = 300): Promise<any> {
  const headers: HeadersInit = {
    'Accept': 'application/vnd.github.v3+json',
  };
  const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  try {
    const response = await fetch(url, { headers, next: { revalidate: revalidateTime } });
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}. Body: ${errorBody}`);
      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}`);
    }
    return response.json();
  } catch (error) {
    console.error(`Error fetching from GitHub API URL ${url}:`, error);
    throw error;
  }
}

async function fetchRawContent(url: string): Promise<string> {
  const headers: HeadersInit = {};
  const token = process.env.NEXT_PUBLIC_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  try {
    const response = await fetch(url, { headers, next: { revalidate: 300 } });
    if (!response.ok) {
      throw new Error(`Failed to fetch raw content: ${response.status} ${response.statusText} for ${url}`);
    }
    return response.text();
  } catch (error) {
     console.error(`Error fetching raw content from URL ${url}:`, error);
    throw error;
  }
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

interface ParseSipFileOptions {
  fileName: string;
  filePath: string;
  prUrl?: string;
  defaultStatus: SipStatus;
  source: 'folder' | 'pull_request';
  createdAt?: string; 
  updatedAt?: string; 
  mergedAt?: string;  
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const { fileName, filePath, prUrl: optionPrUrl, defaultStatus, source, createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt } = options;
  try {
    const { data: frontmatter, content: body } = matter(content);
    
    let id: string;
    const fmSip = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    // Regex to match sip- followed by digits, then .md. Catches sip-0.md, sip-123.md etc.
    const fileNameNumMatch = fileName.match(/^sip-(\d+)(?:\.md)$/i); 

    if (fmSip !== undefined && String(fmSip).match(/^\d+$/)) {
        id = `sip-${String(fmSip).padStart(3, '0')}`;
    } else if (fileNameNumMatch && fileNameNumMatch[1]) {
        id = `sip-${String(fileNameNumMatch[1]).padStart(3, '0')}`;
    } else {
        // Fallback for non-standard naming, less likely for official SIPs
        // console.warn(`Could not derive standard SIP ID for ${fileName} (path: ${filePath}). Using filename as ID.`);
        id = fileName.replace(/\.md$/, ''); 
    }
    
    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final"];
    const status: SipStatus = statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter) 
        ? statusFromFrontmatter 
        : defaultStatus;

    let aiSummary = "Summary not available.";
    if (body && body.trim().length > 10) {
      try {
        const summaryResult = await summarizeSipContent({ sipBody: body });
        aiSummary = summaryResult.summary;
      } catch (e) {
        console.error(`Failed to generate AI summary for SIP ID ${id} (file: ${filePath}):`, e);
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || `Could not generate AI summary. Fallback: ${body.substring(0, 120).split('\n')[0]}...`);
      }
    } else {
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || "No content available for summary.");
    }

    let prUrlToUse = optionPrUrl;
    if (!prUrlToUse) {
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else {
            // Fallback: construct a search query URL on GitHub PRs
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
        }
    }
    
    const nowISO = new Date().toISOString();
    // For created/updated, prioritize explicit option (from PR/commit), then frontmatter, then fallback.
    const createdAt = optionCreatedAt ? parseValidDate(optionCreatedAt) : parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    const updatedAt = optionUpdatedAt ? parseValidDate(optionUpdatedAt) : parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAt)!;
    
    let mergedAt: string | undefined;
    if (optionMergedAt) { // Explicit mergedAt from options (e.g., PR object)
      mergedAt = parseValidDate(optionMergedAt);
    } else if (source === 'folder' && status === 'Final') { 
      // For folder SIPs that are Final, try to get merged date from frontmatter, or fallback to updatedAt
      mergedAt = parseValidDate(frontmatter.merged, updatedAt); 
    } else if (frontmatter.merged) { // If frontmatter.merged exists, use it regardless of source/status
        mergedAt = parseValidDate(frontmatter.merged);
    }
    // else mergedAt remains undefined


    return {
      id,
      title: String(frontmatter.title || `SIP ${id.replace(/^sip-0*/, '')}`),
      status,
      summary: aiSummary,
      body,
      prUrl: prUrlToUse!,
      source,
      createdAt,
      updatedAt,
      mergedAt,
    };
  } catch (e) {
    console.error(`Error parsing SIP file ${fileName} (source: ${source}, path: ${filePath}):`, e);
    return null;
  }
}

async function fetchSipsFromFolder(): Promise<SIP[]> {
  const repoContentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/contents/${SIPS_MAIN_BRANCH_PATH}?ref=${SIPS_REPO_BRANCH}`;
  let files: GitHubFile[];
  try {
    const filesOrDirs = await fetchFromGitHubAPI(repoContentsUrl);
    if (Array.isArray(filesOrDirs)) {
        files = filesOrDirs;
    } else {
        console.warn(`Fetched main branch content from '${SIPS_MAIN_BRANCH_PATH}' is not an array. Response:`, filesOrDirs);
        files = [];
    }
  } catch (error) {
    console.error(`Failed to fetch SIPs from folder '${SIPS_MAIN_BRANCH_PATH}':`, error);
    return [];
  }
  
  const sipsPromises = files
    .filter(file => file.type === 'file' && file.name.match(/^sip-\d+(?:\.md)$/i) && !file.name.toLowerCase().includes('template') && file.download_url)
    .map(async (file) => {
      try {
        const rawContent = await fetchRawContent(file.download_url!);
        return parseSipFile(rawContent, {
          fileName: file.name,
          filePath: file.path,
          defaultStatus: 'Final', 
          source: 'folder',
        });
      } catch (error) {
        console.error(`Failed to process folder SIP file ${file.name} (path: ${file.path}):`, error);
        return null;
      }
    });
  const folderSips = (await Promise.all(sipsPromises)).filter(sip => sip !== null) as SIP[];
  console.log(`Fetched ${folderSips.length} SIPs from folder '${SIPS_MAIN_BRANCH_PATH}'.`);
  return folderSips;
}

async function fetchSipsFromPullRequests(): Promise<SIP[]> {
  const openPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=open&sort=updated&direction=desc&per_page=50`;
  let openPRs: GitHubPullRequest[];
  try {
    openPRs = await fetchFromGitHubAPI(openPRsUrl);
  } catch (error) {
    console.error("Failed to fetch open pull requests:", error);
    return [];
  }
  console.log(`Fetched ${openPRs.length} open PRs.`);

  const draftSips: SIP[] = [];

  for (const pr of openPRs) {
    console.log(`Processing PR #${pr.number}: ${pr.title}`);
    try {
      const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files`;
      const prFiles = await fetchFromGitHubAPI(prFilesUrl) as GitHubFile[];
      console.log(`  PR #${pr.number}: Found ${prFiles.length} files.`);

      for (const file of prFiles) {
        const filePath = file.filename || file.path; // Use filename if path is not available
        console.log(`  PR #${pr.number}: Checking file: ${filePath}, status: ${file.status}, raw_url: ${!!file.raw_url}`);
        
        const fileName = filePath.split('/').pop();
        // Ensure filename is valid and matches sip-NUMBER.md pattern, and is in the correct directory
        const isSipFilePattern = fileName && fileName.match(/^sip-\d+(?:\.md)$/i) && !fileName.toLowerCase().includes('template');
        const isInSipsFolder = filePath.startsWith(SIPS_MAIN_BRANCH_PATH + '/');

        console.log(`    File: ${filePath}, Name: ${fileName}, Is SIP Pattern: ${!!isSipFilePattern}, Is in SIPs folder: ${isInSipsFolder}`);

        if ((file.status === 'added' || file.status === 'modified') && 
            isInSipsFolder &&
            isSipFilePattern &&
            file.raw_url &&
            fileName // Ensure fileName is not undefined
        ) {
          console.log(`    PR #${pr.number}: File ${filePath} matches criteria. Fetching content...`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePath,
              prUrl: pr.html_url,
              defaultStatus: 'Draft',
              source: 'pull_request',
              createdAt: pr.created_at,
              updatedAt: pr.updated_at,
              // mergedAt for open PRs will be null/undefined by default
            });
            if (parsedSip) {
              console.log(`    PR #${pr.number}: Successfully parsed ${filePath} as SIP ID ${parsedSip.id}. Adding to drafts.`);
              draftSips.push(parsedSip);
            } else {
              console.log(`    PR #${pr.number}: Failed to parse ${filePath} or it returned null.`);
            }
          } catch (error) {
            console.error(`    PR #${pr.number}: Error processing file ${filePath} content:`, error);
          }
        } else {
          // console.log(`    PR #${pr.number}: File ${filePath} did NOT match all criteria. Status: ${file.status}, In SIPs Folder: ${isInSipsFolder}, Is Pattern: ${isSipFilePattern}, Has raw_url: ${!!file.raw_url}`);
        }
      }
    } catch (error) {
      console.error(`  Error processing files for PR #${pr.number}:`, error);
    }
  }
  console.log(`Found ${draftSips.length} potential draft SIPs from PRs.`);
  return draftSips;
}

export async function getAllSips(): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
    console.log("Returning SIPs from cache.");
    return sipsCache;
  }
  console.log("Fetching fresh SIPs (cache expired or empty).");

  try {
    const folderSips = await fetchSipsFromFolder();
    const prSips = await fetchSipsFromPullRequests();

    const combinedSipsMap = new Map<string, SIP>();

    folderSips.forEach(sip => combinedSipsMap.set(sip.id, sip));

    prSips.forEach(prSip => {
      const existingSip = combinedSipsMap.get(prSip.id);
      if (!existingSip) { 
        combinedSipsMap.set(prSip.id, prSip);
      } else {
        // Log if a PR SIP is skipped due to an existing Final SIP
        console.log(`Skipping PR SIP ${prSip.id} (source: ${prSip.source}, status: ${prSip.status}) as a SIP with the same ID already exists (likely Final from folder: ${existingSip.source}, status: ${existingSip.status}).`);
      }
    });
    
    const sips = Array.from(combinedSipsMap.values());
    
    sips.sort((a, b) => {
      const statusOrder: SipStatus[] = ["Final", "Live", "Accepted", "Proposed", "Draft", "Archived", "Rejected", "Withdrawn"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex; 
      }

      const mergedA = a.mergedAt ? new Date(a.mergedAt).getTime() : 0;
      const mergedB = b.mergedAt ? new Date(b.mergedAt).getTime() : 0;
      if (mergedA !== mergedB) {
        return mergedB - mergedA; // Sort by mergedAt descending
      }
      
      const updatedA = new Date(a.updatedAt).getTime();
      const updatedB = new Date(b.updatedAt).getTime();
      if (updatedA !== updatedB) {
        return updatedB - updatedA; // Sort by updatedAt descending
      }
      
      const numA = parseInt(a.id.replace(/sip-/i, ''), 10);
      const numB = parseInt(b.id.replace(/sip-/i, ''), 10);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB; // Sort by SIP ID ascending
      }
      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    console.log(`Total unique SIPs processed: ${sips.length}. Cache updated.`);
    return sips;
  } catch (error) {
    console.error("Error in getAllSips fetching/processing:", error);
    sipsCache = null; // Invalidate cache on error
    return []; // Return empty array or rethrow, depending on desired error handling
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  // If cache is stale or empty, refresh it by calling getAllSips
  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    console.log(`Cache miss or stale for getSipById(${id}). Refreshing all SIPs.`);
    sipsToSearch = await getAllSips(); // This will also update the cache
  } else {
    // console.log(`Cache hit for getSipById(${id}).`);
  }
  
  // Normalize ID for comparison (e.g., "sip-1" becomes "sip-001")
  const normalizedId = id.toLowerCase().startsWith('sip-') ? 
    `sip-${id.toLowerCase().replace('sip-', '').padStart(3, '0')}` : 
    `sip-${id.toLowerCase().padStart(3, '0')}`;
  
  const foundSip = sipsToSearch.find(sip => {
    // Normalize SIP ID from the list for comparison
    const sipNormalizedId = sip.id.toLowerCase().startsWith('sip-') ?
      `sip-${sip.id.toLowerCase().replace('sip-', '').padStart(3, '0')}` :
      `sip-${sip.id.toLowerCase().padStart(3, '0')}`;
    return sipNormalizedId === normalizedId;
  });
  
  if (foundSip) {
    return foundSip;
  }
  
  // Optional: If not found and cache was not just refreshed, do one more refresh attempt.
  // This handles cases where a new SIP might have been added since the last cache population
  // but before the full CACHE_DURATION expired.
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) { // Arbitrary threshold like half cache life
     console.log(`SIP ID ${id} (normalized: ${normalizedId}) not found, cache is midway. Attempting one more refresh.`);
     sipsToSearch = await getAllSips(); // Force refresh
     return sipsToSearch.find(sip => {
        const sipNormalizedId = sip.id.toLowerCase().startsWith('sip-') ?
        `sip-${sip.id.toLowerCase().replace('sip-', '').padStart(3, '0')}` :
        `sip-${sip.id.toLowerCase().padStart(3, '0')}`;
        return sipNormalizedId === normalizedId;
     }) || null;
  }

  console.log(`SIP ID ${id} (normalized: ${normalizedId}) not found after search.`);
  return null;
}

    