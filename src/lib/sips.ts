
'use server';
import matter from 'gray-matter';
import type { SIP, SipStatus } from '@/types/sip';
import { summarizeSipContent } from '@/ai/flows/summarize-sip-flow';

const GITHUB_API_URL = 'https://api.github.com';
const SIPS_REPO_OWNER = 'sui-foundation';
const SIPS_REPO_NAME = 'sips';
const SIPS_MAIN_BRANCH_PATH = 'sips'; // Path to SIPs directory on the main branch
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
  source: 'folder' | 'pull_request';
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
        idSource = "filename";
      }
    }
    
    if (!sipNumberStr && source === 'pull_request' && optionPrTitle) {
        const numFromTitle = extractSipNumberFromPrTitle(optionPrTitle);
        if (numFromTitle) {
          sipNumberStr = numFromTitle;
          idSource = "PR title";
        }
    }

    if (!sipNumberStr && source === 'pull_request' && optionPrNumber !== undefined) {
      sipNumberStr = String(optionPrNumber);
      idSource = "PR number";
    }
    
    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
      console.log(`  Derived numeric SIP ID: ${id} (from ${idSource}, original number: ${sipNumberStr})`);
    } else {
      // Fallback for non-numeric IDs, more common for early PRs or non-standard naming
      if (typeof fmSipField === 'string' && fmSipField.trim() !== '' && !fmSipField.toLowerCase().includes("<to be assigned>")) {
        id = fmSipField.trim().toLowerCase().replace(/\s+/g, '-');
        idSource = "frontmatter string";
      } else {
        id = fileName.replace(/\.md$/, '').toLowerCase().replace(/\s+/g, '-');
        idSource = "filename slug";
      }
      console.log(`  Derived non-numeric/fallback ID: ${id} (from ${idSource})`);
    }


    const frontmatterTitle = frontmatter.title || frontmatter.name;
    let sipTitle = frontmatterTitle;
    console.log(`  Title from frontmatter: ${frontmatterTitle}`);

    if (!sipTitle && source === 'pull_request' && optionPrTitle) {
      console.log(`  No title in frontmatter for PR SIP, using PR title: '${optionPrTitle}'`);
      sipTitle = optionPrTitle;
    }
    
    if (source === 'pull_request' && !id.match(/^sip-\d+$/i) && !sipTitle) {
      console.log(`  [SKIP] PR SIP (path: ${filePath}, derived ID: '${id}') because it has a non-standard ID AND no title could be determined (from frontmatter or PR).`);
      return null;
    }

    if (!sipTitle) {
      sipTitle = `SIP ${sipNumberStr || id.replace(/^sip-/, '').replace(/^0+/, '') || 'Proposal'}`; 
      console.log(`  No title from frontmatter or PR, generated fallback title: ${sipTitle}`);
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final"];
    let status: SipStatus = statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)
        ? statusFromFrontmatter
        : defaultStatus;

    if (source === 'pull_request' && optionMergedAt && status === 'Draft' && defaultStatus === 'Draft') {
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
    console.log(`  Dates - Created: ${createdAt}, Updated: ${updatedAt}, Merged: ${mergedAtVal}`);

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
      author: optionAuthor,
      prNumber: optionPrNumber,
    };
  } catch (e) {
    console.error(`Error parsing SIP file ${fileName} (source: ${source}, path: ${filePath}):`, e);
    return null;
  }
}

