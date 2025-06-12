
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus, AiSummary, Comment } from '@/types/sip';
import { summarizeSipContentStructured } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips';
const SIPS_WITHDRAWN_PATH = 'withdrawn-sips';
const SIPS_REPO_BRANCH = 'main';
const GITHUB_API_TIMEOUT = 15000; // 15 seconds

let sipsCache: SIP[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const FALLBACK_CREATED_AT_DATE = '1970-01-01T00:00:00.000Z';
const INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD = "This proposal does not contain enough information to summarize.";

const USER_REQUESTED_FALLBACK_AI_SUMMARY: AiSummary = {
  whatItIs: "No summary available yet.",
  whatItChanges: "-",
  whyItMatters: "-",
};

const PLACEHOLDER_AI_SUMMARY_FOR_PR_ONLY: (prNumber: number, prTitle: string, status: SipStatus) => AiSummary = (prNumber, prTitle, status) => ({
    whatItIs: `This tracks Pull Request #${prNumber} ("${prTitle}"), currently in '${status}' state.`,
    whatItChanges: "Details about the specific changes are in the pull request discussion and files.",
    whyItMatters: "Tracking proposals directly from pull requests allows early visibility into potential ecosystem changes.",
});


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
    avatar_url: string;
    html_url: string;
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

interface GitHubIssueComment {
  id: number;
  user: GitHubUser | null;
  body: string;
  created_at: string;
  html_url: string;
}

interface GitHubReviewComment {
  id: number;
  user: GitHubUser | null;
  body: string;
  created_at: string;
  html_url: string;
  path: string;
  diff_hunk: string;
  original_commit_id: string;
}


async function fetchFromGitHubAPI(url: string, revalidateTime: number = 300): Promise<any> {
  const headers: HeadersInit = {
    'Accept': 'application/vnd.github.v3+json',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    console.warn(`GitHub API request to ${url} is UNAUTHENTICATED. GITHUB_TOKEN not found. Rate limits will be lower.`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT);

  try {
    const response = await fetch(url, { headers, next: { revalidate: revalidateTime }, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorBody = 'Could not read error body';
      try {
        errorBody = await response.text();
      } catch (e) {
        // ignore if can't read body
      }
      const MAX_BODY_LOG_LENGTH = 500;
      const truncatedErrorBody = errorBody.length > MAX_BODY_LOG_LENGTH ? errorBody.substring(0, MAX_BODY_LOG_LENGTH) + "..." : errorBody;
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      const rateLimitReset = response.headers.get('x-ratelimit-reset');
      console.error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}. RL-Remaining: ${rateLimitRemaining}, RL-Reset: ${rateLimitReset}. Body: ${truncatedErrorBody}`);
      throw new Error(`GitHub API request failed for ${url}: ${response.status} ${response.statusText} (RL-Remaining: ${rateLimitRemaining})`);
    }
    return response.json();
  } catch (error: any) {
    clearTimeout(timeoutId);
    const errorMessage = `Error during fetch or JSON parsing for GitHub API URL ${url}. Original error: ${error?.message || String(error)}`;
    console.error(errorMessage, error); 
    if (error.name === 'AbortError') {
      throw new Error(`GitHub API request timed out for ${url}.`);
    }
    throw new Error(errorMessage);
  }
}

async function fetchRawContent(url: string): Promise<string> {
  const headers: HeadersInit = {};
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    console.warn(`Raw content fetch from ${url} is UNAUTHENTICATED. GITHUB_TOKEN not found. Rate limits will be lower.`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT);

  try {
    const response = await fetch(url, { headers, next: { revalidate: 300 }, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch raw content: ${response.status} ${response.statusText} for ${url}`);
    }
    return response.text();
  } catch (error: any) {
    clearTimeout(timeoutId);
    const errorMessage = `Error fetching raw content from URL ${url}. Original error: ${error?.message || String(error)}`;
    console.error(errorMessage, error);
    if (error.name === 'AbortError') {
      throw new Error(`Raw content fetch timed out for ${url}.`);
    }
    throw new Error(errorMessage);
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
        d = undefined;
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
  prBody?: string | null;
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const {
    fileName, filePath, prUrl: optionPrUrl, prTitle: optionPrTitle, prNumber: optionPrNumber,
    prState: optionPrState, defaultStatus, source,
    createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt,
    author: optionAuthor, prBody: optionPrBody
  } = options;

  try {
    const { data: frontmatter, content: body } = matter(content);

    let sipNumberStr: string | null = null;
    const frontmatterTitle = frontmatter.title || frontmatter.name;

    const fmSipField = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    if (fmSipField !== undefined && String(fmSipField).match(/^\d+$/)) {
      sipNumberStr = String(fmSipField);
    }

    if (!sipNumberStr) {
      const fileNameNumMatch = fileName.match(/^(?:sip-)?(\d+)(?:[.\-_].*|\.md$)/i);
      if (fileNameNumMatch && fileNameNumMatch[1]) {
        sipNumberStr = fileNameNumMatch[1];
      } else {
        const fileNameDirectNumMatch = fileName.match(/^(\d+)(?:[.\-_].*|\.md$)/i);
        if (fileNameDirectNumMatch && fileNameDirectNumMatch[1]) {
            sipNumberStr = fileNameDirectNumMatch[1];
        }
      }
    }

    if (!sipNumberStr && (source === 'pull_request') && optionPrTitle) {
      const numFromTitle = extractSipNumberFromPrTitle(optionPrTitle);
      if (numFromTitle) {
        sipNumberStr = numFromTitle;
      }
    }

    if (source === 'pull_request' && !sipNumberStr && !frontmatterTitle && optionPrNumber !== undefined && optionPrTitle) {
      // This case implies a PR that doesn't define a new SIP file numerology and doesn't have a title in the file's frontmatter
      // It's likely just modifying an existing SIP or is a generic PR. We handle PR-only placeholders separately.
      // If this file parse is *for* a placeholder, that logic is upstream. Here, a file without ID means it's not a distinct SIP by itself.
      return null;
    }

    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
    } else {
        // If no sipNumberStr, this file might not be a proper SIP (e.g. README in a SIP folder, or an unrelated MD file)
        // However, if source is folder, we might want to assign a generic ID based on filename.
        if (source === 'folder' || source === 'withdrawn_folder') {
            // Create a generic ID for files that don't specify one but are in SIP directories
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
        } else {
             // For 'pull_request' source, if no ID can be derived, this file isn't treated as a standalone SIP here.
             // The PR itself might be a placeholder SIP.
             return null;
        }
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && (source === 'pull_request') && optionPrTitle) {
      sipTitle = optionPrTitle; // Use PR title if file title is missing and it's from a PR context
    }
    if (!sipTitle) {
        // Fallback title if absolutely nothing else is available
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal Document'}`;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    let resolvedStatus: SipStatus = defaultStatus;

    if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter;
    } else if (source === 'pull_request') { // If status is not in frontmatter and it's from a PR
        if (optionMergedAt) {
            resolvedStatus = 'Accepted'; // Or 'Final'/'Live' if we can determine
        } else if (optionPrState === 'open') {
            resolvedStatus = 'Draft';
        } else {
            resolvedStatus = 'Closed (unmerged)'; // Default for closed, non-merged PRs
        }
    }
    // If from 'folder' or 'withdrawn_folder', defaultStatus already applies if not in frontmatter.


    const abstractOrDescriptionFM = frontmatter.abstract || frontmatter.description;
    let textualSummary: string;

    // Prepare inputs for AI summary
    const hasSufficientBody = body && body.trim().length > 10;
    const hasSufficientAbstractFM = abstractOrDescriptionFM && abstractOrDescriptionFM.trim().length > 10;

    let aiInputSipBody: string | undefined = hasSufficientBody ? body : undefined;
    let aiInputAbstractOrDescription: string | undefined = hasSufficientAbstractFM ? abstractOrDescriptionFM : undefined;

    // Fallback for AI input if primary sources are weak
    if (!aiInputSipBody && !aiInputAbstractOrDescription) {
      if (source === 'pull_request' && optionPrTitle) {
        // For PRs, use PR title/body if file content is minimal
        aiInputAbstractOrDescription = optionPrTitle; // PR title can serve as abstract
        aiInputSipBody = optionPrBody || undefined; // PR body as main content
      } else if (sipTitle && sipTitle.trim().length > 5 && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #") && !sipTitle.endsWith("Proposal Document")) {
          // If it's not a PR, but has a meaningful title (not generic)
          aiInputAbstractOrDescription = sipTitle;
      }
    }
    
    const generatedAiSummary: AiSummary = await summarizeSipContentStructured({
        sipBody: aiInputSipBody,
        abstractOrDescription: aiInputAbstractOrDescription,
    });

    // Determine the textual summary (sip.summary field)
    if (frontmatter.summary && String(frontmatter.summary).trim() !== "") {
        textualSummary = String(frontmatter.summary);
    } else if (generatedAiSummary && generatedAiSummary.whatItIs !== USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs && generatedAiSummary.whatItIs !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
        // Construct summary from AI points if it's not a fallback and not "insufficient"
        textualSummary = `${generatedAiSummary.whatItIs} ${generatedAiSummary.whatItChanges} ${generatedAiSummary.whyItMatters}`.replace(/-/g, '').replace(/No summary available yet\./g, '').trim();
        if (textualSummary.length > 200) textualSummary = textualSummary.substring(0, 197) + "...";
        if (textualSummary.trim() === "") textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD; // If it becomes empty after replacements
    } else if (abstractOrDescriptionFM) {
        textualSummary = abstractOrDescriptionFM.substring(0, 200) + (abstractOrDescriptionFM.length > 200 ? "..." : "");
    } else if (body && body.trim() !== "") {
        // Simple body snippet if no better summary
        textualSummary = body.substring(0, 120).split('\n')[0] + "...";
    } else if (sipTitle && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #") && !sipTitle.endsWith("Proposal Document")) {
        // Use the title if it's descriptive and not generic
        textualSummary = sipTitle;
    } else {
        textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD;
    }


    // Determine PR URL
    let prUrlToUse = optionPrUrl; // Use PR URL if this SIP is directly from PR processing
    if (!prUrlToUse) { // If not directly from PR processing, check frontmatter
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else {
            // Fallback to the file's GitHub URL if no PR link found
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/blob/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }

    // Determine timestamps
    let createdAtISO: string;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request') { // If parsed from a file within a PR context
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE; // Use PR's creation date
        updatedAtISO = parseValidDate(optionUpdatedAt); // Use PR's update date
    } else { // If parsed from a folder
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date) || FALLBACK_CREATED_AT_DATE;
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    // Ensure updated is not before created
    if (createdAtISO && updatedAtISO && new Date(updatedAtISO) < new Date(createdAtISO)) {
        updatedAtISO = createdAtISO;
    }
    if (!updatedAtISO) updatedAtISO = createdAtISO; // Default updated to created if not specified


    let mergedAtVal: string | undefined;
    if ((source === 'pull_request') && optionMergedAt !== undefined) { // If from PR context, use PR's merged_at
        mergedAtVal = optionMergedAt === null ? undefined : parseValidDate(optionMergedAt);
    } else { // Otherwise, check frontmatter
        mergedAtVal = frontmatter.merged ? parseValidDate(frontmatter.merged) : undefined;
    }

    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined) || (Array.isArray(frontmatter.authors) ? frontmatter.authors.join(', ') : undefined);
    const prNumberFromFrontmatter = typeof frontmatter.pr === 'number' ? frontmatter.pr : undefined;

    return {
      id,
      title: sipTitle,
      status: resolvedStatus,
      summary: textualSummary,
      aiSummary: generatedAiSummary, // This is now guaranteed to be a valid AiSummary object
      body,
      prUrl: prUrlToUse!,
      source,
      createdAt: createdAtISO,
      updatedAt: updatedAtISO,
      mergedAt: mergedAtVal,
      author: sipAuthor,
      prNumber: optionPrNumber || prNumberFromFrontmatter, // Prefer PR context's number
      filePath: options.filePath, // Store the file path
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
        // If not an array (e.g. single file path was given or error), treat as empty
        console.warn(`Expected array of files from ${repoContentsUrl}, got:`, filesOrDirs);
        filesFromRepo = [];
    }
  } catch (error) {
    console.error(`Failed to fetch SIPs from folder '${folderPath}':`, error);
    return []; // Return empty if fetching the folder content fails
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
          // No PR-specific details here as we are parsing from a folder
        });
      } catch (error) {
        console.error(`Failed to process SIP file ${file.name} from ${folderPath} (path: ${file.path}):`, error);
        return null;
      }
    });
  const sips = (await Promise.all(sipsPromises)).filter(sip => sip !== null) as SIP[];
  return sips;
}


