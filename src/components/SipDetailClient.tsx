
"use client";

import type { SIP } from '@/types/sip';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/icons/StatusBadge';
import { ExternalLink, CalendarDays, GitMerge, FolderArchive, UserCircle, Hash } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';

interface SipDetailClientProps {
  sip: SIP;
}

const INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE = "Insufficient information to summarize this aspect.";

export default function SipDetailClient({ sip }: SipDetailClientProps) {
  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    const date = parseISO(dateString);
    return isValid(date) ? format(date, 'MMM d, yyyy') : 'N/A';
  };

  const renderAiSummaryPoint = (label: string, text?: string) => {
    if (text && text !== INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE && text.trim() !== "") {
      return (
        <div>
          <p className="font-semibold text-foreground/90">{label}:</p>
          <p className="text-muted-foreground">{text}</p>
        </div>
      );
    }
    return null;
  };

  const hasMeaningfulPoint = (text?: string) => text && text !== INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE && text.trim() !== "";

  const hasAnyAiSummary = sip.aiSummary && (
    hasMeaningfulPoint(sip.aiSummary.whatItIs) ||
    hasMeaningfulPoint(sip.aiSummary.whatItChanges) ||
    hasMeaningfulPoint(sip.aiSummary.whyItMatters)
  );

  return (
    <Card className="shadow-lg w-full">
      <CardHeader>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2">
          <CardTitle className="font-headline text-3xl">{sip.title}</CardTitle>
          <StatusBadge status={sip.status} />
        </div>
        
        {/* General Summary/Abstract */}
        <CardDescription className="text-lg leading-relaxed mt-1 mb-3">{sip.summary}</CardDescription>

        <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3 text-sm text-muted-foreground items-center">
          <span className="font-mono bg-muted px-2 py-1 rounded">{sip.id}</span>
          {sip.prNumber && (
            <div className="flex items-center gap-1">
              <Hash size={16} />
              <span>PR: #{sip.prNumber}</span>
            </div>
          )}
          {sip.author && (
             <div className="flex items-center gap-1">
              <UserCircle size={16} />
              <span>Author: {sip.author}</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <CalendarDays size={16} />
            <span>Created: {formatDate(sip.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1">
            <CalendarDays size={16} />
            <span>Updated: {formatDate(sip.updatedAt)}</span>
          </div>
          {sip.mergedAt && (
            <div className="flex items-center gap-1">
              <GitMerge size={16} />
              <span>Merged: {formatDate(sip.mergedAt)}</span>
            </div>
          )}
          <div className="flex items-center gap-1 capitalize">
            <FolderArchive size={16} />
            <span>Source: {sip.source.replace(/_/g, ' ')}</span>
          </div>
        </div>
      </CardHeader>
      
      {/* AI Generated Structured Summary */}
      {sip.aiSummary ? (
        <CardContent className="pt-2 pb-4">
          <div className="mt-0 space-y-3 p-4 border rounded-md bg-muted/10 dark:bg-muted/20 shadow-inner">
            <h3 className="font-headline text-lg font-semibold text-primary">AI-Generated Summary</h3>
            {hasAnyAiSummary ? (
              <>
                {renderAiSummaryPoint("What it is", sip.aiSummary.whatItIs)}
                {renderAiSummaryPoint("What it changes", sip.aiSummary.whatItChanges)}
                {renderAiSummaryPoint("Why it matters", sip.aiSummary.whyItMatters)}
              </>
            ) : (
              <p className="italic text-muted-foreground">Detailed AI summary not available for this proposal.</p>
            )}
          </div>
        </CardContent>
      ) : (
         <CardContent className="pt-2 pb-4">
          <div className="mt-0 space-y-3 p-4 border rounded-md bg-muted/10 dark:bg-muted/20 shadow-inner">
            <h3 className="font-headline text-lg font-semibold text-primary">AI-Generated Summary</h3>
            <p className="italic text-muted-foreground">AI summary not available yet.</p>
          </div>
        </CardContent>
      )}

      <CardContent className="pt-0"> {/* Ensure this CardContent is for the main body */}
        {sip.body && sip.body.trim() !== "" ? (
          <MarkdownRenderer content={sip.body} />
        ) : (
          <div className="italic text-muted-foreground py-4">
            {sip.source === 'pull_request_only' 
              ? "This SIP is a proposal via its Pull Request and does not have a formal proposal document body yet. Details can be found in the PR discussion."
              : "No body content available for this SIP."
            }
          </div>
        )}
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
