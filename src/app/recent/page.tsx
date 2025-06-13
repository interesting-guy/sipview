
import { getAllSips } from '@/lib/sips';
import RecentlyUpdatedSipsClient from '@/components/RecentlyUpdatedSipsClient';
import type { SIP } from '@/types/sip';

export const revalidate = 60; // Revalidate data every 60 seconds

export default async function RecentlyUpdatedPage() {
  const sips: SIP[] = await getAllSips();

  // Note: The client component will handle the default sorting by 'updatedAt'
  return (
    <div className="w-full space-y-8">
      <div>
        <h1 className="font-headline text-4xl font-bold tracking-tight">Recently Updated SIPs</h1>
        <p className="text-lg text-muted-foreground mt-2">
          Discover proposals with the latest updates, sorted by their last modification date.
        </p>
      </div>
      <RecentlyUpdatedSipsClient sips={sips} />
    </div>
  );
}