async function fetchSipsFromPullRequests(): Promise<SIP[]> {
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=100`; // Fetch more PRs
  let allPRs: GitHubPullRequest[];
  try {
    allPRs = await fetchFromGitHubAPI(allPRsUrl);
  } catch (error) {
    console.error("Failed to fetch pull requests:", error);
    return [];
  }

  const sipsFromPRs: SIP[] = [];

  for (const pr of allPRs) {
    // 1. Create a placeholder SIP for EVERY PR (source 'pull_request_only')
    const placeholderSipId = formatSipId(pr.number); // Use PR number for placeholder ID
    let placeholderStatus: SipStatus;
    const prBodyLower = (pr.body || "").toLowerCase();
    const prTitleLower = (pr.title || "").toLowerCase();
    const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn");

    if (pr.state === 'closed') {
      if (pr.merged_at) {
        placeholderStatus = 'Accepted'; // Or potentially 'Final'/'Live' if we have more info
      } else if (mentionsWithdrawnText) {
        placeholderStatus = 'Withdrawn';
      } else {
        placeholderStatus = 'Closed (unmerged)';
      }
    } else { // PR state is 'open'
      placeholderStatus = 'Draft (no file)'; // Default for open PRs without a file yet
    }

    // For 'pull_request_only' SIPs, generate AI summary from PR title/body
    const prAiSummary = await summarizeSipContentStructured({
        abstractOrDescription: pr.title || `PR #${pr.number} Discussion`,
        sipBody: pr.body || undefined,
    });


    const placeholderSip: SIP = {
      id: placeholderSipId,
      title: pr.title || `PR #${pr.number} Discussion`,
      status: placeholderStatus,
      summary: `Status from PR: ${placeholderStatus}. Title: "${pr.title || `PR #${pr.number}`}"`,
      aiSummary: prAiSummary, // Use AI summary from PR content
      body: pr.body || undefined, // PR body can serve as the main content for these
      prUrl: pr.html_url,
      source: 'pull_request_only',
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      mergedAt: pr.merged_at || undefined,
      author: pr.user?.login,
      prNumber: pr.number,
      filePath: undefined, // No specific file path for the PR itself
    };
    sipsFromPRs.push(placeholderSip);


    // 2. Process files within this PR
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    try {
      const filesInPr = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[]; // Cache PR files for 5 min
      for (const file of filesInPr) {
        const filePathInPr = file.filename; // 'filename' is the full path in this context
        if (!filePathInPr) {
            // console.warn(`  PR #${pr.number}: File in PR has no path:`, file);
            continue;
        }

        const fileName = filePathInPr.split('/').pop();
        if (!fileName) {
            // console.warn(`  PR #${pr.number}: Could not extract filename from path ${filePathInPr}`);
            continue;
        }

        // Check if the file is in a SIP directory and is a markdown file, not a template
        const isInSipsDir = filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/') && !filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');
        const isInWithdrawnSipsDir = filePathInPr.startsWith(SIPS_WITHDRAWN_PATH + '/') || filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');

        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) &&
                                   filePathInPr.endsWith('.md') &&
                                   !fileName.toLowerCase().includes('template');

        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);

        if (isRelevantChange && isCandidateSipFile && file.raw_url) {
          // console.log(`  PR #${pr.number}: Processing relevant SIP file change: ${filePathInPr} (Status: ${file.status})`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            // Determine default status for this file based on PR state and file location
            let fileDefaultStatus: SipStatus = 'Draft';
            if (isInWithdrawnSipsDir) { // If file is in a withdrawn directory
                fileDefaultStatus = 'Withdrawn';
            } else if (pr.merged_at) { // If PR is merged
                fileDefaultStatus = 'Accepted'; // Could be 'Final' or 'Live' if frontmatter says so
            } else if (pr.state === 'closed') { // PR closed but not merged
                fileDefaultStatus = 'Closed (unmerged)';
            }
            // If PR is open, default is 'Draft'

            const parsedSipFromFile = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              prState: pr.state,
              createdAt: pr.created_at, // Use PR's creation for context
              updatedAt: pr.updated_at, // Use PR's update for context
              mergedAt: pr.merged_at,   // Use PR's merge status
              author: pr.user?.login,   // Use PR's author
              defaultStatus: fileDefaultStatus,
              source: 'pull_request', // This SIP is derived from a file in a PR
              prBody: pr.body // Pass PR body for context if file content is minimal
            });

            if (parsedSipFromFile) {
              // console.log(`    Successfully parsed ${parsedSipFromFile.id} from ${filePathInPr} in PR #${pr.number}`);
              sipsFromPRs.push(parsedSipFromFile);
            } else {
              // console.log(`    File ${filePathInPr} in PR #${pr.number} did not parse into a distinct SIP.`);
            }
          } catch (error) {
            console.error(`  PR #${pr.number}: Error processing file ${filePathInPr} content:`, error);
          }
        }
      }
    } catch (filesError) {
      // console.error(`  PR #${pr.number}: Failed to fetch or process files:`, filesError);
      // Continue processing other PRs
    }
  }
  return sipsFromPRs;
}

