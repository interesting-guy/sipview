
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips'; // Path to main SIPs directory within the repo
const SIPS_WITHDRAWN_PATH = 'withdrawn-sips'; // Path to withdrawn SIPs directory within the repo
const SIPS_REPO_BRANCH = 'main';

let sipsCache: SIP[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir';
  filename?: string; 
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
  state: 'open' | 'closed' | 'all';
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

function parseValidDate(dateStr: any, fallback?: string): string | undefined {
  if (!dateStr && fallback === undefined) return undefined;
  if (!dateStr) dateStr = fallback;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    if (fallback && fallback !== dateStr) {
        const fallbackDate = new Date(fallback);
        return isNaN(fallbackDate.getTime()) ? undefined : fallbackDate.toISOString();
    }
    return undefined;
  }
  return date.toISOString();
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
  defaultStatus: SipStatus;
  source: 'folder' | 'pull_request' | 'withdrawn_folder';
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
  author?: string;
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const { fileName, filePath, prUrl: optionPrUrl, prTitle: optionPrTitle, prNumber: optionPrNumber, defaultStatus, source, createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt, author: optionAuthor } = options;
  // console.log(`Attempting to parse SIP file: ${fileName} (source: ${source}, path: ${filePath}, PR# ${optionPrNumber || 'N/A'})`);
  try {
    const { data: frontmatter, content: body } = matter(content);

    let sipNumberStr: string | null = null;
    let idSource = "unknown";

    const fmSipField = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    if (fmSipField !== undefined && String(fmSipField).match(/^\d+$/)) {
      sipNumberStr = String(fmSipField);
      idSource = "frontmatter";
    }

    if (!sipNumberStr) {
      const fileNameNumMatch = fileName.match(/^(?:sip-)?(\d+)(?:\.md)$/i);
      if (fileNameNumMatch && fileNameNumMatch[1]) {
        sipNumberStr = fileNameNumMatch[1];
        idSource = "filename numeric part";
      } else {
        const fileNameDirectNumMatch = fileName.match(/^(\d+)(?:\.md)$/i);
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

    if (!sipNumberStr && (source === 'pull_request' || source === 'pull_request_only') && optionPrNumber !== undefined) {
      sipNumberStr = String(optionPrNumber); 
      idSource = "PR number";
    }
    
    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
      // console.log(`  Derived numeric SIP ID: ${id} (from ${idSource}, original number: ${sipNumberStr})`);
    } else {
      if ((source === 'folder' || source === 'withdrawn_folder') && fileName) {
        id = fileName.replace(/\.md$/, '').toLowerCase().replace(/\s+/g, '-');
        idSource = "filename slug";
        // console.log(`  Derived non-numeric/fallback ID for folder item: ${id} (from ${idSource})`);
      } else {
         console.warn(`  [WARN] Could not derive a numeric SIP ID for PR-related item: ${fileName || 'unknown filename'}, PR# ${optionPrNumber}, Title: ${optionPrTitle}. This should be rare if PR number fallback is working. Path: ${filePath}`);
         id = `sip-${String(optionPrNumber || Date.now()).padStart(3, '0')}`; 
         idSource = "PR number as absolute fallback";
      }
    }

    const frontmatterTitle = frontmatter.title || frontmatter.name;
    let sipTitle = frontmatterTitle;

    if (!sipTitle && (source === 'pull_request' || source === 'pull_request_only') && optionPrTitle) {
      // console.log(`  No title in frontmatter for PR SIP, using PR title: '${optionPrTitle}'`);
      sipTitle = optionPrTitle;
    }
    
    if (!sipTitle) {
        const genericFallbackTitle = `SIP ${id.replace(/^sip-/, '').replace(/^0+/, '') || 'Proposal'}`;
        if (source === 'pull_request' && !id.match(/^sip-\d+$/i)){
            console.log(`  [SKIP] PR file-based SIP (path: ${filePath}, derived ID: '${id}') because it has a non-standard ID AND no meaningful title (not from frontmatter, and PR title was missing/generic).`);
            return null;
        }
        sipTitle = genericFallbackTitle;
        // console.log(`  No title from frontmatter or PR, generated fallback title: ${sipTitle}`);
    }
    

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)", "Closed (unmerged)"];
    let status: SipStatus = statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)
        ? statusFromFrontmatter
        : defaultStatus;

    if (source === 'pull_request' && optionMergedAt && (status === 'Draft' || !statusFromFrontmatter)) {
        status = 'Accepted'; 
        // console.log(`  PR SIP is merged, status (from file/default) was '${statusFromFrontmatter || defaultStatus}', setting effective status to 'Accepted'. MergedAt: ${optionMergedAt}`);
    } else {
      // console.log(`  Derived Status for file-based SIP: ${status} (from frontmatter: ${statusFromFrontmatter}, default: ${defaultStatus})`);
    }

    let aiSummary = "Summary not available.";
    if (body && body.trim().length > 10) {
      try {
        // console.log(`  Generating AI summary for SIP ID ${id} (path: ${filePath})...`);
        const summaryResult = await summarizeSipContent({ sipBody: body });
        aiSummary = summaryResult.summary;
        // console.log(`  AI summary generated for SIP ID ${id}.`);
      } catch (e) {
        console.error(`Failed to generate AI summary for SIP ID ${id} (file: ${filePath}):`, e);
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || `Could not generate AI summary. Fallback: ${body.substring(0, 120).split('\\n')[0]}...`);
      }
    } else {
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || "No content available for summary.");
        // console.log(`  Using fallback summary for SIP ID ${id} as body is short or empty.`);
    }

    let prUrlToUse = optionPrUrl;
    if (!prUrlToUse) { 
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else if (id.match(/^sip-\d+$/i) && sipNumberStr) { 
             prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
        } else if (optionPrNumber) { 
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${optionPrNumber}`;
        } else { 
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/tree/${SIPS_REPO_BRANCH}/${filePath}`; 
        }
    }

    const nowISO = new Date().toISOString();
    const createdAt = optionCreatedAt ? parseValidDate(optionCreatedAt) : parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    const updatedAt = optionUpdatedAt ? parseValidDate(optionUpdatedAt) : parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAt)!;
    
    let mergedAtVal: string | undefined;
    if (optionMergedAt) { 
      mergedAtVal = parseValidDate(optionMergedAt);
    } else if (source === 'folder' && status === 'Final') { 
      mergedAtVal = parseValidDate(frontmatter.merged, updatedAt);
    } else if (frontmatter.merged) { 
        mergedAtVal = parseValidDate(frontmatter.merged);
    }

    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined) || (Array.isArray(frontmatter.authors) ? frontmatter.authors.join(', ') : undefined);

    // console.log(`  Successfully parsed SIP: ID='${id}', Title='${sipTitle}', Status='${status}', Source='${source}', Path='${filePath}', ID Source: ${idSource}`);
    return {
      id,
      title: sipTitle,
      status,
      summary: aiSummary,
      body,
      prUrl: prUrlToUse!,
      source,
      createdAt,
      updatedAt,
      mergedAt: mergedAtVal,
      author: sipAuthor,
      prNumber: optionPrNumber,
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
  console.log(`Fetched ${allPRs.length} pull requests (state=all).`);

  const sipsFromPRs: SIP[] = [];

  for (const pr of allPRs) {
    console.log(`Processing PR #${pr.number}: "${pr.title}" (State: ${pr.state}, Merged: ${!!pr.merged_at})`);
    let foundSipFileInPr = false; 
    
    const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files`;
    try {
      const prFiles = await fetchFromGitHubAPI(prFilesUrl) as GitHubFile[];
      // console.log(`  PR #${pr.number}: Found ${prFiles.length} files to check.`);

      for (const file of prFiles) {
        const filePath = file.filename; 
        if (!filePath) {
            // console.log(`    PR #${pr.number}: Skipping file due to missing 'filename' field in PR file data.`);
            continue;
        }
        const fileName = filePath.split('/').pop();

        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);
        
        const isInSipsDir = filePath.startsWith(SIPS_MAIN_BRANCH_PATH + '/');
        const isInWithdrawnSipsDir = filePath.startsWith(SIPS_WITHDRAWN_PATH + '/');
        
        const isCandidateSipFile = fileName && (isInSipsDir || isInWithdrawnSipsDir) && filePath.endsWith('.md') && !fileName.toLowerCase().includes('template');
        
        // console.log(`    PR #${pr.number} File: ${filePath}, RelevantChange: ${isRelevantChange}, CandidateSIP: ${isCandidateSipFile}, RawURL: ${!!file.raw_url}, InSips: ${isInSipsDir}, InWithdrawn: ${isInWithdrawnSipsDir}`);
        
        if (isRelevantChange && isCandidateSipFile && file.raw_url && fileName) {
          // console.log(`    PR #${pr.number}: File ${filePath} is a candidate. Fetching content...`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            
            let defaultPrFileStatus: SipStatus = 'Draft';
            if (pr.merged_at) defaultPrFileStatus = 'Accepted'; // More specific than just Draft if merged
            if (isInWithdrawnSipsDir) defaultPrFileStatus = 'Withdrawn'; // Specific if file is in withdrawn path

            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePath, 
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              defaultStatus: defaultPrFileStatus,
              source: 'pull_request',
              createdAt: pr.created_at,
              updatedAt: pr.updated_at,
              mergedAt: pr.merged_at || undefined,
              author: pr.user?.login,
            });

            if (parsedSip) {
              sipsFromPRs.push(parsedSip);
              foundSipFileInPr = true; // CRITICAL: Only set if a SIP was successfully parsed and added
              console.log(`    PR #${pr.number}: Successfully parsed ${filePath} as SIP ID ${parsedSip.id}. Setting foundSipFileInPr = true.`);
            } else {
              console.log(`    PR #${pr.number}: File ${filePath} was a candidate but did not parse into a valid SIP (returned null). foundSipFileInPr remains ${foundSipFileInPr}.`);
            }
          } catch (error) {
            console.error(`    PR #${pr.number}: Error processing file ${filePath} content:`, error);
          }
        }
      }
    } catch (error) {
        console.error(`  Error fetching/processing files for PR #${pr.number}:`, error);
    }


    if (!foundSipFileInPr) {
        // console.log(`  PR #${pr.number}: No valid SIP markdown file found in designated folders. Creating placeholder SIP.`);
        
        let placeholderStatus: SipStatus;
        const prTitleLower = (pr.title || "").toLowerCase();
        const prBodyLower = (pr.body || "").toLowerCase(); // Assuming body might also contain "withdrawn"
        const mentionsWithdrawnText = prTitleLower.includes("withdrawn") || prBodyLower.includes("withdrawn");

        if (pr.state === 'open') {
            placeholderStatus = 'Draft (no file)';
        } else { // pr.state === 'closed'
            if (mentionsWithdrawnText) {
                placeholderStatus = 'Withdrawn';
            } else if (pr.merged_at) {
                placeholderStatus = 'Accepted'; // If merged, it implies acceptance of the PR's intent
            } else { // Closed, not merged, not withdrawn
                placeholderStatus = 'Closed (unmerged)';
            }
        }
        
        const placeholderSipId = formatSipId(pr.number);
        const metadataOnlySip: SIP = {
          id: placeholderSipId,
          title: pr.title || `PR #${pr.number} Discussion`,
          status: placeholderStatus,
          summary: `No SIP file yet. Status from PR: ${placeholderStatus}.`,
          body: undefined,
          prUrl: pr.html_url,
          source: 'pull_request_only',
          createdAt: parseValidDate(pr.created_at, new Date().toISOString())!,
          updatedAt: parseValidDate(pr.updated_at, new Date().toISOString())!,
          mergedAt: pr.merged_at ? parseValidDate(pr.merged_at) : undefined,
          author: pr.user?.login,
          prNumber: pr.number,
        };
        sipsFromPRs.push(metadataOnlySip);
        console.log(`  PR #${pr.number}: Created placeholder SIP. ID: ${metadataOnlySip.id}, Status: ${metadataOnlySip.status}, Title: "${metadataOnlySip.title}"`);
    }
  }
  console.log(`Found ${sipsFromPRs.length} potential SIPs (including file-based and metadata-only) from PRs.`);
  return sipsFromPRs;
}

