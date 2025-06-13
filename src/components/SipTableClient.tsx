
"use client";

import type { SIP, SipStatus } from '@/types/sip';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { ArrowUpDown, Search, X, ExternalLink } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';
import { getPrimaryTopicEmoji } from '@/lib/sips_categorization';
import { cn } from '@/lib/utils';

interface SipTableClientProps {
  sips: SIP[];
}

type SortKey = keyof Pick<SIP, 'id' | 'title' | 'status' | 'updatedAt' | 'createdAt' | 'mergedAt' | 'cleanTitle'>;

interface SipTableDisplayInfo {
  label: string;
  dateLabel: string;
}

const INSUFFICIENT_SUMMARY_PLACEHOLDER = "This proposal does not contain enough information to summarize.";


function getSipTableDisplayInfo(sip: SIP, formatDateFn: (dateString?: string) => string): SipTableDisplayInfo {
  let label: string;
  let dateLabel: string;

  switch (sip.status) {
    case 'Live':
    case 'Final':
    case 'Accepted':
      label = 'Approved';
      if (sip.status === 'Accepted') {
         dateLabel = sip.mergedAt ? formatDateFn(sip.mergedAt) : 'N/A';
      } else {
         dateLabel = formatDateFn(sip.mergedAt || sip.updatedAt);
      }
      break;
    case 'Proposed':
    case 'Draft':
      label = 'In Progress';
      dateLabel = 'Pending';
      break;
    case 'Draft (no file)':
      label = 'Draft Started';
      dateLabel = 'Pending';
      break;
    case 'Withdrawn':
      label = 'Withdrawn';
      dateLabel = formatDateFn(sip.updatedAt);
      break;
    case 'Rejected':
    case 'Closed (unmerged)':
      label = 'Rejected';
      dateLabel = formatDateFn(sip.updatedAt);
      break;
    case 'Archived':
      label = 'Archived';
      dateLabel = 'N/A';
      break;
    default:
      label = sip.status; 
      dateLabel = 'N/A';
  }
  return { label, dateLabel };
}

type FilterSegment = "All" | "In Progress" | "Approved" | "Withdrawn" | "Rejected";
const filterSegments: FilterSegment[] = ["All", "In Progress", "Approved", "Withdrawn", "Rejected"];

const segmentToStatusesMap: Record<Exclude<FilterSegment, "All">, SipStatus[]> = {
  "In Progress": ["Draft", "Proposed", "Draft (no file)"],
  "Approved": ["Live", "Final", "Accepted"],
  "Withdrawn": ["Withdrawn"],
  "Rejected": ["Rejected", "Closed (unmerged)"],
};

