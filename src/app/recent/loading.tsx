
import { Skeleton } from "@/components/ui/skeleton";

export default function RecentlyUpdatedLoading() {
  return (
    <div className="container mx-auto px-4 py-8 space-y-8">
      {/* Header Skeleton */}
      <div className="space-y-2">
        <Skeleton className="h-10 w-3/5 rounded-lg" />
        <Skeleton className="h-6 w-4/5 rounded-lg" />
      </div>

      {/* Search Input Skeleton */}
      <Skeleton className="h-12 w-full md:w-1/2 lg:w-1/3 rounded-lg" />

      {/* Table Skeleton */}
      <div className="rounded-lg border overflow-hidden">
        <div className="p-4"> {/* Mimic CardContent padding */}
          {/* Table Header Skeleton */}
          <div className="flex justify-between items-center py-3 border-b">
            <Skeleton className="h-6 w-1/6 rounded" />
            <Skeleton className="h-6 w-2/6 rounded" />
            <Skeleton className="h-6 w-1/6 rounded" />
            <Skeleton className="h-6 w-1/6 rounded" />
            <Skeleton className="h-6 w-1/6 rounded text-right" />
          </div>
          {/* Table Body Skeleton Rows */}
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex justify-between items-center py-4 border-b">
              <Skeleton className="h-5 w-1/6 rounded" />
              <Skeleton className="h-5 w-2/6 rounded" />
              <Skeleton className="h-5 w-1/6 rounded" />
              <div className="w-1/6 flex gap-1">
                <Skeleton className="h-5 w-10 rounded-full" />
                <Skeleton className="h-5 w-10 rounded-full" />
              </div>
              <Skeleton className="h-5 w-1/6 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