export async function getAllSips(): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
    console.log("Returning SIPs from cache.");
    return sipsCache;
  }
  console.log("Fetching fresh SIPs (cache expired or empty).");

  try {
    const mainFolderSips = await fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder');
    const withdrawnFolderSips = await fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder');
    const prSips = await fetchSipsFromPullRequests(); 

    const combinedSipsMap = new Map<string, SIP>();

    const allRawSips = [
      ...prSips, // Includes pull_request_only and pull_request sources
      ...mainFolderSips, 
      ...withdrawnFolderSips,
    ];

    const sourcePrecedenceValues: Record<SIP['source'], number> = {
        'withdrawn_folder': 0, // Highest precedence
        'folder': 1,
        'pull_request': 2,
        'pull_request_only': 3 // Lowest precedence
    };

    for (const sip of allRawSips) {
        if (!sip || !sip.id) {
            console.warn(`Encountered a SIP object without an ID during merging. Title: ${sip?.title}, Source: ${sip?.source}. Skipping.`);
            continue;
        }
        const key = sip.id.toLowerCase(); 
        const existingSip = combinedSipsMap.get(key);

        if (!existingSip) {
            combinedSipsMap.set(key, sip);
            // console.log(`Added new SIP to map: ${sip.id} (Status: ${sip.status}, Source: ${sip.source})`);
        } else {
            const existingPrecedence = sourcePrecedenceValues[existingSip.source];
            const currentPrecedence = sourcePrecedenceValues[sip.source];

            // Lower numeric value means higher precedence
            if (currentPrecedence < existingPrecedence) {
                combinedSipsMap.set(key, sip);
                // console.log(`Replaced SIP in map: ${sip.id} (New Status: ${sip.status}, New Source: ${sip.source}) over (Old Status: ${existingSip.status}, Old Source: ${existingSip.source}) due to higher source precedence.`);
            } else if (currentPrecedence === existingPrecedence) {
                // If same source precedence, prefer the one with more content or later update.
                const existingHasBody = !!existingSip.body?.trim();
                const currentHasBody = !!sip.body?.trim();
                const existingUpdatedAt = existingSip.updatedAt ? new Date(existingSip.updatedAt).getTime() : 0;
                const currentUpdatedAt = sip.updatedAt ? new Date(sip.updatedAt).getTime() : 0;

                if (currentHasBody && !existingHasBody) {
                    combinedSipsMap.set(key, sip);
                    // console.log(`Replaced SIP in map: ${sip.id} (Source: ${sip.source}) due to new one having body content.`);
                } else if (currentUpdatedAt > existingUpdatedAt && (!existingHasBody || currentHasBody)) {
                    combinedSipsMap.set(key, sip);
                    // console.log(`Replaced SIP in map: ${sip.id} (Source: ${sip.source}) due to newer update date.`);
                }
            }
        }
    }
    
    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      const numA = parseInt(a.id.replace(/^sip-/, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-/, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA; 
      } else if (!isNaN(numA)) {
        return -1; 
      } else if (!isNaN(numB)) {
        return 1;  
      }
      
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Closed (unmerged)", "Archived", "Withdrawn", "Rejected"];
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
    sipsCache = null; 
    return [];
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    console.log(`Cache miss or stale for getSipById(${id}). Refreshing all SIPs.`);
    sipsToSearch = await getAllSips(); 
  }

  const normalizedIdInput = id.toLowerCase().startsWith('sip-') && id.match(/^sip-\d+$/i)
    ? id.toLowerCase() 
    : id.toLowerCase().match(/^\d+$/)
      ? formatSipId(id.toLowerCase()) 
      : id.toLowerCase().replace(/\s+/g, '-'); 

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase(); 
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    return foundSip;
  }
  
  // Attempt a refresh only if the cache was potentially stale and the item wasn't found
  // This reduces redundant refreshes if the item genuinely doesn't exist.
  if (cacheTimestamp && (now - cacheTimestamp > 1000) && (now - cacheTimestamp >= CACHE_DURATION)) { 
     console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found, cache might be stale. Attempting one more full refresh for getSipById.`);
     sipsToSearch = await getAllSips(); // This will also update sipsCache
     const refreshedFoundSip = sipsToSearch.find(sip => {
        if (!sip.id) return false;
        const sipNormalizedMapId = sip.id.toLowerCase();
        return sipNormalizedMapId === normalizedIdInput;
     });
     if (refreshedFoundSip) {
        console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) found after targeted refresh for getSipById.`);
        return refreshedFoundSip;
     }
  }

  console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found after search and potential refresh.`);
  return null;
}
