
"use client";

import type { SIP, Comment as CommentType } from '@/types/sip';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/icons/StatusBadge';
import { ExternalLink, CalendarDays, GitMerge, FolderArchive, UserCircle, Hash, MessageSquare } from 'lucide-react';
import { format, parseISO, isValid, formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import Link from 'next/link';

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

  const formatRelativeDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    const date = parseISO(dateString);
    return isValid(date) ? `${formatDistanceToNow(date)} ago` : 'N/A';
  };

  const renderAiSummaryPoint = (label: string, text?: string) => {
    if (text && text !== INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE && text.trim() !== "" && text.trim() !== "-") {
      return (
        <div>
          <p className="font-semibold text-foreground/90">{label}:</p>
          <p className="text-muted-foreground">{text}</p>
        </div>
      );
    }
    return null;
  };

  const hasMeaningfulPoint = (text?: string) => text && text !== INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE && text.trim() !== "" && text.trim() !== "-";

  const hasAnyAiSummary = sip.aiSummary && (
    hasMeaningfulPoint(sip.aiSummary.whatItIs) ||
    hasMeaningfulPoint(sip.aiSummary.whatItChanges) ||
    hasMeaningfulPoint(sip.aiSummary.whyItMatters)
  );
  
  const hasFallbackAiSummary = sip.aiSummary &&
    sip.aiSummary.whatItIs === "No summary available yet." &&
    sip.aiSummary.whatItChanges === "-" &&
    sip.aiSummary.whyItMatters === "-";


  return (
    <div className="space-y-6">
      <Card className="shadow-lg w-full">
        <CardHeader>
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2">
            <CardTitle className="font-headline text-3xl">{sip.title}</CardTitle>
            <StatusBadge status={sip.status} />
          </div>
          
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
        
        <CardContent className="pt-2 pb-4">
          <div className="mt-0 space-y-3 p-4 border rounded-md bg-muted/10 dark:bg-muted/20 shadow-inner">
            <h3 className="font-headline text-lg font-semibold text-primary">AI-Generated Summary</h3>
            {hasAnyAiSummary && !hasFallbackAiSummary ? (
              <>
                {renderAiSummaryPoint("What it is", sip.aiSummary.whatItIs)}
                {renderAiSummaryPoint("What it changes", sip.aiSummary.whatItChanges)}
                {renderAiSummaryPoint("Why it matters", sip.aiSummary.whyItMatters)}
              </>
            ) : (
              <p className="italic text-muted-foreground">
                {sip.aiSummary.whatItIs === "No summary available yet." 
                 ? "AI summary not available for this proposal yet."
                 : "Detailed AI summary not available for this proposal."}
              </p>
            )}
          </div>
        </CardContent>

        <CardContent className="pt-0"> 
          {sip.body && sip.body.trim() !== "" ? (
            <MarkdownRenderer content={sip.body} />
          ) : (
            <div className="italic text-muted-foreground py-4">
              {sip.source === 'pull_request_only' 
                ? "This SIP is primarily discussed via its Pull Request and does not have a formal proposal document body yet. Details can be found in the PR discussion and comments below."
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

      {/* Discussion Section */}
      {sip.prNumber && (
        <Card className="shadow-lg w-full mt-6">
          <CardHeader>
            <CardTitle className="font-headline text-2xl flex items-center gap-2">
              <MessageSquare size={24} className="text-primary" /> Discussion
            </CardTitle>
            <CardDescription>
              Latest comments from GitHub Pull Request #{sip.prNumber}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sip.comments && sip.comments.length > 0 ? (
              <div className="space-y-6">
                {sip.comments.map((comment: CommentType) => (
                  <div key={comment.id} className="flex items-start space-x-3 p-4 border rounded-md shadow-sm bg-card">
                    <Avatar className="h-10 w-10 border">
                      <AvatarImage src={comment.avatar} alt={`@${comment.author}`} data-ai-hint="user avatar" />
                      <AvatarFallback>{comment.author.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <Link href={`https://github.com/${comment.author}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-sm text-accent hover:underline">
                            @{comment.author}
                        </Link>
                        <Link href={comment.htmlUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:underline">
                          {formatRelativeDate(comment.createdAt)}
                        </Link>
                      </div>
                      <div className="mt-1 text-sm text-foreground prose dark:prose-invert max-w-none">
                        <MarkdownRenderer content={comment.body} />
                      </div>
                    </div>
                  </div>
                ))}
                 {sip.comments.length >= 5 && (
                   <div className="text-center mt-4">
                     <Button asChild variant="outline">
                       <a href={sip.prUrl} target="_blank" rel="noopener noreferrer">
                         View all comments on GitHub <ExternalLink className="ml-2 h-4 w-4" />
                       </a>
                     </Button>
                   </div>
                 )}
              </div>
            ) : (
              <p className="text-muted-foreground italic">
                No comments found for this Pull Request, or discussion is primarily within the PR's main description or file diffs. 
                <a href={sip.prUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline ml-1">View on GitHub</a> for more context.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

