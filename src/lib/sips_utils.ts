
import type { SipStatus } from '@/types/sip';

/**
 * Maps a raw SIP status to a user-friendly display label.
 */
export function getFriendlySipStatusLabel(status: SipStatus): string {
  switch (status) {
    case 'Live':
    case 'Final':
    case 'Accepted':
      return 'Approved';
    case 'Proposed':
    case 'Draft':
      return 'In Progress';
    case 'Draft (no file)':
      return 'Draft Started';
    case 'Withdrawn':
      return 'Withdrawn';
    case 'Rejected':
    case 'Closed (unmerged)':
      return 'Rejected';
    case 'Archived':
      return 'Archived';
    default:
      return status; // Fallback to the original status if unmapped
  }
}
