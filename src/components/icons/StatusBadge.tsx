
import type { SipStatus } from '@/types/sip';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, FileText, ThumbsUp, MessageSquare, XCircle, Undo2, Archive, Rocket, Pencil, Award, FileQuestion, ArchiveX, ClockHistory } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getFriendlySipStatusLabel } from '@/lib/sips_utils';

interface StatusBadgeProps {
  status: SipStatus;
}

const statusConfig: Record<SipStatus, { icon: LucideIcon; colorClass: string; label: string; textColorClass?: string }> = {
  Draft: { icon: Pencil, colorClass: 'bg-sky-500 hover:bg-sky-600', label: 'Draft', textColorClass: 'text-white' },
  "Draft (no file)": { icon: FileQuestion, colorClass: 'bg-sky-500 hover:bg-sky-600', label: 'Draft (No File)', textColorClass: 'text-white' },
  Proposed: { icon: MessageSquare, colorClass: 'bg-primary hover:bg-primary/90', label: 'Proposed', textColorClass: 'text-primary-foreground' },
  Accepted: { icon: ThumbsUp, colorClass: 'bg-accent hover:bg-accent/90', label: 'Accepted', textColorClass: 'text-accent-foreground' },
  Live: { icon: Rocket, colorClass: 'bg-accent hover:bg-accent/90', label: 'Live', textColorClass: 'text-accent-foreground' },
  Final: { icon: Award, colorClass: 'bg-accent hover:bg-accent/90', label: 'Final', textColorClass: 'text-accent-foreground' },
  Rejected: { icon: XCircle, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Rejected', textColorClass: 'text-white' },
  Withdrawn: { icon: Undo2, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Withdrawn', textColorClass: 'text-white' },
  Archived: { icon: Archive, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Archived', textColorClass: 'text-white' },
  "Closed (unmerged)": { icon: ArchiveX, colorClass: 'bg-slate-500 hover:bg-slate-600', label: 'Closed (Unmerged)', textColorClass: 'text-white' },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] || { icon: FileText, colorClass: 'bg-muted text-muted-foreground', label: status };
  const IconComponent = config.icon;
  const friendlyLabelText = getFriendlySipStatusLabel(status);

  return (
    <Badge variant="default" className={`${config.colorClass} ${config.textColorClass || 'text-primary-foreground'} flex items-center gap-1.5 whitespace-nowrap`}>
      <IconComponent size={14} />
      {friendlyLabelText}
    </Badge>
  );
}
