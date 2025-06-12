
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus, AiSummary } from '@/types/sip';
import { summarizeSipContentStructured } from '@/ai/flows/summarize-sip-flow';

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
const INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD = "This proposal does not contain enough information to summarize.";
const INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE = "Insufficient information to summarize this aspect."; // Used by AI for individual points
const USER_REQUESTED_FALLBACK_AI_SUMMARY: AiSummary = { // Used if AI fails or input is globally insufficient
  whatItIs: "No summary available yet.",
  whatItChanges: "-",
  whyItMatters: "-",
};


interface GitHubFile {
  name: string;
  path: string;
  filename?: string; // This seems to be the same as `path` from listFiles, but `name` from contents API.
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  raw_url?: string; // Specific to files from PRs file list
  type: 'file' | 'dir';
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'; // From PR files
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
  createdAt?: string; // Should be from PR if source is 'pull_request'
  updatedAt?: string; // Should be from PR if source is 'pull_request'
  mergedAt?: string | null; // Should be from PR if source is 'pull_request'
  author?: string; // Should be from PR if source is 'pull_request'
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
    
    if (source === 'pull_request' && !sipNumberStr && !frontmatterTitle && optionPrNumber !== undefined && optionPrTitle) {
        // This rule: if a file in a PR doesn't have its own SIP ID (from filename or frontmatter)
        // AND doesn't have its own title in frontmatter, then it's likely a generic MD file.
        // We defer to the placeholder logic for the PR itself.
        console.log(`  [DEFER_TO_PLACEHOLDER_LOGIC] PR file (path: ${filePath}, name: ${fileName}) likely generic. No specific SIP ID/title in file. Associated PR title: "${optionPrTitle}", PR num: ${optionPrNumber}. Placeholder logic for PR #${optionPrNumber} should handle this.`);
        return null;
    }


    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
    } else {
        if (source === 'folder' || source === 'withdrawn_folder') {
             // For files directly from main/withdrawn folders, if no number, make a generic ID.
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
            idSource = "generic fallback filename (folder)";
        } else {
             // For PR files, if no number could be derived after all checks, it means it's not a primary SIP file.
             console.warn(`  [ID_WARN_NULL_RETURN_PR_FILE] Could not determine numeric SIP ID for PR file: ${fileName}, path: ${filePath}, source: ${source}. PR title: "${optionPrTitle}", PR num: ${optionPrNumber}. File will be skipped by parseSipFile.`);
             return null;
        }
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && (source === 'pull_request') && optionPrTitle) {
      sipTitle = optionPrTitle; // Title from PR if not in file's frontmatter
    }
    if (!sipTitle) { // Fallback title if still none
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal Document'}`;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    let resolvedStatus: SipStatus = defaultStatus;

    if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter;
    } else if (source === 'pull_request') { // If from PR and no frontmatter status, derive from PR state
        if (optionMergedAt) {
            resolvedStatus = 'Accepted';
        } else if (optionPrState === 'open') {
            resolvedStatus = 'Draft';
        } else { // PR is closed but not merged
            resolvedStatus = 'Closed (unmerged)'; // Default for closed, non-merged, non-status PR files
        }
    }
    // If source is 'folder', defaultStatus (e.g. 'Final' or 'Withdrawn') remains unless overridden by frontmatter.

    const abstractOrDescriptionFM = frontmatter.abstract || frontmatter.description;
    let textualSummary: string; // This is the general summary field.

    // AI Summary Generation
    const hasSufficientBody = body && body.trim().length > 10;
    const hasSufficientAbstractFM = abstractOrDescriptionFM && abstractOrDescriptionFM.trim().length > 10;

    let aiInputSipBody: string | undefined = hasSufficientBody ? body : undefined;
    let aiInputAbstractOrDescription: string | undefined = hasSufficientAbstractFM ? abstractOrDescriptionFM : undefined;

    if (!aiInputSipBody && !aiInputAbstractOrDescription && sipTitle && sipTitle.trim().length > 5 && !sipTitle.startsWith("SIP ")) {
        // Use title as a last resort for AI input if other content is lacking and title seems descriptive
        aiInputAbstractOrDescription = sipTitle;
    }
    
    const generatedAiSummary: AiSummary = await summarizeSipContentStructured({
        sipBody: aiInputSipBody,
        abstractOrDescription: aiInputAbstractOrDescription,
    });


    // Determine fallback textualSummary (for metadata, etc.)
    if (frontmatter.summary) { // Highest priority for textual summary
        textualSummary = String(frontmatter.summary);
    } else if (abstractOrDescriptionFM) {
        textualSummary = abstractOrDescriptionFM.substring(0, 200) + (abstractOrDescriptionFM.length > 200 ? "..." : "");
    } else if (body) {
        textualSummary = body.substring(0, 120).split('\n')[0] + "...";
    } else if (sipTitle && !sipTitle.startsWith("SIP ")) { // Use title if it seems descriptive and no other source
        textualSummary = sipTitle;
    } else {
        textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD;
    }


    let prUrlToUse = optionPrUrl; // PR URL is passed if from PR
    if (!prUrlToUse) { // If not from PR or PR URL was not available, check frontmatter
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else {
            // Fallback to file path URL if no PR link found (typical for folder-sourced SIPs initially)
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/blob/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }

    let createdAtISO: string;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request') {
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE;
        if (createdAtISO === FALLBACK_CREATED_AT_DATE && optionCreatedAt) {
             console.warn(`[TIMESTAMP_WARN_PR_FILE_INVALID_CREATED] Invalid createdAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. Input: ${optionCreatedAt}. Using fallback.`);
        }
        updatedAtISO = parseValidDate(optionUpdatedAt); // Will be undefined if optionUpdatedAt is invalid/missing
    } else { // 'folder' or 'withdrawn_folder'
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date) || FALLBACK_CREATED_AT_DATE;
      if (createdAtISO === FALLBACK_CREATED_AT_DATE && (frontmatter.created || frontmatter.date)) {
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE_INVALID_CREATED] Invalid createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Input: ${frontmatter.created || frontmatter.date}. Using fallback.`);
      } else if (createdAtISO === FALLBACK_CREATED_AT_DATE && source !== 'pull_request') {
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE_MISSING_CREATED] Missing createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Using fallback.`);
      }
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    let mergedAtVal: string | undefined;
    if (source === 'pull_request' && optionMergedAt !== undefined) { // optionMergedAt can be null
        mergedAtVal = optionMergedAt === null ? undefined : parseValidDate(optionMergedAt);
    } else { // For folder sources or if PR didn't provide mergedAt
        mergedAtVal = frontmatter.merged ? parseValidDate(frontmatter.merged) : undefined;
    }

    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined) || (Array.isArray(frontmatter.authors) ? frontmatter.authors.join(', ') : undefined);
    const prNumberFromFrontmatter = typeof frontmatter.pr === 'number' ? frontmatter.pr : undefined;

    return {
      id,
      title: sipTitle,
      status: resolvedStatus,
      summary: textualSummary, // General summary
      aiSummary: generatedAiSummary, // Structured AI summary (now non-optional)
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
          // Timestamps for folder SIPs initially come from frontmatter or fallbacks in parseSipFile
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
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=100`; // Consider pagination for >100 PRs
  let allPRs: GitHubPullRequest[];
  try {
    allPRs = await fetchFromGitHubAPI(allPRsUrl);
  } catch (error) {
    console.error("Failed to fetch pull requests:", error);
    return [];
  }

  const sipsFromPRs: SIP[] = [];

  for (const pr of allPRs) {
    let foundSipFileInPr = false; // Flag to track if a valid SIP .md file was parsed from this PR

    // 1. Always create a placeholder SIP for the PR itself.
    const placeholderSipId = formatSipId(pr.number);
    let placeholderStatus: SipStatus;
    const prBodyLower = (pr.body || "").toLowerCase();
    const prTitleLower = (pr.title || "").toLowerCase();
    const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn");

    if (pr.state === 'closed') {
        if (pr.merged_at) {
            placeholderStatus = 'Accepted'; // PR itself was accepted/merged
        } else if (mentionsWithdrawnText) {
            placeholderStatus = 'Withdrawn';
        } else {
            placeholderStatus = 'Closed (unmerged)';
        }
    } else { // 'open'
        placeholderStatus = 'Draft (no file)';
    }

    const placeholderSummaryText = `Proposal discussion via Pull Request #${pr.number}. Status: ${placeholderStatus}.`;
    const placeholderAiSummaryForPrOnly: AiSummary = {
        whatItIs: `Proposal discussion via Pull Request #${pr.number}.`,
        whatItChanges: `Refer to the PR for details on proposed changes. Current PR status: ${placeholderStatus}.`,
        whyItMatters: "This tracks a proposal idea or change suggestion made via a Pull Request.",
    };

    const placeholderSip: SIP = {
      id: placeholderSipId,
      title: pr.title || `PR #${pr.number} Discussion`,
      status: placeholderStatus,
      summary: placeholderSummaryText,
      aiSummary: placeholderAiSummaryForPrOnly,
      body: pr.body || undefined, // Use PR body as body for placeholder if available
      prUrl: pr.html_url,
      source: 'pull_request_only', // Explicitly mark as PR-metadata-only
      createdAt: pr.created_at, // Directly use PR's timestamp
      updatedAt: pr.updated_at, // Directly use PR's timestamp
      mergedAt: pr.merged_at || undefined, // Use PR's merged_at, or undefined if null
      author: pr.user?.login,
      prNumber: pr.number,
      filePath: undefined, // No specific file for this placeholder entry
    };
    sipsFromPRs.push(placeholderSip);
    console.log(`  PR #${pr.number} ("${(pr.title || '').substring(0,30)}..."): Created placeholder SIP. ID: ${placeholderSip.id}, Status: ${placeholderSip.status}`);


    // 2. Process files within the PR to find actual SIP documents.
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    try {
      const filesInPr = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[];
      for (const file of filesInPr) {
        const filePathInPr = file.filename; // 'filename' from PR files API is the full path
        if (!filePathInPr) {
            console.log(`  PR #${pr.number}, File SHA ${file.sha}: Skipping file with no path: ${JSON.stringify(file)}`);
            continue;
        }

        const fileName = filePathInPr.split('/').pop();
        if (!fileName) {
            console.log(`  PR #${pr.number}, File SHA ${file.sha}: Skipping file with no name from path: ${filePathInPr}`);
            continue;
        }

        // Check if file is in '/sips/' or '/withdrawn-sips/' (top-level or nested under 'sips/' for withdrawn)
        const isInSipsDir = filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/') && !filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');
        const isInWithdrawnSipsDir = filePathInPr.startsWith(SIPS_WITHDRAWN_PATH + '/') || filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');


        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) &&
                                   filePathInPr.endsWith('.md') &&
                                   !fileName.toLowerCase().includes('template');

        // Only consider files that were 'added', 'modified', 'renamed', 'copied', 'changed'
        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);

        if (isRelevantChange && isCandidateSipFile && file.raw_url) {
          try {
            const rawContent = await fetchRawContent(file.raw_url);

            let fileDefaultStatus: SipStatus = 'Draft'; // Default for a new file in a PR
            if (isInWithdrawnSipsDir) { // If file is in withdrawn path
                fileDefaultStatus = 'Withdrawn';
            } else if (pr.merged_at) { // If PR is merged and file is in main sips path
                fileDefaultStatus = 'Accepted';
            } else if (pr.state === 'closed') { // PR closed, not merged
                fileDefaultStatus = 'Closed (unmerged)';
            }
            // If PR is 'open', defaultStatus remains 'Draft'

            const parsedSipFromFile = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              prState: pr.state,
              createdAt: pr.created_at, // Pass PR's creation time for context
              updatedAt: pr.updated_at, // Pass PR's update time for context
              mergedAt: pr.merged_at,   // Pass PR's merge time for context
              author: pr.user?.login,   // Pass PR's author
              defaultStatus: fileDefaultStatus,
              source: 'pull_request', // This is a SIP parsed from a file within a PR
            });

            if (parsedSipFromFile) {
              sipsFromPRs.push(parsedSipFromFile);
              foundSipFileInPr = true; // Mark that this PR yielded at least one file-based SIP
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

    // Map to store the latest PR info for each file path that was part of a merged PR
    const mergedFilePrInfoMap = new Map<string, {
        prUrl: string;
        author?: string;
        prNumber?: number;
        createdAt: string; // PR creation
        updatedAt?: string; // PR update
        mergedAt: string;    // PR merge (must exist for this map)
    }>();

    for (const prSip of prSipsData) {
        // Only consider file-based SIPs from PRs that were merged
        if (prSip.source === 'pull_request' && prSip.filePath && prSip.mergedAt && prSip.prNumber) {
            const existing = mergedFilePrInfoMap.get(prSip.filePath);
            // If multiple PRs modified the same file and were merged,
            // prioritize the one with the latest merge date.
            if (!existing || new Date(prSip.mergedAt) > new Date(existing.mergedAt)) {
                 mergedFilePrInfoMap.set(prSip.filePath, {
                    prUrl: prSip.prUrl,
                    author: prSip.author,
                    prNumber: prSip.prNumber,
                    createdAt: prSip.createdAt, // Use the PR's createdAt for the file's origin
                    updatedAt: prSip.updatedAt, // Use the PR's updatedAt
                    mergedAt: prSip.mergedAt,   // This is the PR's merge date
                });
            }
        }
    }

    // Enrich folder SIPs with info from their merging PRs
    const enrichFolderSip = (folderSip: SIP, prInfo: ReturnType<typeof mergedFilePrInfoMap.get>): SIP => {
        if (!prInfo) return folderSip;
        const enriched: SIP = { ...folderSip }; // Start with folder data

        // Overwrite with PR data if more specific or authoritative
        enriched.prUrl = prInfo.prUrl || enriched.prUrl;
        enriched.author = prInfo.author || enriched.author;
        enriched.prNumber = prInfo.prNumber || enriched.prNumber;
        
        // Crucially, update timestamps from the PR that merged this file
        enriched.createdAt = prInfo.createdAt; // File's creation is effectively the PR's creation
        enriched.updatedAt = prInfo.updatedAt; // Last update related to this file via PR
        enriched.mergedAt = prInfo.mergedAt;   // This is the key mergedAt timestamp

        enriched.source = 'folder+pr'; // Mark as enriched
        return enriched;
    };

    const enrichedMainFolderSips = mainFolderSipsData.map(sip => {
        if (sip.filePath && mergedFilePrInfoMap.has(sip.filePath)) {
            return enrichFolderSip(sip, mergedFilePrInfoMap.get(sip.filePath)!);
        }
        return sip;
    });

    const enrichedWithdrawnFolderSips = withdrawnFolderSipsData.map(sip => {
        if (sip.filePath && mergedFilePrInfoMap.has(sip.filePath)) {
            const enriched = enrichFolderSip(sip, mergedFilePrInfoMap.get(sip.filePath)!);
            enriched.status = 'Withdrawn'; // Ensure status is correct
            enriched.source = 'withdrawn_folder'; // Keep original source authority for withdrawn status
            return enriched;
        }
        if (sip.status !== 'Withdrawn') sip.status = 'Withdrawn'; // Ensure withdrawn status
        return sip;
    });


    const combinedSipsMap = new Map<string, SIP>();
    // Precedence: withdrawn_folder > folder+pr > folder > pull_request > pull_request_only
    // Lower number = lower precedence (will be overridden by higher)
    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0,
        'pull_request': 1,
        'folder': 2,
        'folder+pr': 3,
        'withdrawn_folder': 4,
    };

    const allProcessedSips = [
        ...prSipsData, // Includes placeholders and file-based SIPs from PRs
        ...enrichedMainFolderSips,
        ...enrichedWithdrawnFolderSips,
    ];


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

        let sipToKeep: SIP;

        if (currentPrecedence >= existingPrecedence) {
            // Current SIP has higher or equal precedence, merge its data into existing
            sipToKeep = { ...existingSip, ...currentSip };

            // Specific merge logic for aiSummary and body: prefer more complete versions
            if (currentSip.aiSummary && currentSip.aiSummary.whatItIs !== USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs &&
                (!existingSip.aiSummary || existingSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs ||
                 existingSip.aiSummary.whatItIs === INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE)) {
                sipToKeep.aiSummary = currentSip.aiSummary;
            }
            if (currentSip.body && (!existingSip.body || existingSip.source === 'pull_request_only')) {
                sipToKeep.body = currentSip.body;
            }
        } else {
            // Existing SIP has higher precedence, merge current SIP's data into it
            sipToKeep = { ...currentSip, ...existingSip };

            if (existingSip.aiSummary && existingSip.aiSummary.whatItIs !== USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs &&
                (!currentSip.aiSummary || currentSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs ||
                 currentSip.aiSummary.whatItIs === INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE)) {
                sipToKeep.aiSummary = existingSip.aiSummary;
            }
            if (existingSip.body && (!currentSip.body || currentSip.source === 'pull_request_only')) {
                sipToKeep.body = existingSip.body;
            }
        }
        
        // Ensure authoritative status for withdrawn_folder
        if (sipToKeep.source === 'withdrawn_folder') {
            sipToKeep.status = 'Withdrawn';
        } else if (existingSip.source === 'withdrawn_folder' && currentSip.source !== 'withdrawn_folder') {
            // If existing was withdrawn, but current is not, and current would overwrite, force withdrawn
            sipToKeep.status = 'Withdrawn';
            sipToKeep.source = 'withdrawn_folder';
        }


        combinedSipsMap.set(key, sipToKeep);
      }
    }

    let sips = Array.from(combinedSipsMap.values());

    // Final sort
    sips.sort((a, b) => {
      const numA = parseInt(a.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA; // Sort by ID descending
      } else if (!isNaN(numA)) {
        return -1; // Numeric IDs first
      } else if (!isNaN(numB)) {
        return 1;
      }

      // Fallback sort by status, then update date, then ID string
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
        return timeB - timeA; // Sort by date descending
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
  // Try to match sip-001, sip-1, 001, 1
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?0*(\d+)$/);

  if (numericMatch && numericMatch[1]) {
    // If it's purely numeric or sip-numeric, format it consistently
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
  } else if (!normalizedIdInput.startsWith('sip-')) {
    // If it's some other string and doesn't start with sip-, it might be a generic ID
    if (!normalizedIdInput.startsWith('sip-generic-')) { // Avoid double prefixing
        normalizedIdInput = `sip-generic-${normalizedIdInput}`;
    }
  }
  // If it already starts with sip- or sip-generic-, use as is (already lowercased)

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

