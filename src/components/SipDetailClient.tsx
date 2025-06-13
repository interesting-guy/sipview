
"use client";

import type { SIP, Comment as CommentType } from '@/types/sip';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/icons/StatusBadge';
import { ExternalLink, CalendarDays, GitMerge, FolderArchive, UserCircle, Hash, MessageSquare, FileCode, Brain, RefreshCcw, Info } from 'lucide-react';
import { format, parseISO, isValid, formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import Link from 'next/link';
import React, { useState, useEffect, useCallback } from 'react';
import { explainSipEli5, type Eli5SipInput } from '@/ai/flows/eli5-sip-flow';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface SipDetailClientProps {
  sip: SIP;
}

const INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE = "Insufficient information to summarize this aspect.";

interface CommentItemProps {
  comment: CommentType;
}

const CommentItem: React.FC<CommentItemProps> = ({ comment }) => {
  const [relativeDate, setRelativeDate] = useState<string>('Loading date...');

  useEffect(() => {
    if (comment.createdAt) {
      const date = parseISO(comment.createdAt);
      if (isValid(date)) {
        setRelativeDate(`${formatDistanceToNow(date)} ago`);
      } else {
        setRelativeDate('Invalid date');
      }
    } else {
      setRelativeDate('Date N/A');
    }
  }, [comment.createdAt]);

  return (
    <div className="flex items-start space-x-3 p-4 border rounded-md shadow-sm bg-card">
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
            {relativeDate}
          </Link>
        </div>
        {comment.filePath && (
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <FileCode size={14} />
            <span>
              Comment on file: <code className="text-xs bg-muted/50 px-1 py-0.5 rounded-sm">{comment.filePath.split('/').pop()}</code>
            </span>
          </div>
        )}
        <div className="mt-1 text-sm text-foreground prose dark:prose-invert max-w-none">
          <MarkdownRenderer content={comment.body} />
        </div>
      </div>
    </div>
  );
};


export default function SipDetailClient({ sip }: SipDetailClientProps) {
  const [isEli5Active, setIsEli5Active] = useState(false);
  const [eli5Summary, setEli5Summary] = useState<string | null>(null);
  const [isEli5Loading, setIsEli5Loading] = useState(false);
  const [eli5Error, setEli5Error] = useState<string | null>(null);

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'N/A';
    const date = parseISO(dateString);
    return isValid(date) ? format(date, 'MMM d, yyyy') : 'N/A';
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

  const showViewAllCommentsButton = sip.prNumber && 
    ( (sip._rawIssueCommentCount !== undefined && sip._rawIssueCommentCount >= (sip._commentFetchLimit || 15)) ||
      (sip._rawReviewCommentCount !== undefined && sip._rawReviewCommentCount >= (sip._commentFetchLimit || 15)) );

  const handleToggleEli5 = useCallback(async () => {
    if (!isEli5Active) { // Toggling to ON
      setIsEli5Active(true);
      if (!eli5Summary && !isEli5Loading) { // Fetch only if not already fetched or loading
        setIsEli5Loading(true);
        setEli5Error(null);
        try {
          const input: Eli5SipInput = {
            title: sip.title,
            // Use sip.summary (CardDescription) as the primary context for ELI5
            proposalContext: sip.summary === INSUFFICIENT_AI_SUMMARY_ASPECT_MESSAGE ? sip.title : sip.summary,
          };
          const result = await explainSipEli5(input);
          setEli5Summary(result.eli5Explanation);
        } catch (error) {
          console.error("ELI5 generation error:", error);
          setEli5Error(error instanceof Error ? error.message : "Failed to generate simplified explanation.");
          setEli5Summary(null); // Clear any previous summary on error
        } finally {
          setIsEli5Loading(false);
        }
      }
    } else { // Toggling to OFF
      setIsEli5Active(false);
      // Optionally clear ELI5 summary if you want it to refetch next time
      // setEli5Summary(null); 
      // setEli5Error(null);
    }
  }, [isEli5Active, eli5Summary, isEli5Loading, sip.title, sip.summary]);
  
  // Reset ELI5 state if SIP changes
  useEffect(() => {
    setIsEli5Active(false);
    setEli5Summary(null);
    setIsEli5Loading(false);
    setEli5Error(null);
  }, [sip.id]);


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
          <div className="flex justify-between items-center mb-2">
             <h3 className="font-headline text-lg font-semibold text-primary">
                {isEli5Active ? "Simplified Summary (ELI5)" : "AI-Generated Summary"}
             </h3>
            <Button variant="outline" size="sm" onClick={handleToggleEli5} disabled={isEli5Loading}>
              {isEli5Active ? <RefreshCcw className="mr-2 h-4 w-4" /> : <Brain className="mr-2 h-4 w-4" />}
              {isEli5Active ? "Back to Technical" : "Simplify"}
            </Button>
          </div>

          <div className="mt-0 space-y-3 p-4 border rounded-md bg-muted/10 dark:bg-muted/20 shadow-inner min-h-[100px]">
            {isEli5Active ? (
              isEli5Loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : eli5Error ? (
                 <Alert variant="destructive">
                  <Info className="h-4 w-4" />
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{eli5Error}</AlertDescription>
                </Alert>
              ) : eli5Summary ? (
                <p className="italic text-muted-foreground">{eli5Summary}</p>
              ) : (
                <p className="italic text-muted-foreground">No simplified summary available.</p>
              )
            ) : ( // Technical AI Summary
              hasAnyAiSummary && !hasFallbackAiSummary ? (
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
              )
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
              Comments from GitHub Pull Request #{sip.prNumber}. Includes general comments and reviews on file changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sip.comments && sip.comments.length > 0 ? (
              <div className="space-y-6">
                {sip.comments.map((comment: CommentType) => (
                  <CommentItem key={comment.id} comment={comment} />
                ))}
                 {showViewAllCommentsButton && (
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
