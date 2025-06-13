
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus, AiSummary, Comment } from '@/types/sip';
import { summarizeSipContentStructured } from '@/ai/flows/summarize-sip-flow';
import { generateCleanSipTitle } from '@/ai/flows/generate-clean-title-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips';
const SIPS_WITHDRAWN_PATH = 'withdrawn-sips';
const SIPS_REPO_BRANCH = 'main';
const GITHUB_API_TIMEOUT = 15000; // 15 seconds
let MAX_PR_PAGES_TO_FETCH = 1; // Reduced for faster testing
const AI_SUMMARY_TIMEOUT_MS = 10000; // 10 seconds for AI summary generation
const AI_CLEAN_TITLE_TIMEOUT_MS = 7000; // 7 seconds for AI clean title generation


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

interface GitHubLabel {
  id: number;
  node_id: string;
  url: string;
  name: string;
  color: string;
  default: boolean;
  description: string | null;
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
  labels: GitHubLabel[];
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
    const MAX_BODY_LOG_LENGTH = 500;

    if (!response.ok) {
      let errorBodyText = 'Could not read error body';
      try {
        errorBodyText = await response.text();
      } catch (e) {
         console.warn(`Failed to read error body for ${url}:`, e);
      }
      const safeErrorBody = typeof errorBodyText === 'string' ? errorBodyText : String(errorBodyText);
      const truncatedErrorBody = safeErrorBody.length > MAX_BODY_LOG_LENGTH ? safeErrorBody.substring(0, MAX_BODY_LOG_LENGTH) + "..." : safeErrorBody;
      
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      const rateLimitReset = response.headers.get('x-ratelimit-reset');
      const statusText = response.statusText || 'Unknown Status';
      
      console.error(`GitHub API request failed: ${response.status} ${statusText} for ${url}. RL-Remaining: ${rateLimitRemaining}, RL-Reset: ${rateLimitReset}. Body: ${truncatedErrorBody}`);
      throw new Error(`GitHub API request failed for ${url}: ${response.status} ${statusText} (RL-Remaining: ${rateLimitRemaining})`);
    }
    return response.json();
  } catch (error: any) {
    const errorType = error?.name || 'UnknownError';
    const errorMessageDetail = error?.message || String(error);
    const baseMessage = `Error during fetch or JSON parsing for GitHub API URL ${url}. Type: ${errorType}. Detail: ${errorMessageDetail}`;
    
    console.error(baseMessage, error?.stack);
    if (errorType !== 'AbortError' && errorType !== 'Error' && error.stack) {
        console.error("Full error object in fetchFromGitHubAPI:", error);
    }

    if (errorType === 'AbortError') {
      throw new Error(`GitHub API request timed out for ${url}.`);
    }
    if (error.message && (error.message.startsWith("GitHub API request failed for") || error.message.startsWith("GitHub API request timed out for"))) {
        throw error;
    }
    throw new Error(baseMessage);
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
    const fullErrorMessage = `Error fetching raw content from URL ${url}. Type: ${errorType}. Detail: ${errorMessageDetail}`;
    
    console.error(fullErrorMessage);
     if (errorType !== 'AbortError' && errorType !== 'Error' && error.stack) {
        console.error("Full error object in fetchRawContent:", error);
    }
    
    if (errorType === 'AbortError') {
      throw new Error(`Raw content fetch timed out for ${url}.`);
    }
     if (error.message && (error.message.startsWith("Failed to fetch raw content:") || error.message.startsWith("Raw content fetch timed out for"))) {
        throw error;
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
  source: 'folder' | 'pull_request' | 'pull_request_only' | 'withdrawn_folder';
  createdAt?: string; // From PR
  updatedAt?: string; // From PR
  mergedAt?: string | null; // From PR
  author?: string;
  prBody?: string | null;
  prLabels?: string[];
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const {
    fileName, filePath, prUrl: optionPrUrl, prTitle: optionPrTitle, prNumber: optionPrNumber,
    prState: optionPrState, defaultStatus, source,
    createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt,
    author: optionAuthor, prBody: optionPrBody, prLabels,
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
    
    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
    } else {
        if ((source === 'pull_request' || source === 'pull_request_only') && optionPrNumber) {
            id = formatSipId(optionPrNumber);
        } else if (source === 'folder' || source === 'withdrawn_folder') {
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
        } else {
             console.warn(`parseSipFile: Could not determine SIP ID for file ${fileName}, source ${source}. Skipping.`);
             return null;
        }
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && (source === 'pull_request' || source === 'pull_request_only') && optionPrTitle) {
      sipTitle = optionPrTitle;
    }
    if (!sipTitle) {
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal Document'}`;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    
    let resolvedStatus: SipStatus;
    if (defaultStatus === 'Withdrawn' || (options.filePath && options.filePath.includes(SIPS_WITHDRAWN_PATH))) {
        resolvedStatus = 'Withdrawn';
    } else if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter;
    } else if (source === 'pull_request' || source === 'pull_request_only') {
        if (optionMergedAt) resolvedStatus = 'Accepted';
        else if (optionPrState === 'open') resolvedStatus = 'Draft';
        else resolvedStatus = 'Closed (unmerged)';
    } else {
        resolvedStatus = defaultStatus;
    }
    
    const abstractOrDescriptionFM = frontmatter.abstract || frontmatter.description;
    let textualSummary: string;
    
    if (frontmatter.summary && String(frontmatter.summary).trim() !== "") {
        textualSummary = String(frontmatter.summary);
    } else if (abstractOrDescriptionFM) {
        textualSummary = abstractOrDescriptionFM.substring(0, 200) + (abstractOrDescriptionFM.length > 200 ? "..." : "");
    } else if (body && body.trim() !== "") {
        const lines = body.trim().split('\n');
        let firstMeaningfulLine = "";
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === "" ||
                trimmedLine.startsWith("#") ||
                trimmedLine.startsWith("|") ||
                trimmedLine.startsWith("```") ||
                trimmedLine.startsWith("---") ||
                trimmedLine.startsWith("* ") ||
                trimmedLine.startsWith("- ") ||
                trimmedLine.startsWith("+ ") ||
                /^\d+\.\s/.test(trimmedLine)
            ) {
                continue;
            }
            firstMeaningfulLine = trimmedLine;
            break;
        }

        if (firstMeaningfulLine) {
            textualSummary = firstMeaningfulLine.substring(0, 150) + (firstMeaningfulLine.length > 150 ? "..." : "");
        } else {
            if (sipTitle && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #") && !sipTitle.endsWith("Proposal Document") && !sipTitle.includes(`PR #${optionPrNumber} Discussion`)) {
                textualSummary = sipTitle;
            } else {
                textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD;
            }
        }
    } else if (sipTitle && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #") && !sipTitle.endsWith("Proposal Document") && !sipTitle.includes(`PR #${optionPrNumber} Discussion`)) {
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
    let mergedAtVal: string | undefined;

    const fmCreated = parseValidDate(frontmatter.created || frontmatter.date);
    const fmUpdated = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    const fmMerged = parseValidDate(frontmatter.merged);

    const prAssociated = (source === 'pull_request' || source === 'pull_request_only');

    if (prAssociated) {
        const prCreatedAt = optionCreatedAt ? parseValidDate(optionCreatedAt) : undefined;
        const prUpdatedAt = optionUpdatedAt ? parseValidDate(optionUpdatedAt) : undefined;
        const prMergedAt = optionMergedAt === null ? undefined : (optionMergedAt ? parseValidDate(optionMergedAt) : undefined);

        createdAtISO = prCreatedAt && prCreatedAt !== FALLBACK_CREATED_AT_DATE ? prCreatedAt :
                       fmCreated && fmCreated !== FALLBACK_CREATED_AT_DATE ? fmCreated :
                       prCreatedAt || fmCreated || FALLBACK_CREATED_AT_DATE;

        let candidatePrUpdated = (prUpdatedAt && prUpdatedAt !== FALLBACK_CREATED_AT_DATE && new Date(prUpdatedAt) >= new Date(createdAtISO)) ? prUpdatedAt : undefined;
        let candidateFmUpdated = (fmUpdated && fmUpdated !== FALLBACK_CREATED_AT_DATE && new Date(fmUpdated) >= new Date(createdAtISO)) ? fmUpdated : undefined;

        if (candidatePrUpdated && candidateFmUpdated) {
            updatedAtISO = new Date(candidatePrUpdated) > new Date(candidateFmUpdated) ? candidatePrUpdated : candidateFmUpdated;
        } else {
            updatedAtISO = candidatePrUpdated || candidateFmUpdated;
        }
        mergedAtVal = prMergedAt || fmMerged;
    } else { // 'folder' or 'withdrawn_folder'
        createdAtISO = fmCreated || FALLBACK_CREATED_AT_DATE;
        updatedAtISO = (fmUpdated && new Date(fmUpdated) >= new Date(createdAtISO)) ? fmUpdated : undefined;
        mergedAtVal = fmMerged;
    }

    if (!updatedAtISO && createdAtISO !== FALLBACK_CREATED_AT_DATE) {
        updatedAtISO = createdAtISO;
    } else if (!updatedAtISO && createdAtISO === FALLBACK_CREATED_AT_DATE) {
        updatedAtISO = FALLBACK_CREATED_AT_DATE;
    }
    if (updatedAtISO && createdAtISO !== FALLBACK_CREATED_AT_DATE && new Date(updatedAtISO) < new Date(createdAtISO)) {
        updatedAtISO = createdAtISO;
    }


    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined) || (Array.isArray(frontmatter.authors) ? frontmatter.authors.join(', ') : undefined);
    const prNumberFromFrontmatter = typeof frontmatter.pr === 'number' ? frontmatter.pr : undefined;
    const proposalType = typeof frontmatter.type === 'string' ? frontmatter.type : undefined;


    return {
      id,
      title: sipTitle,
      status: resolvedStatus,
      summary: textualSummary,
      aiSummary: USER_REQUESTED_FALLBACK_AI_SUMMARY,
      body,
      prUrl: prUrlToUse!,
      source,
      createdAt: createdAtISO,
      updatedAt: updatedAtISO,
      mergedAt: mergedAtVal,
      author: sipAuthor,
      prNumber: optionPrNumber || prNumberFromFrontmatter,
      filePath: options.filePath,
      labels: prLabels || (Array.isArray(frontmatter.labels) ? frontmatter.labels.map(String) : undefined),
      type: proposalType,
      cleanTitle: sipTitle,
    };
  } catch (e: any) {
    console.error(`Error parsing SIP file ${fileName || 'unknown filename'} (source: ${source}, path: ${filePath}): ${e.message}`, e.stack);
    return null;
  }
}

