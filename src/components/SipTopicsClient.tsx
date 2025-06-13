
"use client";

import type { SIP, SipStatus } from '@/types/sip';
import type { TopicCategory } from '@/lib/sips_categorization';
import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/icons/StatusBadge';
import { Search, Package, CalendarDays } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';
import { cn } from '@/lib/utils';

interface SipTopicsClientProps {
  categorizedSips: Map<TopicCategory, SIP[]>;
  topicOrder: readonly TopicCategory[];
}

export default function SipTopicsClient({ categorizedSips, topicOrder }: SipTopicsClientProps) {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [openAccordions, setOpenAccordions] = useState<string[]>([]);

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    const date = parseISO(dateString);
    return isValid(date) ? format(date, 'MMM d, yyyy') : 'N/A';
  };

  const filteredCategorizedSips = useMemo(() => {
    if (!searchTerm) {
      return categorizedSips;
    }
    const lowerSearchTerm = searchTerm.toLowerCase();
    const filteredMap = new Map<TopicCategory, SIP[]>();

    topicOrder.forEach(topic => {
      const sipsInTopic = categorizedSips.get(topic) || [];
      const filteredSips = sipsInTopic.filter(sip => 
        sip.title.toLowerCase().includes(lowerSearchTerm) ||
        sip.id.toLowerCase().includes(lowerSearchTerm) ||
        sip.summary.toLowerCase().includes(lowerSearchTerm) ||
        (sip.body || '').toLowerCase().includes(lowerSearchTerm)
      );
      if (filteredSips.length > 0) {
        filteredMap.set(topic, filteredSips);
      } else {
         filteredMap.set(topic, []); 
      }
    });
    return filteredMap;
  }, [searchTerm, categorizedSips, topicOrder]);
  
   useMemo(() => {
    if (searchTerm) {
      const newOpenAccordions: string[] = [];
      topicOrder.forEach(topic => {
        if ((filteredCategorizedSips.get(topic) || []).length > 0) {
          newOpenAccordions.push(topic);
        }
      });
      setOpenAccordions(newOpenAccordions);
    }
  }, [searchTerm, filteredCategorizedSips, topicOrder]);


  const handleSipClick = (sipId: string) => {
    router.push(`/sips/${sipId}`);
  };

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search SIPs across all topics..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10 w-full md:w-1/2 lg:w-1/3 shadow-sm"
        />
      </div>

      {topicOrder.length === 0 && <p>No topics found.</p>}
      
      <Accordion 
        type="multiple" 
        className="w-full space-y-2"
        value={openAccordions}
        onValueChange={setOpenAccordions}
      >
        {topicOrder.map(topic => {
          const sipsInThisTopic = filteredCategorizedSips.get(topic) || [];
          const originalSipsInThisTopic = categorizedSips.get(topic) || [];
          const sipCount = sipsInThisTopic.length;
          const originalSipCount = originalSipsInThisTopic.length;

          if (originalSipCount === 0 && !searchTerm) return null; 

          return (
            <AccordionItem key={topic} value={topic} className="border bg-card rounded-lg shadow-sm">
              <AccordionTrigger className="px-6 py-4 hover:no-underline text-lg font-semibold">
                <div className="flex items-center gap-2">
                  <Package size={20} className="text-primary" /> 
                  {topic} ({sipCount} {searchTerm && `of ${originalSipCount}`})
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                {sipCount === 0 ? (
                  <p className="text-muted-foreground italic">
                    {searchTerm ? `No SIPs matching "${searchTerm}" in this topic.` : "No SIPs currently in this topic."}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {sipsInThisTopic.map(sip => (
                      <Link href={`/sips/${sip.id}`} key={sip.id} className="block p-0 m-0">
                        <Card 
                            onClick={(e) => { e.preventDefault(); handleSipClick(sip.id);}} 
                            className={cn(
                              "hover:shadow-md transition-shadow cursor-pointer",
                              "animate-in fade-in-0 delay-100 duration-500 ease-out"
                            )}
                        >
                          <CardHeader className="pb-3 pt-4 px-4">
                            <CardTitle className="text-base font-medium leading-tight">{sip.id}: {sip.cleanTitle || sip.title}</CardTitle>
                          </CardHeader>
                          <CardContent className="flex justify-between items-center text-xs text-muted-foreground px-4 pb-3">
                            <StatusBadge status={sip.status} />
                            <div className="flex items-center gap-1">
                                <CalendarDays size={14} />
                                Merged: {formatDate(sip.mergedAt)}
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
