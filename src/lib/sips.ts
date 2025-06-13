
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
const MAX_PR_PAGES_TO_FETCH = 3; // Reduced from 5 to 3

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
    whatItIs: `This proposal is tracked via Pull Request #${prNumber}, titled "${prTitle}". It is currently in the '${status}' state.`,
    whatItChanges: "The specific changes and discussions are detailed in the pull request on GitHub rather than a separate SIP document.",
    whyItMatters: "Tracking proposals directly from pull requests allows early visibility and community input on potential ecosystem changes. Review the PR for full context.",
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
    const errorType = error?.name || 'UnknownError';
    const errorMessageDetail = error?.message || String(error);
    const fullErrorMessage = `Error during fetch or JSON parsing for GitHub API URL ${url}. Type: ${errorType}. Original error: ${errorMessageDetail}`;
    
    console.error(fullErrorMessage);
    console.error("Full error object in fetchFromGitHubAPI:", error);

    if (errorType === 'AbortError') {
      throw new Error(`GitHub API request timed out for ${url}.`);
    }
    throw new Error(fullErrorMessage);
  } finally {
    clearTimeout(timeoutId);
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

    if (!response.ok) {
      throw new Error(`Failed to fetch raw content: ${response.status} ${response.statusText} for ${url}`);
    }
    return response.text();
  } catch (error: any) {
    const errorType = error?.name || 'UnknownError';
    const errorMessageDetail = error?.message || String(error);
    const fullErrorMessage = `Error fetching raw content from URL ${url}. Type: ${errorType}. Original error: ${errorMessageDetail}`;
    
    console.error(fullErrorMessage);
    console.error("Full error object in fetchRawContent:", error);
    
    if (errorType === 'AbortError') {
      throw new Error(`Raw content fetch timed out for ${url}.`);
    }
    throw new Error(fullErrorMessage);
  } finally {
    clearTimeout(timeoutId);
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
      return null;
    }

    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
    } else {
        if (source === 'folder' || source === 'withdrawn_folder') {
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
        } else {
             return null;
        }
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && (source === 'pull_request') && optionPrTitle) {
      sipTitle = optionPrTitle; 
    }
    if (!sipTitle) {
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal Document'}`;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    
    let resolvedStatus: SipStatus;
    if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter;
    } else if (defaultStatus === 'Withdrawn' && (source === 'pull_request' || source === 'withdrawn_folder')) {
        resolvedStatus = 'Withdrawn';
    } else if (source === 'pull_request') {
        if (optionMergedAt) resolvedStatus = 'Accepted';
        else if (optionPrState === 'open') resolvedStatus = 'Draft';
        else resolvedStatus = 'Closed (unmerged)';
    } else {
        resolvedStatus = defaultStatus;
    }
    
    const abstractOrDescriptionFM = frontmatter.abstract || frontmatter.description;
    let textualSummary: string;

    const hasSufficientBody = body && body.trim().length > 10;
    const hasSufficientAbstractFM = abstractOrDescriptionFM && abstractOrDescriptionFM.trim().length > 10;

    let aiInputSipBody: string | undefined = hasSufficientBody ? body : undefined;
    let aiInputAbstractOrDescription: string | undefined = hasSufficientAbstractFM ? abstractOrDescriptionFM : undefined;

    if (!aiInputSipBody && !aiInputAbstractOrDescription) {
      if (source === 'pull_request' && optionPrTitle) {
        aiInputAbstractOrDescription = optionPrTitle;
        aiInputSipBody = optionPrBody || undefined;
      } else if (sipTitle && sipTitle.trim().length > 5 && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #") && !sipTitle.endsWith("Proposal Document")) {
          aiInputAbstractOrDescription = sipTitle;
      }
    }
    
    let generatedAiSummary: AiSummary = USER_REQUESTED_FALLBACK_AI_SUMMARY;
    try {
        generatedAiSummary = await summarizeSipContentStructured({
            sipBody: aiInputSipBody,
            abstractOrDescription: aiInputAbstractOrDescription,
        });
    } catch (aiError: any) {
        console.error(`Error generating AI summary for SIP ${id} (file: ${fileName}, source: ${source}): ${aiError.message}`, aiError);
        generatedAiSummary = USER_REQUESTED_FALLBACK_AI_SUMMARY; // Fallback if AI call itself fails
    }


    const { whatItIs: aiWhat, whatItChanges: aiChanges, whyItMatters: aiMatters } = generatedAiSummary;
    const aiSummaryIsFallback = aiWhat === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs &&
                                aiChanges === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItChanges &&
                                aiMatters === USER_REQUESTED_FALLBACK_AI_SUMMARY.whyItMatters;

    if (frontmatter.summary && String(frontmatter.summary).trim() !== "") {
        textualSummary = String(frontmatter.summary);
    } else if (!aiSummaryIsFallback) {
        let constructedSummary = `${aiWhat} ${aiChanges} ${aiMatters}`.replace(/-/g, '').replace(/No summary available yet\./g, '').trim();
        if (constructedSummary.length > 200) constructedSummary = constructedSummary.substring(0, 197) + "...";
        textualSummary = constructedSummary.trim() === "" ? INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD : constructedSummary;
    } else if (abstractOrDescriptionFM) {
        textualSummary = abstractOrDescriptionFM.substring(0, 200) + (abstractOrDescriptionFM.length > 200 ? "..." : "");
    } else if (body && body.trim() !== "") {
        textualSummary = body.substring(0, 120).split('\n')[0] + "...";
    } else if (sipTitle && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #") && !sipTitle.endsWith("Proposal Document")) {
        textualSummary = sipTitle;
    } else {
        textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD;
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

    if (source === 'pull_request' || source === 'pull_request_only') { 
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE; 
        updatedAtISO = parseValidDate(optionUpdatedAt); 
    } else { 
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date) || FALLBACK_CREATED_AT_DATE;
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    if (createdAtISO && updatedAtISO && new Date(updatedAtISO) < new Date(createdAtISO)) {
        updatedAtISO = createdAtISO;
    }
    if (!updatedAtISO) updatedAtISO = createdAtISO; 


    let mergedAtVal: string | undefined;
    if ((source === 'pull_request' || source === 'pull_request_only') && optionMergedAt !== undefined) { 
        mergedAtVal = optionMergedAt === null ? undefined : parseValidDate(optionMergedAt);
    } else { 
        mergedAtVal = frontmatter.merged ? parseValidDate(frontmatter.merged) : undefined;
    }

    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined) || (Array.isArray(frontmatter.authors) ? frontmatter.authors.join(', ') : undefined);
    const prNumberFromFrontmatter = typeof frontmatter.pr === 'number' ? frontmatter.pr : undefined;

    return {
      id,
      title: sipTitle,
      status: resolvedStatus,
      summary: textualSummary,
      aiSummary: generatedAiSummary, 
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
        console.warn(`Expected array of files from ${repoContentsUrl}, got:`, filesOrDirs);
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
  console.log(`fetchSipsFromFolder (${folderPath}): Processed ${sips.length} SIPs.`);
  return sips;
}