async function fetchSipsFromFolder(folderPath: string, defaultStatus: SipStatus, source: 'folder' | 'withdrawn_folder'): Promise<SIP[]> {
  console.log(`fetchSipsFromFolder: Starting for folder '${folderPath}'.`);
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
  console.log(`fetchSipsFromFolder ('${folderPath}'): Processed ${sips.length} SIPs.`);
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
    const prLabels = pr.labels.map(label => label.name);
    const placeholderSipId = formatSipId(pr.number);
    let placeholderStatus: SipStatus;
    const prBodyLower = (pr.body || "").toLowerCase();
    const prTitleLower = (pr.title || "").toLowerCase();
    const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn") || prLabels.some(l => l.toLowerCase().includes('withdrawn'));


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
    
    const initialTitleForPlaceholder = pr.title || `PR #${pr.number} Discussion`;
    const placeholderSip: SIP = {
      id: placeholderSipId,
      title: initialTitleForPlaceholder,
      cleanTitle: initialTitleForPlaceholder, // Initialize cleanTitle
      status: placeholderStatus,
      summary: `Status from PR: ${placeholderStatus}. Title: "${pr.title || `PR #${pr.number}`}"`,
      aiSummary: USER_REQUESTED_FALLBACK_AI_SUMMARY,
      body: pr.body || undefined,
      prUrl: pr.html_url,
      source: 'pull_request_only',
      createdAt: parseValidDate(pr.created_at) || FALLBACK_CREATED_AT_DATE,
      updatedAt: parseValidDate(pr.updated_at) || parseValidDate(pr.created_at) || FALLBACK_CREATED_AT_DATE,
      mergedAt: pr.merged_at ? parseValidDate(pr.merged_at) : undefined,
      author: pr.user?.login,
      prNumber: pr.number,
      filePath: undefined,
      labels: prLabels,
      // type will be populated later if applicable
    };
    sipsFromPRs.push(placeholderSip);

    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    try {
      const filesInPr: GitHubFile[] = await fetchFromGitHubAPI(prFilesUrl, 60 * 5).catch(e => {
         console.error(`Error fetching files for PR #${pr.number} (Page ${page}) inside try-catch: ${e?.message}`, e?.stack);
         return [];
      });

      for (const file of filesInPr) {
        const filePathInPr = file.filename;
        if (!filePathInPr) {
            console.warn(`  PR #${pr.number}, Page ${page}: File object missing 'filename' (path). Skipping. File:`, file);
            continue;
        }

        const fileName = filePathInPr.split('/').pop();
        if (!fileName) {
            console.warn(`  PR #${pr.number}, Page ${page}: Could not extract filename from path: ${filePathInPr}. Skipping.`);
            continue;
        }

        const isInSipsDir = filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/') && !filePathInPr.includes(SIPS_WITHDRAWN_PATH);
        const isInWithdrawnSipsDir = filePathInPr.includes(SIPS_WITHDRAWN_PATH);

        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) &&
                                   filePathInPr.endsWith('.md') &&
                                   !fileName.toLowerCase().includes('template');

        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);

        if (isRelevantChange && isCandidateSipFile && file.raw_url) {
          console.log(`fetchSipsFromPullRequests (Page ${page}, PR #${pr.number}): Processing relevant file: ${filePathInPr} with status ${file.status}`);
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
              prBody: pr.body,
              prLabels: prLabels,
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
       console.error(`Error fetching files for PR #${pr.number} (Page ${page}): ${filesError?.message}`, filesError.stack);
    }
  }
  console.log(`fetchSipsFromPullRequests: Finished for page ${page}. Found ${sipsFromPRs.length} SIP objects (includes placeholders and file-parsed).`);
  return sipsFromPRs;
}

