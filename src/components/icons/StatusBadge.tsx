import type { SipStatus } from '@/types/sip';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, FileText, ThumbsUp, MessageSquare, XCircle, Undo2, Archive, Rocket, Pencil, Award } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface StatusBadgeProps {
  status: SipStatus;
}

const statusConfig: Record<SipStatus, { icon: LucideIcon; colorClass: string; label: string }> = {
  Draft: { icon: Pencil, colorClass: 'bg-blue-500 hover:bg-blue-600', label: 'Draft' },
  Proposed: { icon: MessageSquare, colorClass: 'bg-purple-500 hover:bg-purple-600', label: 'Proposed' },
  Accepted: { icon: ThumbsUp, colorClass: 'bg-yellow-500 hover:bg-yellow-600 text-black', label: 'Accepted' },
  Live: { icon: Rocket, colorClass: 'bg-green-500 hover:bg-green-600', label: 'Live' },
  Rejected: { icon: XCircle, colorClass: 'bg-red-500 hover:bg-red-600', label: 'Rejected' },
  Withdrawn: { icon: Undo2, colorClass: 'bg-gray-500 hover:bg-gray-600', label: 'Withdrawn' },
  Archived: { icon: Archive, colorClass: 'bg-neutral-500 hover:bg-neutral-600', label: 'Archived' },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] || { icon: FileText, colorClass: 'bg-gray-400', label: status };
  const IconComponent = config.icon;

  return (
    <Badge variant="default" className={`${config.colorClass} text-primary-foreground flex items-center gap-1.5 whitespace-nowrap`}>
      <IconComponent size={14} />
      {config.label}
    </Badge>
  );
}
