
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips'; // Files in the main sips folder on 'main' branch
const SIPS_WITHDRAWN_PATH = 'withdrawn-sips'; // Files in the withdrawn sips folder on 'main' branch
const SIPS_REPO_BRANCH = 'main';

let sipsCache: SIP[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

interface GitHubFile {
  name: string;
  path: string; // Path in the repo at the commit of the PR
  filename?: string; // This comes from pulls.listFiles API, preferred for PR file paths
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir';
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'; // From pulls.listFiles API
  raw_url?: string; // From pulls.listFiles API
}

interface GitHubUser {
    login: string;
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  user: GitHubUser | null;
  created_at: string; // ISO 8601 string
  updated_at: string; // ISO 8601 string
  merged_at: string | null; // ISO 8601 string or null
  state: 'open' | 'closed'; // GitHub API returns 'open' or 'closed'
  head: { sha: string };
  body: string | null;
}

async function fetchFromGitHubAPI(url: string, revalidateTime: number = 300): Promise<any> {
  const headers: HeadersInit = {
    'Accept': 'application/vnd.github.v3+json',
    // Add 'X-GitHub-Api-Version': '2022-11-28' if needed
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
    const response = await fetch(url, { headers, next: { revalidate: 300 } }); // Content can be cached longer
    if (!response.ok) {
      throw new Error(`Failed to fetch raw content: ${response.status} ${response.statusText} for ${url}`);
    }
    return response.text();
  } catch (error) {
     console.error(`Error fetching raw content from URL ${url}:`, error);
    throw error;
  }
}

function parseValidDate(dateStr: any, fallbackDateISO?: string): string | undefined {
    let d: Date | undefined;
    if (dateStr && typeof dateStr === 'string') { // Ensure it's a string before parsing
        d = new Date(dateStr);
        if (isNaN(d.getTime())) {
            d = undefined;
        }
    }

    if (!d && fallbackDateISO) {
        d = new Date(fallbackDateISO);
        if (isNaN(d.getTime())) {
            return undefined;
        }
    }
    return d ? d.toISOString() : undefined;
}


function formatSipId(num: string | number): string {
  const numStr = String(num);
  return `sip-${numStr.padStart(3, '0')}`;
}

function extractSipNumberFromPrTitle(prTitle: string): string | null {
  if (!prTitle) return null;
  const match = prTitle.match(/SIP[-\s:]?(\d+)/i);
  return match && match[1] ? match[1] : null;
}

interface ParseSipFileOptions {
  fileName: string;
  filePath: string; // Full path in the repo
  prUrl?: string;
  prTitle?: string;
  prNumber?: number;
  prState?: 'open' | 'closed';
  defaultStatus: SipStatus; // Status to use if not in frontmatter (depends on source)
  source: 'folder' | 'pull_request' | 'withdrawn_folder';
  createdAt?: string; // ISO string from PR (pr.created_at)
  updatedAt?: string; // ISO string from PR (pr.updated_at)
  mergedAt?: string | null; // ISO string or null from PR (pr.merged_at)
  author?: string; // PR author login
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const {
    fileName, filePath, prUrl: optionPrUrl, prTitle: optionPrTitle, prNumber: optionPrNumber,
    prState: optionPrState, defaultStatus, source,
    createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt, // These are from PR
    author: optionAuthor
  } = options;

  // console.log(`Attempting to parse file: ${fileName} (source: ${source}, path: ${filePath}, PR# ${optionPrNumber || 'N/A'})`);

  try {
    const { data: frontmatter, content: body } = matter(content);

    let sipNumberStr: string | null = null;
    let idSource = "unknown";
    const frontmatterTitle = frontmatter.title || frontmatter.name;

    const fmSipField = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    if (fmSipField !== undefined && String(fmSipField).match(/^\d+$/)) {
      sipNumberStr = String(fmSipField);
      idSource = "frontmatter";
    }

    if (!sipNumberStr) {
      const fileNameNumMatch = fileName.match(/^(?:sip-)?(\d+)(?:[.\-_].*|\.md$)/i);
      if (fileNameNumMatch && fileNameNumMatch[1]) {
        sipNumberStr = fileNameNumMatch[1];
        idSource = "filename numeric part";
      } else {
        const fileNameDirectNumMatch = fileName.match(/^(\d+)(?:[.\-_].*|\.md$)/i);
        if (fileNameDirectNumMatch && fileNameDirectNumMatch[1]) {
            sipNumberStr = fileNameDirectNumMatch[1];
            idSource = "filename direct number";
        }
      }
    }
    
    if (!sipNumberStr && (source === 'pull_request')) { // For PR-sourced files, try PR title then PR num
      if (optionPrTitle) {
        const numFromTitle = extractSipNumberFromPrTitle(optionPrTitle);
        if (numFromTitle) {
          sipNumberStr = numFromTitle;
          idSource = "PR title";
        }
      }
      if (!sipNumberStr && optionPrNumber !== undefined) {
        sipNumberStr = String(optionPrNumber);
        idSource = "PR number";
      }
    }

    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
    } else {
        // Generic ID for files that don't have a number (e.g. template.md, or other non-SIPs from folders)
        // Or for PRs where no number could be derived (should be rare now with PR# fallback for PR source).
        id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
        idSource = "generic fallback filename";
        // console.warn(`  [WARN_ID] Could not derive a standard numeric ID for: ${fileName}, Path: ${filePath}, PR# ${optionPrNumber}. Using generic ID: ${id}. ID Source: ${idSource}`);
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && source === 'pull_request' && optionPrTitle) {
      sipTitle = optionPrTitle; // Use PR title as fallback for file-based SIPs from PRs
    }
    if (!sipTitle) { // Fallback for folder SIPs or if PR title was also missing
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal'}`;
    }

    // If this file is from a PR, and its ID and Title are solely derived from PR metadata (not from the file itself),
    // then this file is likely not a "true" SIP document. Return null to let the PR placeholder logic handle it.
    const idIsEssentiallyFromPRMetadata = (idSource === "PR title" || idSource === "PR number");
    const titleIsEssentiallyFromPRMetadata = !frontmatterTitle && !!optionPrTitle; // Title came from PR, not frontmatter

    if (source === 'pull_request' && idIsEssentiallyFromPRMetadata && titleIsEssentiallyFromPRMetadata) {
        console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) is being skipped by parseSipFile because its ID (source: ${idSource}) and title are derived from PR metadata, not the file's own content. Placeholder logic will handle PR #${optionPrNumber}.`);
        return null;
    }


    // Skip if it's from a PR, has a generic ID (e.g. sip-generic-...), and has no specific title.
    const isGenericId = id.startsWith('sip-generic-');
    const hasNoSpecificTitle = !frontmatterTitle && (!optionPrTitle || optionPrTitle.toLowerCase().startsWith("pr ") || optionPrTitle.toLowerCase().startsWith("wip") || optionPrTitle.match(/^#\d+/));

    if (source === 'pull_request' && isGenericId && hasNoSpecificTitle) {
        console.log(`  [SKIP_PARSE_FILE_GENERIC] PR file-based SIP (path: ${filePath}, derived ID: '${id}', PR Title: '${optionPrTitle || ''}') because it has a generic ID AND no specific title. This avoids ingesting random non-SIP markdown.`);
        return null;
    }


    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    
    let resolvedStatus: SipStatus = defaultStatus; // Start with the passed default (e.g. 'Final' for main folder, 'Withdrawn' for withdrawn_folder)
    
    if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter; // Frontmatter status takes precedence
    } else if (source === 'pull_request') { // If from PR and no valid frontmatter status
        if (optionMergedAt) {
            resolvedStatus = 'Accepted';
        } else if (optionPrState === 'open') {
            resolvedStatus = 'Draft';
        } else { // Closed but not merged (and no frontmatter status)
            resolvedStatus = 'Closed (unmerged)';
        }
    }
    // If source is 'folder' or 'withdrawn_folder', defaultStatus already correctly reflects 'Final' or 'Withdrawn'.


    let aiSummary = "Summary not available.";
    if (body && body.trim().length > 10) {
      try {
        const summaryResult = await summarizeSipContent({ sipBody: body });
        aiSummary = summaryResult.summary;
      } catch (e) {
        console.error(`Failed to generate AI summary for SIP ID ${id} (file: ${filePath}):`, e);
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || `Could not generate AI summary. Fallback: ${body.substring(0, 120).split('\\n')[0]}...`);
      }
    } else {
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || "No content available for summary.");
    }

    let prUrlToUse = optionPrUrl; // Default to PR's URL if provided (for source 'pull_request')
    if (!prUrlToUse) { // Fallbacks if parsing a folder SIP or PR URL wasn't passed
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else if (optionPrNumber) {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${optionPrNumber}`;
        } else { // Fallback for folder-based SIPs without explicit PR link
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/tree/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }
    
    let createdAtISO: string | undefined;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request') {
      createdAtISO = parseValidDate(optionCreatedAt);
      updatedAtISO = parseValidDate(optionUpdatedAt);
      if (!createdAtISO || !updatedAtISO) {
        console.warn(`[TIMESTAMP_WARN_PR] Invalid/missing createdAt/updatedAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. optionCreatedAt: ${optionCreatedAt}, optionUpdatedAt: ${optionUpdatedAt}. Using emergency fallback.`);
        const emergencyFallbackDate = '1970-01-01T00:00:00Z';
        if (!createdAtISO) createdAtISO = emergencyFallbackDate;
        if (!updatedAtISO) updatedAtISO = emergencyFallbackDate;
      }
    } else { // 'folder' or 'withdrawn_folder'
      const nowISO = new Date().toISOString(); // Fallback only for folder sources if no frontmatter
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAtISO)!;
    }

    let mergedAtVal: string | undefined;
    // For PR-sourced files, optionMergedAt (from pr.merged_at) is authoritative.
    // For folder files, frontmatter.merged is used.
    if (source === 'pull_request') {
        mergedAtVal = optionMergedAt ? parseValidDate(optionMergedAt) : undefined;
    } else { // folder or withdrawn_folder
        mergedAtVal = frontmatter.merged ? parseValidDate(frontmatter.merged) : undefined;
    }

    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined) || (Array.isArray(frontmatter.authors) ? frontmatter.authors.join(', ') : undefined);
    
    // console.log(`    [SIP_DETAIL_LOG] Parsed SIP: ID='${id}', Title='${sipTitle}', Status='${resolvedStatus}', Source='${source}', Path='${filePath}', ID Source: ${idSource}`);
    return {
      id,
      title: sipTitle,
      status: resolvedStatus,
      summary: aiSummary,
      body,
      prUrl: prUrlToUse!,
      source,
      createdAt: createdAtISO!,
      updatedAt: updatedAtISO!,
      mergedAt: mergedAtVal,
      author: sipAuthor,
      prNumber: optionPrNumber,
    };
  } catch (e) {
    console.error(`Error parsing SIP file ${fileName || 'unknown filename'} (source: ${source}, path: ${filePath}):`, e);
    return null;
  }
}

async function fetchSipsFromFolder(folderPath: string, defaultStatus: SipStatus, source: 'folder' | 'withdrawn_folder'): Promise<SIP[]> {
  const repoContentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/contents/${folderPath}?ref=${SIPS_REPO_BRANCH}`;
  let filesFromRepo: GitHubFile[];
  try {
    const filesOrDirs = await fetchFromGitHubAPI(repoContentsUrl);
    if (Array.isArray(filesOrDirs)) {
        filesFromRepo = filesOrDirs;
    } else {
        console.warn(`Fetched content from '${folderPath}' is not an array. Response:`, filesOrDirs);
        filesFromRepo = [];
    }
  } catch (error) {
    console.error(`Failed to fetch SIPs from folder '${folderPath}':`, error);
    return [];
  }

  const sipsPromises = filesFromRepo
    .filter(file => file.type === 'file' && file.name.endsWith('.md') && !file.name.toLowerCase().includes('template') && file.download_url)
    .map(async (file) => {
      try {
        const rawContent = await fetchRawContent(file.download_url!);
        // For folder SIPs, timestamps come from frontmatter or fall back to now/each other.
        // PR related options (prNumber, prTitle etc.) are not applicable here.
        return parseSipFile(rawContent, {
          fileName: file.name,
          filePath: file.path, // file.path from contents API is the full path
          defaultStatus: defaultStatus,
          source: source,
        });
      } catch (error) {
        console.error(`Failed to process SIP file ${file.name} from ${folderPath} (path: ${file.path}):`, error);
        return null;
      }
    });
  const sips = (await Promise.all(sipsPromises)).filter(sip => sip !== null) as SIP[];
  console.log(`Fetched ${sips.length} SIPs from ${source} folder '${folderPath}'.`);
  return sips;
}


async function fetchSipsFromPullRequests(): Promise<SIP[]> {
  // Fetch all PRs (open, closed, merged)
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=100`; // Max 100, consider pagination for >100
  let allPRs: GitHubPullRequest[];
  try {
    allPRs = await fetchFromGitHubAPI(allPRsUrl);
  } catch (error) {
    console.error("Failed to fetch pull requests:", error);
    return [];
  }

  const sipsFromPRs: SIP[] = [];

  for (const pr of allPRs) {
    console.log(`PR #${pr.number}: Processing. Title: "${pr.title}", State: ${pr.state}, Merged: ${!!pr.merged_at}`);
    let foundSipFileInPr = false;
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    
    try {
      const prFiles = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[]; // Cache PR file lists for 5 min
      for (const file of prFiles) {
        const filePath = file.filename; // filename includes the full path from repo root
        if (!filePath) {
            console.log(`  PR #${pr.number}: Skipping file with no path: ${JSON.stringify(file)}`);
            continue;
        }
        
        const fileName = filePath.split('/').pop();
        if (!fileName) {
            console.log(`  PR #${pr.number}: Skipping file with no name from path: ${filePath}`);
            continue;
        }
        
        // console.log(`  PR #${pr.number}: Checking file ${filePath} (status: ${file.status})`);

        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);
        
        const isInSipsDir = filePath.startsWith(SIPS_MAIN_BRANCH_PATH + '/');
        const isInWithdrawnSipsDir = filePath.startsWith(SIPS_WITHDRAWN_PATH + '/');
        
        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) && filePath.endsWith('.md') && !fileName.toLowerCase().includes('template');

        if (isRelevantChange && isCandidateSipFile && file.raw_url) {
          console.log(`  PR #${pr.number}: File ${filePath} is a candidate. Parsing...`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            
            // Default status for a file found in a PR depends on its location and PR state
            let defaultPrFileStatus: SipStatus;
            if (isInWithdrawnSipsDir) { // File is in withdrawn_sips/ within the PR
                defaultPrFileStatus = 'Withdrawn';
            } else if (pr.merged_at) { // File in sips/ and PR is merged
                defaultPrFileStatus = 'Accepted';
            } else if (pr.state === 'open') { // File in sips/ and PR is open
                defaultPrFileStatus = 'Draft';
            } else { // File in sips/ and PR is closed but not merged
                defaultPrFileStatus = 'Closed (unmerged)';
            }

            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePath,
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              prState: pr.state,
              defaultStatus: defaultPrFileStatus, // More nuanced default for PR files
              source: 'pull_request',
              createdAt: pr.created_at,
              updatedAt: pr.updated_at,
              mergedAt: pr.merged_at,
              author: pr.user?.login,
            });

            if (parsedSip) {
              sipsFromPRs.push(parsedSip);
              foundSipFileInPr = true; 
              console.log(`    [SIP_DETAIL_LOG] Parsed SIP from PR file: ID='${parsedSip.id}', Title='${parsedSip.title}', Status='${parsedSip.status}', Source='${parsedSip.source}', Path='${filePath}'`);
            } else {
              console.warn(`  PR #${pr.number}: File ${filePath} was a candidate but did not parse into a valid SIP. Skipping this file.`);
            }
          } catch (error) {
            console.error(`  PR #${pr.number}: Error processing file ${filePath} content:`, error);
          }
        }
      }
    } catch (error) {
        console.error(`Error fetching/processing files for PR #${pr.number}:`, error);
        // If fetching files fails, foundSipFileInPr remains false, and placeholder logic below will run.
    }

    if (!foundSipFileInPr) {
        console.log(`PR #${pr.number}: No parseable SIP MD file found in sips/ or withdrawn-sips/ folders. Creating placeholder. Title: "${pr.title}"`);
        
        const prSipNumber = extractSipNumberFromPrTitle(pr.title) || String(pr.number);
        const placeholderSipId = formatSipId(prSipNumber);
        
        let placeholderStatus: SipStatus;
        const prBodyLower = (pr.body || "").toLowerCase();
        const prTitleLower = (pr.title || "").toLowerCase();
        // A more robust check for "withdrawn" would involve checking commit messages if available,
        // but for now, title and body are primary indicators for placeholders.
        const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn");

        if (pr.state === 'open') {
            placeholderStatus = 'Draft (no file)';
        } else { // pr.state === 'closed'
            if (mentionsWithdrawnText) {
                placeholderStatus = 'Withdrawn';
            } else if (pr.merged_at) {
                placeholderStatus = 'Accepted'; // If closed and merged, and not "withdrawn" by text
            } else {
                placeholderStatus = 'Closed (unmerged)';
            }
        }
        
        const placeholderSip: SIP = {
          id: placeholderSipId,
          title: pr.title || `PR #${pr.number} Discussion`,
          status: placeholderStatus,
          summary: `No SIP file yet. Status from PR: ${placeholderStatus}`,
          body: undefined, // No body for placeholders
          prUrl: pr.html_url,
          source: 'pull_request_only',
          createdAt: pr.created_at, // Directly use PR's ISO string
          updatedAt: pr.updated_at, // Directly use PR's ISO string
          mergedAt: pr.merged_at || undefined, // Use PR's ISO string or undefined
          author: pr.user?.login,
          prNumber: pr.number,
        };
        sipsFromPRs.push(placeholderSip);
        console.log(`  PR #${pr.number}: Created placeholder SIP. ID: ${placeholderSip.id}, Title: "${placeholderSip.title}", Status: ${placeholderSip.status}, Created: ${placeholderSip.createdAt}, Updated: ${placeholderSip.updatedAt}, Merged: ${placeholderSip.mergedAt}`);
    }
  }
  console.log(`Processed ${allPRs.length} PRs, yielding ${sipsFromPRs.length} SIP entries (file-based or placeholders).`);
  return sipsFromPRs;
}