export default function SipTableClient({ sips: initialSips }: SipTableClientProps) {
  const router = useRouter();
  const [sips, setSips] = useState(initialSips);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('mergedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedStatuses, setSelectedStatuses] = useState<SipStatus[]>([]);
  const [activeFilterSegment, setActiveFilterSegment] = useState<FilterSegment>("All");

  useEffect(() => {
    setSips(initialSips);
  }, [initialSips]);

  useEffect(() => {
    if (activeFilterSegment === "All") {
      setSelectedStatuses([]);
    } else {
      setSelectedStatuses(segmentToStatusesMap[activeFilterSegment as Exclude<FilterSegment, "All">]);
    }
  }, [activeFilterSegment]);

  const formatDate = useCallback((dateString?: string) => {
    if (!dateString) return 'N/A';
    const date = parseISO(dateString);
    if (!isValid(date)) return 'N/A';
    if (date.getFullYear() === 1970 && date.getMonth() === 0 && date.getDate() === 1) {
      return 'N/A';
    }
    return format(date, 'MMM d, yyyy');
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder(key === 'mergedAt' || key === 'updatedAt' || key === 'createdAt' ? 'desc' : 'asc');
    }
  };

  const filteredAndSortedSips = useMemo(() => {
    let filtered = sips.filter(sip => {
      const titleToSearch = sip.cleanTitle || sip.title;
      const searchMatch =
        titleToSearch.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sip.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sip.summary.toLowerCase().includes(searchTerm.toLowerCase());

      const statusMatch = selectedStatuses.length === 0 || selectedStatuses.includes(sip.status);
      
      return searchMatch && statusMatch;
    });

    if (sortKey) {
      filtered.sort((a, b) => {
        let valA: any;
        let valB: any;

        if (sortKey === 'status') {
          valA = getSipTableDisplayInfo(a, formatDate).label;
          valB = getSipTableDisplayInfo(b, formatDate).label;
        } else if (sortKey === 'cleanTitle') {
            valA = a.cleanTitle || a.title;
            valB = b.cleanTitle || b.title;
        } else {
            valA = a[sortKey as keyof SIP];
            valB = b[sortKey as keyof SIP];
        }
        
        if (sortKey === 'updatedAt' || sortKey === 'createdAt' || sortKey === 'mergedAt') {
          const dateA = valA && isValid(parseISO(valA)) ? parseISO(valA).getTime() : (sortOrder === 'asc' ? Infinity : -Infinity);
          const dateB = valB && isValid(parseISO(valB)) ? parseISO(valB).getTime() : (sortOrder === 'asc' ? Infinity : -Infinity);
          return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
        }
        
        if (valA === undefined || valA === null) return sortOrder === 'asc' ? 1 : -1;
        if (valB === undefined || valB === null) return sortOrder === 'asc' ? -1 : 1;

        if (typeof valA === 'string' && typeof valB === 'string') {
          return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortOrder === 'asc' ? valA - valB : valB - valA;
        }
        return 0;
      });
    }
    return filtered;
  }, [sips, searchTerm, sortKey, sortOrder, selectedStatuses, formatDate]);

  const renderSortIcon = (key: SortKey) => {
    if (sortKey === key) {
      return sortOrder === 'asc' ? ' ▲' : ' ▼';
    }
    return <ArrowUpDown className="ml-2 h-4 w-4 inline-block opacity-30 group-hover:opacity-100" />;
  };

  const handleRowClick = (sipId: string) => {
    router.push(`/sips/${sipId}`);
  };
  
  const clearFilters = () => {
    setActiveFilterSegment("All");
    setSearchTerm('');
  };
  
  const hasActiveFilters = activeFilterSegment !== "All" || searchTerm !== '';

  return (
    <TooltipProvider delayDuration={100}>
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="relative flex-grow w-full md:w-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search SIPs by ID, title, or summary..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 w-full shadow-sm"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter SIPs by status">
            {filterSegments.map((segment) => (
              <Button
                key={segment}
                variant={activeFilterSegment === segment ? "default" : "outline"}
                onClick={() => setActiveFilterSegment(segment)}
                className={cn(
                  "shadow-sm",
                  activeFilterSegment === segment 
                    ? "bg-primary text-primary-foreground hover:bg-primary/90" 
                    : "hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {segment}
              </Button>
            ))}
          </div>
          {hasActiveFilters && (
            <Button variant="ghost" onClick={clearFilters} className="text-accent hover:text-accent/90 self-start sm:self-center">
              <X className="mr-2 h-4 w-4" /> Clear Filters
            </Button>
          )}
        </div>

        <Card className="shadow-lg">
          <CardContent className="p-0">
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead onClick={() => handleSort('id')} className="group cursor-pointer hover:bg-muted/50 w-[100px]">
                      ID {renderSortIcon('id')}
                    </TableHead>
                    <TableHead onClick={() => handleSort('cleanTitle')} className="group cursor-pointer hover:bg-muted/50">
                      Title {renderSortIcon('cleanTitle')}
                    </TableHead>
                    <TableHead onClick={() => handleSort('status')} className="group cursor-pointer hover:bg-muted/50 w-[160px]">
                      Status {renderSortIcon('status')}
                    </TableHead>
                    <TableHead onClick={() => handleSort('mergedAt')} className="group cursor-pointer hover:bg-muted/50 w-[150px] text-right">
                      Approved On {renderSortIcon('mergedAt')}
                    </TableHead>
                    <TableHead onClick={() => handleSort('updatedAt')} className="group cursor-pointer hover:bg-muted/50 w-[150px] text-right">
                      Last Updated {renderSortIcon('updatedAt')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAndSortedSips.map((sip) => {
                    const displayInfo = getSipTableDisplayInfo(sip, formatDate);
                    const topicEmoji = getPrimaryTopicEmoji(sip);
                    const summaryForTooltip = sip.summary && sip.summary !== INSUFFICIENT_SUMMARY_PLACEHOLDER
                                              ? (sip.summary.length > 120 ? sip.summary.substring(0, 117) + "..." : sip.summary)
                                              : "No summary available.";
                    return (
                      <Tooltip key={sip.id}>
                        <TooltipTrigger asChild>
                          <TableRow onClick={() => handleRowClick(sip.id)} className="cursor-pointer hover:bg-muted/30 transition-colors duration-150">
                            <TableCell className="font-mono text-sm">{sip.id}</TableCell>
                            <TableCell className="font-medium">
                              <span role="img" aria-label="topic icon" className="mr-2">{topicEmoji}</span>
                              {sip.cleanTitle || sip.title}
                            </TableCell>
                            <TableCell>
                              {displayInfo.label}
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {displayInfo.dateLabel}
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {formatDate(sip.updatedAt)}
                            </TableCell>
                          </TableRow>
                        </TooltipTrigger>
                        <TooltipContent className="w-64 sm:w-80 p-3 shadow-xl bg-background border-border" side="top" align="center">
                          <div className="space-y-1.5 text-sm">
                            <p className="font-semibold text-foreground">{sip.cleanTitle || sip.title}</p>
                            <p className="text-muted-foreground text-xs leading-relaxed">
                              {summaryForTooltip}
                            </p>
                            <Separator className="my-1 bg-border" />
                            <div className="flex justify-between items-center text-xs text-muted-foreground">
                              <span>Last Updated: {formatDate(sip.updatedAt)}</span>
                              {sip.prUrl && (
                                <Button variant="outline" size="sm" asChild className="py-0.5 px-1.5 h-auto text-xs border-input hover:bg-accent hover:text-accent-foreground">
                                  <a href={sip.prUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                    <ExternalLink className="mr-1 h-3 w-3" />
                                    GitHub
                                  </a>
                                </Button>
                              )}
                            </div>
                            <p className="text-xs text-center text-muted-foreground/70 pt-1">Click row to view details</p>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                  {filteredAndSortedSips.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                        No SIPs found matching your criteria.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
