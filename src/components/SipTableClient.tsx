
"use client";

import type { SIP, SipStatus } from '@/types/sip';
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
// StatusBadge is no longer used directly in this table for the status column
// import StatusBadge from '@/components/icons/StatusBadge'; 
import { ArrowUpDown, Search, ListFilter, X } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';

interface SipTableClientProps {
  sips: SIP[];
}

type SortKey = keyof Pick<SIP, 'id' | 'title' | 'status' | 'updatedAt' | 'createdAt' | 'mergedAt' | 'cleanTitle'>;

// Helper function to get display labels for table
interface SipTableDisplayInfo {
  label: string; // Friendly status label
  dateLabel: string; // Label for "Approved On" column
}

function getSipTableDisplayInfo(sip: SIP, formatDateFn: (dateString?: string) => string): SipTableDisplayInfo {
  let label: string;
  let dateLabel: string;

  switch (sip.status) {
    case 'Live':
    case 'Final':
    case 'Accepted':
      label = 'Approved';
      // For Approved statuses, mergedAt is preferred.
      // For Live/Final, if mergedAt is not available, updatedAt can act as a proxy for approval/finalization.
      // For Accepted, if mergedAt is not available, it implies it was accepted but merging details are missing, so N/A.
      if (sip.status === 'Accepted') {
        dateLabel = formatDateFn(sip.mergedAt); 
      } else { // Live or Final
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
      // Fallback for any unexpected statuses
      label = sip.status; 
      dateLabel = 'N/A';
  }
  return { label, dateLabel };
}


export default function SipTableClient({ sips: initialSips }: SipTableClientProps) {
  const router = useRouter();
  const [sips, setSips] = useState(initialSips);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('mergedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedStatuses, setSelectedStatuses] = useState<SipStatus[]>([]);

  useEffect(() => {
    setSips(initialSips);
  }, [initialSips]);

  const formatDate = useCallback((dateString?: string) => {
    if (!dateString) return 'N/A';
    const date = parseISO(dateString);
    if (!isValid(date)) return 'N/A';
    // Check if the date is the epoch date (January 1, 1970)
    if (date.getFullYear() === 1970 && date.getMonth() === 0 && date.getDate() === 1) {
      return 'N/A';
    }
    return format(date, 'MMM d, yyyy');
  }, []);

  const availableStatuses = useMemo(() => {
    const statuses = new Set<SipStatus>();
    sips.forEach(sip => statuses.add(sip.status));
    // Order statuses as per the friendly display preference or a logical flow
    const preferredOrder: SipStatus[] = ['Live', 'Final', 'Accepted', 'Proposed', 'Draft', 'Draft (no file)', 'Withdrawn', 'Rejected', 'Closed (unmerged)', 'Archived'];
    return Array.from(statuses).sort((a, b) => {
        const indexA = preferredOrder.indexOf(a);
        const indexB = preferredOrder.indexOf(b);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return a.localeCompare(b);
    });
  }, [sips]);

  const getCountForStatus = useCallback((status: SipStatus) => {
    return sips.filter(sip => sip.status === status).length;
  }, [sips]);

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
  
  const toggleStatus = (status: SipStatus) => {
    setSelectedStatuses(prev => 
      prev.includes(status) ? prev.filter(s => s !== status) : [...prev, status]
    );
  };

  const clearFilters = () => {
    setSelectedStatuses([]);
    setSearchTerm('');
  };
  
  const hasActiveFilters = selectedStatuses.length > 0 || searchTerm !== '';

  return (
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
        <div className="flex gap-2 flex-wrap">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="shadow-sm">
                <ListFilter className="mr-2 h-4 w-4" />
                Status {selectedStatuses.length > 0 ? `(${selectedStatuses.length})` : ''}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {availableStatuses.map(status => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={selectedStatuses.includes(status)}
                  onCheckedChange={() => toggleStatus(status)}
                  onSelect={(e) => e.preventDefault()} 
                >
                  {getSipTableDisplayInfo({ status } as SIP, formatDate).label} ({getCountForStatus(status)})
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {hasActiveFilters && (
            <Button variant="ghost" onClick={clearFilters} className="text-accent hover:text-accent/90">
              <X className="mr-2 h-4 w-4" /> Clear Filters
            </Button>
          )}
        </div>
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
                  return (
                    <TableRow key={sip.id} onClick={() => handleRowClick(sip.id)} className="cursor-pointer hover:bg-muted/30 transition-colors duration-150">
                      <TableCell className="font-mono text-sm">{sip.id}</TableCell>
                      <TableCell className="font-medium">{sip.cleanTitle || sip.title}</TableCell>
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
  );
}

