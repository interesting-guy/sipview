
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips'; // Path to SIPs on the main branch
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
  download_url: string | null; // download_url can be null
  type: 'file' | 'dir';
  raw_url?: string; // For PR files, raw_url is often more useful
  status?: string; // For PR files, status like 'added', 'modified'
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
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
    throw error; // Re-throw to be caught by caller
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
    throw error; // Re-throw
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
  filePath: string; // Full path in repo, e.g. "sips/sip-001.md"
  prUrl?: string;
  defaultStatus: SipStatus;
  source: 'folder' | 'pull_request';
  createdAt?: string; // From PR or commit
  updatedAt?: string; // From PR or commit
  mergedAt?: string;  // From PR or commit (for merged PRs, though we mainly focus on open)
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const { fileName, filePath, prUrl: optionPrUrl, defaultStatus, source, createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt } = options;
  try {
    const { data: frontmatter, content: body } = matter(content);
    
    let id: string;
    const fmSip = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    const fileNameNumMatch = fileName.match(/sip-(\d+)/i);

    if (fmSip !== undefined && String(fmSip).match(/^\d+$/)) {
        id = `sip-${String(fmSip).padStart(3, '0')}`;
    } else if (fileNameNumMatch && fileNameNumMatch[1]) {
        id = `sip-${String(fileNameNumMatch[1]).padStart(3, '0')}`;
    } else {
        id = fileName.replace(/\.md$/, '');
    }
    
    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const status: SipStatus = statusFromFrontmatter && Object.values<string>(["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final"]).includes(statusFromFrontmatter) 
        ? statusFromFrontmatter 
        : defaultStatus;

    let aiSummary = "Summary not available.";
    if (body && body.trim().length > 10) {
      try {
        const summaryResult = await summarizeSipContent({ sipBody: body });
        aiSummary = summaryResult.summary;
      } catch (e) {
        console.error(`Failed to generate AI summary for ${id} (${filePath}):`, e);
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || "Could not generate AI summary. " + (body.substring(0, 120).split('\n')[0] + "..."));
      }
    } else {
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || "No content available for summary.");
    }

    let prUrlToUse = optionPrUrl;
    if (!prUrlToUse) { // Only construct default if no optionPrUrl is provided
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
        }
    }
    
    const nowISO = new Date().toISOString();
    const createdAt = optionCreatedAt || parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    const updatedAt = optionUpdatedAt || parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAt)!;
    
    let mergedAt: string | undefined;
    if (optionMergedAt) {
      mergedAt = parseValidDate(optionMergedAt);
    } else if (source === 'folder' && status === 'Final') { // Assume merged if 'Final' and from folder
      mergedAt = parseValidDate(frontmatter.merged, updatedAt); // Use frontmatter.merged or fallback to updatedAt
    } else {
      mergedAt = parseValidDate(frontmatter.merged, undefined); // For drafts or other statuses
    }


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
        console.warn("Fetched main branch repository contents is not an array. Path:", SIPS_MAIN_BRANCH_PATH, "Response:", filesOrDirs);
        files = [];
    }
  } catch (error) {
    console.error("Failed to fetch SIPs from folder:", error);
    return [];
  }
  
  const sipsPromises = files
    .filter(file => file.type === 'file' && file.name.match(/^sip-[\w\d-]+(?:\.md)$/i) && !file.name.toLowerCase().includes('template') && file.download_url)
    .map(async (file) => {
      try {
        const rawContent = await fetchRawContent(file.download_url!);
        // For folder SIPs, createdAt/updatedAt can be fetched via commit history if needed, but frontmatter is primary
        // For simplicity, parseSipFile will use frontmatter dates or fallback to now/createdAt.
        return parseSipFile(rawContent, {
          fileName: file.name,
          filePath: file.path,
          defaultStatus: 'Final', // SIPs in the main folder are considered Final
          source: 'folder',
          // We could get commit dates here for createdAt/updatedAt if frontmatter is unreliable
        });
      } catch (error) {
        console.error(`Failed to process folder SIP file ${file.name}:`, error);
        return null;
      }
    });
  return (await Promise.all(sipsPromises)).filter(sip => sip !== null) as SIP[];
}