async function fetchSipsFromPullRequests(page: number = 1): Promise<SIP[]> {
  console.log(`fetchSipsFromPullRequests: Starting for page ${page}.`);
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=30&page=${page}`; 
  let allPRs: GitHubPullRequest[];
  try {
    allPRs = await fetchFromGitHubAPI(allPRsUrl);
  } catch (error) {
    console.error(`Failed to fetch pull requests (page ${page}):`, error);
    return [];
  }

  if (!allPRs || allPRs.length === 0) {
    console.log(`fetchSipsFromPullRequests: No PRs found on page ${page}.`);
    return [];
  }
  console.log(`fetchSipsFromPullRequests: Fetched ${allPRs.length} PRs on page ${page}.`);

  const sipsFromPRs: SIP[] = [];

  for (const pr of allPRs) {
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
    } else { 
      placeholderStatus = 'Draft (no file)'; 
    }
    
    let placeholderAiSummary = USER_REQUESTED_FALLBACK_AI_SUMMARY;
    try {
        placeholderAiSummary = await summarizeSipContentStructured({ 
            sipBody: pr.body || undefined, 
            abstractOrDescription: pr.title 
        });
    } catch (aiError: any) {
        console.error(`Error generating AI summary for PR_ONLY SIP #${pr.number}: ${aiError.message}`, aiError);
        // placeholderAiSummary remains USER_REQUESTED_FALLBACK_AI_SUMMARY
    }

    const placeholderSip: SIP = {
      id: placeholderSipId,
      title: pr.title || `PR #${pr.number} Discussion`,
      status: placeholderStatus,
      summary: `Status from PR: ${placeholderStatus}. Title: "${pr.title || `PR #${pr.number}`}"`,
      aiSummary: placeholderAiSummary,
      body: pr.body || undefined, 
      prUrl: pr.html_url,
      source: 'pull_request_only',
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      mergedAt: pr.merged_at || undefined,
      author: pr.user?.login,
      prNumber: pr.number,
      filePath: undefined, 
    };
    sipsFromPRs.push(placeholderSip);

    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    try {
      const filesInPr = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[]; 
      for (const file of filesInPr) {
        const filePathInPr = file.filename; 
        if (!filePathInPr) {
            continue;
        }

        const fileName = filePathInPr.split('/').pop();
        if (!fileName) {
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
          console.log(`fetchSipsFromPullRequests (Page ${page}, PR #${pr.number}): Processing relevant file: ${filePathInPr}`);
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
              prBody: pr.body 
            });

            if (parsedSipFromFile) {
              console.log(`fetchSipsFromPullRequests (Page ${page}, PR #${pr.number}): Successfully parsed SIP from file: ${parsedSipFromFile.id}`);
              sipsFromPRs.push(parsedSipFromFile);
            }
          } catch (error) {
            console.error(`  PR #${pr.number}, Page ${page}: Error processing file ${filePathInPr} content:`, error);
          }
        }
      }
    } catch (filesError: any) {
       console.error(`Error fetching files for PR #${pr.number} (Page ${page}): ${filesError?.message}`, filesError);
    }
  }
  console.log(`fetchSipsFromPullRequests: Finished for page ${page}. Found ${sipsFromPRs.length} SIP objects (includes placeholders and file-parsed).`);
  return sipsFromPRs;
}

