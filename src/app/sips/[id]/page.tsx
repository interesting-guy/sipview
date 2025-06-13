import { getSipById } from '@/lib/sips';
import SipDetailClient from '@/components/SipDetailClient';
import { notFound } from 'next/navigation';
import type { Metadata, ResolvingMetadata } from 'next';
import type { SIP } from '@/types/sip';

interface SipDetailPageProps {
  params: { id: string };
}

export const revalidate = 300; // Revalidate data every 5 minutes

export async function generateMetadata(
  { params }: SipDetailPageProps,
  parent: ResolvingMetadata
): Promise<Metadata> {
  const id = params.id;
  const sip: SIP | null = await getSipById(id);

  if (!sip) {
    return {
      title: 'SIP Not Found',
    };
  }

  return {
    title: `${sip.id}: ${sip.title} - SipView`,
    description: sip.summary,
  };
}

export default async function SipDetailPage({ params }: SipDetailPageProps) {
  const sipId = params.id;
  const sip: SIP | null = await getSipById(sipId);

  if (!sip) {
    notFound();
  }

  return (
    <div className="w-full animate-in fade-in-0 duration-500 ease-out">
      <SipDetailClient sip={sip} />
    </div>
  );
}
