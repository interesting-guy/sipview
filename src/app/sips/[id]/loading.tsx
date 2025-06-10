import { Skeleton } from "@/components/ui/skeleton";

export default function SipDetailLoading() {
  return (
    <div className="w-full space-y-6 p-1"> {/* Added p-1 to prevent overflow with box-shadow */}
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-6 space-y-4">
        {/* Title and Status Skeleton */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2">
          <Skeleton className="h-10 w-3/4 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
        
        {/* Summary Skeleton */}
        <Skeleton className="h-6 w-full rounded-lg" />
        <Skeleton className="h-6 w-5/6 rounded-lg" />

        {/* Metadata Skeleton (ID, Dates, Topics) */}
        <div className="space-y-2 mt-3">
          <Skeleton className="h-5 w-1/4 rounded" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-5 w-1/3 rounded" />
            <Skeleton className="h-5 w-1/3 rounded" />
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        </div>

        {/* Body Content Skeleton */}
        <div className="space-y-3 pt-4">
          <Skeleton className="h-8 w-1/3 rounded-lg" /> {/* H2 */}
          <Skeleton className="h-5 w-full rounded" />
          <Skeleton className="h-5 w-full rounded" />
          <Skeleton className="h-5 w-2/3 rounded" />
          <Skeleton className="h-8 w-1/4 rounded-lg mt-4" /> {/* Another H2 */}
          <Skeleton className="h-5 w-full rounded" />
          <Skeleton className="h-5 w-11/12 rounded" />
        </div>

        {/* Button Skeleton */}
        <Skeleton className="h-10 w-36 rounded-md mt-6" />
      </div>
    </div>
  );
}
