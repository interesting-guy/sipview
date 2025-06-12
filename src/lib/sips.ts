
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

// Fallback AI Summary for SIPs where AI generation isn't appropriate or fails.
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
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      const rateLimitReset = response.headers.get('x-ratelimit-reset');
      console.error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}. RL-Remaining: ${rateLimitRemaining}, RL-Reset: ${rateLimitReset}. Body: ${errorBody}`);
      throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}. RL-Remaining: ${rateLimitRemaining}`);
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
    let idSource = "unknown"; // For logging/debugging where the ID came from
    const frontmatterTitle = frontmatter.title || frontmatter.name;

    // Try to get SIP number from frontmatter first
    const fmSipField = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    if (fmSipField !== undefined && String(fmSipField).match(/^\d+$/)) {
      sipNumberStr = String(fmSipField);
      idSource = "frontmatter";
    }

    // Fallback to filename if not in frontmatter
    if (!sipNumberStr) {
      const fileNameNumMatch = fileName.match(/^(?:sip-)?(\d+)(?:[.\-_].*|\.md$)/i);
      if (fileNameNumMatch && fileNameNumMatch[1]) {
        sipNumberStr = fileNameNumMatch[1];
        idSource = "filename numeric part";
      } else {
        // Check for filenames that are just numbers (e.g., "005.md")
        const fileNameDirectNumMatch = fileName.match(/^(\d+)(?:[.\-_].*|\.md$)/i);
        if (fileNameDirectNumMatch && fileNameDirectNumMatch[1]) {
            sipNumberStr = fileNameDirectNumMatch[1];
            idSource = "filename direct number";
        }
      }
    }

    // If it's a PR source and still no number, try extracting from PR title
    if (!sipNumberStr && (source === 'pull_request') && optionPrTitle) {
      const numFromTitle = extractSipNumberFromPrTitle(optionPrTitle);
      if (numFromTitle) {
        sipNumberStr = numFromTitle;
        idSource = "PR title";
      }
    }
    
    // If this file is from a PR, and it seems like a generic MD file (no self-declared SIP ID or title in frontmatter),
    // and we couldn't get a SIP number from its name or PR title,
    // then it's better to let the PR's placeholder logic handle this PR.
    // This check is refined to defer if SIP ID is ONLY from PR number AND title is ONLY from PR title.
    const onlyIdFromPrNum = source === 'pull_request' && !sipNumberStr && optionPrNumber !== undefined;
    const onlyTitleFromPrTitle = !frontmatterTitle && optionPrTitle;

    if (source === 'pull_request' && !sipNumberStr && !frontmatterTitle && optionPrNumber !== undefined && optionPrTitle) {
      // This condition specifically targets files within PRs that don't assert their own SIP identity.
      // If a file in a PR is, e.g., "README.md" and has no SIP frontmatter, it should be skipped here
      // so that the placeholder for the PR itself (e.g., based on PR number) can be created.
      console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) likely generic or not a primary SIP doc for this PR. SIP ID from PR num: ${optionPrNumber}, SIP Title from PR: "${optionPrTitle}". Associated PR num: ${optionPrNumber}. Placeholder logic for PR #${optionPrNumber} should handle this.`);
      return null;
    }


    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
    } else {
        // If no numeric ID can be found, and it's not from a PR (where PR number would be the fallback),
        // create a generic ID based on filename for folder-based SIPs.
        if (source === 'folder' || source === 'withdrawn_folder') {
            id = `sip-generic-${fileName.replace(/\.md$/, '').toLowerCase().replace(/[\s_]+/g, '-')}`;
            idSource = "generic fallback filename (folder)";
        } else {
             // This case should ideally be caught by the "DEFER_TO_PLACEHOLDER" logic above for PR files.
             // If we reach here for a PR file, it means it's an un-identifiable file from a PR.
             console.warn(`  [ID_WARN_NULL_RETURN_PR_FILE] Could not determine numeric SIP ID for PR file: ${fileName}, path: ${filePath}, source: ${source}. PR title: "${optionPrTitle}", PR num: ${optionPrNumber}. File will be skipped by parseSipFile.`);
             return null; // Skip this file from PR if it's unidentifiable
        }
    }

    let sipTitle = frontmatterTitle;
    if (!sipTitle && (source === 'pull_request') && optionPrTitle) {
      sipTitle = optionPrTitle; // Use PR title if frontmatter title is missing for PR-sourced files
    }
    // If still no title, create a fallback based on ID.
    if (!sipTitle) {
        // Use a more generic placeholder if ID is also generic
        sipTitle = `SIP ${id.replace(/^sip-(?:generic-)?/, '').replace(/^0+/, '') || 'Proposal Document'}`;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    let resolvedStatus: SipStatus = defaultStatus;

    if (statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)) {
        resolvedStatus = statusFromFrontmatter;
    } else if (source === 'pull_request') {
        // If status is not in frontmatter for a PR-sourced file, derive from PR state
        if (optionMergedAt) {
            resolvedStatus = 'Accepted'; // Or 'Final' if we decide merged PRs are final, but 'Accepted' seems safer from PR context
        } else if (optionPrState === 'open') {
            resolvedStatus = 'Draft';
        } else { // Closed but not merged
            resolvedStatus = 'Closed (unmerged)';
        }
    }


    // AI Summary Generation
    const abstractOrDescriptionFM = frontmatter.abstract || frontmatter.description;
    let textualSummary: string;

    const hasSufficientBody = body && body.trim().length > 10;
    const hasSufficientAbstractFM = abstractOrDescriptionFM && abstractOrDescriptionFM.trim().length > 10;

    let aiInputSipBody: string | undefined = hasSufficientBody ? body : undefined;
    let aiInputAbstractOrDescription: string | undefined = hasSufficientAbstractFM ? abstractOrDescriptionFM : undefined;

    // If both are empty, try to use the PR title/body (if source is PR) or the SIP title itself for AI input
    if (!aiInputSipBody && !aiInputAbstractOrDescription) {
      if (source === 'pull_request' && optionPrTitle) {
        aiInputAbstractOrDescription = optionPrTitle; // PR title as primary
        aiInputSipBody = optionPrBody || undefined;   // PR body as secondary
      } else if (sipTitle && sipTitle.trim().length > 5 && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #")) { // Avoid generic "SIP X" titles
          aiInputAbstractOrDescription = sipTitle;
      }
    }

    const generatedAiSummary: AiSummary = await summarizeSipContentStructured({
        sipBody: aiInputSipBody,
        abstractOrDescription: aiInputAbstractOrDescription,
    });


    // Determine the human-readable textual summary (sip.summary)
    if (frontmatter.summary && String(frontmatter.summary).trim() !== "") {
        textualSummary = String(frontmatter.summary);
    } else if (generatedAiSummary && generatedAiSummary.whatItIs !== USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs && generatedAiSummary.whatItIs !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
        // Construct a brief summary from AI points if no explicit summary exists
        textualSummary = `${generatedAiSummary.whatItIs} ${generatedAiSummary.whatItChanges} ${generatedAiSummary.whyItMatters}`.replace(/-/g, '').trim();
        if (textualSummary.length > 200) textualSummary = textualSummary.substring(0, 197) + "...";
        if (textualSummary === "No summary available yet.  ") textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD;
    } else if (abstractOrDescriptionFM) {
        textualSummary = abstractOrDescriptionFM.substring(0, 200) + (abstractOrDescriptionFM.length > 200 ? "..." : "");
    } else if (body && body.trim() !== "") {
        textualSummary = body.substring(0, 120).split('\n')[0] + "..."; // First line or 120 chars
    } else if (sipTitle && !sipTitle.startsWith("SIP ") && !sipTitle.startsWith("PR #")) { // Use title if it's descriptive
        textualSummary = sipTitle;
    } else {
        textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD;
    }


    let prUrlToUse = optionPrUrl;
    if (!prUrlToUse) { // If PR URL not directly from options (e.g. folder source)
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            // Try to use discussions-to if it's a valid PR/issue link
            prUrlToUse = frontmatter['discussions-to'];
        } else {
            // Fallback for folder SIPs without explicit PR link: link to the file itself
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/blob/${SIPS_REPO_BRANCH}/${filePath}`;
        }
    }

    // Timestamps
    let createdAtISO: string;
    let updatedAtISO: string | undefined;

    if (source === 'pull_request') {
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE;
        if (createdAtISO === FALLBACK_CREATED_AT_DATE && optionCreatedAt) {
             console.warn(`[TIMESTAMP_WARN_PR_FILE_INVALID_CREATED] Invalid createdAt from PR options for SIP ID ${id}, PR #${optionPrNumber}. File: ${fileName}. Input: ${optionCreatedAt}. Using fallback.`);
        }
        updatedAtISO = parseValidDate(optionUpdatedAt);
    } else { // folder or withdrawn_folder
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date);
      if (!createdAtISO) { // Mandatory field
           console.warn(`[TIMESTAMP_WARN_FOLDER_FILE_MISSING_CREATED] Missing or invalid createdAt from frontmatter for SIP ID ${id}. File: ${fileName}. Input: ${frontmatter.created || frontmatter.date}. Using fallback.`);
           createdAtISO = FALLBACK_CREATED_AT_DATE;
      }
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    let mergedAtVal: string | undefined;
    // If 'mergedAt' is explicitly passed in options (from PR processing), use that.
    if ((source === 'pull_request') && optionMergedAt !== undefined) { // optionMergedAt can be null
        mergedAtVal = optionMergedAt === null ? undefined : parseValidDate(optionMergedAt);
    } else {
        // Otherwise, try to get it from frontmatter.
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
    // 1. Create placeholder SIP for EVERY PR first
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

    // For PRs that are just placeholders (no actual SIP file defining this PR's number as its ID)
    // we use a more generic AI summary to avoid excessive AI calls for non-critical items.
    const placeholderAiSummary: AiSummary = {
      whatItIs: `Tracks discussion for Pull Request #${pr.number}: "${pr.title || 'Untitled PR'}".`,
      whatItChanges: `Refer to the PR on GitHub for specific proposed changes. Current PR status: ${placeholderStatus}.`,
      whyItMatters: "This entry represents a proposal or modification idea at the Pull Request stage.",
    };

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
    console.log(`  PR #${pr.number} ("${(pr.title || '').substring(0,30)}..."): Created placeholder SIP. ID: ${placeholderSip.id}, Status: ${placeholderSip.status}`);


    // 2. Process files within the PR
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
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
              prBody: pr.body
            });

            if (parsedSipFromFile) {
              sipsFromPRs.push(parsedSipFromFile);
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

    const mergedFilePrInfoMap = new Map<string, {
        prUrl: string;
        author?: string;
        prNumber?: number;
        createdAt: string;
        updatedAt?: string;
        mergedAt?: string;
        prTitle?: string;
        prState?: 'open' | 'closed';
    }>();

    for (const prSip of prSipsData) {
        if (prSip.source === 'pull_request' && prSip.filePath && prSip.prNumber) {
            const existing = mergedFilePrInfoMap.get(prSip.filePath);
            const prTimestamp = prSip.mergedAt || prSip.updatedAt || prSip.createdAt;
            const existingTimestamp = existing?.mergedAt || existing?.updatedAt || existing?.createdAt;

            if (!existing || (prTimestamp && existingTimestamp && new Date(prTimestamp) > new Date(existingTimestamp)) || (prTimestamp && !existingTimestamp)) {
                 mergedFilePrInfoMap.set(prSip.filePath, {
                    prUrl: prSip.prUrl,
                    author: prSip.author,
                    prNumber: prSip.prNumber,
                    createdAt: prSip.createdAt,
                    updatedAt: prSip.updatedAt,
                    mergedAt: prSip.mergedAt,
                    prTitle: prSip.title, // Assuming prSip.title holds the PR title for source 'pull_request'
                    prState: prSip.status === "Draft" || prSip.status === "Draft (no file)" ? 'open' : 'closed', // Approximate prState
                });
            }
        }
    }

    const enrichFolderSip = (folderSip: SIP, prInfo: ReturnType<typeof mergedFilePrInfoMap.get>): SIP => {
        if (!prInfo) return folderSip;
        const enriched: SIP = { ...folderSip };

        enriched.prUrl = prInfo.prUrl || enriched.prUrl;
        enriched.author = prInfo.author || enriched.author;
        enriched.prNumber = prInfo.prNumber || enriched.prNumber;

        // Prioritize PR timestamps if they are more recent or folderSip's are missing/default
        const folderSipCreated = folderSip.createdAt && folderSip.createdAt !== FALLBACK_CREATED_AT_DATE ? new Date(folderSip.createdAt) : null;
        const prInfoCreated = new Date(prInfo.createdAt);
        if (!folderSipCreated || (folderSipCreated && prInfoCreated < folderSipCreated)) {
            enriched.createdAt = prInfo.createdAt;
        }
        
        const folderSipUpdated = folderSip.updatedAt ? new Date(folderSip.updatedAt) : null;
        const prInfoUpdated = prInfo.updatedAt ? new Date(prInfo.updatedAt) : null;

        if (prInfoUpdated) {
            if (!folderSipUpdated || prInfoUpdated > folderSipUpdated) {
                enriched.updatedAt = prInfo.updatedAt;
            }
        }
        
        enriched.mergedAt = prInfo.mergedAt || enriched.mergedAt;

        if (folderSip.source === 'folder' && (prInfo.prNumber || prInfo.mergedAt)) {
          enriched.source = 'folder+pr';
        }
        
        // Status update based on PR if folder SIP isn't 'Final' or 'Live' already
        if (folderSip.status !== 'Final' && folderSip.status !== 'Live' && folderSip.status !== 'Withdrawn') {
            if (prInfo.mergedAt) {
                enriched.status = 'Accepted'; // More conservative than 'Final' directly from PR merge
            } else if (prInfo.prState === 'open' && folderSip.status !== 'Draft' && folderSip.status !== 'Proposed') {
                 // enriched.status = 'Draft'; // If PR is open and folder SIP is not yet draft/proposed
            } else if (prInfo.prState === 'closed' && !prInfo.mergedAt && folderSip.status !== 'Closed (unmerged)') {
                 // enriched.status = 'Closed (unmerged)';
            }
        }
        if (folderSip.source === 'withdrawn_folder') { // Ensure withdrawn status from folder is authoritative
            enriched.status = 'Withdrawn';
        }


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
            enriched.status = 'Withdrawn';
            return enriched;
        }
        if (sip.status !== 'Withdrawn') sip.status = 'Withdrawn';
        return sip;
    });


    const combinedSipsMap = new Map<string, SIP>();
    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0,
        'pull_request': 1,
        'folder': 2,
        'folder+pr': 3,
        'withdrawn_folder': 4,
    };

    const allProcessedSips = [
        ...prSipsData,
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

        let sipToKeep: SIP = currentSip; // Default to current if equal precedence

        if (currentPrecedence > existingPrecedence) {
            sipToKeep = { ...existingSip, ...currentSip };
        } else if (existingPrecedence > currentPrecedence) {
            sipToKeep = { ...currentSip, ...existingSip };
        } else { // Equal precedence, merge carefully
            sipToKeep = { ...existingSip, ...currentSip }; // currentSip's individual fields take precedence

            // Specific merges for equal precedence:
            // Timestamps: prefer the most recent valid one
            const chooseRecent = (date1Str?: string, date2Str?: string): string | undefined => {
                const date1 = date1Str ? new Date(date1Str) : null;
                const date2 = date2Str ? new Date(date2Str) : null;
                if (date1 && date2) return date1 > date2 ? date1Str : date2Str;
                return date1Str || date2Str;
            };
            sipToKeep.updatedAt = chooseRecent(existingSip.updatedAt, currentSip.updatedAt);
            sipToKeep.mergedAt = chooseRecent(existingSip.mergedAt, currentSip.mergedAt);
            // createdAt is usually more fixed, currentSip.createdAt (from the loop) should be fine.

            // Body: prefer non-empty body
            if (!currentSip.body && existingSip.body) sipToKeep.body = existingSip.body;
            
            // Summary: prefer non-generic summary
             if (currentSip.summary === INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD && existingSip.summary !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
                sipToKeep.summary = existingSip.summary;
            }

            // AI Summary: prefer non-fallback AI summary
            const isCurrentAiFallback = currentSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;
            const isExistingAiFallback = existingSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;
            if(isCurrentAiFallback && !isExistingAiFallback) sipToKeep.aiSummary = existingSip.aiSummary;
            // If !isCurrentAiFallback && isExistingAiFallback, currentSip.aiSummary is already preferred.
        }
        
        if (currentSip.source === 'withdrawn_folder' || existingSip.source === 'withdrawn_folder') {
            sipToKeep.status = 'Withdrawn';
            sipToKeep.source = 'withdrawn_folder';
        }
        combinedSipsMap.set(key, sipToKeep);
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

  if (foundSip) {
    console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) found.`);
    return foundSip;
  }

  console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) not found after search of ${sipsToSearch?.length} SIPs.`);
  return null;
}