async function fetchSipsFromFolder(): Promise<SIP[]> {
  const repoContentsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/contents/${SIPS_MAIN_BRANCH_PATH}?ref=${SIPS_REPO_BRANCH}`;
  let filesFromRepo: GitHubFile[];
  try {
    const filesOrDirs = await fetchFromGitHubAPI(repoContentsUrl);
    if (Array.isArray(filesOrDirs)) {
        filesFromRepo = filesOrDirs;
    } else {
        console.warn(`Fetched main branch content from '${SIPS_MAIN_BRANCH_PATH}' is not an array. Response:`, filesOrDirs);
        filesFromRepo = [];
    }
  } catch (error) {
    console.error(`Failed to fetch SIPs from folder '${SIPS_MAIN_BRANCH_PATH}':`, error);
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
          defaultStatus: 'Final', 
          source: 'folder',
        });
      } catch (error) {
        console.error(`Failed to process folder SIP file ${file.name} (path: ${file.path}):`, error);
        return null;
      }
    });
  const folderSips = (await Promise.all(sipsPromises)).filter(sip => sip !== null) as SIP[];
  console.log(`Fetched ${folderSips.length} SIPs from folder '${SIPS_MAIN_BRANCH_PATH}'.`);
  return folderSips;
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

  const draftSips: SIP[] = [];

  for (const pr of allPRs) {
    console.log(`Processing PR #${pr.number}: ${pr.title} (State: ${pr.state}, Merged: ${pr.merged_at ? 'Yes' : 'No'})`);
    let parsedSipsFromThisPr: SIP[] = [];
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
        
        const isCandidateSipFile = fileName && filePath.endsWith('.md') && !fileName.toLowerCase().includes('template');
        
        console.log(`    PR #${pr.number} File: ${filePath}, Name: ${fileName}, GitHub File Status: ${file.status}, Is Candidate: ${isCandidateSipFile}, Is Relevant Change: ${isRelevantChange}, Has raw_url: ${!!file.raw_url}`);

        if (isRelevantChange &&
            isInSipsFolder &&
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
              console.log(`    PR #${pr.number}: Successfully parsed ${filePath} as SIP ID ${parsedSip.id}. Status: ${parsedSip.status}. Adding to drafts.`);
              parsedSipsFromThisPr.push(parsedSip);
            } else {
              console.log(`    PR #${pr.number}: File ${filePath} did not parse into a valid SIP (returned null).`);
            }
          } catch (error) {
            console.error(`    PR #${pr.number}: Error processing file ${filePath} content:`, error);
          }
        } else {
            let skipReason = "did NOT match all criteria.";
            if (!isRelevantChange) skipReason += ` Irrelevant change type ('${file.status}').`;
            if (!isInSipsFolder) skipReason += ` Not in SIPs folder ('${SIPS_MAIN_BRANCH_PATH}/').`;
            if (!isCandidateSipFile) skipReason += " Not a candidate SIP file (ends .md, not template).";
            if (!file.raw_url) skipReason += " Missing raw_url.";
            if (!fileName) skipReason += " Missing filename derived from path.";
            console.log(`    PR #${pr.number}: File ${filePath} ${skipReason}`);
        }
      }

      if (parsedSipsFromThisPr.length > 0) {
        draftSips.push(...parsedSipsFromThisPr);
      } else if (pr.title.toLowerCase().includes('sip')) {
        console.log(`  PR #${pr.number}: No SIP file found in '${SIPS_MAIN_BRANCH_PATH}/', but title "${pr.title}" contains "SIP". Creating metadata-only SIP.`);
        const metadataOnlySip: SIP = {
          id: formatSipId(pr.number),
          title: pr.title,
          status: 'Draft (no file)',
          summary: 'No SIP file yet — PR under discussion.',
          body: undefined,
          prUrl: pr.html_url,
          source: 'pull_request_only',
          createdAt: parseValidDate(pr.created_at)!,
          updatedAt: parseValidDate(pr.updated_at)!,
          mergedAt: pr.merged_at ? parseValidDate(pr.merged_at) : undefined,
          author: pr.user.login,
          prNumber: pr.number,
        };
        draftSips.push(metadataOnlySip);
        console.log(`    PR #${pr.number}: Created metadata-only SIP ID ${metadataOnlySip.id}.`);
      }


    } catch (error) {
      console.error(`  Error processing files for PR #${pr.number}:`, error);
    }
  }
  console.log(`Found ${draftSips.length} potential SIPs (including metadata-only) from PRs.`);
  return draftSips;
}

