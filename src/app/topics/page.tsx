
import { getAllSips } from '@/lib/sips';
import { groupSipsByTopic, TOPIC_CATEGORIES } from '@/lib/sips_categorization';
import SipTopicsClient from '@/components/SipTopicsClient';
import type { SIP } from '@/types/sip';

export const revalidate = 300; // Revalidate data every 5 minutes

export default async function TopicsPage() {
  const sips: SIP[] = await getAllSips();
  const categorizedSips = groupSipsByTopic(sips);

  return (
    <div className="w-full space-y-8">
      <div>
        <h1 className="font-headline text-4xl font-bold tracking-tight">SIP Topics</h1>
        <p className="text-lg text-muted-foreground mt-2">
          Explore Sui Improvement Proposals grouped by common categories.
        </p>
      </div>
      <SipTopicsClient categorizedSips={categorizedSips} topicOrder={TOPIC_CATEGORIES} />
    </div>
  );
}
