
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
  raw_url?: string; 
  type: 'file' | 'dir';
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
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
    } else if (dateStr instanceof Date) {
        d = dateStr;
    }
    if (d && isNaN(d.getTime())) {
        d = undefined; // Invalid date
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
    
    if (!sipNumberStr && (source === 'pull_request') && optionPrTitle) {
      const numFromTitle = extractSipNumberFromPrTitle(optionPrTitle);
      if (numFromTitle) {
        sipNumberStr = numFromTitle;
        idSource = "PR title";
      }
    }
    
    // Fallback to PR number for ID if source is pull_request and no other ID found
    if (!sipNumberStr && (source === 'pull_request') && optionPrNumber !== undefined) {
      sipNumberStr = String(optionPrNumber);
      idSource = "PR number"; 
    }


    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
    } else {
        // This case should be rare for `pull_request` source due to PR number fallback above.
        // For folder sources, if a file has no number in name/frontmatter, it gets a generic ID.
        if (source === 'folder' || source === 'withdrawn_folder') {
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
            idSource = "generic fallback filename (folder)";
        } else {
             // This specific log is for when even PR number fallback didn't yield an ID for a PR file.
             console.warn(`  [ID_WARN_NULL_RETURN] Could not determine numeric SIP ID for PR file: ${fileName}, path: ${filePath}, source: ${source}. PR title: "${optionPrTitle}", PR num: ${optionPrNumber}. File will be skipped by parseSipFile.`);
             return null; 
        }
    }
    
    // If ID is purely from PR number and title is purely from PR metadata (no SIP-specific assertion in file)
    // then defer this file to be handled by the placeholder logic for the PR itself.
    const idIsPurelyFromPRNumberFallback = idSource === "PR number";
    const titleIsPurelyFromPRMetadata = !frontmatterTitle && !!optionPrTitle && source === 'pull_request';

    if (source === 'pull_request' && idIsPurelyFromPRNumberFallback && titleIsPurelyFromPRMetadata) {
        console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) will be skipped by parseSipFile as it lacks specific SIP ID in filename/frontmatter and lacks title in frontmatter. ID derived from PR#: ${optionPrNumber}. Associated PR title: "${optionPrTitle}". Placeholder logic should handle PR #${optionPrNumber}.`);
        return null;
    }


    let sipTitle = frontmatterTitle;
    if (!sipTitle && (source === 'pull_request') && optionPrTitle) {
      sipTitle = optionPrTitle;
    }
    if (!sipTitle) {
        // Fallback title using the derived ID
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal'}`;
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
    
    const abstractOrDescription = frontmatter.abstract || frontmatter.description;
    let aiSummary = "Summary not available.";

    // Conditions for attempting AI summary:
    // 1. There's a body OR there's a substantial abstract/description.
    const hasSufficientBody = body && body.trim().length > 10;
    const hasSufficientAbstract = abstractOrDescription && abstractOrDescription.trim().length > 10;

    if (hasSufficientBody || hasSufficientAbstract) {
      try {
        const summaryResult = await summarizeSipContent({ 
            sipBody: hasSufficientBody ? body : undefined, 
            abstractOrDescription: hasSufficientAbstract ? abstractOrDescription : undefined 
        });
        aiSummary = summaryResult.summary;
      } catch (e) {
        console.error(`Failed to generate AI summary for SIP ID ${id} (file: ${filePath}):`, e);
        // Fallback if AI fails
        if (abstractOrDescription) {
            aiSummary = abstractOrDescription.substring(0, 200) + (abstractOrDescription.length > 200 ? "..." : "");
        } else if (body) {
            aiSummary = body.substring(0, 120).split('\n')[0] + "...";
        } else {
            aiSummary = "Could not generate AI summary.";
        }
      }
    } else {
        // If neither body nor abstract/description is sufficient
        aiSummary = "This proposal does not have enough detail to summarize yet.";
    }
    
    // If AI summary itself says "insufficient detail", but we have a frontmatter summary, use that as a better placeholder.
    if (aiSummary === "This proposal does not have enough detail to summarize yet." && frontmatter.summary) {
        aiSummary = String(frontmatter.summary);
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
            // Default PR URL for files from folders without explicit PR link in frontmatter
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/blob/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }

    let createdAtISO: string;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request' || source === 'pull_request_only') {
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE;
        if (createdAtISO === FALLBACK_CREATED_AT_DATE && optionCreatedAt) {
             console.warn(`[TIMESTAMP_WARN_PR_FILE_INVALID_CREATED] Invalid createdAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. Input: ${optionCreatedAt}. Using fallback.`);
        }
        updatedAtISO = parseValidDate(optionUpdatedAt); 
    } else { 
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date) || FALLBACK_CREATED_AT_DATE;
      if (createdAtISO === FALLBACK_CREATED_AT_DATE && (frontmatter.created || frontmatter.date)) {
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE_INVALID_CREATED] Invalid createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Input: ${frontmatter.created || frontmatter.date}. Using fallback.`);
      } else if (createdAtISO === FALLBACK_CREATED_AT_DATE && source !== 'pull_request' && source !== 'pull_request_only' ) {
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE_MISSING_CREATED] Missing createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Using fallback.`);
      }
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    let mergedAtVal: string | undefined;
    if (optionMergedAt !== undefined) { 
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
          // Timestamps for folder files primarily come from frontmatter or fallback to file system if needed (not implemented here)
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
    // 1. Always create a placeholder SIP for the PR itself
    const placeholderSipId = formatSipId(pr.number);
    let placeholderStatus: SipStatus;
    const prBodyLower = (pr.body || "").toLowerCase();
    const prTitleLower = (pr.title || "").toLowerCase();
    const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn");

    if (pr.state === 'closed') {
        if (pr.merged_at) {
            placeholderStatus = 'Accepted';
        } else if (mentionsWithdrawnText) {
            placeholderStatus = 'Withdrawn';
        } else {
            placeholderStatus = 'Closed (unmerged)';
        }
    } else { // pr.state === 'open'
        placeholderStatus = 'Draft (no file)';
    }
    
    const placeholderSip: SIP = {
      id: placeholderSipId,
      title: pr.title || `PR #${pr.number} Discussion`,
      status: placeholderStatus,
      summary: `No SIP file yet. Status from PR: ${placeholderStatus}`, // Updated summary
      body: undefined,
      prUrl: pr.html_url,
      source: 'pull_request_only',
      createdAt: pr.created_at, 
      updatedAt: pr.updated_at, 
      mergedAt: pr.merged_at || undefined, 
      author: pr.user?.login,
      prNumber: pr.number,
      filePath: undefined, 
    };
    sipsFromPRs.push(placeholderSip); // Add placeholder first
    console.log(`  PR #${pr.number} (${pr.title.substring(0,30)}...): Created placeholder SIP. ID: ${placeholderSip.id}, Status: ${placeholderSip.status}`);


    // 2. Process files within the PR
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    try {
      const filesInPr = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[]; // Cache PR files for 5 mins
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
        
        const isInSipsDir = filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/') && !filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');
        const isInWithdrawnSipsDir = filePathInPr.startsWith(SIPS_WITHDRAWN_PATH + '/') || filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');
        
        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) && 
                                   filePathInPr.endsWith('.md') && 
                                   !fileName.toLowerCase().includes('template');
        
        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);

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

            const parsedSipFromFile = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              prState: pr.state,
              createdAt: pr.created_at, 
              updatedAt: pr.updated_at, 
              mergedAt: pr.merged_at,   
              author: pr.user?.login,  
              defaultStatus: fileDefaultStatus,
              source: 'pull_request',
            });

            if (parsedSipFromFile) {
              sipsFromPRs.push(parsedSipFromFile); // Add file-based SIP
              console.log(`  PR #${pr.number}: Parsed SIP from file ${filePathInPr}. ID: ${parsedSipFromFile.id}, Status: ${parsedSipFromFile.status}`);
            }
          } catch (error) {
            console.error(`  PR #${pr.number}: Error processing file ${filePathInPr} content:`, error);
          }
        }
      }
    } catch (error) {
        console.error(`Error fetching/processing files for PR #${pr.number}:`, error);
    }
  }
  console.log(`Processed ${sipsFromPRs.length} total SIP entries (placeholders + file-based) from Pull Requests.`);
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

    const filePrInfoMap = new Map<string, {
        prUrl: string;
        author?: string;
        prNumber?: number;
        createdAt: string; 
        updatedAt?: string; 
        mergedAt?: string | null; 
    }>();

    // Populate filePrInfoMap with the most recent PR data for each file path
    // This map is used to enrich folder-based SIPs with PR context.
    for (const prSip of prSipsData) {
        if (prSip.filePath && prSip.source === 'pull_request' && (prSip.mergedAt || prSip.prNumber)) { 
            const existing = filePrInfoMap.get(prSip.filePath);
            const prDateToSortBy = prSip.mergedAt || prSip.updatedAt || prSip.createdAt;
            const existingDateToSortBy = existing ? (existing.mergedAt || existing.updatedAt || existing.createdAt) : null;

            if (!existing || (prDateToSortBy && existingDateToSortBy && new Date(prDateToSortBy) > new Date(existingDateToSortBy)) || (prDateToSortBy && !existingDateToSortBy)) {
                 filePrInfoMap.set(prSip.filePath, {
                    prUrl: prSip.prUrl,
                    author: prSip.author,
                    prNumber: prSip.prNumber,
                    createdAt: prSip.createdAt, 
                    updatedAt: prSip.updatedAt, 
                    mergedAt: prSip.mergedAt,    
                });
            }
        }
    }
    
    const enrichFolderSip = (folderSip: SIP, prInfo: ReturnType<typeof filePrInfoMap.get>): SIP => {
        if (!prInfo) return folderSip;
        const enriched: SIP = { ...folderSip };

        // Prioritize PR's metadata for these fields
        enriched.prUrl = prInfo.prUrl || enriched.prUrl;
        enriched.author = prInfo.author || enriched.author;
        enriched.prNumber = prInfo.prNumber || enriched.prNumber;
        enriched.createdAt = prInfo.createdAt || enriched.createdAt; 
        enriched.updatedAt = prInfo.updatedAt || enriched.updatedAt;
        enriched.mergedAt = prInfo.mergedAt || enriched.mergedAt; 

        // Change source if it was enriched from a PR context
        if (enriched.source === 'folder' && (prInfo.mergedAt || prInfo.prNumber)) {
            enriched.source = 'folder+pr';
        }
        return enriched;
    };

    const enrichedMainFolderSips = mainFolderSipsData.map(sip => {
        if (sip.filePath && filePrInfoMap.has(sip.filePath)) {
            return enrichFolderSip(sip, filePrInfoMap.get(sip.filePath)!);
        }
        return sip;
    });

    const enrichedWithdrawnFolderSips = withdrawnFolderSipsData.map(sip => {
        if (sip.filePath && filePrInfoMap.has(sip.filePath)) {
            const enriched = enrichFolderSip(sip, filePrInfoMap.get(sip.filePath)!);
            // Ensure withdrawn status and source are preserved for these
            enriched.status = 'Withdrawn';
            enriched.source = 'withdrawn_folder'; // Keep this authoritative
            return enriched;
        }
        return sip;
    });

    const combinedSipsMap = new Map<string, SIP>();
    
    // Order matters for precedence: Start with lowest precedence, end with highest.
    // Placeholders -> PR files -> Folder files -> Enriched folder files -> Withdrawn files
    const allProcessedSips = [
        ...prSipsData.filter(s => s.source === 'pull_request_only'), // Placeholders first
        ...prSipsData.filter(s => s.source === 'pull_request'),     // Then files from PRs
        ...mainFolderSipsData.filter(s => !enrichedMainFolderSips.find(es => es.id === s.id)), // Original folder SIPs not enriched
        ...enrichedMainFolderSips,                                  // Enriched main folder SIPs
        ...withdrawnFolderSipsData.filter(s => !enrichedWithdrawnFolderSips.find(es => es.id === s.id)), // Original withdrawn not enriched
        ...enrichedWithdrawnFolderSips,                             // Enriched withdrawn folder SIPs
    ];


    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0,
        'pull_request': 1,
        'folder': 2,
        'folder+pr': 3,
        'withdrawn_folder': 4, 
    };

    for (const currentSip of allProcessedSips) {
      if (!currentSip || !currentSip.id) {
        console.warn("Skipping SIP with no ID during final combination:", currentSip);
        continue;
      }
      const key = currentSip.id.toLowerCase();
      const existingSip = combinedSipsMap.get(key);

      if (!existingSip) {
        combinedSipsMap.set(key, currentSip);
      } else {
        const currentPrecedence = sourcePrecedenceValues[currentSip.source] ?? -1;
        const existingPrecedence = sourcePrecedenceValues[existingSip.source] ?? -1;

        let mergedSip = { ...currentSip }; // Start with current as base for potential merge

        if (currentSip.source === 'withdrawn_folder') {
            mergedSip = { ...existingSip, ...currentSip, status: 'Withdrawn', source: 'withdrawn_folder' };
        } else if (existingSip.source === 'withdrawn_folder') {
            mergedSip = { ...currentSip, ...existingSip, status: 'Withdrawn', source: 'withdrawn_folder' };
        } else if (currentPrecedence >= existingPrecedence) {
            // Current is higher or equal precedence (and not withdrawn case)
            mergedSip = { ...existingSip, ...currentSip };
            if(currentSip.source === 'folder+pr' && existingSip.source === 'folder'){
                 // ensure body from original folder sip is kept if folder+pr doesn't have one
                mergedSip.body = currentSip.body || existingSip.body;
                mergedSip.summary = currentSip.summary || existingSip.summary;
            }
        } else {
            // Existing is higher precedence (and not withdrawn case)
            mergedSip = { ...currentSip, ...existingSip };
             if(existingSip.source === 'folder+pr' && currentSip.source === 'folder'){
                mergedSip.body = existingSip.body || currentSip.body;
                mergedSip.summary = existingSip.summary || currentSip.summary;
            }
        }
        
        // Ensure essential fields from the higher precedence source are not lost
        if (currentPrecedence > existingPrecedence) {
            if (!mergedSip.body && existingSip.body && currentSip.source !== 'pull_request_only') mergedSip.body = existingSip.body;
            if (mergedSip.summary === `No SIP file yet. Status from PR: ${mergedSip.status}` && existingSip.summary && existingSip.summary !== `No SIP file yet. Status from PR: ${existingSip.status}`) {
                 mergedSip.summary = existingSip.summary;
            }
        } else if (existingPrecedence > currentPrecedence) {
            if (!mergedSip.body && currentSip.body && existingSip.source !== 'pull_request_only') mergedSip.body = currentSip.body;
             if (mergedSip.summary === `No SIP file yet. Status from PR: ${mergedSip.status}` && currentSip.summary && currentSip.summary !== `No SIP file yet. Status from PR: ${currentSip.status}`) {
                 mergedSip.summary = currentSip.summary;
            }
        }


        combinedSipsMap.set(key, mergedSip);
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

      const updatedA = a.updatedAt || a.createdAt; 
      const updatedB = b.updatedAt || b.createdAt; 
      
      const timeA = updatedA ? new Date(updatedA).getTime() : 0;
      const timeB = updatedB ? new Date(updatedB).getTime() : 0;

      if (timeA !== timeB) {
        return timeB - timeA; 
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

  if (!sipsToSearch || sipsToSearch.length === 0) { 
    console.log(`No SIPs available in cache or after fetch for getSipById(${id}).`);
    return null;
  }

  let normalizedIdInput = id.toLowerCase();
  // Allow lookup by pure number "8" or "008" -> "sip-008"
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?0*(\d+)$/);

  if (numericMatch && numericMatch[1]) {
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
  } else if (!normalizedIdInput.startsWith('sip-')) {
    // If it's not numeric and doesn't start with sip-, it might be a generic ID
    if (!normalizedIdInput.startsWith('sip-generic-')) { 
        normalizedIdInput = `sip-generic-${normalizedIdInput}`; // Or handle as error if generic IDs aren't expected for direct lookup
    }
  }
  
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

