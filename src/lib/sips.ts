
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips'; // Path to main SIPs directory on the main branch
const SIPS_WITHDRAWN_PATH = 'withdrawn-sips'; // Path to withdrawn SIPs directory
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

interface GitHubPullRequest {
  number: number;
  html_url: string;
  title: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  state: 'open' | 'closed' | 'all';
  head: { sha: string };
  body: string | null; // PR body content
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
  console.log(`Parsing SIP file: ${fileName} (source: ${source}, path: ${filePath}, PR# ${optionPrNumber || 'N/A'})`);
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
      console.log(`  Derived numeric SIP ID: ${id} (from ${idSource}, original number: ${sipNumberStr})`);
    } else {
      if (source === 'folder' || source === 'withdrawn_folder') {
        id = fileName.replace(/\.md$/, '').toLowerCase().replace(/\s+/g, '-');
        idSource = "filename slug";
        console.log(`  Derived non-numeric/fallback ID for folder item: ${id} (from ${idSource})`);
      } else {
         console.error(`  [CRITICAL SKIP] Could not derive a numeric SIP ID for PR-related item: ${fileName}, PR# ${optionPrNumber}, Title: ${optionPrTitle}. This should not happen if PR number fallback is working.`);
         return null; 
      }
    }

    const frontmatterTitle = frontmatter.title || frontmatter.name;
    let sipTitle = frontmatterTitle;

    if (!sipTitle && (source === 'pull_request' || source === 'pull_request_only') && optionPrTitle) {
      console.log(`  No title in frontmatter for PR SIP, using PR title: '${optionPrTitle}'`);
      sipTitle = optionPrTitle;
    }
    
    if (!sipTitle) {
      sipTitle = `SIP ${id.replace(/^sip-/, '').replace(/^0+/, '') || 'Proposal'}`; 
      console.log(`  No title from frontmatter or PR, generated fallback title: ${sipTitle}`);
    }
    
    // Skip if ID is not standard numeric AND title is also generic (only for PR-sourced files)
    if ((source === 'pull_request') && !id.match(/^sip-\d+$/i) && (sipTitle === optionPrTitle && !optionPrTitle )) {
         console.log(`  [SKIP] PR file-based SIP (path: ${filePath}, derived ID: '${id}', title: '${sipTitle}') because it has a non-standard ID AND no meaningful title (not from frontmatter, and PR title was generic/missing).`);
         return null;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final", "Draft (no file)"];
    let status: SipStatus = statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)
        ? statusFromFrontmatter
        : defaultStatus;

    // If it's a PR-sourced file, and it's merged, and status is still Draft/not set, it should be at least 'Accepted'.
    if (source === 'pull_request' && optionMergedAt && (status === 'Draft' || !statusFromFrontmatter)) {
        status = 'Accepted'; 
        console.log(`  PR SIP is merged, status (from file/default) was '${statusFromFrontmatter || defaultStatus}', setting effective status to 'Accepted'. MergedAt: ${optionMergedAt}`);
    } else {
      console.log(`  Derived Status: ${status} (from frontmatter: ${statusFromFrontmatter}, default: ${defaultStatus})`);
    }

    let aiSummary = "Summary not available.";
    if (body && body.trim().length > 10) {
      try {
        console.log(`  Generating AI summary for SIP ID ${id} (path: ${filePath})...`);
        const summaryResult = await summarizeSipContent({ sipBody: body });
        aiSummary = summaryResult.summary;
        console.log(`  AI summary generated for SIP ID ${id}.`);
      } catch (e) {
        console.error(`Failed to generate AI summary for SIP ID ${id} (file: ${filePath}):`, e);
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || `Could not generate AI summary. Fallback: ${body.substring(0, 120).split('\\n')[0]}...`);
      }
    } else {
        aiSummary = String(frontmatter.summary || frontmatter.abstract || frontmatter.description || "No content available for summary.");
        console.log(`  Using fallback summary for SIP ID ${id} as body is short or empty.`);
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

    const sipAuthor = optionAuthor || (typeof frontmatter.author === 'string' ? frontmatter.author : undefined);

    console.log(`  Successfully parsed SIP: ID='${id}', Title='${sipTitle}', Status='${status}', Source='${source}', Path='${filePath}'`);
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
    console.error(`Error parsing SIP file ${fileName} (source: ${source}, path: ${filePath}):`, e);
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
    console.log(`Processing PR #${pr.number}: ${pr.title} (State: ${pr.state}, Merged: ${pr.merged_at ? 'Yes' : 'No'})`);
    let foundSipFileInPr = false;
    
    try {
      const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files`;
      const prFiles = await fetchFromGitHubAPI(prFilesUrl) as GitHubFile[];
      console.log(`  PR #${pr.number}: Found ${prFiles.length} files.`);

      for (const file of prFiles) {
        const filePath = file.filename; 
        if (!filePath) {
            console.log(`    PR #${pr.number}: Skipping file due to missing 'filename' field. File object:`, JSON.stringify(file));
            continue;
        }
        const fileName = filePath.split('/').pop();

        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);
        
        const isInSipsFolder = filePath.startsWith(SIPS_MAIN_BRANCH_PATH + '/');
        console.log(`    PR #${pr.number} File: Path='${filePath}', SIPS_MAIN_BRANCH_PATH='${SIPS_MAIN_BRANCH_PATH}', isInSipsFolder=${isInSipsFolder}`);
        
        const isCandidateSipFile = fileName && isInSipsFolder && filePath.endsWith('.md') && !fileName.toLowerCase().includes('template');
        
        console.log(`    PR #${pr.number} File: ${filePath}, Name: ${fileName}, GitHub File Status: ${file.status}, Is Candidate: ${isCandidateSipFile}, Is Relevant Change: ${isRelevantChange}, Has raw_url: ${!!file.raw_url}`);

        if (isRelevantChange &&
            isCandidateSipFile &&
            file.raw_url &&
            fileName 
        ) {
          console.log(`    PR #${pr.number}: File ${filePath} is a candidate. Fetching content...`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePath, 
              prUrl: pr.html_url,
              prTitle: pr.title,
              prNumber: pr.number,
              defaultStatus: pr.merged_at ? 'Accepted' : 'Draft',
              source: 'pull_request',
              createdAt: pr.created_at,
              updatedAt: pr.updated_at,
              mergedAt: pr.merged_at || undefined,
              author: pr.user.login,
            });
            if (parsedSip) {
              console.log(`    PR #${pr.number}: Successfully parsed ${filePath} as SIP ID ${parsedSip.id}. Status: ${parsedSip.status}. Adding to PR SIPs list.`);
              sipsFromPRs.push(parsedSip);
              foundSipFileInPr = true;
            } else {
              console.log(`    PR #${pr.number}: File ${filePath} did not parse into a valid SIP (returned null).`);
            }
          } catch (error) {
            console.error(`    PR #${pr.number}: Error processing file ${filePath} content:`, error);
          }
        } else {
            let skipReason = "did NOT match all criteria for a file-based PR SIP.";
            if (!isRelevantChange) skipReason += ` Irrelevant change type ('${file.status}').`;
            if (!isCandidateSipFile) skipReason += ` Not a candidate SIP file (in '${SIPS_MAIN_BRANCH_PATH}/', ends .md, not template).`;
            if (!file.raw_url) skipReason += " Missing raw_url.";
            if (!fileName) skipReason += " Missing filename derived from path.";
            console.log(`    PR #${pr.number}: File ${filePath} ${skipReason}`);
        }
      }

      if (!foundSipFileInPr) {
        console.log(`  PR #${pr.number}: No actual SIP markdown file found in '${SIPS_MAIN_BRANCH_PATH}/'. Creating metadata-only SIP.`);
        const metadataOnlySip: SIP = {
          id: formatSipId(pr.number),
          title: pr.title,
          status: 'Draft (no file)',
          summary: 'No SIP file yet. Draft under discussion.',
          body: undefined,
          prUrl: pr.html_url,
          source: 'pull_request_only',
          createdAt: parseValidDate(pr.created_at, new Date().toISOString())!,
          updatedAt: parseValidDate(pr.updated_at, new Date().toISOString())!,
          mergedAt: pr.merged_at ? parseValidDate(pr.merged_at) : undefined,
          author: pr.user.login,
          prNumber: pr.number,
        };
        sipsFromPRs.push(metadataOnlySip);
        console.log(`    PR #${pr.number}: Created metadata-only SIP ID ${metadataOnlySip.id}.`);
      }


    } catch (error) {
      console.error(`  Error processing files for PR #${pr.number}:`, error);
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
    const withdrawnFolderSips = await fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder');
    const mainFolderSips = await fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder');
    const prSips = await fetchSipsFromPullRequests(); 

    const combinedSipsMap = new Map<string, SIP>();

    // Precedence order: withdrawn, then folder, then PR files, then PR metadata-only
    const allSources = [
      ...withdrawnFolderSips, 
      ...mainFolderSips, 
      ...prSips
    ];

    for (const sip of allSources) {
        if (!sip || !sip.id) {
            console.warn(`Encountered a SIP object without an ID during merging. Title: ${sip?.title}, Source: ${sip?.source}. Skipping.`);
            continue;
        }
        const key = sip.id.toLowerCase();
        const existingSip = combinedSipsMap.get(key);

        if (!existingSip) {
            combinedSipsMap.set(key, sip);
            console.log(`Added new SIP to map: ${sip.id} (Status: ${sip.status}, Source: ${sip.source})`);
        } else {
            // Define precedence: withdrawn_folder > folder > pull_request > pull_request_only
            const sourcePrecedence = ['withdrawn_folder', 'folder', 'pull_request', 'pull_request_only'];
            const existingPrecedence = sourcePrecedence.indexOf(existingSip.source);
            const currentPrecedence = sourcePrecedence.indexOf(sip.source);

            if (currentPrecedence < existingPrecedence) { // Lower index means higher precedence
                combinedSipsMap.set(key, sip);
                console.log(`Replaced SIP in map: ${sip.id} (New Status: ${sip.status}, New Source: ${sip.source}) over (Old Status: ${existingSip.status}, Old Source: ${existingSip.source})`);
            } else {
                console.log(`Skipped SIP due to lower precedence: ${sip.id} (Status: ${sip.status}, Source: ${sip.source}). Existing is (Status: ${existingSip.status}, Source: ${existingSip.source})`);
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
      
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Archived", "Rejected", "Withdrawn"];
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
    console.log(`Total unique SIPs processed: ${sips.length}. Cache updated.`);
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
  } else {
    console.log(`Serving getSipById(${id}) from existing cache.`);
  }

  const normalizedIdInput = id.toLowerCase().startsWith('sip-') && id.match(/^sip-\d+$/i)
    ? id.toLowerCase()
    : id.toLowerCase().match(/^\d+$/)
      ? formatSipId(id.toLowerCase()) 
      : id.toLowerCase().replace(/\s+/g, '-'); 

  console.log(`Normalized ID for search in getSipById: ${normalizedIdInput}`);

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase(); 
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) found in current list.`);
    return foundSip;
  }
  
  if (cacheTimestamp && (now - cacheTimestamp > 1000)) { 
     console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found, cache might be stale. Attempting one more full refresh.`);
     sipsToSearch = await getAllSips(); 
     const refreshedFoundSip = sipsToSearch.find(sip => {
        if (!sip.id) return false;
        const sipNormalizedMapId = sip.id.toLowerCase();
        return sipNormalizedMapId === normalizedIdInput;
     });
     if (refreshedFoundSip) {
        console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) found after targeted refresh.`);
        return refreshedFoundSip;
     }
  }

  console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found after search and potential refresh.`);
  return null;
}

