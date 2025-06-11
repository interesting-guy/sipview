

export type SipStatus = "Draft" | "Proposed" | "Accepted" | "Live" | "Rejected" | "Withdrawn" | "Archived" | "Final" | "Draft (no file)" | "Closed (unmerged)";

export interface SIP {
  id: string; // e.g., "sip-001"
  title: string;
  status: SipStatus;
  summary: string; // For AI summary or placeholder for metadata-only SIPs
  body?: string; // Markdown content, optional for metadata-only
  prUrl: string;
  source: 'folder' | 'pull_request' | 'pull_request_only' | 'withdrawn_folder'; // Indicates origin
  mergedAt?: string; // ISO date string, optional if not merged
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
  author?: string; // GitHub username of PR author
  prNumber?: number; // GitHub PR number
}

