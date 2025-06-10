"use client";

import type { SIP } from '@/types/sip';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/icons/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, CalendarDays, GitMerge } from 'lucide-react';
import { format, parseISO } from 'date-fns';

interface SipDetailClientProps {
  sip: SIP;
}

export default function SipDetailClient({ sip }: SipDetailClientProps) {
  return (
    <Card className="shadow-lg w-full">
      <CardHeader>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2">
          <CardTitle className="font-headline text-3xl">{sip.title}</CardTitle>
          <StatusBadge status={sip.status} />
        </div>
        <CardDescription className="text-lg leading-relaxed">{sip.summary}</CardDescription>
        <div className="flex flex-wrap gap-2 mt-3 text-sm text-muted-foreground items-center">
          <span className="font-mono bg-muted px-2 py-1 rounded">{sip.id}</span>
          <div className="flex items-center gap-1">
            <CalendarDays size={16} />
            <span>Created: {format(parseISO(sip.createdAt), 'MMM d, yyyy')}</span>
          </div>
          <div className="flex items-center gap-1">
            <CalendarDays size={16} />
            <span>Updated: {format(parseISO(sip.updatedAt), 'MMM d, yyyy')}</span>
          </div>
          {sip.mergedAt && (
            <div className="flex items-center gap-1">
              <GitMerge size={16} />
              <span>Merged: {format(parseISO(sip.mergedAt), 'MMM d, yyyy')}</span>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {sip.topics.map((topic) => (
            <Badge key={topic} variant="secondary">{topic}</Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <MarkdownRenderer content={sip.body} />
      </CardContent>
      <CardFooter>
        <Button asChild variant="default" className="bg-accent hover:bg-accent/90 text-accent-foreground">
          <a href={sip.prUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-2 h-4 w-4" /> View PR on GitHub
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}