export async function getAllSips(forceRefresh: boolean = false): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION) && !forceRefresh) {
    // console.log("Returning cached SIPs data.");
    return sipsCache;
  }
  if (forceRefresh) {
    // console.log("Forcing refresh of SIPs data");
  }

  try {
    const [mainFolderSipsData, withdrawnFolderSipsData, prSipsData] = await Promise.all([
      fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder'),
      fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder'),
      fetchSipsFromPullRequests(),
    ]);

    const combinedSipsMap = new Map<string, SIP>();

    // Precedence: withdrawn_folder > folder > pull_request (file in PR) > pull_request_only (PR placeholder)
    // Higher number means higher precedence
    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0,
        'pull_request': 1,
        'folder': 2,
        // 'folder+pr': 3, // Not a real source, but for conceptual merging
        'withdrawn_folder': 4,
    };

    // Process in order of increasing precedence to allow overriding
    const allProcessedSips = [
        ...prSipsData.filter(s => s.source === 'pull_request_only'), // Lowest precedence
        ...prSipsData.filter(s => s.source === 'pull_request'),
        ...mainFolderSipsData, // from 'folder'
        ...withdrawnFolderSipsData, // from 'withdrawn_folder' (highest precedence)
    ];


    for (const currentSip of allProcessedSips) {
      if (!currentSip || !currentSip.id) {
        // console.warn("Encountered a SIP object without an ID during merging:", currentSip);
        continue;
      }
      const key = currentSip.id.toLowerCase(); // Normalize ID for map key
      const existingSip = combinedSipsMap.get(key);

      if (!existingSip) {
        combinedSipsMap.set(key, currentSip);
      } else {
        // Merge logic: currentSip is from a source with equal or higher precedence
        // due to processing order. So, currentSip's version of fields is generally preferred.
        let mergedSip = { ...existingSip, ...currentSip }; // Start with existing, override with current

        // Specific merging considerations:
        // Body: Prefer non-empty body. If current is empty but existing wasn't, keep existing.
        if (!currentSip.body && existingSip.body) {
            mergedSip.body = existingSip.body;
        }

        // Summary (textual): Prefer non-placeholder.
        if (currentSip.summary === INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD && existingSip.summary !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
            mergedSip.summary = existingSip.summary;
        }

        // AI Summary: Prefer non-fallback.
        const isCurrentAiFallback = currentSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;
        const isExistingAiFallback = existingSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;
        if (isCurrentAiFallback && !isExistingAiFallback) {
            mergedSip.aiSummary = existingSip.aiSummary;
        }
        // If !isCurrentAiFallback, currentSip.aiSummary is already preferred by the spread.

        // Timestamps:
        // - createdAt: Prefer the earliest
        const dateCurrentCreatedAt = currentSip.createdAt ? new Date(currentSip.createdAt).getTime() : Infinity;
        const dateExistingCreatedAt = existingSip.createdAt ? new Date(existingSip.createdAt).getTime() : Infinity;
        if (dateExistingCreatedAt < dateCurrentCreatedAt) {
            mergedSip.createdAt = existingSip.createdAt;
        }
        // - updatedAt: Prefer the latest
        const dateCurrentUpdatedAt = currentSip.updatedAt ? new Date(currentSip.updatedAt).getTime() : 0;
        const dateExistingUpdatedAt = existingSip.updatedAt ? new Date(existingSip.updatedAt).getTime() : 0;
        if (dateExistingUpdatedAt > dateCurrentUpdatedAt) {
            mergedSip.updatedAt = existingSip.updatedAt;
        }
        // - mergedAt: Prefer if one has it and other doesn't, or latest if both do.
        if (existingSip.mergedAt && !currentSip.mergedAt) {
            mergedSip.mergedAt = existingSip.mergedAt;
        } else if (currentSip.mergedAt && existingSip.mergedAt) {
            if (new Date(existingSip.mergedAt).getTime() > new Date(currentSip.mergedAt).getTime()) {
                mergedSip.mergedAt = existingSip.mergedAt;
            }
        }


        // PR Number & Author: Prefer if one has it and other doesn't
        if (!mergedSip.prNumber && (currentSip.prNumber || existingSip.prNumber)) {
            mergedSip.prNumber = currentSip.prNumber || existingSip.prNumber;
        }
        if (!mergedSip.author && (currentSip.author || existingSip.author)) {
            mergedSip.author = currentSip.author || existingSip.author;
        }
        // FilePath should come from the highest precedence source that has one
        if (sourcePrecedenceValues[currentSip.source] >= sourcePrecedenceValues[existingSip.source]) {
            mergedSip.filePath = currentSip.filePath || existingSip.filePath; // Prefer current if it has one
        } else {
            mergedSip.filePath = existingSip.filePath || currentSip.filePath; // Prefer existing if it has one
        }


        // Status: Highest precedence source dictates status.
        // `currentSip` is from higher or equal precedence. Its status field would generally win.
        // However, if a PR got merged, and its file was previously 'Draft', status should reflect 'Accepted'.
        if (mergedSip.mergedAt && mergedSip.status !== 'Final' && mergedSip.status !== 'Live' && mergedSip.status !== 'Withdrawn' && mergedSip.status !== 'Archived') {
            mergedSip.status = 'Accepted';
        }
        // If currentSip.source is 'withdrawn_folder', its status 'Withdrawn' is already set and correct.

        combinedSipsMap.set(key, mergedSip);
      }
    }

    let sips = Array.from(combinedSipsMap.values());

    // Final sort for display
    sips.sort((a, b) => {
      // Try to parse numeric part of ID for primary sort (e.g., sip-001 vs sip-010)
      const numA = parseInt(a.id.replace(/^sip-(?:generic-|sip-)?0*/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-|sip-)?0*/, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA; // Higher number first
      } else if (!isNaN(numA)) { // Only A is numeric
        return -1; // Numeric IDs first
      } else if (!isNaN(numB)) { // Only B is numeric
        return 1;  // Numeric IDs first
      }

      // Fallback to status order
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Closed (unmerged)", "Withdrawn", "Rejected", "Archived"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex; // Lower index (more active status) first
      }

      // Fallback to mergedAt or updatedAt
      const updatedA = a.mergedAt || a.updatedAt || a.createdAt;
      const updatedB = b.mergedAt || b.updatedAt || b.createdAt;
      const timeA = updatedA ? new Date(updatedA).getTime() : 0;
      const timeB = updatedB ? new Date(updatedB).getTime() : 0;
      if (timeA !== timeB) {
        return timeB - timeA; // Most recent first
      }

      // Final fallback to ID string comparison
      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    // console.log(`SIPs processing complete. Found ${sips.length} unique SIPs.`);
    return sips;
  } catch (error) {
    console.error("Critical error in getAllSips pipeline:", error);
    sipsCache = null; // Invalidate cache on critical error
    return []; // Return empty array to prevent crashing the app
  }
}

