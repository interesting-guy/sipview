
'use server';
import type { SIP } from '@/types/sip';

export const TOPIC_CATEGORIES = [
  "Developer Tooling",
  "Gas & Fees",
  "Security",
  "Wallets & Identity",
  "DeFi",
  "NFTs & Standards",
  "Storage & Objects",
  "Governance & Community",
  "Core Infrastructure",
  "Miscellaneous"
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

// Broader keywords first, then more specific ones to avoid premature matching.
// Order within an array doesn't matter as much as the order of keys in the map.
const KEYWORD_TO_TOPIC_MAP: Record<string, TopicCategory[]> = {
  // Developer Tooling
  'sdk': ['Developer Tooling'],
  'tooling': ['Developer Tooling'],
  'ide': ['Developer Tooling'],
  'debugger': ['Developer Tooling'],
  'framework': ['Developer Tooling'],
  'move analyzer': ['Developer Tooling'],
  'typescript': ['Developer Tooling'],
  'client': ['Developer Tooling'],
  'api': ['Developer Tooling'], // Can be broad, but often dev-related
  'rpc': ['Developer Tooling', 'Core Infrastructure'],
  'cli': ['Developer Tooling'],
  'build': ['Developer Tooling'],
  'test': ['Developer Tooling'],
  'deploy': ['Developer Tooling'],
  'upgrade': ['Developer Tooling', 'Core Infrastructure'], // Smart contract upgrades

  // Gas & Fees
  'gas': ['Gas & Fees'],
  'fee': ['Gas & Fees'],
  'pricing': ['Gas & Fees'],
  'economic': ['Gas & Fees'], // Note: 'economics' label also exists
  'computation': ['Gas & Fees', 'Core Infrastructure'],
  'transaction cost': ['Gas & Fees'],
  'metering': ['Gas & Fees'],

  // Security
  'security': ['Security'],
  'audit': ['Security'],
  'vulnerability': ['Security'],
  'exploit': ['Security'],
  'permission': ['Security', 'Wallets & Identity'],
  'access control': ['Security'],
  'multisig': ['Security', 'Wallets & Identity'],
  'cryptography': ['Security', 'Core Infrastructure'],

  // Wallets & Identity
  'wallet': ['Wallets & Identity'],
  'key': ['Wallets & Identity', 'Security'],
  'address': ['Wallets & Identity'],
  'account': ['Wallets & Identity', 'Core Infrastructure'],
  'identity': ['Wallets & Identity'],
  'did': ['Wallets & Identity'],
  'authentication': ['Wallets & Identity', 'Security'],
  'zklogin': ['Wallets & Identity'],
  'signature': ['Wallets & Identity', 'Security'],

  // DeFi
  'defi': ['DeFi'],
  'dex': ['DeFi'],
  'swap': ['DeFi'],
  'liquidity': ['DeFi'],
  'pool': ['DeFi'],
  'lending': ['DeFi'],
  'borrow': ['DeFi'],
  'yield': ['DeFi'],
  'stablecoin': ['DeFi'],
  'oracle': ['DeFi', 'Developer Tooling'],
  'deepbook': ['DeFi'],
  'order book': ['DeFi'],
  'token': ['DeFi', 'NFTs & Standards'], // Can be fungible or non-fungible

  // NFTs & Standards
  'nft': ['NFTs & Standards'],
  'non-fungible': ['NFTs & Standards'],
  'metadata': ['NFTs & Standards'],
  'collection': ['NFTs & Standards'],
  'mint': ['NFTs & Standards', 'DeFi'],
  'eip-712': ['NFTs & Standards', 'Wallets & Identity'],
  'token standard': ['NFTs & Standards'],
  'kiosk': ['NFTs & Standards'], // Sui-specific NFT primitive

  // Storage & Objects
  'storage': ['Storage & Objects'],
  'object': ['Storage & Objects'],
  'data': ['Storage & Objects'],
  'dynamic field': ['Storage & Objects', 'Developer Tooling'],
  'versioning': ['Storage & Objects'],

  // Governance & Community
  'governance': ['Governance & Community'],
  'vote': ['Governance & Community'],
  'staking': ['Governance & Community', 'DeFi'],
  'delegation': ['Governance & Community'],
  'proposal': ['Governance & Community'],
  'sip': ['Governance & Community'],
  'community': ['Governance & Community'],
  'fund': ['Governance & Community'],

  // Core Infrastructure
  'consensus': ['Core Infrastructure'],
  'validator': ['Core Infrastructure'],
  'node': ['Core Infrastructure'],
  'network': ['Core Infrastructure'],
  'epoch': ['Core Infrastructure'],
  'transaction': ['Core Infrastructure'],
  'block': ['Core Infrastructure'],
  'performance': ['Core Infrastructure'],
  'scalability': ['Core Infrastructure'],
  'sequencer': ['Core Infrastructure'],
  'indexer': ['Core Infrastructure', 'Developer Tooling'],
  'bridge': ['Core Infrastructure', 'DeFi'], // Cross-chain bridges
  'protocol': ['Core Infrastructure'], // Very general
};

const LABEL_TO_TOPIC_MAP: Record<string, TopicCategory[]> = {
  // Developer Tooling
  'developer-experience': ['Developer Tooling'],
  'tooling': ['Developer Tooling'],
  'dx': ['Developer Tooling'],
  'sdk': ['Developer Tooling'],
  'apis': ['Developer Tooling'],

  // Gas & Fees
  'gas': ['Gas & Fees'],
  'fees': ['Gas & Fees'],
  'economics': ['Gas & Fees'],

  // Security
  'security': ['Security'],

  // Wallets & Identity
  'wallets': ['Wallets & Identity'],
  'identity': ['Wallets & Identity'],
  'accounts': ['Wallets & Identity'],
  'zklogin': ['Wallets & Identity'],

  // DeFi
  'defi': ['DeFi'],
  'deepbook': ['DeFi'],
  'tokens': ['DeFi', 'NFTs & Standards'],

  // NFTs & Standards
  'nfts': ['NFTs & Standards'],
  'standards': ['NFTs & Standards'],
  'metadata': ['NFTs & Standards'],

  // Storage & Objects
  'storage': ['Storage & Objects'],
  'objects': ['Storage & Objects'],

  // Governance & Community
  'governance': ['Governance & Community'],
  'community': ['Governance & Community'],
  'staking': ['Governance & Community', 'DeFi'], // Staking can be DeFi related too
  'sips': ['Governance & Community'], // Meta-proposals about SIP process

  // Core Infrastructure
  'core': ['Core Infrastructure'],
  'networking': ['Core Infrastructure'],
  'consensus': ['Core Infrastructure'],
  'transactions': ['Core Infrastructure'], // If a label specifically for tx processing
  'performance': ['Core Infrastructure'],
  'framework': ['Core Infrastructure', 'Developer Tooling'], // Sui framework is core, but "framework" label could be dev tooling
};


export function categorizeSip(sip: SIP): TopicCategory[] {
  const categories = new Set<TopicCategory>();
  const textToSearch = `${sip.title.toLowerCase()} ${sip.summary.toLowerCase()} ${(sip.body || '').toLowerCase()}`;

  // 1. Check Labels
  if (sip.labels) {
    for (const label of sip.labels) {
      const lowerLabel = label.toLowerCase();
      if (LABEL_TO_TOPIC_MAP[lowerLabel]) {
        LABEL_TO_TOPIC_MAP[lowerLabel].forEach(cat => categories.add(cat));
      }
    }
  }

  // 2. Check Keywords if no categories found from specific labels or to augment
  // This ensures broader keyword matches are considered
  for (const keyword in KEYWORD_TO_TOPIC_MAP) {
    if (textToSearch.includes(keyword)) {
      KEYWORD_TO_TOPIC_MAP[keyword].forEach(cat => categories.add(cat));
    }
  }
  
  // Check specific SIP types if available and map them
  if (sip.type) {
      const lowerSipType = sip.type.toLowerCase();
      if (lowerSipType.includes('standard') || lowerSipType.includes('feature')) {
          categories.add('Core Infrastructure');
          categories.add('Developer Tooling'); // Standards often impact tooling
      } else if (lowerSipType.includes('informational')) {
          categories.add('Governance & Community');
      } else if (lowerSipType.includes('meta') || lowerSipType.includes('process')) {
          categories.add('Governance & Community');
      }
  }


  if (categories.size === 0) {
    categories.add("Miscellaneous");
  }

  return Array.from(categories);
}

export function groupSipsByTopic(sips: SIP[]): Map<TopicCategory, SIP[]> {
  const grouped = new Map<TopicCategory, SIP[]>();

  // Initialize map with all predefined categories to maintain order
  TOPIC_CATEGORIES.forEach(topic => {
    grouped.set(topic, []);
  });

  sips.forEach(sip => {
    const sipCategories = categorizeSip(sip);
    sipCategories.forEach(category => {
      // Ensure the category exists in the map (it should due to pre-initialization)
      if (grouped.has(category)) {
        grouped.get(category)!.push(sip);
      } else {
        // This case should ideally not happen if TOPIC_CATEGORIES is comprehensive
        // and categorizeSip only returns values from TOPIC_CATEGORIES or "Miscellaneous"
        // If it does, it means a new category was dynamically created by categorizeSip
        // that wasn't in TOPIC_CATEGORIES. We'll add it to Miscellaneous for now.
        grouped.get("Miscellaneous")!.push(sip);
         console.warn(`SIP ${sip.id} categorized to unknown topic '${category}'. Added to Miscellaneous.`);
      }
    });
  });

  // Sort SIPs within each category, e.g., by status then date
  for (const topic of TOPIC_CATEGORIES) {
    grouped.get(topic)?.sort((a, b) => {
      const statusOrder: SipStatus[] = ["Live", "Final", "Accepted", "Proposed", "Draft", "Draft (no file)", "Closed (unmerged)", "Withdrawn", "Rejected", "Archived"];
      const statusAIndex = statusOrder.indexOf(a.status);
      const statusBIndex = statusOrder.indexOf(b.status);
      if (statusAIndex !== statusBIndex) return statusAIndex - statusBIndex;
      
      const dateA = a.mergedAt || a.updatedAt || a.createdAt;
      const dateB = b.mergedAt || b.updatedAt || b.createdAt;
      const timeA = dateA ? new Date(dateA).getTime() : 0;
      const timeB = dateB ? new Date(dateB).getTime() : 0;
      if (timeA !== timeB) return timeB - timeA;
      
      return a.id.localeCompare(b.id);
    });
  }


  return grouped;
}
