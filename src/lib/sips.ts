
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips'; // Path to SIPs directory on the main branch
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
  raw_url?: string;
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  filename?: string;
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
  head: { sha: string };
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
    const fileNameNumMatch = fileName.match(/^(?:sip-)?(\d+)(?:\.md)$/i); // Matches sip-DDD.md or DDD.md

    if (fmSip !== undefined && String(fmSip).match(/^\d+$/)) {
        id = `sip-${String(fmSip).padStart(3, '0')}`;
    } else if (fileNameNumMatch && fileNameNumMatch[1]) {
        id = `sip-${String(fileNameNumMatch[1]).padStart(3, '0')}`;
    } else {
        id = fileName.replace(/\.md$/, ''); // e.g., "my-proposal"
    }

    const explicitTitle = frontmatter.title || frontmatter.name;
    const sipTitle = String(explicitTitle || `SIP: ${id.startsWith('sip-') ? id.substring(4).replace(/^0+/, '') : id}`);

    if (source === 'pull_request' && !id.match(/^sip-\d+$/i) && !explicitTitle) {
        console.log(`  ParseSipFile (PR ${options.prUrl}): File ${filePath} (ID derived as '${id}') has no explicit title in frontmatter. Skipping.`);
        return null;
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
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
        }
    }

    const nowISO = new Date().toISOString();
    const createdAt = optionCreatedAt ? parseValidDate(optionCreatedAt) : parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    const updatedAt = optionUpdatedAt ? parseValidDate(optionUpdatedAt) : parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAt)!;

    let mergedAt: string | undefined;
    if (optionMergedAt) {
      mergedAt = parseValidDate(optionMergedAt);
    } else if (source === 'folder' && status === 'Final') {
      mergedAt = parseValidDate(frontmatter.merged, updatedAt);
    } else if (frontmatter.merged) {
        mergedAt = parseValidDate(frontmatter.merged);
    }

    console.log(`  Successfully parsed SIP: ID='${id}', Title='${sipTitle}', Status='${status}', Source='${source}', Path='${filePath}'`);
    return {
      id,
      title: sipTitle,
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
    .filter(file => file.type === 'file' && file.name.endsWith('.md') && !file.name.toLowerCase().includes('template') && file.download_url)
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
        const filePath = file.filename || file.path;
        const fileName = filePath.split('/').pop();

        const isInSipsFolder = filePath.startsWith(SIPS_MAIN_BRANCH_PATH + '/');
        // Consider any .md file (not a template) in the sips/ directory as a candidate
        const isCandidateSipFile = fileName && filePath.endsWith('.md') && !fileName.toLowerCase().includes('template');

        console.log(`    File: ${filePath}, Name: ${fileName}, Is Candidate: ${!!isCandidateSipFile}, Is in SIPs folder: ${isInSipsFolder}`);

        if ((file.status === 'added' || file.status === 'modified') &&
            isInSipsFolder &&
            isCandidateSipFile &&
            file.raw_url &&
            fileName
        ) {
          console.log(`    PR #${pr.number}: File ${filePath} is a candidate. Fetching content...`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePath,
              prUrl: pr.html_url,
              defaultStatus: 'Draft', // Default for PRs, can be overridden by frontmatter
              source: 'pull_request',
              createdAt: pr.created_at,
              updatedAt: pr.updated_at,
            });
            if (parsedSip) {
              console.log(`    PR #${pr.number}: Successfully parsed ${filePath} as SIP ID ${parsedSip.id}. Status: ${parsedSip.status}. Adding to drafts.`);
              draftSips.push(parsedSip);
            } else {
              console.log(`    PR #${pr.number}: File ${filePath} did not parse into a valid SIP (returned null).`);
            }
          } catch (error) {
            console.error(`    PR #${pr.number}: Error processing file ${filePath} content:`, error);
          }
        } else {
          // console.log(`    PR #${pr.number}: File ${filePath} did NOT match all criteria. Status: ${file.status}, In SIPs Folder: ${isInSipsFolder}, Is Candidate: ${isCandidateSipFile}, Has raw_url: ${!!file.raw_url}`);
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

    // Add folder SIPs first (these are considered canonical/Final)
    folderSips.forEach(sip => {
      if (sip.id) { // Ensure sip has an ID
        combinedSipsMap.set(sip.id.toLowerCase(), sip); // Normalize ID for map key
      } else {
        console.warn(`Folder SIP with missing ID encountered: ${sip.title}, Path: (filePath not available here, check parseSipFile logs)`);
      }
    });

    // Add PR SIPs, potentially overwriting if a folder SIP with same ID doesn't exist,
    // or if the PR SIP has a more "advanced" status (though unlikely here as folder SIPs are Final)
    prSips.forEach(prSip => {
      if (prSip.id) { // Ensure prSip has an ID
        const normalizedPrSipId = prSip.id.toLowerCase();
        const existingSip = combinedSipsMap.get(normalizedPrSipId);
        if (!existingSip) {
          combinedSipsMap.set(normalizedPrSipId, prSip);
        } else {
          // If a "Final" SIP from folder exists, don't overwrite with a "Draft" PR version
          // This handles the case where a PR might be for an already merged SIP (e.g. minor edits)
          if (existingSip.source === 'folder' && existingSip.status === 'Final' && prSip.source === 'pull_request') {
             console.log(`Skipping PR SIP ${prSip.id} (source: ${prSip.source}, status: ${prSip.status}) as a 'Final' SIP with the same ID already exists from folder.`);
          } else {
            // This case is less likely if folder sips are always Final.
            // Could be a PR updating another PR's draft, or more complex scenarios.
            // For now, simple overwrite if not blocked by a Final version.
            combinedSipsMap.set(normalizedPrSipId, prSip);
            console.log(`Overwriting/Updating SIP ${prSip.id} with version from PR (Source: ${prSip.source}, Status: ${prSip.status}). Existing was (Source: ${existingSip.source}, Status: ${existingSip.status})`);
          }
        }
      } else {
         console.warn(`PR SIP with missing ID encountered: ${prSip.title}, PR URL: ${prSip.prUrl}`);
      }
    });

    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      // Prioritize specific statuses like 'Live', 'Final', 'Accepted'
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Archived", "Rejected", "Withdrawn"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);

      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex;
      }

      // For SIPs with numeric IDs (e.g., sip-001), sort numerically descending for latest
      const numA = parseInt(a.id.replace(/^sip-/i, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-/i, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA; // Higher number first
      }

      // Fallback: sort by updatedAt descending
      const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (updatedA !== updatedB) {
        return updatedB - updatedA;
      }
      
      // Final fallback: locale compare on ID
      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    console.log(`Total unique SIPs processed: ${sips.length}. Cache updated.`);
    return sips;
  } catch (error) {
    console.error("Error in getAllSips fetching/processing:", error);
    sipsCache = null;
    return [];
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    console.log(`Cache miss or stale for getSipById(${id}). Refreshing all SIPs.`);
    sipsToSearch = await getAllSips();
  }

  const normalizedIdInput = id.toLowerCase().startsWith('sip-')
    ? id.toLowerCase()
    : `sip-${id.toLowerCase().padStart(3, '0')}`;

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase().startsWith('sip-')
        ? sip.id.toLowerCase()
        : `sip-${sip.id.toLowerCase().padStart(3, '0')}`;
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    return foundSip;
  }

  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) {
     console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found, cache is midway. Attempting one more refresh.`);
     sipsToSearch = await getAllSips(); // Force refresh
     const refreshedFoundSip = sipsToSearch.find(sip => {
        if (!sip.id) return false;
        const sipNormalizedMapId = sip.id.toLowerCase().startsWith('sip-')
            ? sip.id.toLowerCase()
            : `sip-${sip.id.toLowerCase().padStart(3, '0')}`;
        return sipNormalizedMapId === normalizedIdInput;
     });
     return refreshedFoundSip || null;
  }

  console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found after search.`);
  return null;
}