async function enrichSipWithAiData(sip: SIP): Promise<SIP> {
  const enrichedSip = { ...sip };

  // 1. Generate AI Summary if needed
  if (!enrichedSip.aiSummary || enrichedSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs) {
    console.log(`enrichSipWithAiData: Generating AI summary for SIP ${enrichedSip.id}`);
    try {
      const aiInputSipBody = enrichedSip.body && enrichedSip.body.trim().length > 10 ? enrichedSip.body : undefined;
      let aiInputAbstractOrDescription = enrichedSip.summary !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD ? enrichedSip.summary : undefined;
      if (!aiInputAbstractOrDescription && enrichedSip.title && !enrichedSip.title.startsWith("SIP ") && !enrichedSip.title.startsWith("PR #") && !enrichedSip.title.endsWith("Proposal Document")) {
        aiInputAbstractOrDescription = enrichedSip.title;
      }
      if (!aiInputSipBody && !aiInputAbstractOrDescription && enrichedSip.prNumber && enrichedSip.title) {
        aiInputAbstractOrDescription = enrichedSip.title;
      }

      const aiSummaryPromise = summarizeSipContentStructured({
        sipBody: aiInputSipBody,
        abstractOrDescription: aiInputAbstractOrDescription,
      });
      const summaryTimeoutPromise = new Promise<AiSummary>((_, reject) =>
        setTimeout(() => reject(new Error(`AI summary generation timed out for SIP ${enrichedSip.id} after ${AI_SUMMARY_TIMEOUT_MS / 1000}s`)), AI_SUMMARY_TIMEOUT_MS)
      );
      enrichedSip.aiSummary = await Promise.race([aiSummaryPromise, summaryTimeoutPromise]);
    } catch (aiError: any) {
      console.warn(`AI Summary Error/Timeout for SIP ${enrichedSip.id}: ${aiError.message}. Falling back to default.`);
      enrichedSip.aiSummary = USER_REQUESTED_FALLBACK_AI_SUMMARY;
    }
  }

  // 2. Generate Clean Title
  console.log(`enrichSipWithAiData: Attempting to generate clean title for SIP ${enrichedSip.id} (Original: "${enrichedSip.title}")`);
  try {
    let contextForCleanTitle = enrichedSip.summary !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD ? enrichedSip.summary : "";
    if (enrichedSip.aiSummary && enrichedSip.aiSummary.whatItIs !== USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs) {
        contextForCleanTitle += `\nAI Summary: ${enrichedSip.aiSummary.whatItIs} ${enrichedSip.aiSummary.whatItChanges} ${enrichedSip.aiSummary.whyItMatters}`;
    } else if (enrichedSip.body && enrichedSip.body.trim().length > 20) {
        contextForCleanTitle += `\nBody snippet: ${enrichedSip.body.substring(0, 300).replace(/\s+/g, ' ').trim()}...`;
    }
    
    if (contextForCleanTitle.trim().length < 10 && enrichedSip.title) {
        console.log(`enrichSipWithAiData: Context for clean title for SIP ${enrichedSip.id} is very short. Using original title ("${enrichedSip.title}") as primary context.`);
        contextForCleanTitle = enrichedSip.title;
    }
    
    const cleanTitlePromise = generateCleanSipTitle({
        originalTitle: enrichedSip.title,
        context: contextForCleanTitle,
        proposalType: enrichedSip.type,
    });
    const titleTimeoutPromise = new Promise<ReturnType<typeof generateCleanSipTitle>>((_, reject) =>
        setTimeout(() => reject(new Error(`AI clean title generation timed out for SIP ${enrichedSip.id} after ${AI_CLEAN_TITLE_TIMEOUT_MS / 1000}s`)), AI_CLEAN_TITLE_TIMEOUT_MS)
    );
    const cleanTitleResult = await Promise.race([cleanTitlePromise, titleTimeoutPromise]);

    if (cleanTitleResult && cleanTitleResult.cleanTitle) {
        if (cleanTitleResult.cleanTitle !== enrichedSip.title) {
            enrichedSip.cleanTitle = cleanTitleResult.cleanTitle;
            console.log(`enrichSipWithAiData: Successfully generated NEW clean title for SIP ${enrichedSip.id}: "${enrichedSip.cleanTitle}" (Original: "${enrichedSip.title}")`);
        } else {
            enrichedSip.cleanTitle = enrichedSip.title; // Explicitly set to original if AI returned the same
            console.log(`enrichSipWithAiData: AI-generated clean title for SIP ${enrichedSip.id} is SAME as original: "${enrichedSip.title}". Using original.`);
        }
    } else {
        enrichedSip.cleanTitle = enrichedSip.title; // Fallback if no result or empty title
        console.log(`enrichSipWithAiData: Clean title for SIP ${enrichedSip.id} was not generated or invalid by AI. Using original title: "${enrichedSip.title}"`);
    }
  } catch (titleError: any) {
    console.warn(`AI clean title generation process failed for SIP ${enrichedSip.id}: ${titleError.message}. Using original title.`);
    enrichedSip.cleanTitle = enrichedSip.title; // Fallback
  }
  return enrichedSip;
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

    const allFetches = await Promise.all([
      fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder'),
      fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder'),
      ...prSipsPromises,
    ]);
    
    const mainFolderSipsData = allFetches[0];
    const withdrawnFolderSipsData = allFetches[1];
    const prSipsResults = allFetches.slice(2).flat();


    console.log(`getAllSips: Fetched ${mainFolderSipsData.length} SIPs from main folder.`);
    console.log(`getAllSips: Fetched ${withdrawnFolderSipsData.length} SIPs from withdrawn folder.`);
    console.log(`getAllSips: Total potential SIPs from ${MAX_PR_PAGES_TO_FETCH} PR pages: ${prSipsResults.length}`);

    const combinedSipsMap = new Map<string, SIP>();
    
    const allProcessedSips = [
        ...prSipsResults.filter(s => s.source === 'pull_request_only'),
        ...prSipsResults.filter(s => s.source === 'pull_request'),
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
        let mergedSip = { ...existingSip };

        if (currentSip.title && !currentSip.title.startsWith(`PR #${currentSip.prNumber} Discussion`)) {
            mergedSip.title = currentSip.title;
        } else if (!mergedSip.title.startsWith(`PR #${mergedSip.prNumber} Discussion`) && existingSip.title) {
            // keep existing
        } else {
             mergedSip.title = currentSip.title || existingSip.title;
        }
        
        if (currentSip.cleanTitle && currentSip.cleanTitle !== currentSip.title) {
            mergedSip.cleanTitle = currentSip.cleanTitle;
        } else if (mergedSip.title !== existingSip.title) {
             mergedSip.cleanTitle = mergedSip.title;
        } else {
            mergedSip.cleanTitle = existingSip.cleanTitle || mergedSip.title;
        }
        
        if (currentSip.body && currentSip.body.trim() !== "") {
            mergedSip.body = currentSip.body;
        }

        if (currentSip.summary && currentSip.summary !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
            mergedSip.summary = currentSip.summary;
        } else if (existingSip.summary === INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD && currentSip.summary) {
            mergedSip.summary = currentSip.summary;
        }
        
        mergedSip.labels = currentSip.labels && currentSip.labels.length > 0 ? currentSip.labels : existingSip.labels;
        
        // Date merging logic
        const validExistingCreatedAt = existingSip.createdAt && existingSip.createdAt !== FALLBACK_CREATED_AT_DATE;
        const validCurrentCreatedAt = currentSip.createdAt && currentSip.createdAt !== FALLBACK_CREATED_AT_DATE;
        if (validCurrentCreatedAt && (!validExistingCreatedAt || new Date(currentSip.createdAt!) < new Date(existingSip.createdAt!))) {
            mergedSip.createdAt = currentSip.createdAt!;
        } else if (!validCurrentCreatedAt && validExistingCreatedAt) {
            // Keep existing valid created at
        } else { // Both valid and current is not earlier, or both fallback/invalid
            mergedSip.createdAt = currentSip.createdAt || existingSip.createdAt || FALLBACK_CREATED_AT_DATE;
        }


        let bestUpdatedAt = mergedSip.createdAt;
        const validExistingUpdatedAt = existingSip.updatedAt && existingSip.updatedAt !== FALLBACK_CREATED_AT_DATE && new Date(existingSip.updatedAt) >= new Date(mergedSip.createdAt);
        const validCurrentUpdatedAt = currentSip.updatedAt && currentSip.updatedAt !== FALLBACK_CREATED_AT_DATE && new Date(currentSip.updatedAt) >= new Date(mergedSip.createdAt);

        if (validExistingUpdatedAt && validCurrentUpdatedAt) {
            bestUpdatedAt = new Date(existingSip.updatedAt!) > new Date(currentSip.updatedAt!) ? existingSip.updatedAt! : currentSip.updatedAt!;
        } else if (validExistingUpdatedAt) {
            bestUpdatedAt = existingSip.updatedAt!;
        } else if (validCurrentUpdatedAt) {
            bestUpdatedAt = currentSip.updatedAt!;
        }
        mergedSip.updatedAt = bestUpdatedAt;


        mergedSip.mergedAt = currentSip.mergedAt !== undefined ? currentSip.mergedAt : existingSip.mergedAt;
        if (mergedSip.mergedAt === FALLBACK_CREATED_AT_DATE) mergedSip.mergedAt = undefined; // Ensure fallback is not used for mergedAt


        mergedSip.prNumber = currentSip.prNumber || existingSip.prNumber;
        mergedSip.author = currentSip.author || existingSip.author;
        mergedSip.filePath = currentSip.filePath || existingSip.filePath;
        mergedSip.prUrl = currentSip.prUrl || existingSip.prUrl;
        mergedSip.type = currentSip.type || existingSip.type;


        if (currentSip.source === 'folder' || currentSip.source === 'withdrawn_folder') {
            mergedSip.status = currentSip.status;
        } else if (currentSip.source === 'pull_request' && existingSip.source !== 'pull_request_only') {
            mergedSip.status = currentSip.status;
        } else if (currentSip.source === 'pull_request_only' && existingSip.source !== 'pull_request_only') {
            mergedSip.status = existingSip.status;
        } else {
            mergedSip.status = currentSip.status;
        }
        
        mergedSip.source = currentSip.source === 'pull_request_only' && existingSip.source !== 'pull_request_only' ? existingSip.source : currentSip.source;


        if (mergedSip.source === 'withdrawn_folder' || (mergedSip.filePath && mergedSip.filePath.includes(SIPS_WITHDRAWN_PATH))) {
            mergedSip.status = 'Withdrawn';
        } else if (mergedSip.mergedAt && !['Final', 'Live', 'Archived', 'Withdrawn', 'Rejected'].includes(mergedSip.status)) {
             mergedSip.status = 'Accepted';
        } else if (mergedSip.status === 'Draft (no file)' && mergedSip.body && mergedSip.body.trim().length > 0) {
            mergedSip.status = 'Draft';
        }

        combinedSipsMap.set(key, mergedSip);
      }
    }

    let sipsNoAi = Array.from(combinedSipsMap.values());

    const enrichedSipsPromises = sipsNoAi.map(async (sip) => {
      try {
        const sipToEnrich = { ...sip, cleanTitle: sip.cleanTitle || sip.title };
        return await enrichSipWithAiData(sipToEnrich);
      } catch (enrichError) {
        console.error(`Error enriching SIP ${sip.id} with AI data:`, enrichError);
        return { ...sip, aiSummary: USER_REQUESTED_FALLBACK_AI_SUMMARY, cleanTitle: sip.title };
      }
    });
    let sips = await Promise.all(enrichedSipsPromises);


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

      const dateA = a.mergedAt || a.updatedAt || a.createdAt;
      const dateB = b.mergedAt || b.updatedAt || b.createdAt;
      const timeA = dateA ? new Date(dateA).getTime() : 0;
      const timeB = dateB ? new Date(dateB).getTime() : 0;
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
    console.error("Critical error in getAllSips pipeline. Error:", error.message, error.stack);
    sipsCache = null;
    return [];
  }
}

