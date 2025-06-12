
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
    if (source === 'pull_request' && !sipNumberStr && !frontmatterTitle && optionPrNumber !== undefined && optionPrTitle) {
        console.log(`  [DEFER_TO_PLACEHOLDER] PR file (path: ${filePath}, name: ${fileName}) likely generic. SIP ID from PR num: ${optionPrNumber}, SIP Title from PR: "${optionPrTitle}". Associated PR num: ${optionPrNumber}. Placeholder logic for PR #${optionPrNumber} should handle this.`);
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
      } else if (sipTitle && sipTitle.trim().length > 5 && !sipTitle.startsWith("SIP ")) { // Avoid generic "SIP X" titles
          aiInputAbstractOrDescription = sipTitle;
      }
    }

    const generatedAiSummary: AiSummary = await summarizeSipContentStructured({
        sipBody: aiInputSipBody,
        abstractOrDescription: aiInputAbstractOrDescription,
    });


    // Determine the human-readable textual summary (sip.summary)
    if (frontmatter.summary) {
        textualSummary = String(frontmatter.summary);
    } else if (generatedAiSummary && generatedAiSummary.whatItIs !== USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs && generatedAiSummary.whatItIs !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
        // Construct a brief summary from AI points if no explicit summary exists
        textualSummary = `${generatedAiSummary.whatItIs} ${generatedAiSummary.whatItChanges} ${generatedAiSummary.whyItMatters}`.replace(/-/g, '').trim();
        if (textualSummary.length > 200) textualSummary = textualSummary.substring(0, 197) + "...";
    } else if (abstractOrDescriptionFM) {
        textualSummary = abstractOrDescriptionFM.substring(0, 200) + (abstractOrDescriptionFM.length > 200 ? "..." : "");
    } else if (body) {
        textualSummary = body.substring(0, 120).split('\n')[0] + "..."; // First line or 120 chars
    } else if (sipTitle && !sipTitle.startsWith("SIP ")) { // Use title if it's descriptive
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

    if (source === 'pull_request' || source === 'pull_request_only') { // Note: 'pull_request_only' isn't passed to parseSipFile
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
    if ((source === 'pull_request' || source === 'pull_request_only') && optionMergedAt !== undefined) { // optionMergedAt can be null
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
      aiSummary: generatedAiSummary, // Now always a valid AiSummary object
      body,
      prUrl: prUrlToUse!,
      source,
      createdAt: createdAtISO,
      updatedAt: updatedAtISO, // Can be undefined
      mergedAt: mergedAtVal, // Can be undefined
      author: sipAuthor,
      prNumber: optionPrNumber || prNumberFromFrontmatter, // Prioritize PR num from options
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
          // PR-specific fields are not applicable here initially, might be enriched later
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
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=100`; // Fetch more PRs to increase chance of finding relevant ones
  let allPRs: GitHubPullRequest[];
  try {
    allPRs = await fetchFromGitHubAPI(allPRsUrl);
  } catch (error) {
    console.error("Failed to fetch pull requests:", error);
    return [];
  }

  const sipsFromPRs: SIP[] = [];

  for (const pr of allPRs) {
    let foundSipFileInPr = false; // Flag to track if a SIP file was parsed from this PR

    // First, process any actual SIP files within the PR
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files?per_page=100`;
    try {
      const filesInPr = await fetchFromGitHubAPI(prFilesUrl, 60 * 5) as GitHubFile[]; // Cache for 5 mins
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

        // Check if the file is in a SIPs directory and is a markdown file, not a template
        const isInSipsDir = filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/') && !filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');
        const isInWithdrawnSipsDir = filePathInPr.startsWith(SIPS_WITHDRAWN_PATH + '/') || filePathInPr.startsWith(SIPS_MAIN_BRANCH_PATH + '/' + SIPS_WITHDRAWN_PATH + '/');


        const isCandidateSipFile = (isInSipsDir || isInWithdrawnSipsDir) &&
                                   filePathInPr.endsWith('.md') &&
                                   !fileName.toLowerCase().includes('template');

        // Consider files that were added, modified, or renamed as relevant changes
        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);

        if (isRelevantChange && isCandidateSipFile && file.raw_url) {
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            // Determine default status based on PR state and file location
            let fileDefaultStatus: SipStatus = 'Draft';
            if (isInWithdrawnSipsDir) {
                fileDefaultStatus = 'Withdrawn'; // If file is in withdrawn path, default to withdrawn
            } else if (pr.merged_at) {
                fileDefaultStatus = 'Accepted';
            } else if (pr.state === 'closed') { // Closed but not merged
                fileDefaultStatus = 'Closed (unmerged)';
            }
            // For open PRs, defaultStatus remains 'Draft'

            const parsedSipFromFile = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePathInPr,
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              prState: pr.state,
              createdAt: pr.created_at, // Pass PR's creation as potential SIP creation
              updatedAt: pr.updated_at, // Pass PR's update as potential SIP update
              mergedAt: pr.merged_at,   // Pass PR's merge date
              author: pr.user?.login,
              defaultStatus: fileDefaultStatus,
              source: 'pull_request',
              prBody: pr.body
            });

            if (parsedSipFromFile) {
              sipsFromPRs.push(parsedSipFromFile);
              foundSipFileInPr = true; // Mark that we found and parsed a SIP file from this PR
              console.log(`  PR #${pr.number}: Parsed SIP from file ${filePathInPr}. ID: ${parsedSipFromFile.id}, Status: ${parsedSipFromFile.status}`);
            }
          } catch (error) {
            // Log error and continue with other files/PRs
            console.error(`  PR #${pr.number}: Error processing file ${filePathInPr} content:`, error);
          }
        }
      }
    } catch (error) {
        // Log error and continue; this PR might not have files or API failed
        console.error(`Error fetching/processing files for PR #${pr.number}:`, error);
    }

    // If no SIP file was parsed from this PR, create a placeholder SIP
    // This ensures every PR (especially those just discussing ideas or without formal SIP docs yet) is represented.
    if (!foundSipFileInPr) {
      const placeholderSipId = formatSipId(pr.number); // Use PR number for placeholder ID
      let placeholderStatus: SipStatus;
      const prBodyLower = (pr.body || "").toLowerCase();
      const prTitleLower = (pr.title || "").toLowerCase();
      const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn");

      if (pr.state === 'closed') {
          if (pr.merged_at) {
              placeholderStatus = 'Accepted'; // Merged PRs are considered Accepted
          } else if (mentionsWithdrawnText) { // Closed, unmerged, mentions withdrawn
              placeholderStatus = 'Withdrawn';
          }
           else { // Closed, unmerged, no withdrawn keyword
              placeholderStatus = 'Closed (unmerged)';
          }
      } else { // Open PR
          placeholderStatus = 'Draft (no file)'; // Or 'Proposed' if we prefer
      }

      const placeholderSummaryText = `Status from PR: ${placeholderStatus}. Title: "${pr.title || `PR #${pr.number}`}"`;

      // Generate AI summary for the PR placeholder using its title and body
      const placeholderAiSummary: AiSummary = await summarizeSipContentStructured({
        abstractOrDescription: pr.title || `Pull Request #${pr.number}`,
        sipBody: pr.body || undefined,
      });

      const placeholderSip: SIP = {
        id: placeholderSipId,
        title: pr.title || `PR #${pr.number} Discussion`,
        status: placeholderStatus,
        summary: placeholderSummaryText,
        aiSummary: placeholderAiSummary, // Use the generated or fallback AI summary
        body: pr.body || undefined, // Include PR body if available
        prUrl: pr.html_url,
        source: 'pull_request_only', // Distinct source for these placeholders
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at || undefined, // Can be null, store as undefined
        author: pr.user?.login,
        prNumber: pr.number,
        filePath: undefined, // No specific file path for placeholder
      };
      sipsFromPRs.push(placeholderSip);
      console.log(`  PR #${pr.number} ("${(pr.title || '').substring(0,30)}..."): Created placeholder SIP. ID: ${placeholderSip.id}, Status: ${placeholderSip.status}`);
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

    // Create a map to store PR info keyed by file path for easy lookup
    // This map will help enrich folder SIPs with PR metadata if they were merged via a PR.
    const mergedFilePrInfoMap = new Map<string, {
        prUrl: string;
        author?: string;
        prNumber?: number;
        createdAt: string; // from PR
        updatedAt?: string; // from PR
        mergedAt?: string;  // from PR, can be undefined
    }>();

    // Populate the map with info from PRs that involved file changes
    for (const prSip of prSipsData) {
        // Only consider SIPs parsed from files within PRs for this map
        if (prSip.source === 'pull_request' && prSip.filePath && prSip.prNumber) {
            const existing = mergedFilePrInfoMap.get(prSip.filePath);
            // If this PR is more recent (later update or merge date), update the map entry.
            // This prioritizes the latest PR that touched a file.
            const prTimestamp = prSip.mergedAt || prSip.updatedAt || prSip.createdAt;
            const existingTimestamp = existing?.mergedAt || existing?.updatedAt || existing?.createdAt;

            if (!existing || (prTimestamp && existingTimestamp && new Date(prTimestamp) > new Date(existingTimestamp)) || (prTimestamp && !existingTimestamp)) {
                 mergedFilePrInfoMap.set(prSip.filePath, {
                    prUrl: prSip.prUrl,
                    author: prSip.author,
                    prNumber: prSip.prNumber,
                    createdAt: prSip.createdAt, // PR's creation time
                    updatedAt: prSip.updatedAt, // PR's last update time
                    mergedAt: prSip.mergedAt,   // PR's merge time
                });
            }
        }
    }

    // Enrich folder SIPs with PR information
    const enrichFolderSip = (folderSip: SIP, prInfo: ReturnType<typeof mergedFilePrInfoMap.get>): SIP => {
        if (!prInfo) return folderSip;
        const enriched: SIP = { ...folderSip };

        // Always prefer PR info for these fields if available, as PR lifecycle is more dynamic
        enriched.prUrl = prInfo.prUrl || enriched.prUrl; // prInfo.prUrl is likely more specific
        enriched.author = prInfo.author || enriched.author;
        enriched.prNumber = prInfo.prNumber || enriched.prNumber;

        // Crucially, use PR's timestamps if available, as they reflect actual activity
        enriched.createdAt = prInfo.createdAt; // Override with PR's createdAt
        enriched.updatedAt = prInfo.updatedAt || enriched.updatedAt; // Override with PR's updatedAt
        enriched.mergedAt = prInfo.mergedAt || enriched.mergedAt;   // Override with PR's mergedAt


        // Change source if it was a folder SIP now enriched with PR info
        if (folderSip.source === 'folder' && (prInfo.prNumber || prInfo.mergedAt)) {
          enriched.source = 'folder+pr';
        }

        // If the original folder SIP had a 'Final' status, and PR info confirms merge, keep 'Final'.
        // If it was 'Withdrawn' from folder, it stays 'Withdrawn'.
        // Otherwise, if PR info indicates merged, status could be 'Accepted' or 'Final' depending on conventions.
        // The defaultStatus for main folder is 'Final', so if it's enriched, it usually means it's a 'Final' SIP that was merged.
        // For withdrawn_folder, its status should remain 'Withdrawn'.
        if (enriched.source === 'withdrawn_folder' || folderSip.status === 'Withdrawn') {
            enriched.status = 'Withdrawn';
        } else if (prInfo.mergedAt && folderSip.status !== 'Live' && folderSip.status !== 'Final') {
            // If merged via PR, and not explicitly Live/Final by folder content,
            // it's at least 'Accepted'. If folderSip.status was 'Final', it remains 'Final'.
            // if (folderSip.status !== 'Final') enriched.status = 'Accepted';
        }
        // If folderSip.status is 'Final', it should typically remain 'Final'.
        // The default status for /sips/ folder items is 'Final'.
        // The `parseSipFile` function determines status based on frontmatter primarily.

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
            enriched.status = 'Withdrawn'; // Ensure status is 'Withdrawn' for these
            return enriched;
        }
        // Ensure status is 'Withdrawn' even if not enriched
        if (sip.status !== 'Withdrawn') sip.status = 'Withdrawn';
        return sip;
    });


    // Combine all SIPs and deduplicate
    const combinedSipsMap = new Map<string, SIP>();
    // Define precedence for merging. Higher value means higher precedence.
    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'pull_request_only': 0, // Lowest precedence
        'pull_request': 1,
        'folder': 2,
        'folder+pr': 3,          // Higher than plain folder or plain PR
        'withdrawn_folder': 4,   // Highest, as its status is authoritative
    };

    // Process all SIPs: PRs first, then enriched folder SIPs
    // This order helps in merging: PR placeholders < PR files < folder files < enriched folder files < withdrawn files
    const allProcessedSips = [
        ...prSipsData, // Includes placeholders and files from PRs
        ...enrichedMainFolderSips,
        ...enrichedWithdrawnFolderSips,
    ];


    for (const currentSip of allProcessedSips) {
      if (!currentSip || !currentSip.id) {
        console.warn("Skipping SIP with no ID during final combination:", currentSip);
        continue;
      }
      const key = currentSip.id.toLowerCase(); // Normalize ID for map key
      const existingSip = combinedSipsMap.get(key);

      if (!existingSip) {
        combinedSipsMap.set(key, currentSip);
      } else {
        // Determine which SIP entry to keep based on source precedence and content
        const currentPrecedence = sourcePrecedenceValues[currentSip.source] ?? -1;
        const existingPrecedence = sourcePrecedenceValues[existingSip.source] ?? -1;

        let sipToKeep: SIP;

        if (currentPrecedence >= existingPrecedence) {
            // Current SIP has higher or equal precedence, merge existing into current
            sipToKeep = { ...existingSip, ...currentSip };
        } else {
            // Existing SIP has higher precedence, merge current into existing
            sipToKeep = { ...currentSip, ...existingSip };
        }

        // AI Summary: Prefer the one that isn't the basic fallback or "insufficient"
        const isCurrentAiSummaryGeneric = currentSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs || currentSip.aiSummary.whatItIs.includes(INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD.substring(0,10));
        const isExistingAiSummaryGeneric = existingSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs || existingSip.aiSummary.whatItIs.includes(INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD.substring(0,10));

        if (isCurrentAiSummaryGeneric && !isExistingAiSummaryGeneric) {
            sipToKeep.aiSummary = existingSip.aiSummary;
        } else if (!isCurrentAiSummaryGeneric && isExistingAiSummaryGeneric) {
            sipToKeep.aiSummary = currentSip.aiSummary;
        } // else, if both are generic or both specific, the merge above handled it based on precedence.


        // Body: Prefer body content if one has it and the other doesn't (common for PR placeholders vs file-based)
        if (currentSip.body && !existingSip.body && existingSip.source === 'pull_request_only') {
            sipToKeep.body = currentSip.body;
        } else if (existingSip.body && !currentSip.body && currentSip.source === 'pull_request_only') {
            sipToKeep.body = existingSip.body;
        }


        // Ensure 'Withdrawn' status is sticky if one of the sources is withdrawn_folder
        if (currentSip.source === 'withdrawn_folder' || existingSip.source === 'withdrawn_folder') {
            sipToKeep.status = 'Withdrawn';
            sipToKeep.source = 'withdrawn_folder'; // Ensure source reflects this authoritative status
        }
        // If a 'folder+pr' entry meets a 'folder' entry, the 'folder+pr' (enriched) should win due to precedence.
        // If a 'folder+pr' entry meets a 'pull_request' entry, 'folder+pr' should win.

        combinedSipsMap.set(key, sipToKeep);
      }
    }

    let sips = Array.from(combinedSipsMap.values());

    // Final sort for display
    sips.sort((a, b) => {
      // Try to parse numeric part of ID for primary sort (e.g., sip-001 vs sip-010)
      const numA = parseInt(a.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-(?:generic-|sip-)?/, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA; // Sort by number descending
      } else if (!isNaN(numA)) {
        return -1; // Numeric IDs come before generic ones
      } else if (!isNaN(numB)) {
        return 1;
      }

      // Fallback sorting for non-numeric or identical numeric IDs
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Closed (unmerged)", "Withdrawn", "Rejected", "Archived"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex; // Sort by status precedence
      }

      // Then by last updated/merged/created date descending
      const updatedA = a.mergedAt || a.updatedAt || a.createdAt;
      const updatedB = b.mergedAt || b.updatedAt || b.createdAt;

      const timeA = updatedA ? new Date(updatedA).getTime() : 0;
      const timeB = updatedB ? new Date(updatedB).getTime() : 0;

      if (timeA !== timeB) {
        return timeB - timeA; // Sort by most recent activity
      }
      return a.id.localeCompare(b.id); // Finally by ID string
    });

    sipsCache = sips;
    cacheTimestamp = now;
    console.log(`Total unique SIPs processed and cached: ${sips.length}.`);
    return sips;
  } catch (error) {
    console.error("Error in getAllSips fetching/processing:", error);
    sipsCache = null; // Invalidate cache on error
    return []; // Return empty array on error to prevent site crash
  }
}

