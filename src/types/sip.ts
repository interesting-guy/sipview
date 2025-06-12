
export type SipStatus = "Draft" | "Proposed" | "Accepted" | "Live" | "Rejected" | "Withdrawn" | "Archived" | "Final" | "Draft (no file)" | "Closed (unmerged)";

export interface AiSummary {
  whatItIs: string;
  whatItChanges: string;
  whyItMatters: string;
}

export interface Comment {
  id: number;
  author: string;
  avatar: string;
  body: string;
  createdAt: string; // ISO date string
  htmlUrl: string; // Link to the comment on GitHub
  filePath?: string; // For review comments, the path to the file commented on
}

export interface SIP {
  id: string; // e.g., "sip-001"
  title: string;
  status: SipStatus;
  summary: string; // For general description/abstract, or placeholder for metadata-only SIPs
  aiSummary: AiSummary; // Structured AI summary
  body?: string; // Markdown content, optional for metadata-only
  prUrl: string;
  source: 'folder' | 'pull_request' | 'pull_request_only' | 'withdrawn_folder' | 'folder+pr'; // Indicates origin
  mergedAt?: string; // ISO date string, optional if not merged
  createdAt: string; // ISO date string
  updatedAt?: string; // ISO date string, now optional
  author?: string; // GitHub username of PR author or from frontmatter
  prNumber?: number; // GitHub PR number or from frontmatter
  filePath?: string; // The path of the file from which this SIP was parsed
  comments?: Comment[]; // Added comments field

  // Internal fields, not strictly part of the "public" SIP type but used for rendering logic
  _rawIssueCommentCount?: number;
  _rawReviewCommentCount?: number;
  _commentFetchLimit?: number;
}

