
import type { SipStatus } from '@/types/sip';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, FileText, ThumbsUp, MessageSquare, XCircle, Undo2, Archive, Rocket, Pencil, Award, FileQuestion, ArchiveX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface StatusBadgeProps {
  status: SipStatus;
}

const statusConfig: Record<SipStatus, { icon: LucideIcon; colorClass: string; label: string; textColorClass?: string }> = {
  Draft: { icon: Pencil, colorClass: 'bg-sky-500 hover:bg-sky-600', label: 'Draft', textColorClass: 'text-white' },
  "Draft (no file)": { icon: FileQuestion, colorClass: 'bg-sky-500 hover:bg-sky-600', label: 'Draft (No File)', textColorClass: 'text-white' },
  Proposed: { icon: MessageSquare, colorClass: 'bg-blue-500 hover:bg-blue-600', label: 'Proposed', textColorClass: 'text-white' }, // blue-500 is #3B82F6 (primary)
  Accepted: { icon: ThumbsUp, colorClass: 'bg-blue-600 hover:bg-blue-700', label: 'Accepted', textColorClass: 'text-white' }, // blue-600 is #2563EB (accent)
  Live: { icon: Rocket, colorClass: 'bg-blue-600 hover:bg-blue-700', label: 'Live', textColorClass: 'text-white' },
  Final: { icon: Award, colorClass: 'bg-blue-600 hover:bg-blue-700', label: 'Final', textColorClass: 'text-white' },
  Rejected: { icon: XCircle, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Rejected', textColorClass: 'text-white' },
  Withdrawn: { icon: Undo2, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Withdrawn', textColorClass: 'text-white' },
  Archived: { icon: Archive, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Archived', textColorClass: 'text-white' },
  "Closed (unmerged)": { icon: ArchiveX, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Closed (Unmerged)', textColorClass: 'text-white' },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] || { icon: FileText, colorClass: 'bg-gray-400', label: status, textColorClass: 'text-white' };
  const IconComponent = config.icon;

  return (
    <Badge variant="default" className={`${config.colorClass} ${config.textColorClass || 'text-primary-foreground'} flex items-center gap-1.5 whitespace-nowrap`}>
      <IconComponent size={14} />
      {config.label}
    </Badge>
  );
}
