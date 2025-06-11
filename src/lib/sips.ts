
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips';
const SIPS_WITHDRAWN_PATH = 'withdrawn-sips';
const SIPS_REPO_BRANCH = 'main';

let sipsCache: SIP[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

interface GitHubFile {
  name: string;
  path: string; 
  filename?: string; 
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null; 
  type: 'file' | 'dir';
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'; 
  raw_url?: string; 
}

interface GitHubUser {
    login: string;
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  user: GitHubUser | null;
  created_at: string; 
  updated_at: string; 
  merged_at: string | null; 
  state: 'open' | 'closed'; 
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
    } else if (dateStr instanceof Date) {
        d = dateStr;
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
  createdAt?: string; 
  updatedAt?: string; 
  mergedAt?: string | null; 
  author?: string; 
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
    let idSource = "unknown"; // For logging how the ID was derived
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
        // If source is 'pull_request' and no other ID, and we reach here, means it's a file like 'sip-tba.md'
        // Use PR number for ID as a fallback for such files within PRs.
        if (source === 'pull_request' && optionPrNumber !== undefined) {
            id = formatSipId(optionPrNumber);
            idSource = `PR number (fallback for non-numeric filename: ${fileName})`;
        } else {
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
            idSource = "generic fallback filename";
        }
    }
    
    let sipTitle = frontmatterTitle;
    if (!sipTitle && source === 'pull_request' && optionPrTitle) {
      sipTitle = optionPrTitle;
    }
    if (!sipTitle) {
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal'}`;
    }
    
    const idIsPurelyFromPRMetadataOrGeneric = (idSource.startsWith("PR") || idSource.startsWith("generic"));
    const titleIsPurelyFromPRMetadata = !frontmatterTitle && !!optionPrTitle && source === 'pull_request';

    if (source === 'pull_request' && idIsPurelyFromPRMetadataOrGeneric && titleIsPurelyFromPRMetadata) {
        console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) potentially skipped by parseSipFile. ID source: ${idSource}, Title from PR. Placeholder logic might handle PR #${optionPrNumber} if this is the only candidate.`);
        // Allow processing for files like 'sip-tba.md' if ID is derived from PR number due to this.
        // Only return null if title AND ID are both unassertive from file content.
        if (idSource.startsWith("generic fallback filename") && titleIsPurelyFromPRMetadata) { // very weak assertion
             return null;
        }
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
            resolvedStatus = 'Closed (unmerged)'; // default for closed, unmerged PR files
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
        if (source === 'pull_request' && !body) {
          aiSummary = `This SIP is based on PR #${optionPrNumber} which does not yet have a detailed markdown body. Title: ${sipTitle}`;
        }
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
             // For folder SIPs, this fallback might be too generic if no PR link in frontmatter.
             // This will be enriched later by getAllSips if a PR is found.
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/blob/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }
    
    let createdAtISO: string | undefined;
    let updatedAtISO: string | undefined;
    const emergencyFallbackDate = '1970-01-01T00:00:00.000Z';

    if (source === 'pull_request') {
        createdAtISO = parseValidDate(optionCreatedAt, emergencyFallbackDate);
        updatedAtISO = parseValidDate(optionUpdatedAt, createdAtISO || emergencyFallbackDate);
        if (!optionCreatedAt || !optionUpdatedAt) {
            console.warn(`[TIMESTAMP_WARN_PR_FILE] Invalid/missing createdAt/updatedAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}.`);
        }
    } else { // 'folder' or 'withdrawn_folder'
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date, emergencyFallbackDate)!;
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAtISO)!;
    }

    let mergedAtVal: string | undefined;
    if (source === 'pull_request' && optionMergedAt) {
        mergedAtVal = parseValidDate(optionMergedAt);
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
      filePath: options.filePath,
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
          filePath: file.path, // file.path is the full path in the repo
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
    
    const prOptions: Omit<ParseSipFileOptions, 'fileName' | 'filePath' | 'defaultStatus' | 'source'> = {
        prUrl: pr.html_url,
        prTitle: pr.title,
        prNumber: pr.number,
        prState: pr.state,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at,
        author: pr.user?.login,
    };

    try {
      const filesInPr = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[];
      for (const file of filesInPr) {
        const filePathInPr = file.filename; 
        if (!filePathInPr) {
            console.log(`  PR #${pr.number}, File SHA ${file.sha}: Skipping file with no path: ${JSON.stringify(file)}`);
            continue;
        }
        
        const fileName = filePathInPr.split('/').pop();
        if (!fileName) {
            console.log(`  PR #${pr.number}, File SHA ${file.sha}: Skipping file with no name from path: ${filePathInPr}`);
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
            
            let fileDefaultStatus: SipStatus = 'Draft'; 
            let fileSource: 'pull_request' | 'withdrawn_folder' = 'pull_request'; // withdrawn_folder not right here

            if (isInWithdrawnSipsDir) { // File is in withdrawn_sips path within the PR
                 fileDefaultStatus = 'Withdrawn';
                 // Source should still be 'pull_request' indicating it's from a PR context,
                 // but its location suggests withdrawn content.
                 // parseSipFile will use frontmatter status if available.
            } else if (pr.merged_at) {
                fileDefaultStatus = 'Accepted';
            } else if (pr.state === 'closed') { 
                fileDefaultStatus = 'Closed (unmerged)';
            } // else 'Draft' for open PRs

            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              ...prOptions,
              defaultStatus: fileDefaultStatus, 
              source: 'pull_request', 
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
        const prSipNumberStr = extractSipNumberFromPrTitle(pr.title) || String(pr.number);
        const placeholderSipId = formatSipId(prSipNumberStr);
        
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
                placeholderStatus = 'Accepted'; // The PR/discussion itself was accepted/merged
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
          filePath: undefined, // No specific file for placeholder
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
    const [mainFolderSipsData, withdrawnFolderSipsData, prSipsData] = await Promise.all([
      fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder'),
      fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder'),
      fetchSipsFromPullRequests(),
    ]);

    let mainFolderSips = [...mainFolderSipsData]; // mutable copy

    // Stage 2: Build a map of file paths to their latest merged PR metadata from prSipsData
    const mergedFilePrInfoMap = new Map<string, {
        mergedAt: string;
        prUrl: string;
        author?: string;
        prNumber?: number;
    }>();

    for (const prSip of prSipsData) {
        if (prSip.source === 'pull_request' && prSip.filePath && prSip.mergedAt) {
            const existingEntry = mergedFilePrInfoMap.get(prSip.filePath);
            if (!existingEntry || new Date(prSip.mergedAt) > new Date(existingEntry.mergedAt)) {
                mergedFilePrInfoMap.set(prSip.filePath, {
                    mergedAt: prSip.mergedAt,
                    prUrl: prSip.prUrl,
                    author: prSip.author,
                    prNumber: prSip.prNumber,
                });
            }
        }
    }

    // Stage 3: Enrich mainFolderSips
    mainFolderSips = mainFolderSips.map(folderSip => {
        if (folderSip.filePath && mergedFilePrInfoMap.has(folderSip.filePath)) {
            const prInfo = mergedFilePrInfoMap.get(folderSip.filePath)!;
            const enrichedSip = { ...folderSip };

            if (!enrichedSip.mergedAt && prInfo.mergedAt) { // Only fill if not already set (e.g. by frontmatter)
                enrichedSip.mergedAt = prInfo.mergedAt;
            }
            if ((!enrichedSip.prUrl || enrichedSip.prUrl.includes('/blob/')) && prInfo.prUrl) { // Prefer specific PR URL
                enrichedSip.prUrl = prInfo.prUrl;
            }
            if (!enrichedSip.author && prInfo.author) {
                enrichedSip.author = prInfo.author;
            }
            if (!enrichedSip.prNumber && prInfo.prNumber) {
                enrichedSip.prNumber = prInfo.prNumber;
            }
            enrichedSip.source = 'folder+pr';
            console.log(`Enriched SIP ${folderSip.id} (file: ${folderSip.filePath}) to source 'folder+pr' with PR #${prInfo.prNumber} data.`);
            return enrichedSip;
        }
        return folderSip;
    });
    
    const combinedSipsMap = new Map<string, SIP>();
    // Combine all SIPs: prSips, then enriched mainFolderSips, then withdrawnFolderSips
    const allSipsToProcess = [...prSipsData, ...mainFolderSips, ...withdrawnFolderSipsData];

    const sourcePrecedenceOrder: Array<SIP['source']> = [
        'pull_request_only',
        'pull_request',
        'folder',
        'folder+pr',
        'withdrawn_folder',
    ];

    for (const currentSip of allSipsToProcess) {
      if (!currentSip || !currentSip.id) {
        console.warn("Skipping SIP with no ID:", currentSip);
        continue;
      }
      const key = currentSip.id.toLowerCase();
      const existingSip = combinedSipsMap.get(key);

      if (!existingSip) {
        combinedSipsMap.set(key, currentSip);
      } else {
        const existingPrecedence = sourcePrecedenceOrder.indexOf(existingSip.source);
        const currentPrecedence = sourcePrecedenceOrder.indexOf(currentSip.source);

        if (currentPrecedence >= existingPrecedence) {
          // Handle specific merge cases for enrichment, e.g. 'folder+pr' enhancing 'folder'
          if (existingSip.source === 'folder' && currentSip.source === 'folder+pr' && existingSip.id === currentSip.id) {
             // currentSip is the enriched version. Its metadata (mergedAt, prUrl from PR) is preferred.
             // Content (body, summary, title, file's createdAt/updatedAt, status) should be from the original file.
             combinedSipsMap.set(key, {
                ...currentSip, // Contains PR-derived metadata and 'folder+pr' source
                body: existingSip.body || currentSip.body, 
                summary: existingSip.summary || currentSip.summary,
                title: existingSip.title || currentSip.title, 
                createdAt: existingSip.createdAt, // Keep original file's createdAt
                updatedAt: (existingSip.updatedAt !== existingSip.createdAt && existingSip.updatedAt !== emergencyFallbackDate) ? existingSip.updatedAt : currentSip.updatedAt, // Keep original file's updatedAt if meaningful
                status: existingSip.status, // Keep original status ('Final')
             });
          } else if (currentPrecedence > existingPrecedence) {
            combinedSipsMap.set(key, currentSip);
          } else if (currentPrecedence === existingPrecedence && currentSip.source === 'pull_request') {
             // If two prSips have same ID and source 'pull_request', pick the one most recently updated in the PR
             if (new Date(currentSip.updatedAt) > new Date(existingSip.updatedAt)) {
                 combinedSipsMap.set(key, currentSip);
             }
          } else if (currentPrecedence === existingPrecedence && currentSip.source === 'pull_request_only') {
             // If two placeholders, pick the one most recently updated
             if (new Date(currentSip.updatedAt) > new Date(existingSip.updatedAt)) {
                 combinedSipsMap.set(key, currentSip);
             }
          }
          // If currentPrecedence < existingPrecedence, do nothing (keep existingSip)
        }
      }
    }

    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      const numA = parseInt(a.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA; // Sort by ID number descending
      } else if (!isNaN(numA)) {
        return -1; // Numeric IDs first
      } else if (!isNaN(numB)) {
        return 1;  // Numeric IDs first
      }
      
      // Fallback sorting for non-numeric or if IDs are equal (should be rare for numeric)
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Closed (unmerged)", "Withdrawn", "Rejected", "Archived"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex;
      }

      const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (updatedA !== updatedB) {
        return updatedB - updatedA; // Most recently updated first
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
    console.log(`Cache miss or forced refresh for getSipById(${id}). Re-fetching all SIPs.`);
    sipsToSearch = await getAllSips(true);
  } else {
    console.log(`Using cached SIPs for getSipById(${id}).`);
  }
  
  let normalizedIdInput = id.toLowerCase();
  // Allow simple number like "8" or "sip-8" or "sip-008"
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?(\d+)$/);
  if (numericMatch && numericMatch[1]) {
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
  } else if (!normalizedIdInput.startsWith('sip-')) { // for generic IDs if any remain
    normalizedIdInput = `sip-${normalizedIdInput}`;
  }
  normalizedIdInput = normalizedIdInput.replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');


  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase();
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) found.`);
    return foundSip;
  }
  
  console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) not found after search of ${sipsToSearch?.length} SIPs.`);
  return null;
}
