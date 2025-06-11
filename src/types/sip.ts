
export type SipStatus = "Draft" | "Proposed" | "Accepted" | "Live" | "Rejected" | "Withdrawn" | "Archived" | "Final";

export interface SIP {
  id: string; // e.g., "sip-001"
  title: string;
  status: SipStatus;
  summary: string;
  body: string; // Markdown content
  prUrl: string;
  source: 'folder' | 'pull_request'; // Indicates if the SIP is from a merged file or a PR
  mergedAt?: string; // ISO date string, optional if not merged
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}
