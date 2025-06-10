import { getAllSips } from '@/lib/sips';
import SipTableClient from '@/components/SipTableClient';
import type { SIP } from '@/types/sip';

export const revalidate = 60; // Revalidate data every 60 seconds

export default async function HomePage() {
  const sips: SIP[] = await getAllSips();

  return (
    <div className="w-full space-y-8">
      <div>
        <h1 className="font-headline text-4xl font-bold tracking-tight">Sui Improvement Proposals</h1>
        <p className="text-lg text-muted-foreground mt-2">
          Browse, search, and explore all SIPs in the Sui ecosystem.
        </p>
      </div>
      <SipTableClient sips={sips} />
    </div>
  );
}
