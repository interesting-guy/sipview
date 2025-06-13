
"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Info } from "lucide-react";

export default function OnboardingTooltip() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label="App Information">
          <Info className="h-[1.2rem] w-[1.2rem]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 sm:w-96 z-[100] max-h-[80vh] overflow-y-auto" side="bottom" align="end">
        <div className="grid gap-4 p-1">
          <div className="space-y-2">
            <h4 className="font-medium leading-none text-primary">Welcome to SipView!</h4>
            <p className="text-sm text-muted-foreground">
              Understand Sui Improvement Proposals (SIPs) and how to navigate this app.
            </p>
          </div>
          <div className="grid gap-3 text-sm">
            <div>
              <div className="font-semibold mb-1">What are SIPs?</div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Sui Improvement Proposals (SIPs) are formal proposals for new features, standards, or changes to the Sui network. They are key to Sui's governance and evolution.
              </p>
            </div>

            <div>
              <div className="font-semibold mb-1">SIP Statuses Explained:</div>
              <ul className="list-disc list-outside pl-4 space-y-1 text-xs text-muted-foreground leading-relaxed">
                <li><strong>Draft / Draft (no file):</strong> Initial idea or early Pull Request.</li>
                <li><strong>Proposed:</strong> Formally submitted, under community discussion.</li>
                <li><strong>Accepted / Live / Final:</strong> Approved and implemented or being implemented. "Approved On" date often reflects merge/finalization.</li>
                <li><strong>Withdrawn:</strong> Proposal withdrawn by the author.</li>
                <li><strong>Rejected / Closed (unmerged):</strong> Not approved or closed without merge.</li>
                <li><strong>Archived:</strong> Older, inactive SIP kept for records.</li>
              </ul>
            </div>

            <div>
              <div className="font-semibold mb-1">Voting (General Concept):</div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Actual voting on SIPs typically occurs through community discussions on GitHub, forums, and sometimes on-chain, depending on the proposal. This app tracks outcomes and discussions.
              </p>
            </div>

            <div>
              <div className="font-semibold mb-1">Navigation Tips:</div>
              <ul className="list-disc list-outside pl-4 space-y-1 text-xs text-muted-foreground leading-relaxed">
                <li><strong>All SIPs:</strong> Browse all proposals. Search, sort, and filter by status. Hover rows for quick summaries.</li>
                <li><strong>Topics:</strong> Explore SIPs grouped by category.</li>
                <li><strong>SIP Detail Page:</strong> Click any SIP for full details, AI summaries, and GitHub comments.</li>
                <li><strong>Simplify Button:</strong> On detail pages, get an ELI5 (Explain Like I'm 5) version of the AI summary.</li>
                <li><strong>Theme Toggle:</strong> Switch themes (sun/moon icon in header).</li>
              </ul>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
