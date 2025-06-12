
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
  filename?: string; // Note: 'filename' is often used by GitHub API for files in PRs, 'name' for repo contents
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

interface GitHubIssueComment { // For general PR comments
  id: number;
  user: GitHubUser | null;
  body: string;
  created_at: string;
  html_url: string;
}

interface GitHubReviewComment { // For comments on specific diffs
  id: number;
  user: GitHubUser | null;
  body: string;
  created_at: string;
  html_url: string;
  path: string; // File path
  diff_hunk: string;
  original_commit_id: string;
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
    
    const generatedAiSummary: AiSummary = await summarizeSipContentStructured({
        sipBody: aiInputSipBody,
        abstractOrDescription: aiInputAbstractOrDescription,
    });

    if (frontmatter.summary && String(frontmatter.summary).trim() !== "") {
        textualSummary = String(frontmatter.summary);
    } else if (generatedAiSummary && generatedAiSummary.whatItIs !== USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs && generatedAiSummary.whatItIs !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
        textualSummary = `${generatedAiSummary.whatItIs} ${generatedAiSummary.whatItChanges} ${generatedAiSummary.whyItMatters}`.replace(/-/g, '').replace(/No summary available yet\./g, '').trim();
        if (textualSummary.length > 200) textualSummary = textualSummary.substring(0, 197) + "...";
        if (textualSummary.trim() === "") textualSummary = INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD;
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

    if (source === 'pull_request') {
        createdAtISO = parseValidDate(optionCreatedAt) || FALLBACK_CREATED_AT_DATE;
        if (createdAtISO === FALLBACK_CREATED_AT_DATE && optionCreatedAt) {
           console.warn(`SIP ${id}: PR source, createdAt invalid: ${optionCreatedAt}. Using fallback.`);
        }
        updatedAtISO = parseValidDate(optionUpdatedAt);
    } else { 
      createdAtISO = parseValidDate(frontmatter.created || frontmatter.date) || FALLBACK_CREATED_AT_DATE;
      if (createdAtISO === FALLBACK_CREATED_AT_DATE && !(frontmatter.created || frontmatter.date)) { 
          // console.warn(`SIP ${id}: Folder source, no valid created/date in frontmatter. Using fallback.`);
      }
      updatedAtISO = parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated']);
    }

    let mergedAtVal: string | undefined;
    if ((source === 'pull_request') && optionMergedAt !== undefined) { 
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
    
    const generatedAiSummaryForPrOnly: AiSummary = await summarizeSipContentStructured({
        sipBody: pr.body || undefined,
        abstractOrDescription: pr.title || `PR #${pr.number} Discussion`,
    });

    const placeholderSip: SIP = {
      id: placeholderSipId,
      title: pr.title || `PR #${pr.number} Discussion`,
      status: placeholderStatus,
      summary: `Status from PR: ${placeholderStatus}. Title: "${pr.title || `PR #${pr.number}`}"`,
      aiSummary: generatedAiSummaryForPrOnly,
      body: pr.body || undefined,
      prUrl: pr.html_url,
      source: 'pull_request_only',
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      mergedAt: pr.merged_at || undefined,
      author: pr.user?.login,
      prNumber: pr.number,
      filePath: undefined, // No specific file for this placeholder
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
  return sipsFromPRs;
}

export async function getAllSips(forceRefresh: boolean = false): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION) && !forceRefresh) {
    return sipsCache;
  }
  if (forceRefresh) {
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
        mergedAt?: string | null;
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
                    prTitle: prSip.title, 
                    prState: (prSip.status === "Draft" || prSip.status === "Draft (no file)") ? 'open' : 'closed', 
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
        
        enriched.createdAt = prInfo.createdAt; 
        enriched.updatedAt = prInfo.updatedAt || enriched.updatedAt; 
        enriched.mergedAt = prInfo.mergedAt || enriched.mergedAt;

        if (folderSip.source === 'folder' && (prInfo.prNumber || prInfo.mergedAt)) {
          enriched.source = 'folder+pr';
        }
        
        if (folderSip.status !== 'Final' && folderSip.status !== 'Live' && folderSip.status !== 'Withdrawn') {
            if (prInfo.mergedAt) {
                enriched.status = 'Accepted'; 
            }
        }
        if (folderSip.source === 'withdrawn_folder') { 
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
        continue;
      }
      const key = currentSip.id.toLowerCase();
      const existingSip = combinedSipsMap.get(key);

      if (!existingSip) {
        combinedSipsMap.set(key, currentSip);
      } else {
        let sipToKeep: SIP = { ...existingSip }; // Start with existing as base
        const currentPrecedence = sourcePrecedenceValues[currentSip.source] ?? -1;
        const existingPrecedence = sourcePrecedenceValues[existingSip.source] ?? -1;

        if (currentPrecedence > existingPrecedence) {
            // Current source is more authoritative, merge current into existing
            sipToKeep = { ...existingSip, ...currentSip };
        } else if (existingPrecedence > currentPrecedence) {
            // Existing source is more authoritative, merge existing into current (already done by init)
            sipToKeep = { ...currentSip, ...existingSip };
        } else { // Same precedence, merge fields carefully
            sipToKeep = { ...existingSip, ...currentSip }; // currentSip's fields (except body/summary if better in existing)
            
            const chooseRecent = (date1Str?: string, date2Str?: string): string | undefined => {
                const date1 = date1Str ? new Date(date1Str) : null;
                const date2 = date2Str ? new Date(date2Str) : null;
                if (date1 && date2) return date1 > date2 ? date1Str : date2Str;
                return date1Str || date2Str;
            };
            sipToKeep.updatedAt = chooseRecent(existingSip.updatedAt, currentSip.updatedAt);
            sipToKeep.mergedAt = chooseRecent(existingSip.mergedAt, currentSip.mergedAt);
            
            if (!currentSip.body && existingSip.body) sipToKeep.body = existingSip.body;
            
            if (currentSip.summary === INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD && existingSip.summary !== INSUFFICIENT_DETAIL_MESSAGE_FOR_SUMMARY_FIELD) {
                sipToKeep.summary = existingSip.summary;
            }

            const isCurrentAiFallback = currentSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;
            const isExistingAiFallback = existingSip.aiSummary.whatItIs === USER_REQUESTED_FALLBACK_AI_SUMMARY.whatItIs;

            if (isCurrentAiFallback && !isExistingAiFallback) {
                sipToKeep.aiSummary = existingSip.aiSummary;
            } else if (!isCurrentAiFallback && isExistingAiFallback) {
                // currentSip.aiSummary is already there from the spread
            } else if (isCurrentAiFallback && isExistingAiFallback) {
                // both are fallbacks, currentSip (which could be the PR-only one) is fine
            } else { // both are potentially good summaries, prefer the one from the higher source or more recent
                 if (currentSip.source === 'pull_request_only' && existingSip.source !== 'pull_request_only') {
                    sipToKeep.aiSummary = existingSip.aiSummary;
                 } // else currentSip.aiSummary is already there
            }
        }
        
        // Authoritative status for withdrawn SIPs
        if (currentSip.source === 'withdrawn_folder') {
            sipToKeep.status = 'Withdrawn';
            sipToKeep.source = 'withdrawn_folder'; // Ensure source reflects this
        } else if (existingSip.source === 'withdrawn_folder') {
            sipToKeep.status = 'Withdrawn';
            sipToKeep.source = 'withdrawn_folder';
        } else if (sipToKeep.mergedAt && sipToKeep.status !== 'Final' && sipToKeep.status !== 'Live' && sipToKeep.status !== 'Withdrawn') {
            sipToKeep.status = 'Accepted';
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
    return sips;
  } catch (error) {
    console.error("Error in getAllSips fetching/processing:", error);
    sipsCache = null; // Invalidate cache on error
    return []; // Return empty array on error to prevent app crash
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

  if (foundSip && foundSip.prNumber) {
    try {
      const issueCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/issues/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;
      const reviewCommentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${foundSip.prNumber}/comments?sort=created&direction=asc&per_page=${COMMENTS_PER_PAGE}`;
      
      const [rawIssueComments, rawReviewComments] = await Promise.all([
        fetchFromGitHubAPI(issueCommentsUrl, 60) as Promise<GitHubIssueComment[]>,
        fetchFromGitHubAPI(reviewCommentsUrl, 60) as Promise<GitHubReviewComment[]>
      ]);

      const mapComment = (comment: GitHubIssueComment | GitHubReviewComment, filePath?: string): Comment => ({
        id: comment.id,
        author: comment.user?.login || 'Unknown User',
        avatar: comment.user?.avatar_url || `https://placehold.co/40x40.png?text=${(comment.user?.login || 'U').charAt(0)}`,
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


    } catch (commentError) {
      console.error(`Failed to fetch comments for SIP ${foundSip.id} (PR #${foundSip.prNumber}):`, commentError);
      foundSip.comments = [];
    }
  } else if (foundSip) {
    foundSip.comments = [];
  }
  
  return foundSip || null;
}

