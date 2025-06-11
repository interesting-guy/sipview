
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
  filename?: string; // This is the key for files in a PR list
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  raw_url?: string; // For files in PRs, this is the one to fetch content
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
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  merged_at: string | null; // ISO 8601 or null
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
  source: 'folder' | 'pull_request' | 'withdrawn_folder' | 'folder+pr';
  createdAt?: string; // From PR or frontmatter
  updatedAt?: string; // From PR or frontmatter
  mergedAt?: string | null; // From PR or frontmatter
  author?: string; // From PR or frontmatter
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
    let idSource = "unknown"; // For logging how ID was derived
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
    
    // For PR-sourced files, if no ID from file, try PR title then PR number
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
        // If it's a file from a folder (not PR) and still no numeric ID, use filename slug
        if (source === 'folder' || source === 'withdrawn_folder') {
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
            idSource = "generic fallback filename (folder)";
        } else if (source === 'pull_request' && optionPrNumber !== undefined) {
            // This case is for PR files that had no numeric ID in name/frontmatter/PRtitle, fallback to PR number
            id = formatSipId(optionPrNumber);
            idSource = `PR number (fallback for non-numeric filename in PR: ${fileName})`;
        } else {
            // Should be very rare.
            console.warn(`  [ID_WARN] Could not determine SIP ID for file: ${fileName}, path: ${filePath}, source: ${source}. Assigning generic based on filename.`);
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
            idSource = "ultimate generic fallback";
        }
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && source === 'pull_request' && optionPrTitle) {
      sipTitle = optionPrTitle;
    }
    if (!sipTitle) {
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal'}`;
    }

    // Defer to placeholder logic if a PR file has no self-identifying SIP ID or title
    const idIsPurelyFromPRMetadata = idSource === "PR number" || idSource.startsWith("PR number (fallback");
    const titleIsPurelyFromPRMetadata = !frontmatterTitle && !!optionPrTitle && source === 'pull_request';
    if (source === 'pull_request' && idIsPurelyFromPRMetadata && titleIsPurelyFromPRMetadata) {
        console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) will be skipped by parseSipFile as it lacks specific SIP ID/title in content. ID source: ${idSource}. Placeholder logic will handle PR #${optionPrNumber}.`);
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
        } else { // closed, unmerged
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
        if (source === 'pull_request' && !body && optionPrNumber) {
          aiSummary = `This SIP proposal is from PR #${optionPrNumber} which does not have a detailed markdown body yet. Title: ${sipTitle}`;
        }
    }
    
    let prUrlToUse = optionPrUrl; // Prioritize PR URL if this is from a PR context
    if (!prUrlToUse) { // Fallback if not from PR context or optionPrUrl somehow missing
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else {
            // This is a fallback for files read directly from folders if no PR info is available
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/blob/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }

    let createdAtISO: string;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request') {
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE;
        if (createdAtISO === FALLBACK_CREATED_AT_DATE && optionCreatedAt) {
             console.warn(`[TIMESTAMP_WARN_PR_FILE_INVALID_CREATED] Invalid createdAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. Input: ${optionCreatedAt}. Using fallback.`);
        } else if (createdAtISO === FALLBACK_CREATED_AT_DATE) {
             console.warn(`[TIMESTAMP_WARN_PR_FILE_MISSING_CREATED] Missing createdAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. Using fallback.`);
        }
        updatedAtISO = parseValidDate(optionUpdatedAt); 
    } else { // 'folder' or 'withdrawn_folder' (source can also be 'folder+pr' after enrichment)
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date) || FALLBACK_CREATED_AT_DATE;
      if (createdAtISO === FALLBACK_CREATED_AT_DATE && (frontmatter.created || frontmatter.date)) {
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE_INVALID_CREATED] Invalid createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Input: ${frontmatter.created || frontmatter.date}. Using fallback.`);
      } else if (createdAtISO === FALLBACK_CREATED_AT_DATE) {
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE_MISSING_CREATED] Missing createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Using fallback.`);
      }
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    let mergedAtVal: string | undefined;
    // Prioritize PR's merged_at if available (passed via options)
    if (optionMergedAt !== undefined) { // optionMergedAt can be null (valid) or string
        mergedAtVal = parseValidDate(optionMergedAt);
    } else { // Fallback to frontmatter if not PR-sourced or PR didn't provide mergedAt
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
          // For folder SIPs, PR details are initially unknown, might be enriched later
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
    let foundSipFileInPr = false; // Reset for each PR
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`; // Get files for this PR

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
      const filesInPr = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[]; // Cache PR files less aggressively
      for (const file of filesInPr) {
        const filePathInPr = file.filename; // 'filename' is the full path in this context
        if (!filePathInPr) {
            console.log(`  PR #${pr.number}, File SHA ${file.sha}: Skipping file with no path: ${JSON.stringify(file)}`);
            continue;
        }

        const fileName = filePathInPr.split('/').pop();
        if (!fileName) {
            console.log(`  PR #${pr.number}, File SHA ${file.sha}: Skipping file with no name from path: ${filePathInPr}`);
            continue;
        }
        
        // Check if the file is a relevant markdown file in sips/ or withdrawn-sips/
        const isInSipsDir = filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/') && !filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/'); // Exclude double-counting if withdrawn is nested
        const isInWithdrawnSipsDir = filePathInPr.startsWith(SIPS_WITHDRAWN_PATH + '/') || filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');
        
        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) && 
                                   filePathInPr.endsWith('.md') && 
                                   !fileName.toLowerCase().includes('template');
        
        // Consider files that are added, modified, or renamed
        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);


        if (isRelevantChange && isCandidateSipFile && file.raw_url) {
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            
            let fileDefaultStatus: SipStatus = 'Draft'; // Default for files in PRs
            if (isInWithdrawnSipsDir) {
                fileDefaultStatus = 'Withdrawn';
            } else if (pr.merged_at) {
                fileDefaultStatus = 'Accepted'; // If PR is merged, the file is likely accepted
            } else if (pr.state === 'closed') {
                fileDefaultStatus = 'Closed (unmerged)'; // If PR closed but not merged
            }

            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              ...prOptionsBase,
              defaultStatus: fileDefaultStatus,
              source: 'pull_request', // Source for files found in PRs
            });

            if (parsedSip) {
              sipsFromPRs.push(parsedSip);
              foundSipFileInPr = true; // Mark that we found and processed a SIP file from this PR
              console.log(`  PR #${pr.number}: Parsed SIP from file ${filePathInPr}. ID: ${parsedSip.id}, Title: "${parsedSip.title}", Status: ${parsedSip.status}`);
            }
          } catch (error) {
            // Log error for this specific file and continue with other files in the PR
            console.error(`  PR #${pr.number}: Error processing file ${filePathInPr} content:`, error);
          }
        }
      }
    } catch (error) {
        // Log error for fetching files of this PR and continue with the next PR
        console.error(`Error fetching/processing files for PR #${pr.number}:`, error);
    }

    // If no SIP file was found and processed from this PR, create a placeholder
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
                // If a PR was merged but we didn't find a file, it implies the *discussion* was accepted.
                placeholderStatus = 'Accepted'; 
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
    // Fetch all data sources concurrently
    const [mainFolderSipsData, withdrawnFolderSipsData, prSipsData] = await Promise.all([
      fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder'),
      fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder'),
      fetchSipsFromPullRequests(),
    ]);

    // Create a map of file paths to their most relevant PR metadata.
    // This map helps enrich folder-based SIPs with details from the PR that likely introduced/modified them.
    const filePrInfoMap = new Map<string, {
        prUrl: string;
        author?: string;
        prNumber?: number;
        createdAt: string; 
        updatedAt: string; 
        mergedAt?: string | null; // Can be null
    }>();

    // Populate filePrInfoMap from all PRs that modified a file.
    // If multiple PRs touched the same file, the one with the latest 'updatedAt' (or 'mergedAt' if more recent) will win.
    for (const prSip of prSipsData) {
        if (prSip.filePath && prSip.source === 'pull_request') { // Only from 'pull_request' source, not 'pull_request_only'
            const prDateToSortBy = prSip.mergedAt || prSip.updatedAt || prSip.createdAt;
            const existing = filePrInfoMap.get(prSip.filePath);
            const existingDateToSortBy = existing ? (existing.mergedAt || existing.updatedAt || existing.createdAt) : null;

            if (!existing || new Date(prDateToSortBy) > new Date(existingDateToSortBy!)) {
                 filePrInfoMap.set(prSip.filePath, {
                    prUrl: prSip.prUrl,
                    author: prSip.author,
                    prNumber: prSip.prNumber,
                    createdAt: prSip.createdAt, // PR's creation
                    updatedAt: prSip.updatedAt || prSip.createdAt, // PR's update
                    mergedAt: prSip.mergedAt,    // PR's merge (can be null)
                });
            }
        }
    }
    
    // Enrich folder SIPs with PR information
    const enrichFolderSip = (folderSip: SIP, prInfo: typeof filePrInfoMap extends Map<string, infer V> ? V : never): SIP => {
        const enriched: SIP = { ...folderSip }; // Start with folder data (title, body, frontmatter status)

        // Always overwrite with PR's lifecycle timestamps and URL details
        enriched.prUrl = prInfo.prUrl;
        enriched.createdAt = prInfo.createdAt;
        enriched.updatedAt = prInfo.updatedAt;
        enriched.mergedAt = prInfo.mergedAt; // This will be null if PR not merged / info not available

        // Fill in author/prNumber if missing from frontmatter
        enriched.author = folderSip.author || prInfo.author;
        enriched.prNumber = folderSip.prNumber || prInfo.prNumber;
        
        // Update source if it was a 'folder' SIP
        if (enriched.source === 'folder') {
            enriched.source = 'folder+pr';
        }
        // If 'withdrawn_folder', its status 'Withdrawn' is authoritative, but timestamps/PR details are updated.
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
            return enrichFolderSip(sip, filePrInfoMap.get(sip.filePath)!);
        }
        return sip;
    });

    // Combine all SIPs, using a map to handle deduplication by ID
    const combinedSipsMap = new Map<string, SIP>();
    
    const allProcessedSips = [
        ...prSipsData, // Contains placeholders and files parsed directly from PRs
        ...enrichedMainFolderSips,
        ...enrichedWithdrawnFolderSips,
    ];

    // Precedence order for merging if IDs collide. Higher value wins.
    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0,
        'pull_request': 1,
        'folder': 2,
        'folder+pr': 3,
        'withdrawn_folder': 4, // Highest, especially for 'Withdrawn' status
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
        const currentPrecedence = sourcePrecedenceValues[currentSip.source];
        const existingPrecedence = sourcePrecedenceValues[existingSip.source];

        if (currentPrecedence >= existingPrecedence) {
            let mergedSip = { ...currentSip }; // Start with current as base

            // If existingSip was 'withdrawn_folder', its 'Withdrawn' status must be preserved
            if (existingSip.source === 'withdrawn_folder' && currentSip.source !== 'withdrawn_folder') {
                // Current SIP is trying to overwrite a withdrawn SIP with a non-withdrawn source
                // We keep the 'Withdrawn' status and other core fields of existing, but update with current's details if better
                mergedSip = {
                    ...currentSip, // Take most fields from current
                    id: existingSip.id, // Ensure ID consistency
                    status: 'Withdrawn', // Preserve withdrawn status
                    source: 'withdrawn_folder', // Preserve withdrawn source
                    body: existingSip.body || currentSip.body, // Prefer existing body if current has none
                    summary: existingSip.summary || currentSip.summary,
                };
            } else if (currentSip.source === 'withdrawn_folder') {
                 mergedSip.status = 'Withdrawn'; // Ensure current sets status if it's withdrawn source
            }
            // For other fields like body, summary, if currentSip has higher/equal precedence but lacks these,
            // prefer existingSip's if available.
            if (!mergedSip.body && existingSip.body) mergedSip.body = existingSip.body;
            if (!mergedSip.summary && existingSip.summary) mergedSip.summary = existingSip.summary;
            
            combinedSipsMap.set(key, mergedSip);
        }
        // If currentSip has lower precedence, existingSip is kept.
      }
    }

    let sips = Array.from(combinedSipsMap.values());

    // Final sort order
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

      const updatedA = a.updatedAt || a.createdAt; // Use createdAt if updatedAt is missing
      const updatedB = b.updatedAt || b.createdAt; // Use createdAt if updatedAt is missing
      if (new Date(updatedA).getTime() !== new Date(updatedB).getTime()) {
        return new Date(updatedB).getTime() - new Date(updatedA).getTime(); 
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
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?(\d+)$/);
  if (numericMatch && numericMatch[1]) {
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
  } else if (!normalizedIdInput.startsWith('sip-')) {
    if (!normalizedIdInput.startsWith('sip-generic-')) { // Allow "sip-generic-..." through
        normalizedIdInput = `sip-${normalizedIdInput}`;
    }
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

    