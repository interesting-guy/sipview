
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

    if (!sipNumberStr && (source === 'pull_request') && optionPrNumber !== undefined) {
      sipNumberStr = String(optionPrNumber);
      idSource = "PR number";
    }
    
    let id: string;
    if (sipNumberStr) {
      id = formatSipId(sipNumberStr);
      console.log(`  Derived numeric SIP ID: ${id} (from ${idSource}, original number: ${sipNumberStr})`);
    } else {
      // Fallback for non-numeric IDs
      if (typeof fmSipField === 'string' && fmSipField.trim() !== '' && !fmSipField.toLowerCase().includes("<to be assigned>")) {
        id = fmSipField.trim().toLowerCase().replace(/\s+/g, '-');
        idSource = "frontmatter string";
      } else if (source === 'pull_request' && optionPrTitle) {
        id = optionPrTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 50);
        idSource = "PR title slug";
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
    
    if (!sipTitle) { // Generic fallback if no title could be determined
      sipTitle = `SIP ${sipNumberStr || id.replace(/^sip-/, '').replace(/^0+/, '') || 'Proposal'}`; 
      console.log(`  No title from frontmatter or PR, generated fallback title: ${sipTitle}`);
    }
    
    // Stricter skip for PRs: if ID is not standard numeric AND title is still generic/missing after fallbacks
    if (source === 'pull_request' && !id.match(/^sip-\d+$/i) && (sipTitle.startsWith('SIP Proposal') || sipTitle === optionPrTitle && !optionPrTitle )) {
         console.log(`  [SKIP] PR SIP (path: ${filePath}, derived ID: '${id}', title: '${sipTitle}') because it has a non-standard ID AND no meaningful title could be determined (not from frontmatter, and PR title was generic or missing).`);
         return null;
    }


    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final"];
    let status: SipStatus = statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)
        ? statusFromFrontmatter
        : defaultStatus;

    // If source is 'pull_request' and PR is merged, status should be 'Accepted' unless frontmatter says otherwise (e.g. 'Final', 'Live')
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
    if (!prUrlToUse) { // Fallback if no PR URL was passed in options
        if (typeof frontmatter.pr === 'string' && frontmatter.pr.startsWith('http')) {
            prUrlToUse = frontmatter.pr;
        } else if (typeof frontmatter.pr === 'number') {
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${frontmatter.pr}`;
        } else if (typeof frontmatter['discussions-to'] === 'string' && frontmatter['discussions-to'].includes('github.com') && (frontmatter['discussions-to'].includes('/pull/') || frontmatter['discussions-to'].includes('/issues/'))) {
            prUrlToUse = frontmatter['discussions-to'];
        } else if (id.match(/^sip-\d+$/i) && sipNumberStr) { 
            // Try to find PR by SIP ID in title if it's a standard numeric ID
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
        } else if (optionPrNumber) { // If we have a PR number from options (e.g. from a PR source)
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pull/${optionPrNumber}`;
        } else { // Absolute fallback: link to the file on main branch
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/tree/${SIPS_REPO_BRANCH}/${filePath}`; 
        }
    }

    const nowISO = new Date().toISOString();
    const createdAt = optionCreatedAt ? parseValidDate(optionCreatedAt) : parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    const updatedAt = optionUpdatedAt ? parseValidDate(optionUpdatedAt) : parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAt)!;
    
    let mergedAtVal: string | undefined;
    if (optionMergedAt) { // Passed from PR info
      mergedAtVal = parseValidDate(optionMergedAt);
    } else if (source === 'folder' && status === 'Final') { // For main folder SIPs that are Final
      mergedAtVal = parseValidDate(frontmatter.merged, updatedAt);
    } else if (frontmatter.merged) { // Frontmatter specified merged date
        mergedAtVal = parseValidDate(frontmatter.merged);
    }
    console.log(`  Dates - Created: ${createdAt}, Updated: ${updatedAt}, Merged: ${mergedAtVal}`);

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
  const allPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=all&sort=updated&direction=desc&per_page=100`; // Fetch more PRs
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
    let parsedSipsFromThisPr: SIP[] = [];
    try {
      const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files`;
      const prFiles = await fetchFromGitHubAPI(prFilesUrl) as GitHubFile[];
      console.log(`  PR #${pr.number}: Found ${prFiles.length} files.`);

      for (const file of prFiles) {
        const filePath = file.filename; // Use filename as it's more direct for PR files
        if (!filePath) {
            console.log(`    PR #${pr.number}: Skipping file due to missing 'filename' field. File object:`, JSON.stringify(file));
            continue;
        }
        const fileName = filePath.split('/').pop();

        const relevantChangeTypes: Array<GitHubFile['status']> = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);
        
        const isInSipsFolder = filePath.startsWith(SIPS_MAIN_BRANCH_PATH + '/');
        console.log(`    PR #${pr.number} File: Path='${filePath}', SIPS_MAIN_BRANCH_PATH='${SIPS_MAIN_BRANCH_PATH}', isInSipsFolder=${isInSipsFolder}`);
        
        // More inclusive: any .md file in sips/ not a template
        const isCandidateSipFile = fileName && isInSipsFolder && filePath.endsWith('.md') && !fileName.toLowerCase().includes('template');
        
        console.log(`    PR #${pr.number} File: ${filePath}, Name: ${fileName}, GitHub File Status: ${file.status}, Is Candidate: ${isCandidateSipFile}, Is Relevant Change: ${isRelevantChange}, Has raw_url: ${!!file.raw_url}`);

        if (isRelevantChange &&
            isCandidateSipFile && // No need for isInSipsFolder here as isCandidateSipFile implies it
            file.raw_url &&
            fileName // Ensure fileName is derived
        ) {
          console.log(`    PR #${pr.number}: File ${filePath} is a candidate. Fetching content...`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName,
              filePath: filePath, // Use the full path for context
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
              parsedSipsFromThisPr.push(parsedSip);
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

      if (parsedSipsFromThisPr.length > 0) {
        sipsFromPRs.push(...parsedSipsFromThisPr);
      } else if (pr.title.toLowerCase().includes('sip')) { // Check if it's a metadata-only SIP
        console.log(`  PR #${pr.number}: No actual SIP markdown file found in '${SIPS_MAIN_BRANCH_PATH}/', but title "${pr.title}" contains "SIP". Creating metadata-only SIP.`);
        const metadataOnlySip: SIP = {
          id: formatSipId(pr.number), // ID from PR number
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
    const folderSips = await fetchSipsFromFolder(SIPS_MAIN_BRANCH_PATH, 'Final', 'folder');
    // Assuming withdrawn SIPs are in a top-level folder, not nested under SIPS_MAIN_BRANCH_PATH
    const withdrawnSips = await fetchSipsFromFolder(SIPS_WITHDRAWN_PATH, 'Withdrawn', 'withdrawn_folder');
    const prSips = await fetchSipsFromPullRequests(); // This includes file-based and metadata-only PR SIPs

    const combinedSipsMap = new Map<string, SIP>();

    // 1. Process Withdrawn SIPs first - they take precedence for status
    withdrawnSips.forEach(sip => {
      if (sip.id) {
        combinedSipsMap.set(sip.id.toLowerCase(), sip);
        console.log(`Added/Updated from WITHDRAWN_FOLDER: ${sip.id} (Status: ${sip.status}, Source: ${sip.source})`);
      } else {
        console.warn(`Withdrawn SIP with missing ID encountered: ${sip.title}`);
      }
    });

    // 2. Process Folder (Final) SIPs
    folderSips.forEach(sip => {
      if (sip.id) {
        const normalizedId = sip.id.toLowerCase();
        if (!combinedSipsMap.has(normalizedId)) { // Only add if not already processed as withdrawn
          combinedSipsMap.set(normalizedId, sip);
          console.log(`Added from FOLDER: ${sip.id} (Status: ${sip.status}, Source: ${sip.source})`);
        } else {
          console.log(`Skipping FOLDER SIP ${sip.id} because it was already processed (likely as withdrawn). Current map entry status: ${combinedSipsMap.get(normalizedId)?.status}`);
        }
      } else {
        console.warn(`Folder SIP with missing ID encountered: ${sip.title}`);
      }
    });

    // 3. Process PR SIPs (file-based and metadata-only)
    prSips.forEach(prSip => {
      if (prSip.id) {
        const normalizedPrSipId = prSip.id.toLowerCase();
        const existingSip = combinedSipsMap.get(normalizedPrSipId);

        if (!existingSip) {
          combinedSipsMap.set(normalizedPrSipId, prSip);
          console.log(`Added new from PR: ${prSip.id} (Status: ${prSip.status}, Source: ${prSip.source})`);
        } else {
          // Existing SIP from withdrawn_folder or folder takes precedence over PR versions
          if (existingSip.source === 'withdrawn_folder' || existingSip.source === 'folder') {
            console.log(`Skipping PR SIP ${prSip.id} (Source: ${prSip.source}) because a '${existingSip.source}' version already exists.`);
          } 
          // If existing is pull_request_only and current prSip is file-based pull_request, update
          else if (existingSip.source === 'pull_request_only' && prSip.source === 'pull_request') {
            combinedSipsMap.set(normalizedPrSipId, prSip);
            console.log(`Overwriting metadata-only PR SIP ${existingSip.id} with file-based PR version ${prSip.id}.`);
          }
          // If both are pull_request or both are pull_request_only, consider recency or merged status
          else if (existingSip.source === prSip.source && (prSip.source === 'pull_request' || prSip.source === 'pull_request_only')) {
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
              console.log(`Keeping existing PR SIP ${prSip.id} (Source: ${prSip.source}) as it's more recent or same updated time as existing.`);
            }
          } else {
             console.log(`Skipping PR SIP ${prSip.id} (Source: ${prSip.source}) due to existing SIP from a higher precedence source or other condition. Existing source: ${existingSip.source}`);
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
        if (numA !== numB) return numB - numA; // Sort by SIP number descending if status is same
      } else if (numAOnly) { 
        return -1;
      } else if (numBOnly) { 
        return 1;
      }
      
      const updatedA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const updatedB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (updatedA !== updatedB) {
        return updatedB - updatedA; // Sort by update date descending
      }
      
      return a.id.localeCompare(b.id); // Fallback to ID string comparison
    });

    sipsCache = sips;
    cacheTimestamp = now;
    console.log(`Total unique SIPs processed: ${sips.length}. Cache updated.`);
    return sips;
  } catch (error) {
    console.error("Error in getAllSips fetching/processing:", error);
    sipsCache = null; // Invalidate cache on error
    return [];
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  // If cache is empty or stale, refresh it by calling getAllSips
  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    console.log(`Cache miss or stale for getSipById(${id}). Refreshing all SIPs.`);
    sipsToSearch = await getAllSips(); // This will update sipsCache
  } else {
    console.log(`Serving getSipById(${id}) from existing cache.`);
  }

  // Normalize the input ID: try to format as sip-XXX if it's just a number, otherwise use as is (lowercase)
  const normalizedIdInput = id.toLowerCase().startsWith('sip-') && id.match(/^sip-\d+$/i)
    ? id.toLowerCase()
    : id.toLowerCase().match(/^\d+$/)
      ? formatSipId(id.toLowerCase()) // Use formatSipId for numeric input
      : id.toLowerCase().replace(/\s+/g, '-'); // Slugify for other string inputs

  console.log(`Normalized ID for search in getSipById: ${normalizedIdInput}`);

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    const sipNormalizedMapId = sip.id.toLowerCase(); // ID in map should already be normalized
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) found in current list.`);
    return foundSip;
  }

  // Optionally, if not found and cache was not just refreshed, try one more refresh.
  // This check ensures we don't enter an infinite loop if getAllSips itself is failing.
  if (cacheTimestamp && (now - cacheTimestamp > 0)) { // Check if cacheTimestamp is set (meaning a fetch has happened)
     console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found, cache is potentially stale. Attempting one more refresh.`);
     sipsToSearch = await getAllSips(); // Re-fetch all, this updates sipsCache
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

