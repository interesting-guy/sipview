
"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface DiscussionActivityIndicatorProps {
  totalComments: number;
}

export default function DiscussionActivityIndicator({ totalComments }: DiscussionActivityIndicatorProps) {
  let colorClass = "bg-muted-foreground"; // Default for 0 or undefined
  let activityLevel = "No";

  if (totalComments > 0 && totalComments <= 2) {
    colorClass = "bg-blue-500";
    activityLevel = "Low";
  } else if (totalComments >= 3 && totalComments <= 5) {
    colorClass = "bg-yellow-500";
    activityLevel = "Medium";
  } else if (totalComments >= 6) {
    colorClass = "bg-red-500";
    activityLevel = "High";
  }

  const tooltipText = `${totalComments} comment${totalComments !== 1 ? 's' : ''} (${activityLevel} activity)`;

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-center w-full">
            <span className={cn("h-2.5 w-2.5 rounded-full inline-block", colorClass)} />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
