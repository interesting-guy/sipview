"use client";

import type { SIP, SipStatus } from '@/types/sip';
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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import StatusBadge from '@/components/icons/StatusBadge';
import { ArrowUpDown, Search } from 'lucide-react';
import { format, parseISO } from 'date-fns';

interface SipTableClientProps {
  sips: SIP[];
}

type SortKey = keyof Pick<SIP, 'id' | 'title' | 'status' | 'updatedAt'>;

export default function SipTableClient({ sips: initialSips }: SipTableClientProps) {
  const router = useRouter();
  const [sips, setSips] = useState(initialSips);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    setSips(initialSips);
  }, [initialSips]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder('asc');
    }
  };

  const filteredAndSortedSips = useMemo(() => {
    let filtered = sips.filter(sip =>
      sip.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      sip.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      sip.summary.toLowerCase().includes(searchTerm.toLowerCase()) ||
      sip.topics.some(topic => topic.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    if (sortKey) {
      filtered.sort((a, b) => {
        const valA = a[sortKey];
        const valB = b[sortKey];

        if (typeof valA === 'string' && typeof valB === 'string') {
          if (sortKey === 'updatedAt' || sortKey === 'createdAt' || sortKey === 'mergedAt') {
             // Date sorting
            const dateA = valA ? parseISO(valA).getTime() : 0;
            const dateB = valB ? parseISO(valB).getTime() : 0;
            return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
          }
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
    return <ArrowUpDown className="ml-2 h-4 w-4 inline-block opacity-50" />;
  };

  const handleRowClick = (sipId: string) => {
    router.push(`/sips/${sipId}`);
  };

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search SIPs by ID, title, summary, or topic..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10 w-full md:w-1/2 lg:w-1/3 shadow-sm"
        />
      </div>
      <Card className="shadow-lg">
        <CardContent className="p-0">
      <div className="rounded-lg border overflow-hidden shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead onClick={() => handleSort('id')} className="cursor-pointer hover:bg-muted/50 w-[120px]">
                ID {renderSortIcon('id')}
              </TableHead>
              <TableHead onClick={() => handleSort('title')} className="cursor-pointer hover:bg-muted/50">
                Title {renderSortIcon('title')}
              </TableHead>
              <TableHead onClick={() => handleSort('status')} className="cursor-pointer hover:bg-muted/50 w-[150px]">
                Status {renderSortIcon('status')}
              </TableHead>
              <TableHead className="w-[200px]">Topics</TableHead>
              <TableHead onClick={() => handleSort('updatedAt')} className="cursor-pointer hover:bg-muted/50 w-[180px] text-right">
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
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {sip.topics.map((topic) => (
                      <Badge key={topic} variant="secondary" className="text-xs">{topic}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {format(parseISO(sip.updatedAt), 'MMM d, yyyy')}
                </TableCell>
              </TableRow>
            ))}
            {filteredAndSortedSips.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                  No SIPs found.
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

// Minimal Card components for structure if not importing from ui/card
// This is to avoid error if Card is not correctly imported/available in context
const Card = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <div className={cn("rounded-lg border bg-card text-card-foreground", className)}>{children}</div>
);
Card.displayName = "Card";

const CardContent = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <div className={cn("p-6 pt-0", className)}>{children}</div>
);
CardContent.displayName = "CardContent";

// Minimal cn utility
function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}
