export type SipStatus = "Draft" | "Proposed" | "Accepted" | "Live" | "Rejected" | "Withdrawn" | "Archived";

export interface SIP {
  id: string; // e.g., "sip-001"
  title: string;
  status: SipStatus;
  topics: string[]; // e.g., ["gas", "performance"]
  summary: string;
  body: string; // Markdown content
  prUrl: string;
  mergedAt?: string; // ISO date string, optional if not merged
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}
