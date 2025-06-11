
"use client";

import type { SIP } from '@/types/sip';
import { useState, useMemo, useEffect, useCallback } from 'react';
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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import StatusBadge from '@/components/icons/StatusBadge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ArrowUpDown, Search, Filter, CalendarClock } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';
import { cn } from '@/lib/utils';

interface SipTableClientProps {
  sips: SIP[];
}

type SortKey = keyof Pick<SIP, 'id' | 'title' | 'status' | 'updatedAt' | 'createdAt' | 'mergedAt'>;

export default function SipTableClient({ sips: initialSips }: SipTableClientProps) {
  const router = useRouter();
  const [sips, setSips] = useState(initialSips);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('mergedAt'); // Default sort by mergedAt
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc'); // Default descending
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [showOnlyLive, setShowOnlyLive] = useState(false);

  useEffect(() => {
    setSips(initialSips);
  }, [initialSips]);

  const allTopics = useMemo(() => {
    const topicsSet = new Set<string>();
    sips.forEach(sip => sip.topics.forEach(topic => topicsSet.add(topic)));
    return Array.from(topicsSet).sort();
  }, [sips]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder(key === 'mergedAt' || key === 'updatedAt' || key === 'createdAt' ? 'desc' : 'asc');
    }
  };

  const toggleTopicFilter = (topicToToggle: string) => {
    setSelectedTopics(prev =>
      prev.includes(topicToToggle)
        ? prev.filter(t => t !== topicToToggle)
        : [...prev, topicToToggle]
    );
  };

  const filteredAndSortedSips = useMemo(() => {
    let filtered = sips.filter(sip => {
      const searchMatch =
        sip.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sip.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sip.summary.toLowerCase().includes(searchTerm.toLowerCase()) ||
        sip.topics.some(topic => topic.toLowerCase().includes(searchTerm.toLowerCase()));

      const topicMatch =
        selectedTopics.length === 0 ||
        selectedTopics.every(st => sip.topics.map(t => t.toLowerCase()).includes(st.toLowerCase()));
      
      const statusMatch = !showOnlyLive || sip.status === 'Live';

      return searchMatch && topicMatch && statusMatch;
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
  }, [sips, searchTerm, sortKey, sortOrder, selectedTopics, showOnlyLive]);

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
    return isValid(date) ? format(date, 'MMM d, yyyy') : 'Invalid Date';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center">
        <div className="relative flex-grow w-full md:w-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search SIPs by ID, title, summary, or topic..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 w-full shadow-sm"
          />
        </div>
        <div className="flex items-center space-x-2">
          <Switch
            id="live-filter"
            checked={showOnlyLive}
            onCheckedChange={setShowOnlyLive}
          />
          <Label htmlFor="live-filter" className="whitespace-nowrap">Only Live SIPs</Label>
        </div>
      </div>

      {allTopics.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Filter size={16} className="text-muted-foreground" />
            <span>Filter by Topic:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {allTopics.map(topic => (
              <Badge
                key={topic}
                variant={selectedTopics.includes(topic) ? 'default' : 'secondary'}
                onClick={() => toggleTopicFilter(topic)}
                className="cursor-pointer hover:opacity-80 transition-opacity text-xs capitalize"
              >
                {topic}
              </Badge>
            ))}
            {selectedTopics.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedTopics([])} className="text-xs h-auto py-1 px-2">
                    Clear All
                </Button>
            )}
          </div>
        </div>
      )}

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
                  <TableHead className="w-[200px]">Topics</TableHead>
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
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {sip.topics.map((topic) => (
                          <Badge key={topic} variant="secondary" className="text-xs capitalize">{topic}</Badge>
                        ))}
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
                    <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">
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