export async function getAllSips(): Promise<SIP[]> {
  const now = Date.now();
  if (sipsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
    console.log("Returning SIPs from cache.");
    return sipsCache;
  }
  console.log("Fetching fresh SIPs (cache expired or empty).");

  try {
    const folderSips = await fetchSipsFromFolder();
    const prSips = await fetchSipsFromPullRequests();

    const combinedSipsMap = new Map<string, SIP>();

    folderSips.forEach(sip => {
      if (sip.id) {
        combinedSipsMap.set(sip.id.toLowerCase(), sip);
         console.log(`Added/Updated from FOLDER: ${sip.id} (Status: ${sip.status}, Source: ${sip.source})`);
      } else {
        console.warn(`Folder SIP with missing ID encountered: ${sip.title}`);
      }
    });

    prSips.forEach(prSip => {
      if (prSip.id) {
        const normalizedPrSipId = prSip.id.toLowerCase();
        const existingSip = combinedSipsMap.get(normalizedPrSipId);

        if (!existingSip) {
          combinedSipsMap.set(normalizedPrSipId, prSip);
          console.log(`Added new from PR: ${prSip.id} (Status: ${prSip.status}, Source: ${prSip.source})`);
        } else {
          // Precedence: 'folder' > 'pull_request' > 'pull_request_only'
          // If existing is 'folder', it always wins.
          if (existingSip.source === 'folder') {
            console.log(`Skipping PR SIP ${prSip.id} (Source: ${prSip.source}, Status: ${prSip.status}) because a 'folder' version (Status: ${existingSip.status}) already exists.`);
          } else if (existingSip.source === 'pull_request' && prSip.source === 'pull_request_only') {
             console.log(`Skipping metadata-only PR SIP ${prSip.id} because a file-based PR version already exists.`);
          } else if (existingSip.source === 'pull_request_only' && prSip.source === 'pull_request') {
            combinedSipsMap.set(normalizedPrSipId, prSip); // File-based PR overwrites metadata-only
            console.log(`Overwriting metadata-only PR SIP ${existingSip.id} with file-based PR version ${prSip.id}.`);
          } else if (existingSip.source === prSip.source) { // Both 'pull_request' or both 'pull_request_only'
            const existingUpdatedAt = existingSip.updatedAt ? new Date(existingSip.updatedAt).getTime() : 0;
            const newUpdatedAt = prSip.updatedAt ? new Date(prSip.updatedAt).getTime() : 0;
            
            const existingIsMerged = !!existingSip.mergedAt;
            const newIsMerged = !!prSip.mergedAt;

            if (newIsMerged && !existingIsMerged) {
                 combinedSipsMap.set(normalizedPrSipId, prSip);
                 console.log(`Overwriting existing PR SIP ${prSip.id} with newer PR version because new one is merged and old one was not.`);
            } else if (!newIsMerged && existingIsMerged) {
                 console.log(`Keeping existing PR SIP ${prSip.id} because existing one is merged and new one is not.`);
            } else if (newUpdatedAt > existingUpdatedAt) { 
              combinedSipsMap.set(normalizedPrSipId, prSip);
              console.log(`Overwriting existing PR SIP ${prSip.id} (Source: ${prSip.source}) with more recently updated PR version.`);
            } else {
              console.log(`Keeping existing PR SIP ${prSip.id} (Source: ${prSip.source}) as it's more recent or same updated time.`);
            }
          } else {
             // This case should ideally not be hit if logic above is correct, e.g. prSip.source === 'folder'
             console.warn(`Unhandled conflict for SIP ID ${prSip.id}. Existing source: ${existingSip.source}, New source: ${prSip.source}. Keeping existing.`);
          }
        }
      } else {
         console.warn(`PR SIP with missing ID encountered: ${prSip.title}, PR URL: ${prSip.prUrl}`);
      }
    });

    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Archived", "Rejected", "Withdrawn"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);

      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex;
      }
      
      const numAOnly = a.id.match(/^sip-(\d+)$/i);
      const numBOnly = b.id.match(/^sip-(\d+)$/i);

      if (numAOnly && numBOnly) {
        const numA = parseInt(numAOnly[1], 10);
        const numB = parseInt(numBOnly[1], 10);
        if (numA !== numB) return numB - numA;
      } else if (numAOnly) { 
        return -1;
      } else if (numBOnly) { 
        return 1;
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
      ? `sip-${id.toLowerCase().padStart(3, '0')}`
      : id.toLowerCase().replace(/\s+/g, '-');

  console.log(`Normalized ID for search: ${normalizedIdInput}`);

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase();
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) found in current list.`);
    return foundSip;
  }

  // If not found and cache is nearing expiry, try one more refresh just in case.
  // This helps if the user is requesting an ID that just became available.
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) { 
     console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found, cache is older than half duration. Attempting one more refresh.`);
     sipsToSearch = await getAllSips(); // Re-fetch all
     const refreshedFoundSip = sipsToSearch.find(sip => {
        if (!sip.id) return false;
        const sipNormalizedMapId = sip.id.toLowerCase();
        return sipNormalizedMapId === normalizedIdInput;
     });
     if (refreshedFoundSip) {
        console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) found after refresh.`);
        return refreshedFoundSip;
     }
  }

  console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found after search and potential refresh.`);
  return null;
}