export async function getAllSips(forceRefresh: boolean = false): Promise<SIP[]> {
  console.log("getAllSips: Execution started.");
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION) && !forceRefresh) {
    console.log("getAllSips: Returning cached data.");
    return sipsCache;
  }
  if (forceRefresh) {
    console.log("getAllSips: Forcing refresh of SIPs data.");
  }

  try {
    const prSipsPromises = [];
    for (let i = 1; i <= MAX_PR_PAGES_TO_FETCH; i++) {
        console.log(`getAllSips: Queuing fetch for PR page ${i}.`);
        prSipsPromises.push(fetchSipsFromPullRequests(i));
    }

    const [
        mainFolderSipsData, 
        withdrawnFolderSipsData, 
        ...prSipsResults
    ] = await Promise.all([
      fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder'),
      fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder'),
      ...prSipsPromises,
    ]);
    
    const prSipsData = prSipsResults.flat();

    console.log(`getAllSips: Fetched ${mainFolderSipsData.length} SIPs from main folder.`);
    console.log(`getAllSips: Fetched ${withdrawnFolderSipsData.length} SIPs from withdrawn folder.`);
    console.log(`getAllSips: Total potential SIPs from ${MAX_PR_PAGES_TO_FETCH} PR pages: ${prSipsData.length}`);


    const combinedSipsMap = new Map<string, SIP>();

    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0,
        'pull_request': 1,
        'folder': 2,
        'withdrawn_folder': 4, 
    };

    const allProcessedSips = [
        ...prSipsData.filter(s => s.source === 'pull_request_only'), 
        ...prSipsData.filter(s => s.source === 'pull_request'),
        ...mainFolderSipsData, 
        ...withdrawnFolderSipsData, 
    ];
    console.log(`getAllSips: Total SIP entries to process before deduplication: ${allProcessedSips.length}`);


    for (const currentSip of allProcessedSips) {
      if (!currentSip || !currentSip.id) {
        console.warn("getAllSips: Skipping SIP with no ID.", currentSip);
        continue;
      }
      const key = currentSip.id.toLowerCase(); 
      const existingSip = combinedSipsMap.get(key);

      if (!existingSip) {
        combinedSipsMap.set(key, currentSip);
      } else {
        let mergedSip = { ...existingSip, ...currentSip }; 

        if (!currentSip.body && existingSip.body) {
            mergedSip.body = existingSip.body;
        }

        if (currentSip.summary === INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD && existingSip.summary !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
            mergedSip.summary = existingSip.summary;
        }
        
        const isCurrentAiFallback = currentSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;
        const isExistingAiFallback = existingSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;
        if (isCurrentAiFallback && !isExistingAiFallback) {
            mergedSip.aiSummary = existingSip.aiSummary;
        }
        
        // Date Merging Logic:
        const currentCreatedAtValid = currentSip.createdAt && currentSip.createdAt !== FALLBACK_CREATED_AT_DATE;
        const existingCreatedAtValid = existingSip.createdAt && existingSip.createdAt !== FALLBACK_CREATED_AT_DATE;
        if (currentCreatedAtValid) {
            mergedSip.createdAt = currentSip.createdAt;
        } else if (existingCreatedAtValid) {
            mergedSip.createdAt = existingSip.createdAt;
        }

        const currentUpdatedAtValid = currentSip.updatedAt && currentSip.updatedAt !== FALLBACK_CREATED_AT_DATE;
        const existingUpdatedAtValid = existingSip.updatedAt && existingSip.updatedAt !== FALLBACK_CREATED_AT_DATE;
        if (currentUpdatedAtValid && existingUpdatedAtValid) {
            mergedSip.updatedAt = new Date(currentSip.updatedAt!) > new Date(existingSip.updatedAt!) ? currentSip.updatedAt : existingSip.updatedAt;
        } else if (currentUpdatedAtValid) {
            mergedSip.updatedAt = currentSip.updatedAt;
        } else if (existingUpdatedAtValid) {
            mergedSip.updatedAt = existingSip.updatedAt;
        } else if (mergedSip.createdAt !== FALLBACK_CREATED_AT_DATE) { // Fallback updated to created if created is valid
            mergedSip.updatedAt = mergedSip.createdAt;
        }


        if (currentSip.source === 'pull_request' || currentSip.source === 'pull_request_only') {
            mergedSip.mergedAt = currentSip.mergedAt; 
        } else if (existingSip.mergedAt && !currentSip.mergedAt) { 
             mergedSip.mergedAt = existingSip.mergedAt;
        }


        if (!mergedSip.prNumber && (currentSip.prNumber || existingSip.prNumber)) {
            mergedSip.prNumber = currentSip.prNumber || existingSip.prNumber;
        }
        if (!mergedSip.author && (currentSip.author || existingSip.author)) {
            mergedSip.author = currentSip.author || existingSip.author;
        }
        
        if (sourcePrecedenceValues[currentSip.source] >= sourcePrecedenceValues[existingSip.source]) {
            mergedSip.filePath = currentSip.filePath || existingSip.filePath; 
            mergedSip.source = currentSip.source;
            mergedSip.status = currentSip.status; // Status from higher precedence source
        } else {
            mergedSip.filePath = existingSip.filePath || currentSip.filePath; 
            mergedSip.source = existingSip.source;
            mergedSip.status = existingSip.status; // Status from higher precedence source (already existing)
        }
        
        // Status override based on mergedAt or specific source conditions
        if (mergedSip.source === 'withdrawn_folder') {
            mergedSip.status = 'Withdrawn';
        } else if (mergedSip.mergedAt && mergedSip.status !== 'Final' && mergedSip.status !== 'Live' && mergedSip.status !== 'Archived' && mergedSip.status !== 'Withdrawn') {
             mergedSip.status = 'Accepted';
        } else if (mergedSip.status === 'Draft (no file)' && mergedSip.body && mergedSip.body.trim().length > 0) {
            mergedSip.status = 'Draft';
        }


        combinedSipsMap.set(key, mergedSip);
      }
    }

    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      const numA = parseInt(a.id.replace(/^sip-(?:generic-|sip-)?0*/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-|sip-)?0*/, ''), 10);

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

      const updatedA = a.mergedAt || a.updatedAt || a.createdAt;
      const updatedB = b.mergedAt || b.updatedAt || b.createdAt;
      const timeA = updatedA ? new Date(updatedA).getTime() : 0;
      const timeB = updatedB ? new Date(updatedB).getTime() : 0;
      if (timeA !== timeB) {
        return timeB - timeA; 
      }

      return a.id.localeCompare(b.id);
    });

    sipsCache = sips;
    cacheTimestamp = now;
    console.log(`getAllSips: Successfully processed. Final unique SIP count: ${sips.length}. Execution finished.`);
    return sips;
  } catch (error: any) {
    console.error("Critical error in getAllSips pipeline. Error:", error);
    if (error && error.stack) {
      console.error("Stack trace:", error.stack);
    }
    sipsCache = null; 
    return []; 
  }
}

