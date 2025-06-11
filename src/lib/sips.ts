
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
  name: string; // Only for repo contents, not PR files
  path: string; // Only for repo contents, not PR files
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir';
  // Fields specific to PR files API response
  filename?: string; // Full path for PR files
  status?: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  raw_url?: string; // URL to fetch raw content for PR files
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

interface ParseSipFileOptions {
  fileName: string; // Base filename like 'sip-001.md' or 'my-proposal.md'
  filePath: string; // Full path like 'sips/sip-001.md'
  prUrl?: string;
  defaultStatus: SipStatus;
  source: 'folder' | 'pull_request';
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
}

async function parseSipFile(content: string, options: ParseSipFileOptions): Promise<SIP | null> {
  const { fileName, filePath, prUrl: optionPrUrl, defaultStatus, source, createdAt: optionCreatedAt, updatedAt: optionUpdatedAt, mergedAt: optionMergedAt } = options;
  console.log(`Parsing SIP file: ${fileName} (source: ${source}, path: ${filePath})`);
  try {
    const { data: frontmatter, content: body } = matter(content);

    let id: string;
    const fmSip = frontmatter.sip ?? frontmatter.sui_ip ?? frontmatter.id;
    console.log(`  Frontmatter 'sip': ${fmSip}`);
    const fileNameNumMatch = fileName.match(/^(?:sip-)?(\d+)(?:\.md)$/i); // Matches sip-DDD.md or DDD.md

    if (fmSip !== undefined && String(fmSip).match(/^\d+$/)) {
        id = `sip-${String(fmSip).padStart(3, '0')}`;
    } else if (fileNameNumMatch && fileNameNumMatch[1]) {
        id = `sip-${String(fileNameNumMatch[1]).padStart(3, '0')}`;
    } else if (typeof fmSip === 'string' && fmSip.trim() !== '' && !String(fmSip).match(/^\d+$/) && !fmSip.toLowerCase().includes("<to be assigned>")) {
        id = fmSip.trim().toLowerCase().replace(/\s+/g, '-');
    }
     else {
        id = fileName.replace(/\.md$/, ''); // e.g., "my-proposal" or "sip-liveness"
    }
    console.log(`  Derived ID: ${id}`);


    const explicitTitle = frontmatter.title || frontmatter.name;
    console.log(`  Explicit title from frontmatter: ${explicitTitle}`);
    const sipTitle = String(explicitTitle || `SIP: ${id.startsWith('sip-') ? id.substring(4).replace(/^0+/, '') : id}`);

    // For PRs, if we couldn't derive a standard numeric SIP ID (sip-XXX) and there's no explicit title, skip it.
    if (source === 'pull_request' && !id.match(/^sip-\d+$/i) && !explicitTitle) {
        console.log(`  Skipping PR SIP (path: ${filePath}, derived ID: '${id}') because it has a non-standard ID and no explicit title in frontmatter.`);
        return null;
    }

    const statusFromFrontmatter = frontmatter.status as SipStatus;
    const validStatuses: SipStatus[] = ["Draft", "Proposed", "Accepted", "Live", "Rejected", "Withdrawn", "Archived", "Final"];
    const status: SipStatus = statusFromFrontmatter && validStatuses.includes(statusFromFrontmatter)
        ? statusFromFrontmatter
        : defaultStatus;
    console.log(`  Derived Status: ${status} (from frontmatter: ${statusFromFrontmatter}, default: ${defaultStatus})`);

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
        } else {
            // Fallback PR URL linking to a search query for the SIP ID
            prUrlToUse = `https://github.com/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?q=is%3Apr+${encodeURIComponent(id)}`;
        }
    }

    const nowISO = new Date().toISOString();
    const createdAt = optionCreatedAt ? parseValidDate(optionCreatedAt) : parseValidDate(frontmatter.created || frontmatter.date, nowISO)!;
    const updatedAt = optionUpdatedAt ? parseValidDate(optionUpdatedAt) : parseValidDate(frontmatter.updated || frontmatter['last-call-deadline'] || frontmatter.lastUpdated || frontmatter['last-updated'], createdAt)!;

    let mergedAt: string | undefined;
    if (optionMergedAt) {
      mergedAt = parseValidDate(optionMergedAt);
    } else if (source === 'folder' && status === 'Final') { // Only set mergedAt for 'folder' source if status is indeed Final
      mergedAt = parseValidDate(frontmatter.merged, updatedAt); // Use updatedAt as fallback if 'merged' frontmatter is missing
    } else if (frontmatter.merged) { // For PRs, if 'merged' is in frontmatter, use it
        mergedAt = parseValidDate(frontmatter.merged);
    }
    console.log(`  Dates - Created: ${createdAt}, Updated: ${updatedAt}, Merged: ${mergedAt}`);

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
      mergedAt,
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
        // For files from the main branch folder, their status is considered 'Final'
        // and their creation/update times can be derived from frontmatter or fall back to now/each other.
        return parseSipFile(rawContent, {
          fileName: file.name,
          filePath: file.path, // file.path is the full path from repo root
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
  const openPRsUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls?state=open&sort=updated&direction=desc&per_page=50`;
  let openPRs: GitHubPullRequest[];
  try {
    openPRs = await fetchFromGitHubAPI(openPRsUrl);
  } catch (error) {
    console.error("Failed to fetch open pull requests:", error);
    return [];
  }
  console.log(`Fetched ${openPRs.length} open PRs.`);

  const draftSips: SIP[] = [];

  for (const pr of openPRs) {
    console.log(`Processing PR #${pr.number}: ${pr.title}`);
    try {
      const prFilesUrl = `${GITHUB_API_URL}/repos/${SIPS_REPO_OWNER}/${SIPS_REPO_NAME}/pulls/${pr.number}/files`;
      const prFiles = await fetchFromGitHubAPI(prFilesUrl) as GitHubFile[];
      console.log(`  PR #${pr.number}: Found ${prFiles.length} files.`);

      for (const file of prFiles) {
        // For PR files, 'file.filename' gives the full path. 'file.path' is not available.
        const filePath = file.filename;
        if (!filePath) {
            console.log(`    PR #${pr.number}: Skipping file due to missing 'filename' field. File object:`, file);
            continue;
        }
        const fileName = filePath.split('/').pop(); // Get base name like 'sip-liveness.md'

        // Check if the file is in the SIPS_MAIN_BRANCH_PATH directory (e.g., 'sips/')
        const isInSipsFolder = filePath.startsWith(SIPS_MAIN_BRANCH_PATH + '/');
        // Check if it's a markdown file and not a template
        const isCandidateSipFile = fileName && filePath.endsWith('.md') && !fileName.toLowerCase().includes('template');
        
        // Determine if the file change type is relevant
        const relevantChangeTypes = ['added', 'modified', 'renamed', 'copied', 'changed'];
        const isRelevantChange = file.status && relevantChangeTypes.includes(file.status);

        console.log(`    File: ${filePath}, Name: ${fileName}, Status: ${file.status}, Is Candidate: ${!!isCandidateSipFile}, Is in SIPs folder: ${isInSipsFolder}, Is Relevant Change: ${isRelevantChange}, Has raw_url: ${!!file.raw_url}`);

        if (isRelevantChange &&
            isInSipsFolder &&
            isCandidateSipFile &&
            file.raw_url && // Ensure there's a URL to fetch content
            fileName // Ensure fileName is not undefined
        ) {
          console.log(`    PR #${pr.number}: File ${filePath} is a candidate. Fetching content...`);
          try {
            const rawContent = await fetchRawContent(file.raw_url);
            const parsedSip = await parseSipFile(rawContent, {
              fileName: fileName, // Pass base filename
              filePath: filePath,   // Pass full path
              prUrl: pr.html_url,
              defaultStatus: 'Draft', // Default for PRs, can be overridden by frontmatter
              source: 'pull_request',
              createdAt: pr.created_at, // Use PR creation for SIP creation if from PR
              updatedAt: pr.updated_at, // Use PR update for SIP update if from PR
              mergedAt: pr.merged_at || undefined, // Pass PR merged_at if available
            });
            if (parsedSip) {
              console.log(`    PR #${pr.number}: Successfully parsed ${filePath} as SIP ID ${parsedSip.id}. Status: ${parsedSip.status}. Adding to drafts.`);
              draftSips.push(parsedSip);
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
    } catch (error) {
      console.error(`  Error processing files for PR #${pr.number}:`, error);
    }
  }
  console.log(`Found ${draftSips.length} potential draft SIPs from PRs.`);
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

    // Add folder SIPs first (these are considered canonical/Final)
    folderSips.forEach(sip => {
      if (sip.id) {
        combinedSipsMap.set(sip.id.toLowerCase(), sip);
      } else {
        console.warn(`Folder SIP with missing ID encountered: ${sip.title}`);
      }
    });

    // Add PR SIPs
    prSips.forEach(prSip => {
      if (prSip.id) {
        const normalizedPrSipId = prSip.id.toLowerCase();
        const existingSip = combinedSipsMap.get(normalizedPrSipId);
        if (!existingSip) {
          // If no existing SIP with this ID, add the PR SIP
          console.log(`Adding new PR SIP ${prSip.id} (Source: ${prSip.source}, Status: ${prSip.status})`);
          combinedSipsMap.set(normalizedPrSipId, prSip);
        } else {
          // If a SIP with this ID already exists (likely from 'folder' source)
          // We prefer the 'folder' (Final) version over a 'pull_request' (Draft) version.
          // This handles cases where a PR might be for an already merged SIP (e.g., minor edits to a Final SIP).
          // Or if a PR exists for a SIP that also has a final version.
          if (existingSip.source === 'folder' && prSip.source === 'pull_request') {
             console.log(`Skipping PR SIP ${prSip.id} (Source: ${prSip.source}, Status: ${prSip.status}) as a version from 'folder' (Status: ${existingSip.status}) already exists for this ID.`);
          } else if (existingSip.source === 'pull_request' && prSip.source === 'pull_request') {
            // If both are from PRs (e.g. multiple PRs propose same ID, though unlikely or should be distinct PRs)
            // For now, let's log and potentially take the one with more recent 'updatedAt' or just let the last one win.
            // This scenario might need more sophisticated handling if common.
            console.log(`Conflict: Multiple PR SIPs for ID ${prSip.id}. Existing (updated: ${existingSip.updatedAt}), New (updated: ${prSip.updatedAt}). Overwriting with new one for now.`);
            combinedSipsMap.set(normalizedPrSipId, prSip);
          } else {
            // Other cases, e.g. existing is PR and new is Folder (shouldn't happen if folder processed first)
            // Or some other combination. Default to overwriting with current prSip but log.
            console.log(`Overwriting/Updating SIP ${prSip.id} with version from PR (Source: ${prSip.source}, Status: ${prSip.status}). Existing was (Source: ${existingSip.source}, Status: ${existingSip.status})`);
            combinedSipsMap.set(normalizedPrSipId, prSip);
          }
        }
      } else {
         console.warn(`PR SIP with missing ID encountered: ${prSip.title}, PR URL: ${prSip.prUrl}`);
      }
    });

    let sips = Array.from(combinedSipsMap.values());

    sips.sort((a, b) => {
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Archived", "Rejected", "Withdrawn"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);

      if (statusAIndex !== statusBIndex) {
        return statusAIndex - statusBIndex;
      }

      const numA = parseInt(a.id.replace(/^sip-/i, ''), 10);
      const numB = parseInt(b.id.replace(/^sip-/i, ''), 10);

      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numB - numA;
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
    sipsCache = null; // Invalidate cache on error
    return []; // Return empty array or throw, depending on desired error handling
  }
}

export async function getSipById(id: string): Promise<SIP | null> {
  let sipsToSearch = sipsCache;
  const now = Date.now();

  // Check if cache is invalid or too old
  if (!sipsToSearch || !cacheTimestamp || (now - cacheTimestamp >= CACHE_DURATION)) {
    console.log(`Cache miss or stale for getSipById(${id}). Refreshing all SIPs.`);
    sipsToSearch = await getAllSips(); // This will update sipsCache
  } else {
    console.log(`Serving getSipById(${id}) from existing cache.`);
  }

  // Normalize the input ID to match the format used in the map keys (e.g., 'sip-001' or 'my-proposal-slug')
  const normalizedIdInput = id.toLowerCase().startsWith('sip-') && id.match(/^sip-\d+$/i)
    ? id.toLowerCase() // e.g. sip-001
    : id.toLowerCase().match(/^\d+$/)
      ? `sip-${id.toLowerCase().padStart(3, '0')}` // e.g. 1 -> sip-001
      : id.toLowerCase().replace(/\s+/g, '-'); // e.g. my proposal -> my-proposal

  console.log(`Normalized ID for search: ${normalizedIdInput}`);

  const foundSip = sipsToSearch.find(sip => {
    if (!sip.id) return false;
    // Normalize the SIP's ID from the list in the same way for comparison
    const sipNormalizedMapId = sip.id.toLowerCase(); // Map keys are already toLowerCase()
    return sipNormalizedMapId === normalizedIdInput;
  });

  if (foundSip) {
    console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) found in current list.`);
    return foundSip;
  }

  // If not found and cache is somewhat old (e.g., more than halfway through CACHE_DURATION),
  // it might be worth trying one more refresh, especially if the SIP was recently added.
  // This is a softer refresh than the main getAllSips revalidation.
  if (cacheTimestamp && (now - cacheTimestamp >= CACHE_DURATION / 2)) {
     console.log(`SIP ID ${id} (normalized: ${normalizedIdInput}) not found, cache is older than half duration. Attempting one more refresh.`);
     sipsToSearch = await getAllSips(); // Force refresh, this updates sipsCache
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
