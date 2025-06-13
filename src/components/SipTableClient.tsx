
"use client";

import type { SIP } from '@/types/sip';
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
import StatusBadge from '@/components/icons/StatusBadge';
import { ArrowUpDown, Search, ListFilter, X } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';

interface SipTableClientProps {
  sips: SIP[];
}

type SortKey = keyof Pick<SIP, 'id' | 'title' | 'status' | 'updatedAt' | 'createdAt' | 'mergedAt' | 'type'>;

export default function SipTableClient({ sips: initialSips }: SipTableClientProps) {
  const router = useRouter();
  const [sips, setSips] = useState(initialSips);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('mergedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);

  useEffect(() => {
    setSips(initialSips);
  }, [initialSips]);

  const availableTypes = useMemo(() => {
    const types = new Set<string>();
    sips.forEach(sip => sip.type && types.add(sip.type));
    return Array.from(types).sort();
  }, [sips]);

  const availableLabels = useMemo(() => {
    const labels = new Set<string>();
    sips.forEach(sip => sip.labels?.forEach(label => labels.add(label)));
    return Array.from(labels).sort();
  }, [sips]);

  const getCountForOption = useCallback((field: 'type' | 'label', option: string) => {
    return sips.filter(sip => {
      if (field === 'type') return sip.type === option;
      if (field === 'label') return sip.labels?.includes(option);
      return false;
    }).length;
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
      const searchMatch =
        sip.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sip.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sip.summary.toLowerCase().includes(searchTerm.toLowerCase());

      const typeMatch = selectedTypes.length === 0 || (sip.type && selectedTypes.includes(sip.type));
      
      const labelMatch = selectedLabels.length === 0 || selectedLabels.every(label => sip.labels?.includes(label));

      return searchMatch && typeMatch && labelMatch;
    });

    if (sortKey) {
      filtered.sort((a, b) => {
        const valA = a[sortKey] as any;
        const valB = b[sortKey] as any;

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
  }, [sips, searchTerm, sortKey, sortOrder, selectedTypes, selectedLabels]);

  const renderSortIcon = (key: SortKey) => {
    if (sortKey === key) {
      return sortOrder === 'asc' ? ' ▲' : ' ▼';
    }
    return <ArrowUpDown className="ml-2 h-4 w-4 inline-block opacity-30 group-hover:opacity-100" />;
  };

  const handleRowClick = (sipId: string) => {
    router.push(`/sips/${sipId}`);
  };
  
  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    const date = parseISO(dateString);
    return isValid(date) ? format(date, 'MMM d, yyyy') : 'N/A';
  };

  const toggleType = (type: string) => {
    setSelectedTypes(prev => 
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const toggleLabel = (label: string) => {
    setSelectedLabels(prev =>
      prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label]
    );
  };

  const clearFilters = () => {
    setSelectedTypes([]);
    setSelectedLabels([]);
    setSearchTerm('');
  };
  
  const hasActiveFilters = selectedTypes.length > 0 || selectedLabels.length > 0 || searchTerm !== '';

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
                Type {selectedTypes.length > 0 ? `(${selectedTypes.length})` : ''}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel>Filter by Type</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {availableTypes.map(type => (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={selectedTypes.includes(type)}
                  onCheckedChange={() => toggleType(type)}
                  onSelect={(e) => e.preventDefault()} // Prevent closing on select
                >
                  {type} ({getCountForOption('type', type)})
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="shadow-sm">
                <ListFilter className="mr-2 h-4 w-4" />
                Labels {selectedLabels.length > 0 ? `(${selectedLabels.length})` : ''}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64 max-h-96 overflow-y-auto">
               <DropdownMenuLabel>Filter by Labels</DropdownMenuLabel>
               <DropdownMenuSeparator />
              {availableLabels.map(label => (
                <DropdownMenuCheckboxItem
                  key={label}
                  checked={selectedLabels.includes(label)}
                  onCheckedChange={() => toggleLabel(label)}
                  onSelect={(e) => e.preventDefault()} // Prevent closing on select
                >
                  {label} ({getCountForOption('label', label)})
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {hasActiveFilters && (
            <Button variant="ghost" onClick={clearFilters} className="text-accent hover:text-accent/90">
              <X className="mr-2 h-4 w-4" /> Clear All
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
                  <TableHead onClick={() => handleSort('id')} className="group cursor-pointer hover:bg-muted/50 w-[120px]">
                    ID {renderSortIcon('id')}
                  </TableHead>
                  <TableHead onClick={() => handleSort('title')} className="group cursor-pointer hover:bg-muted/50">
                    Title {renderSortIcon('title')}
                  </TableHead>
                  <TableHead onClick={() => handleSort('status')} className="group cursor-pointer hover:bg-muted/50 w-[150px]">
                    Status {renderSortIcon('status')}
                  </TableHead>
                  <TableHead onClick={() => handleSort('type')} className="group cursor-pointer hover:bg-muted/50 w-[150px]">
                    Type {renderSortIcon('type')}
                  </TableHead>
                  <TableHead className="w-[200px]">Labels</TableHead>
                   <TableHead onClick={() => handleSort('mergedAt')} className="group cursor-pointer hover:bg-muted/50 w-[180px] text-right">
                    Merged Date {renderSortIcon('mergedAt')}
                  </TableHead>
                  <TableHead onClick={() => handleSort('updatedAt')} className="group cursor-pointer hover:bg-muted/50 w-[180px] text-right">
                    Last Updated {renderSortIcon('updatedAt')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAndSortedSips.map((sip) => (
                  <TableRow key={sip.id} onClick={() => handleRowClick(sip.id)} className="cursor-pointer hover:bg-muted/30 transition-colors duration-150">
                    <TableCell className="font-mono text-sm">{sip.id}</TableCell>
                    <TableCell className="font-medium">{sip.title}</TableCell>
                    <TableCell>
                      <StatusBadge status={sip.status} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{sip.type || 'N/A'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {sip.labels?.slice(0, 3).map(label => (
                          <span key={label} className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full whitespace-nowrap">
                            {label}
                          </span>
                        ))}
                        {sip.labels && sip.labels.length > 3 && (
                           <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full whitespace-nowrap">
                            +{sip.labels.length - 3} more
                          </span>
                        )}
                         {(!sip.labels || sip.labels.length === 0) && <span className="text-xs text-muted-foreground italic">None</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {formatDate(sip.mergedAt)}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {formatDate(sip.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredAndSortedSips.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center h-24 text-muted-foreground">
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