async function fetchSipsFromPullRequests(): Promise<SIP[]> {
  const openPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=open&sort=updated&direction=desc&per_page=50`; // Fetch up to 50 open PRs
  let openPRs: GitHubPullRequest[];
  try {
    openPRs = await fetchFromGitHubAPI(openPRsUrl);
  } catch (error) {
    console.error("Failed to fetch open pull requests:", error);
    return [];
  }

  const draftSips: SIP[] = [];

  for (const pr of openPRs) {
    try {
      const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files`;
      const prFiles = await fetchFromGitHubAPI(prFilesUrl) as GitHubFile[];

      for (const file of prFiles) {
        // Process only added or modified files in the SIPS_MAIN_BRANCH_PATH that are markdown and SIP-like
        if ((file.status === 'added' || file.status === 'modified') && 
            file.path.startsWith(SIPS_MAIN_BRANCH_PATH + '/') && 
            file.path.endsWith('.md') && 
            !file.path.toLowerCase().includes('template') &&
            file.raw_url // Ensure raw_url exists
        ) {
          // Check if filename matches sip-XXX.md pattern.
          const fileName = file.path.split('/').pop();
          if (fileName && fileName.match(/^sip-[\w\d-]+(?:\.md)$/i)) {
            try {
              const rawContent = await fetchRawContent(file.raw_url);
              const parsedSip = await parseSipFile(rawContent, {
                fileName: fileName,
                filePath: file.path,
                prUrl: pr.html_url,
                defaultStatus: 'Draft', // Default for PRs, can be overridden by frontmatter
                source: 'pull_request',
                createdAt: pr.created_at,
                updatedAt: pr.updated_at,
              });
              if (parsedSip) {
                draftSips.push(parsedSip);
              }
            } catch (error) {
              console.error(`Failed to process file ${file.path} from PR #${pr.number}:`, error);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Failed to process files for PR #${pr.number}:`, error);
    }
  }
  return draftSips;
}

export async function getAllSips(): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
    // console.log("Returning SIPs from cache.");
    return sipsCache;
  }
  // console.log("Fetching fresh SIPs.");

  try {
    const folderSips = await fetchSipsFromFolder();
    const prSips = await fetchSipsFromPullRequests();

    const combinedSipsMap = new Map<string, SIP>();

    // Add folder SIPs first (these are 'Final' and take precedence)
    folderSips.forEach(sip => combinedSipsMap.set(sip.id, sip));

    // Add PR SIPs, but only if an entry with the same ID doesn't already exist from the folder
    // Or if the PR SIP has a more "advanced" status than the folder one (e.g. PR is 'Accepted', folder is 'Draft' - less likely here)
    prSips.forEach(prSip => {
      const existingSip = combinedSipsMap.get(prSip.id);
      if (!existingSip) { // If no SIP with this ID from folder, add the PR version
        combinedSipsMap.set(prSip.id, prSip);
      } else {
        // Optional: More complex logic if a PR updates an existing Final SIP.
        // For now, Final takes precedence. We could add a note to the Final SIP.
        // console.log(`PR SIP ${prSip.id} conflicts with existing Final SIP. Keeping Final version.`);
      }
    });
    
    const sips = Array.from(combinedSipsMap.values());
    
    sips.sort((a, b) => {
      // Sort by status preference first (e.g. Final > Live > Accepted > Proposed > Draft)
      const statusOrder: SipStatus[] = ["Final", "Live", "Accepted", "Proposed", "Draft", "Archived", "Rejected", "Withdrawn"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex; // Lower index = higher preference
      }

      // Then by mergedAt descending (most recent merged first)
      if (a.mergedAt && b.mergedAt) {
        return new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime();
      }
      if (a.mergedAt) return -1;
      if (b.mergedAt) return 1;

      // Then by updatedAt descending (most recent activity first)
      if (a.updatedAt && b.updatedAt) {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      if (a.updatedAt) return -1;
      if (b.updatedAt) return 1;
      
      // Finally, sort by SIP ID (numeric part, ascending)
      const numA = parseInt(a.id.replace(/sip-/i, ''), 10);
      const numB = parseInt(b.id.replace(/sip-/i, ''), 10);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    // console.log(`Fetched ${sips.length} total SIPs.`);
    return sips;
  } catch (error) {
    console.error("Error fetching all SIPs:", error);
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
  
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) {
     sipsToSearch = await getAllSips(); 
     return sipsToSearch.find(sip => {
        const sipNormalizedId = sip.id.toLowerCase().startsWith('sip-') ?
        `sip-${sip.id.toLowerCase().replace('sip-', '').padStart(3, '0')}` :
        `sip-${sip.id.toLowerCase().padStart(3, '0')}`;
        return sipNormalizedId === normalizedId;
     }) || null;
  }

  return null;
}
