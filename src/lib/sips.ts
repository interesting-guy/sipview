
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
  path: string; // Path in the repo at the commit of the PR (for folder lists)
  filename?: string; // This comes from pulls.listFiles API, preferred for PR file paths
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null; // For folder lists
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

function parseValidDate(dateStr: any, fallbackDateISO?: string): string | undefined {
    let d: Date | undefined;
    if (dateStr && typeof dateStr === 'string') {
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
  filePath: string;
  prUrl?: string;
  prTitle?: string;
  prNumber?: number;
  prState?: 'open' | 'closed';
  defaultStatus: SipStatus;
  source: 'folder' | 'pull_request' | 'withdrawn_folder';
  createdAt?: string; // ISO string from PR (pr.created_at) or frontmatter
  updatedAt?: string; // ISO string from PR (pr.updated_at) or frontmatter
  mergedAt?: string | null; // ISO string or null from PR (pr.merged_at) or frontmatter
  author?: string; // PR author login or from frontmatter
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const {
    fileName, filePath, prUrl: optionPrUrl, prTitle: optionPrTitle, prNumber: optionPrNumber,
    prState: optionPrState, defaultStatus, source,
    createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt,
    author: optionAuthor
  } = options;

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
    
    if (!sipNumberStr && (source === 'pull_request')) {
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
        id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
        idSource = "generic fallback filename";
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && source === 'pull_request' && optionPrTitle) {
      sipTitle = optionPrTitle;
    }
    if (!sipTitle) {
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal'}`;
    }

    // If this file is from a PR, and its ID is solely derived from PR metadata (not from the file itself's name/frontmatter)
    // AND its title is also solely derived from PR metadata (not from frontmatter), then skip it.
    // This allows the more general PR placeholder logic to take over.
    const idIsPurelyFromPRMetadata = (idSource === "PR title" || idSource === "PR number");
    const titleIsPurelyFromPRMetadata = !frontmatterTitle && !!optionPrTitle;

    if (source === 'pull_request' && idIsPurelyFromPRMetadata && titleIsPurelyFromPRMetadata) {
        console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) skipped by parseSipFile. ID source: ${idSource}, Title from PR. Placeholder logic will handle PR #${optionPrNumber}.`);
        return null;
    }
    
    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    
    let resolvedStatus: SipStatus = defaultStatus;
    
    if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter;
    } else if (source === 'pull_request') {
        if (optionMergedAt) {
            resolvedStatus = 'Accepted';
        } else if (optionPrState === 'open') {
            resolvedStatus = 'Draft';
        } else {
            resolvedStatus = 'Closed (unmerged)';
        }
    }

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

    let prUrlToUse = optionPrUrl;
    if (!prUrlToUse) {
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/tree/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }
    
    let createdAtISO: string | undefined;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request') {
      createdAtISO = parseValidDate(optionCreatedAt);
      updatedAtISO = parseValidDate(optionUpdatedAt);
      if (!createdAtISO || !updatedAtISO) {
        console.warn(`[TIMESTAMP_WARN_PR] Invalid/missing createdAt/updatedAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. Using emergency fallback.`);
        const emergencyFallbackDate = '1970-01-01T00:00:00Z';
        if (!createdAtISO) createdAtISO = emergencyFallbackDate;
        if (!updatedAtISO) updatedAtISO = emergencyFallbackDate;
      }
    } else { // 'folder' or 'withdrawn_folder'
      const emergencyDate = '1970-01-01T00:00:00Z'; // Fallback if no date in frontmatter
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date, emergencyDate)!;
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAtISO)!;
    }

    let mergedAtVal: string | undefined;
    if (source === 'pull_request') {
        mergedAtVal = optionMergedAt ? parseValidDate(optionMergedAt) : undefined;
    } else { 
        mergedAtVal = frontmatter.merged ? parseValidDate(frontmatter.merged) : undefined;
    }

    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined) || (Array.isArray(frontmatter.authors) ? frontmatter.authors.join(', ') : undefined);
    const prNumberFromFrontmatter = typeof frontmatter.pr === 'number' ? frontmatter.pr : undefined;

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
      prNumber: optionPrNumber || prNumberFromFrontmatter,
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
        return parseSipFile(rawContent, {
          fileName: file.name,
          filePath: file.path,
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
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  let allPRs: GitHubPullRequest[];
  try {
    allPRs = await fetchFromGitHubAPI(allPRsUrl);
  } catch (error) {
    console.error("Failed to fetch pull requests:", error);
    return [];
  }

  const sipsFromPRs: SIP[] = [];

  for (const pr of allPRs) {
    let foundSipFileInPr = false;
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    
    try {
      const prFiles = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[];
      for (const file of prFiles) {
        const filePathInPr = file.filename; 
        if (!filePathInPr) {
            console.log(`  PR #${pr.number}: Skipping file with no path: ${JSON.stringify(file)}`);
            continue;
        }
        
        const fileName = filePathInPr.split('/').pop();
        if (!fileName) {
            console.log(`  PR #${pr.number}: Skipping file with no name from path: ${filePathInPr}`);
            continue;
        }
        
        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);
        
        const isInSipsDir = filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/');
        const isInWithdrawnSipsDir = filePathInPr.startsWith(SIPS_WITHDRAWN_PATH + '/');
        
        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) && filePathInPr.endsWith('.md') && !fileName.toLowerCase().includes('template');

        if (isRelevantChange && isCandidateSipFile && file.raw_url) {
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            
            let defaultPrFileStatus: SipStatus = 'Draft'; // Default for open PRs
            if (isInWithdrawnSipsDir) {
                defaultPrFileStatus = 'Withdrawn';
            } else if (pr.merged_at) {
                defaultPrFileStatus = 'Accepted';
            } else if (pr.state === 'closed') { // Closed but not merged
                defaultPrFileStatus = 'Closed (unmerged)';
            }

            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              prState: pr.state,
              defaultStatus: defaultPrFileStatus,
              source: 'pull_request',
              createdAt: pr.created_at,
              updatedAt: pr.updated_at,
              mergedAt: pr.merged_at,
              author: pr.user?.login,
            });

            if (parsedSip) {
              sipsFromPRs.push(parsedSip);
              foundSipFileInPr = true; 
            }
          } catch (error) {
            console.error(`  PR #${pr.number}: Error processing file ${filePathInPr} content:`, error);
          }
        }
      }
    } catch (error) {
        console.error(`Error fetching/processing files for PR #${pr.number}:`, error);
    }

    if (!foundSipFileInPr) {
        const prSipNumber = extractSipNumberFromPrTitle(pr.title) || String(pr.number);
        const placeholderSipId = formatSipId(prSipNumber);
        
        let placeholderStatus: SipStatus;
        const prBodyLower = (pr.body || "").toLowerCase();
        const prTitleLower = (pr.title || "").toLowerCase();
        const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn");

        if (pr.state === 'open') {
            placeholderStatus = 'Draft (no file)';
        } else { // pr.state === 'closed'
            if (mentionsWithdrawnText) {
                placeholderStatus = 'Withdrawn';
            } else if (pr.merged_at) {
                placeholderStatus = 'Accepted'; // PR itself was accepted/merged
            } else {
                placeholderStatus = 'Closed (unmerged)';
            }
        }
        
        const placeholderSip: SIP = {
          id: placeholderSipId,
          title: pr.title || `PR #${pr.number} Discussion`,
          status: placeholderStatus,
          summary: `No SIP file yet. Status from PR: ${placeholderStatus}`,
          body: undefined,
          prUrl: pr.html_url,
          source: 'pull_request_only',
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          mergedAt: pr.merged_at || undefined,
          author: pr.user?.login,
          prNumber: pr.number,
        };
        sipsFromPRs.push(placeholderSip);
        console.log(`  PR #${pr.number}: Created placeholder SIP. ID: ${placeholderSip.id}, Title: "${placeholderSip.title}", Status: ${placeholderSip.status}`);
    }
  }
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
    const [mainFolderSips, withdrawnFolderSips, prSips] = await Promise.all([
      fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder'),
      fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder'),
      fetchSipsFromPullRequests()
    ]);

    const combinedSipsMap = new Map<string, SIP>();

    // Step 1: Populate with PR data (includes file-based and placeholders)
    // prSips array might have multiple entries if a PR has multiple files or if a placeholder was created and then a file was added.
    // The parsing/placeholder logic should ideally give one entry per PR number, or one per unique file ID.
    // For now, simple iteration and last-one-wins by ID.
    for (const sip of prSips) {
        if (sip && sip.id) {
            combinedSipsMap.set(sip.id.toLowerCase(), sip);
        }
    }
    
    // Step 2: Integrate Main Folder SIPs, potentially enhancing with PR data
    for (const mainSip of mainFolderSips) {
        if (!mainSip || !mainSip.id) continue;
        const key = mainSip.id.toLowerCase();
        const existingPrData = combinedSipsMap.get(key);

        const finalEntry: SIP = {
            ...mainSip, // body, title from file, frontmatter fields
            status: mainSip.status || 'Final', // Authoritative status for main folder
            source: 'folder',         // Authoritative source
        };

        if (existingPrData) {
            // Prefer PR's mergedAt if mainSip (from frontmatter) doesn't have one, or if explicitly requested to override
            finalEntry.mergedAt = existingPrData.mergedAt ?? mainSip.mergedAt; // Per request: PR's mergedAt for folder SIPs
            
            // If mainSip's prUrl is generic (tree link) or undefined, and PR has a specific link
            if ((!mainSip.prUrl || mainSip.prUrl.includes('/tree/')) && existingPrData.prUrl && !existingPrData.prUrl.includes('/tree/')) {
                finalEntry.prUrl = existingPrData.prUrl;
            }
            finalEntry.author = mainSip.author ?? existingPrData.author;
            finalEntry.prNumber = mainSip.prNumber ?? existingPrData.prNumber;
             // Timestamps: Folder SIPs rely on their frontmatter or parseSipFile defaults.
            // Retain mainSip.createdAt and mainSip.updatedAt unless we specifically want to override from PR.
            // For now, keeping mainSip's own timestamps for these.
        }
        combinedSipsMap.set(key, finalEntry);
    }

    // Step 3: Integrate Withdrawn Folder SIPs, potentially enhancing
    for (const withdrawnSip of withdrawnFolderSips) {
        if (!withdrawnSip || !withdrawnSip.id) continue;
        const key = withdrawnSip.id.toLowerCase();
        const existingPrData = combinedSipsMap.get(key); // Could be from PRs or even from mainFolderSips if ID clashed

        const finalEntry: SIP = {
            ...withdrawnSip,
            status: withdrawnSip.status || 'Withdrawn', // Authoritative status
            source: 'withdrawn_folder',   // Authoritative source
        };

        if (existingPrData) {
            // Prefer PR's mergedAt if withdrawnSip (from frontmatter) doesn't have one, or if explicitly requested
            finalEntry.mergedAt = existingPrData.mergedAt ?? withdrawnSip.mergedAt;

            if ((!withdrawnSip.prUrl || withdrawnSip.prUrl.includes('/tree/')) && existingPrData.prUrl && !existingPrData.prUrl.includes('/tree/')) {
                finalEntry.prUrl = existingPrData.prUrl;
            }
            finalEntry.author = withdrawnSip.author ?? existingPrData.author;
            finalEntry.prNumber = withdrawnSip.prNumber ?? existingPrData.prNumber;
        }
        combinedSipsMap.set(key, finalEntry);
    }


    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      const numA = parseInt(a.id.replace(/^sip-(?:generic-)?/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-)?/, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA;
      } else if (!isNaN(numA)) {
        return -1;
      } else if (!isNaN(numB)) {
        return 1;
      }
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Closed (unmerged)", "Withdrawn", "Rejected", "Archived"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex;
      }

      const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (updatedA !== updatedB) {
        return updatedB - updatedA;
      }
      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    console.log(`Total unique SIPs processed and cached: ${sips.length}.`);
    return sips;
  } catch (error) {
    console.error("Error in getAllSips fetching/processing:", error);
    sipsCache = null;
    return [];
  }
}

export async function getSipById(id: string, forceRefresh: boolean = false): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION) || forceRefresh) {
    sipsToSearch = await getAllSips(true);
  }
  
  let normalizedIdInput = id.toLowerCase();
  if (normalizedIdInput.match(/^\d+$/)) {
    normalizedIdInput = formatSipId(normalizedIdInput);
  } else if (!normalizedIdInput.startsWith('sip-')) {
    normalizedIdInput = `sip-${normalizedIdInput}`;
  }
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

    