
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
const FALLBACK_CREATED_AT_DATE = '1970-01-01T00:00:00.000Z';


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

function parseValidDate(dateStr: any): string | undefined {
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
        if (source === 'pull_request' && optionPrNumber !== undefined) {
            id = formatSipId(optionPrNumber);
            idSource = `PR number (fallback for non-numeric filename: ${fileName})`;
        } else {
             // This case should be rare for actual SIPs from folders if they follow any naming convention.
             // For PRs, the above PR number fallback should catch it.
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

    const idIsPurelyFromPRMetadata = idSource.startsWith("PR number");
    const titleIsPurelyFromPRMetadata = !frontmatterTitle && !!optionPrTitle && source === 'pull_request';

    if (source === 'pull_request' && idIsPurelyFromPRMetadata && titleIsPurelyFromPRMetadata) {
        console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) will be skipped by parseSipFile. ID source: ${idSource}, Title from PR. Placeholder logic will handle PR #${optionPrNumber}.`);
        return null;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];

    let resolvedStatus: SipStatus = defaultStatus;

    if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter;
    } else if (source === 'pull_request') {
        if (optionMergedAt) {
            resolvedStatus = 'Accepted'; // Default for merged PR files if no status in FM
        } else if (optionPrState === 'open') {
            resolvedStatus = 'Draft'; // Default for open PR files
        } else {
            resolvedStatus = 'Closed (unmerged)'; // Default for closed, unmerged PR files
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
        if (source === 'pull_request' && !body && optionPrNumber) {
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
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/blob/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }

    let createdAtISO: string;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request') {
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE;
        if (createdAtISO === FALLBACK_CREATED_AT_DATE) {
             console.warn(`[TIMESTAMP_WARN_PR_FILE] Invalid or missing createdAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. Using fallback.`);
        }
        updatedAtISO = parseValidDate(optionUpdatedAt); // This will be undefined if optionUpdatedAt is invalid/missing
    } else { // 'folder' or 'withdrawn_folder' (source can also be 'folder+pr' after enrichment but this block is for initial parsing)
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date) || FALLBACK_CREATED_AT_DATE;
      if (createdAtISO === FALLBACK_CREATED_AT_DATE) {
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE] Invalid or missing createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Using fallback.`);
      }
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    let mergedAtVal: string | undefined;
    if (source === 'pull_request' && optionMergedAt) { // Prioritize PR's merged_at if this is a PR-sourced file
        mergedAtVal = parseValidDate(optionMergedAt);
    } else { // For folder files, or PR files where optionMergedAt wasn't provided (shouldn't happen for merged PRs)
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
      createdAt: createdAtISO,
      updatedAt: updatedAtISO,
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
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=100`; // Fetch more PRs if needed
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

    const prOptionsBase: Omit<ParseSipFileOptions, 'fileName' | 'filePath' | 'defaultStatus' | 'source'> = {
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
            if (isInWithdrawnSipsDir) {
                fileDefaultStatus = 'Withdrawn';
            } else if (pr.merged_at) {
                fileDefaultStatus = 'Accepted';
            } else if (pr.state === 'closed') {
                fileDefaultStatus = 'Closed (unmerged)';
            }

            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              ...prOptionsBase,
              defaultStatus: fileDefaultStatus,
              source: 'pull_request',
            });

            if (parsedSip) {
              sipsFromPRs.push(parsedSip);
              foundSipFileInPr = true;
              console.log(`  PR #${pr.number}: Parsed SIP from file ${filePathInPr}. ID: ${parsedSip.id}, Title: "${parsedSip.title}", Status: ${parsedSip.status}`);
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
                placeholderStatus = 'Accepted'; // Placeholder for a merged PR that didn't yield a file
            } else {
                placeholderStatus = 'Closed (unmerged)';
            }
        }

        const placeholderSip: SIP = {
          id: placeholderSipId,
          title: pr.title || `PR #${pr.number} Discussion`,
          status: placeholderStatus,
          summary: `No SIP file yet. Status from PR: ${placeholderStatus}`,
          body: undefined, // No body for placeholder
          prUrl: pr.html_url,
          source: 'pull_request_only',
          createdAt: pr.created_at, // Direct from GH
          updatedAt: pr.updated_at, // Direct from GH
          mergedAt: pr.merged_at || undefined, // Direct from GH
          author: pr.user?.login,
          prNumber: pr.number,
          filePath: undefined, // No specific file for placeholder
        };
        sipsFromPRs.push(placeholderSip);
        console.log(`  PR #${pr.number}: Created placeholder SIP. ID: ${placeholderSip.id}, Title: "${placeholderSip.title}", Status: ${placeholderSip.status}`);
    }
  }
  console.log(`Fetched ${sipsFromPRs.length} SIPs/placeholders from Pull Requests.`);
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

    // Build a map of file paths to their latest merged PR metadata from prSipsData
    const mergedFilePrInfoMap = new Map<string, {
        mergedAt: string;
        prUrl: string;
        author?: string;
        prNumber?: number;
        createdAt: string; // PR creation
        updatedAt: string; // PR update
    }>();

    for (const prSip of prSipsData) {
        // Consider only PRs that resulted in a file and were merged
        if (prSip.source === 'pull_request' && prSip.filePath && prSip.mergedAt) {
            const existingEntry = mergedFilePrInfoMap.get(prSip.filePath);
            // If no entry or this PR is more recent (shouldn't happen if PRs are sorted by update desc)
            if (!existingEntry || new Date(prSip.mergedAt) > new Date(existingEntry.mergedAt)) {
                mergedFilePrInfoMap.set(prSip.filePath, {
                    mergedAt: prSip.mergedAt,
                    prUrl: prSip.prUrl,
                    author: prSip.author,
                    prNumber: prSip.prNumber,
                    createdAt: prSip.createdAt,
                    updatedAt: prSip.updatedAt || prSip.createdAt, // fallback for updatedAt
                });
            }
        }
    }

    // Enrich mainFolderSips
    const enrichedMainFolderSips = mainFolderSipsData.map(folderSip => {
        if (folderSip.filePath && mergedFilePrInfoMap.has(folderSip.filePath)) {
            const prInfo = mergedFilePrInfoMap.get(folderSip.filePath)!;
            const enrichedSip = { ...folderSip, source: 'folder+pr' as SIP['source'] }; // Explicitly cast source

            // Prefer PR's mergedAt if folder SIP doesn't have one or if PR's is more specific
            if (!enrichedSip.mergedAt || (prInfo.mergedAt && enrichedSip.mergedAt !== prInfo.mergedAt)) {
                enrichedSip.mergedAt = prInfo.mergedAt;
            }
             // Prefer specific PR URL if folder SIP's is generic or missing
            if ((!enrichedSip.prUrl || enrichedSip.prUrl.includes('/blob/')) && prInfo.prUrl) {
                enrichedSip.prUrl = prInfo.prUrl;
            }
            if (!enrichedSip.author && prInfo.author) {
                enrichedSip.author = prInfo.author;
            }
            if (!enrichedSip.prNumber && prInfo.prNumber) {
                enrichedSip.prNumber = prInfo.prNumber;
            }
             // Update createdAt/updatedAt from PR if folder's are basic fallbacks or older
            if (enrichedSip.createdAt === FALLBACK_CREATED_AT_DATE && prInfo.createdAt) {
                enrichedSip.createdAt = prInfo.createdAt;
            }
            if ((!enrichedSip.updatedAt || enrichedSip.updatedAt === enrichedSip.createdAt) && prInfo.updatedAt) {
                 enrichedSip.updatedAt = prInfo.updatedAt;
            }
            console.log(`Enriched SIP ${folderSip.id} (file: ${folderSip.filePath}) to source 'folder+pr' with PR #${prInfo.prNumber} data.`);
            return enrichedSip;
        }
        return folderSip;
    });

    const combinedSipsMap = new Map<string, SIP>();
    const allSipsToProcess = [...prSipsData, ...enrichedMainFolderSips, ...withdrawnFolderSipsData];

    // Define precedence: lower index means lower precedence (more likely to be overridden)
    const sourcePrecedenceOrder: Array<SIP['source']> = [
        'pull_request_only', // Most likely to be overridden by a file
        'pull_request',      // Actual file from a PR
        'folder',            // File from main branch (less specific than folder+pr)
        'folder+pr',         // File from main branch, enriched with PR details
        'withdrawn_folder',  // Authoritative for withdrawn status
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
            // If current SIP has higher or equal precedence, consider replacing
            // Special handling for 'folder+pr' enriching 'folder'
            if (existingSip.source === 'folder' && currentSip.source === 'folder+pr' && existingSip.id === currentSip.id) {
                combinedSipsMap.set(key, {
                    ...currentSip, // currentSip is already the enriched version
                    body: existingSip.body || currentSip.body,
                    summary: existingSip.summary || currentSip.summary, // Prefer existing summary if AI summary failed on re-parse
                    title: existingSip.title || currentSip.title,
                    // createdAt, updatedAt, mergedAt should be correctly set by the enrichment logic already for currentSip
                    status: existingSip.status, // Keep 'Final' status from original folder read
                });
            } else if (currentPrecedence > existingPrecedence) {
                 combinedSipsMap.set(key, currentSip);
            } else if (currentPrecedence === existingPrecedence) {
                // Same precedence, use the one with the most recent 'updatedAt' date
                // Ensure both dates are valid before comparing
                const currentUpdatedAt = currentSip.updatedAt ? new Date(currentSip.updatedAt).getTime() : 0;
                const existingUpdatedAt = existingSip.updatedAt ? new Date(existingSip.updatedAt).getTime() : 0;

                if (currentUpdatedAt > existingUpdatedAt) {
                    combinedSipsMap.set(key, currentSip);
                } else if (currentUpdatedAt === existingUpdatedAt && currentSip.body && !existingSip.body) {
                    // If update dates are same, prefer the one with a body (e.g. file vs placeholder)
                    combinedSipsMap.set(key, currentSip);
                }
            }
        }
      }
    }

    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      const numA = parseInt(a.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);

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
    sipsCache = null; // Invalidate cache on error
    return []; // Return empty array or throw, depending on desired error handling
  }
}

export async function getSipById(id: string, forceRefresh: boolean = false): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  // Cache invalidation or forced refresh
  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION) || forceRefresh) {
    console.log(`Cache miss or forced refresh for getSipById(${id}). Re-fetching all SIPs.`);
    sipsToSearch = await getAllSips(true); // Pass true to ensure refresh
  } else {
    console.log(`Using cached SIPs for getSipById(${id}).`);
  }

  if (!sipsToSearch || sipsToSearch.length === 0) { // Check if sipsToSearch is null or empty
    console.log(`No SIPs available in cache or after fetch for getSipById(${id}).`);
    return null;
  }

  let normalizedIdInput = id.toLowerCase();
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?(\d+)$/);
  if (numericMatch && numericMatch[1]) {
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
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
    console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) found.`);
    return foundSip;
  }

  console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) not found after search of ${sipsToSearch?.length} SIPs.`);
  return null;
}
