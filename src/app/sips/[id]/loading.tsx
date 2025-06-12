
import { Skeleton } from "@/components/ui/skeleton";

export default function SipDetailLoading() {
  return (
    <div className="w-full space-y-6 p-1">
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-6 space-y-4">
        {/* Title and Status Skeleton */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2">
          <Skeleton className="h-10 w-3/4 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
        
        <Skeleton className="h-6 w-full rounded-lg" />
        <Skeleton className="h-6 w-5/6 rounded-lg mb-3" />

        <div className="space-y-2 mt-3">
          <Skeleton className="h-5 w-1/4 rounded" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-5 w-1/3 rounded" />
            <Skeleton className="h-5 w-1/3 rounded" />
          </div>
          <div className="flex flex-wrap gap-2 mt-1">
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        </div>

        <div className="mt-4 space-y-3 p-4 border rounded-md">
          <Skeleton className="h-6 w-1/3 rounded-lg mb-3" /> 
          <Skeleton className="h-4 w-1/4 rounded mb-1" /> 
          <Skeleton className="h-4 w-full rounded mb-2" /> 
          <Skeleton className="h-4 w-1/4 rounded mb-1" /> 
          <Skeleton className="h-4 w-full rounded mb-2" /> 
          <Skeleton className="h-4 w-1/4 rounded mb-1" /> 
          <Skeleton className="h-4 w-5/6 rounded" />      
        </div>

        <div className="space-y-3 pt-4">
          <Skeleton className="h-8 w-1/3 rounded-lg" /> 
          <Skeleton className="h-5 w-full rounded" />
          <Skeleton className="h-5 w-full rounded" />
          <Skeleton className="h-5 w-2/3 rounded" />
          <Skeleton className="h-8 w-1/4 rounded-lg mt-4" /> 
          <Skeleton className="h-5 w-full rounded" />
          <Skeleton className="h-5 w-11/12 rounded" />
        </div>

        <Skeleton className="h-10 w-36 rounded-md mt-6" />
      </div>

      {/* Comments Skeleton */}
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-6 space-y-4 mt-6">
        <Skeleton className="h-8 w-1/2 rounded-lg" /> {/* Discussion Title */}
        <Skeleton className="h-5 w-3/4 rounded-lg" /> {/* Discussion Description */}
        
        {[...Array(2)].map((_, i) => ( // Skeleton for 2 comments
          <div key={i} className="flex items-start space-x-3 p-4 border rounded-md">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="flex justify-between">
                <Skeleton className="h-4 w-1/4 rounded" /> {/* Author */}
                <Skeleton className="h-4 w-1/5 rounded" /> {/* Timestamp */}
              </div>
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-5/6 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