export async function getSipById(id: string, forceRefresh: boolean = false): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();
  const COMMENTS_PER_PAGE = 15;

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION) || forceRefresh) {
    // console.log(`Cache miss or forced refresh for getSipById(${id}). Reloading all SIPs.`);
    sipsToSearch = await getAllSips(true); // Ensure fresh data if cache is stale or forced
  }

  if (!sipsToSearch || sipsToSearch.length === 0) {
    // console.log(`No SIPs available in cache or from fresh fetch for getSipById(${id}).`);
    return null;
  }

  let normalizedIdInput = id.toLowerCase();
  // Normalize IDs like "sip-1" or "1" to "sip-001"
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?0*(\d+)$/);

  if (numericMatch && numericMatch[1]) {
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
  } else if (!normalizedIdInput.startsWith('sip-')) {
    // Handle potential generic IDs if not numeric
    if (!normalizedIdInput.startsWith('sip-generic-')) {
        normalizedIdInput = `sip-generic-${normalizedIdInput}`;
    }
  }
  // console.log(`Searching for normalized ID: ${normalizedIdInput}`);

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase();
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (!foundSip) {
    // console.log(`SIP with normalized ID ${normalizedIdInput} not found.`);
    return null;
  }

  // Fetch comments only if PR number exists
  if (foundSip.prNumber) {
    try {
      const issueCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/issues/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;
      const reviewCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;

      // Wrap Promise.all in a try-catch to handle errors from either API call
      let rawIssueComments: GitHubIssueComment[] = [];
      let rawReviewComments: GitHubReviewComment[] = [];

      try {
        const results = await Promise.all([
          fetchFromGitHubAPI(issueCommentsUrl, 60).catch(e => { console.error(`Error fetching issue comments for PR #${foundSip.prNumber}: ${e.message}`); return []; }), // Return empty on error
          fetchFromGitHubAPI(reviewCommentsUrl, 60).catch(e => { console.error(`Error fetching review comments for PR #${foundSip.prNumber}: ${e.message}`); return []; })  // Return empty on error
        ]);
        rawIssueComments = results[0] as GitHubIssueComment[];
        rawReviewComments = results[1] as GitHubReviewComment[];
      } catch (apiError: any) { // This catch might be redundant if individual fetches handle errors
        console.error(`[getSipById] General error during Promise.all for comment fetching for SIP ${foundSip.id}, PR #${foundSip.prNumber}. Error: ${apiError?.message || 'Unknown error'}`, apiError);
        // Ensure arrays are empty if Promise.all itself fails, though individual catches should prevent this.
        rawIssueComments = [];
        rawReviewComments = [];
      }


      const mapComment = (comment: GitHubIssueComment | GitHubReviewComment, filePath?: string): Comment => ({
        id: comment.id,
        author: comment.user?.login || 'Unknown User',
        avatar: comment.user?.avatar_url || `https://placehold.co/40x40.png?text=${(comment.user?.login || 'U').charAt(0).toUpperCase()}`,
        body: comment.body,
        createdAt: comment.created_at,
        htmlUrl: comment.html_url,
        filePath: filePath,
      });

      const mappedIssueComments = rawIssueComments.map(c => mapComment(c));
      const mappedReviewComments = rawReviewComments.map(c => mapComment(c, (c as GitHubReviewComment).path));

      const allComments = [...mappedIssueComments, ...mappedReviewComments];
      allComments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      foundSip.comments = allComments;
      foundSip._rawIssueCommentCount = rawIssueComments.length;
      foundSip._rawReviewCommentCount = rawReviewComments.length;
      foundSip._commentFetchLimit = COMMENTS_PER_PAGE;

    } catch (commentError: any) { // Catch for mapping/sorting errors, or if API calls re-throw
      const sipIdForError = foundSip?.id || 'unknown SIP';
      const prNumForError = foundSip?.prNumber || 'unknown PR#';
      console.error(`[getSipById] Critical error processing comments for SIP ${sipIdForError}, PR #${prNumForError}. Error: ${commentError?.message || 'Unknown error during comment processing'}`, commentError);
      if (foundSip) { 
        foundSip.comments = [];
        foundSip._rawIssueCommentCount = 0;
        foundSip._rawReviewCommentCount = 0;
        foundSip._commentFetchLimit = COMMENTS_PER_PAGE;
      }
    }
  } else if (foundSip) {
    // Ensure comments array and related fields exist even if no PR number or comments fetched
    foundSip.comments = [];
    foundSip._rawIssueCommentCount = 0;
    foundSip._rawReviewCommentCount = 0;
    foundSip._commentFetchLimit = COMMENTS_PER_PAGE;
  }

  return foundSip;
}