export async function getSipById(id: string, forceRefresh: boolean = false): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();
  const COMMENTS_PER_PAGE = 15;

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION) || forceRefresh) {
    console.log(`getSipById(${id}): Cache miss or forced refresh. Calling getAllSips.`);
    sipsToSearch = await getAllSips(true);
  } else {
    console.log(`getSipById(${id}): Using cached SIP list.`);
  }

  if (!sipsToSearch || sipsToSearch.length === 0) {
    console.warn(`getSipById(${id}): No SIPs available in sipsToSearch.`);
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
    const existingSipNumericMatch = sip.id.toLowerCase().match(/^(?:sip-)?0*(\d+)$/);
    let comparableExistingId = sip.id.toLowerCase();
    if (existingSipNumericMatch && existingSipNumericMatch[1]) {
        comparableExistingId = formatSipId(existingSipNumericMatch[1]).toLowerCase();
    }
    return comparableExistingId === normalizedIdInput;
  });

  if (!foundSip) {
    console.log(`getSipById(${id}): SIP with normalized ID '${normalizedIdInput}' not found.`);
    return null;
  }
  console.log(`getSipById(${id}): Found SIP: ${foundSip.id}, PR: ${foundSip.prNumber}`);

  const sipRequiresEnrichment = !foundSip.cleanTitle ||
                                foundSip.cleanTitle === foundSip.title ||
                                !foundSip.aiSummary ||
                                foundSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;

  if (sipRequiresEnrichment) {
      console.log(`getSipById(${id}): SIP ${foundSip.id} needs AI enrichment (on-demand). Current cleanTitle: "${foundSip.cleanTitle}", AI Summary Status: ${foundSip.aiSummary?.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs ? 'Fallback' : 'Exists'}`);
      try {
          
          const sipToEnrich = { ...foundSip, cleanTitle: foundSip.cleanTitle || foundSip.title };
          const reEnrichedSip = await enrichSipWithAiData(sipToEnrich);
          Object.assign(foundSip, reEnrichedSip);
      } catch (e: any) {
          console.warn(`getSipById(${id}): Error during on-demand AI enrichment for SIP ${foundSip.id}: ${e.message}`);
      }
  }


  if (foundSip.prNumber) {
    try {
      console.log(`getSipById(${id}): Fetching comments for PR #${foundSip.prNumber}`);
      const issueCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/issues/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;
      const reviewCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;

      const results = await Promise.all([
        fetchFromGitHubAPI(issueCommentsUrl, 60).catch(e => { console.error(`Error fetching issue comments for PR #${foundSip.prNumber}: ${e.message}`); return [] as GitHubIssueComment[]; }),
        fetchFromGitHubAPI(reviewCommentsUrl, 60).catch(e => { console.error(`Error fetching review comments for PR #${foundSip.prNumber}: ${e.message}`); return [] as GitHubReviewComment[]; })
      ]);
      const rawIssueComments: GitHubIssueComment[] = results[0] || [];
      const rawReviewComments: GitHubReviewComment[] = results[1] || [];

      console.log(`getSipById(${id}): Fetched ${rawIssueComments.length} issue comments and ${rawReviewComments.length} review comments for PR #${foundSip.prNumber}.`);

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
      console.error(`[getSipById(${id})] Error processing comments for SIP ${sipIdForError}, PR #${prNumForError}. Error: ${commentError?.message || 'Unknown error during comment processing'}`, commentError.stack);
      if (foundSip) {
        foundSip.comments = [];
        foundSip._rawIssueCommentCount = 0;
        foundSip._rawReviewCommentCount = 0;
        foundSip._commentFetchLimit = COMMENTS_PER_PAGE;
      }
    }
  } else if (foundSip) {
    console.log(`getSipById(${id}): No PR number for SIP ${foundSip.id}, skipping comment fetch.`);
    foundSip.comments = [];
    foundSip._rawIssueCommentCount = 0;
    foundSip._rawReviewCommentCount = 0;
    foundSip._commentFetchLimit = COMMENTS_PER_PAGE;
  }

  return foundSip;
}