export async function getAllSips(forceRefresh: boolean = false): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION) && !forceRefresh) {
    console.log("Returning SIPs from cache.");
    return sipsCache;
  }
  if (forceRefresh) {
    console.log("Forcing SIPs cache refresh.");
  }

  try {
    // Fetch from all sources concurrently
    const [mainFolderSips, withdrawnFolderSips, prSips] = await Promise.all([
      fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder'),
      fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder'),
      fetchSipsFromPullRequests()
    ]);

    const combinedSipsMap = new Map<string, SIP>();

    // Order of addition defines precedence if IDs clash: lowest to highest
    // Placeholders from PRs first, then file-based from PRs, then main folder, then withdrawn.
    const allRawSips = [
      ...prSips.filter(sip => sip.source === 'pull_request_only'), // Placeholders
      ...prSips.filter(sip => sip.source === 'pull_request'),       // Files from PRs
      ...mainFolderSips,                                            // Files from main sips/ folder
      ...withdrawnFolderSips,                                       // Files from withdrawn-sips/ folder
    ];
    
    // Precedence: withdrawn_folder > folder > pull_request (file in PR) > pull_request_only (placeholder)
    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0,
        'pull_request': 1,
        'folder': 2,
        'withdrawn_folder': 3,
    };

    for (const sip of allRawSips) {
        if (!sip || !sip.id) {
            console.warn(`Encountered a SIP object without an ID during merging. Title: ${sip?.title}, Source: ${sip?.source}. Skipping.`);
            continue;
        }
        const key = sip.id.toLowerCase(); // Normalize ID for map key
        const existingSip = combinedSipsMap.get(key);

        if (!existingSip) {
            combinedSipsMap.set(key, sip);
        } else {
            const existingPrecedence = sourcePrecedenceValues[existingSip.source];
            const currentPrecedence = sourcePrecedenceValues[sip.source];

            if (currentPrecedence >= existingPrecedence) {
                // If current has higher or equal precedence, it might replace existing.
                // Exception: if existing is a placeholder and current is also a placeholder, don't overwrite (first one wins)
                // unless the current placeholder has more definitive info (e.g. a later update timestamp for the same PR)
                // For simplicity now: if equal precedence, current (later in allRawSips) wins.
                // This means mainFolderSips will override prSips, and withdrawnFolderSips will override all.
                combinedSipsMap.set(key, sip);
            }
            // If currentPrecedence < existingPrecedence, existing SIP is more authoritative, so we keep it.
        }
    }

    let sips = Array.from(combinedSipsMap.values());

    // Sort SIPs: Numeric part of ID descending, then status, then last updated.
    sips.sort((a, b) => {
      const numA = parseInt(a.id.replace(/^sip-(?:generic-)?/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-)?/, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA; // Higher number first
      } else if (!isNaN(numA)) {
        return -1; // Numeric IDs before generic IDs
      } else if (!isNaN(numB)) {
        return 1;
      }
      // If IDs are same or both generic, sort by status
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Closed (unmerged)", "Withdrawn", "Rejected", "Archived"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex; // Lower index (more active) first
      }

      // Then by last updated date descending
      const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (updatedA !== updatedB) {
        return updatedB - updatedA;
      }
      // Fallback to ID string compare for any remaining ties
      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    console.log(`Total unique SIPs processed and cached: ${sips.length}.`);
    return sips;
  } catch (error) {
    console.error("Error in getAllSips fetching/processing:", error);
    sipsCache = null;
    return []; // Return empty array on critical error
  }
}

export async function getSipById(id: string, forceRefresh: boolean = false): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION) || forceRefresh) {
    // console.log(`Cache miss or stale/forced for getSipById(${id}). Refreshing all SIPs.`);
    sipsToSearch = await getAllSips(true); // Pass forceRefresh true
  }
  
  let normalizedIdInput = id.toLowerCase();
  if (normalizedIdInput.match(/^\d+$/)) { // if ID is just a number string like "8"
    normalizedIdInput = formatSipId(normalizedIdInput); // format to "sip-008"
  } else if (!normalizedIdInput.startsWith('sip-')) { // if it's like "generic-foo" but missing "sip-"
    normalizedIdInput = `sip-${normalizedIdInput}`;
  }
  // Ensure it's like "sip-008" or "sip-generic-foo"
  normalizedIdInput = normalizedIdInput.replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');


  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase();
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    return foundSip;
  }
  
  console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) not found after search.`);
  return null;
}