export async function getSipById(id: string, forceRefresh: boolean = false): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  // Check if cache is stale or forceRefresh is requested
  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION) || forceRefresh) {
    console.log(`Cache miss or forced refresh for getSipById(${id}). Re-fetching all SIPs.`);
    sipsToSearch = await getAllSips(true); // Pass true to ensure it refreshes
  } else {
    console.log(`Using cached SIPs for getSipById(${id}).`);
  }

  if (!sipsToSearch || sipsToSearch.length === 0) {
    console.log(`No SIPs available in cache or after fetch for getSipById(${id}).`);
    return null;
  }

  // Normalize the input ID for comparison
  let normalizedIdInput = id.toLowerCase();
  const numericMatch = normalizedIdInput.match(/^(?:sip-)?0*(\d+)$/); // Matches "sip-001", "sip-1", "001", "1"

  if (numericMatch && numericMatch[1]) {
    // If numeric, format it consistently (e.g., "sip-001")
    normalizedIdInput = formatSipId(numericMatch[1]).toLowerCase();
  } else if (!normalizedIdInput.startsWith('sip-')) {
    // If it's a generic ID without "sip-" prefix, add "sip-generic-"
    if (!normalizedIdInput.startsWith('sip-generic-')) { // Avoid double prefixing
        normalizedIdInput = `sip-generic-${normalizedIdInput}`;
    }
  }
  // If it already starts with "sip-" or "sip-generic-", use as is (already lowercased)

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase(); // Ensure comparison is case-insensitive
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) found.`);
    return foundSip;
  }

  console.log(`SIP ID ${id} (normalized to: ${normalizedIdInput}) not found after search of ${sipsToSearch?.length} SIPs.`);
  return null;
}

