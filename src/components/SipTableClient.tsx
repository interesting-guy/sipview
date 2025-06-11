
"use client";

import type { SIP } from '@/types/sip';
import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
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
import { ArrowUpDown, Search } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';

interface SipTableClientProps {
  sips: SIP[];
}

type SortKey = keyof Pick<SIP, 'id' | 'title' | 'status' | 'updatedAt' | 'createdAt' | 'mergedAt'>;

export default function SipTableClient({ sips: initialSips }: SipTableClientProps) {
  const router = useRouter();
  const [sips, setSips] = useState(initialSips);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('mergedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    setSips(initialSips);
  }, [initialSips]);

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
      return searchMatch;
    });

    if (sortKey) {
      filtered.sort((a, b) => {
        const valA = a[sortKey];
        const valB = b[sortKey];

        if (sortKey === 'updatedAt' || sortKey === 'createdAt' || sortKey === 'mergedAt') {
          const dateA = valA && isValid(parseISO(valA)) ? parseISO(valA).getTime() : (sortOrder === 'asc' ? Infinity : -Infinity);
          const dateB = valB && isValid(parseISO(valB)) ? parseISO(valB).getTime() : (sortOrder === 'asc' ? Infinity : -Infinity);
          return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
        }
        
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
  }, [sips, searchTerm, sortKey, sortOrder]);

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

  return (
    <div className="space-y-6">
      <div className="relative flex-grow w-full md:w-auto">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search SIPs by ID, title, or summary..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10 w-full shadow-sm md:w-1/2 lg:w-1/3"
        />
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