export async function getSipById(id: string, forceRefresh: boolean = false): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();
  const COMMENTS_PER_PAGE = 15;

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION) || forceRefresh) {
    sipsToSearch = await getAllSips(true); 
  }

  if (!sipsToSearch || sipsToSearch.length === 0) {
    return null;
  }

  let normalizedIdInput = id.toLowerCase();
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?0*(\d+)$/);

  if (numericMatch && numericMatch[1]) {
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
  } else if (!normalizedIdInput.startsWith('sip-')) {
    if (!normalizedIdInput.startsWith('sip-generic-')) {
        normalizedIdInput = `sip-generic-${normalizedIdInput}`;
    }
  }
  
  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase();
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (!foundSip) {
    return null;
  }

  if (foundSip.prNumber) {
    try {
      const issueCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/issues/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;
      const reviewCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;

      let rawIssueComments: GitHubIssueComment[] = [];
      let rawReviewComments: GitHubReviewComment[] = [];

      const results = await Promise.all([
        fetchFromGitHubAPI(issueCommentsUrl, 60).catch(e => { console.error(`Error fetching issue comments for PR #${foundSip.prNumber}: ${e.message}`); return []; }) as Promise<GitHubIssueComment[]>, 
        fetchFromGitHubAPI(reviewCommentsUrl, 60).catch(e => { console.error(`Error fetching review comments for PR #${foundSip.prNumber}: ${e.message}`); return []; }) as Promise<GitHubReviewComment[]>
      ]);
      rawIssueComments = results[0];
      rawReviewComments = results[1];


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

    } catch (commentError: any) { 
      const sipIdForError = foundSip?.id || 'unknown SIP';
      const prNumForError = foundSip?.prNumber || 'unknown PR#';
      console.error(`[getSipById] Error processing comments for SIP ${sipIdForError}, PR #${prNumForError}. Error: ${commentError?.message || 'Unknown error during comment processing'}`, commentError);
      if (foundSip) { 
        foundSip.comments = [];
        foundSip._rawIssueCommentCount = 0;
        foundSip._rawReviewCommentCount = 0;
        foundSip._commentFetchLimit = COMMENTS_PER_PAGE;
      }
    }
  } else if (foundSip) {
    foundSip.comments = [];
    foundSip._rawIssueCommentCount = 0;
    foundSip._rawReviewCommentCount = 0;
    foundSip._commentFetchLimit = COMMENTS_PER_PAGE;
  }

  return foundSip;
}

