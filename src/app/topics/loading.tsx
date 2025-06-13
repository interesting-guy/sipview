
import { Skeleton } from "@/components/ui/skeleton";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function TopicsLoading() {
  return (
    <div className="w-full space-y-8">
      {/* Header Skeleton */}
      <div className="space-y-2">
        <Skeleton className="h-10 w-1/2 rounded-lg" />
        <Skeleton className="h-6 w-3/4 rounded-lg" />
      </div>

      {/* Search Input Skeleton */}
      <Skeleton className="h-12 w-full md:w-1/2 lg:w-1/3 rounded-lg" />

      {/* Accordion Skeleton */}
      <div className="w-full space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="border bg-card rounded-lg shadow-sm p-1">
            <div className="px-6 py-4">
                <Skeleton className="h-6 w-1/3 rounded" />
            </div>
            <div className="px-6 pb-4 pt-0">
                <div className="space-y-3">
                {[...Array(2)].map((_, j) => (
                    <Card key={j} className="p-0 m-0">
                        <CardHeader className="pb-3 pt-4 px-4">
                            <Skeleton className="h-5 w-5/6 rounded" />
                        </CardHeader>
                        <CardContent className="flex justify-between items-center text-xs px-4 pb-3">
                            <Skeleton className="h-6 w-24 rounded-full" />
                            <Skeleton className="h-4 w-32 rounded" />
                        </CardContent>
                    </Card>
                ))}
                </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
