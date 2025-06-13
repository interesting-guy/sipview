
import type { SIP } from '@/types/sip';

export const sampleSips: SIP[] = [
  {
    id: "sip-001",
    title: "Enable Deterministic Gas Pricing",
    status: "Live",
    type: "Standard Track",
    labels: ["gas", "economics", "core"],
    summary: "Makes gas costs predictable by removing variance in execution pricing, fostering a more stable environment for developers and users.",
    body: `## Motivation

The current gas pricing model on the Sui network, while functional, exhibits variability that can be challenging for developers and users. Fluctuations in network activity can lead to unpredictable transaction costs, making it difficult to budget for operations and potentially hindering adoption for cost-sensitive applications. This SIP aims to address these concerns by introducing a more deterministic approach to gas pricing.

## Proposal

We propose a new gas pricing mechanism that separates the cost of computation from the cost of storage and network bandwidth more explicitly. The core idea is to establish a base fee for computation units that adjusts slowly based on long-term network utilization, combined with a more dynamic but bounded priority fee system for transaction ordering.

### Technical Details

1.  **Base Fee (per Gas Unit):**
    *   Calculated based on a target network utilization (e.g., 50% of block capacity).
    *   Adjusts by a maximum of 12.5% per epoch, preventing rapid spikes.
    *   Published by validators and verifiable by all network participants.

2.  **Priority Fee (Optional):**
    *   Users can optionally include a priority fee to incentivize faster inclusion during congestion.
    *   This fee would go directly to validators.
    *   The impact of priority fees on overall gas cost will be capped to prevent extreme bidding wars.

3.  **Storage Rent:**
    *   Storage costs will continue to be based on a separate, stable storage rent mechanism, largely unaffected by this proposal beyond clearer accounting.

4.  **Object Versioning Impact:**
    *   Gas costs related to object versioning and mutation will be standardized based on object size and complexity, reducing variability.

## Benefits

*   **Predictability:** Developers and users will have a much clearer understanding of potential transaction costs.
*   **Stability:** Reduced volatility in gas prices, leading to a more stable economic environment on Sui.
*   **Improved UX:** Easier for wallets and dApps to estimate fees accurately.
*   **Fairness:** Ensures that network congestion primarily impacts transaction ordering rather than causing exorbitant spikes in execution costs for all.

## Drawbacks

*   **Implementation Complexity:** Requires significant changes to the existing gas schedule and validator logic.
*   **Transition Period:** May require a phased rollout and careful monitoring to ensure smooth adoption.
*   **Potential for Centralization Pressure (Priority Fees):** The priority fee mechanism needs careful design to avoid favoring large players excessively.

## Alternatives Considered

1.  **Fixed Gas Prices:** Deemed too inflexible and unable to respond to legitimate changes in network demand or operational costs for validators.
2.  **EIP-1559 Style Burn Mechanism:** While effective for Ethereum, the Sui model's distinct separation of computation and storage offers opportunities for a more tailored solution. We may incorporate elements like a base fee burn in future iterations if deemed beneficial.

---

This change aims to significantly improve the economic predictability of the Sui network, benefiting all participants.
`,
    prUrl: "https://github.com/MystenLabs/sips/pull/1",
    mergedAt: "2025-06-05T12:00:00Z",
    createdAt: "2025-05-01T10:00:00Z",
    updatedAt: "2025-06-05T12:00:00Z",
    aiSummary: { whatItIs: "Makes gas costs predictable.", whatItChanges: "Removes variance in execution pricing.", whyItMatters: "Fosters a stable environment."}
  },
  {
    id: "sip-002",
    title: "Advanced Programmable Transaction Blocks",
    status: "Accepted",
    type: "Standard Track",
    labels: ["transactions", "developer-experience", "core"],
    summary: "Introduces more powerful and flexible programmable transaction blocks, allowing for complex multi-step operations within a single atomic transaction.",
    body: `## Abstract

This SIP proposes an enhancement to Sui's transaction model by introducing Advanced Programmable Transaction Blocks (APTB). APTBs will allow developers to define a sequence of operations, including multiple smart contract calls, object manipulations, and conditional logic, to be executed atomically. This significantly improves developer experience and enables new complex application patterns.

## Motivation

Currently, complex workflows requiring multiple dependent operations on Sui might necessitate multiple separate transactions or sophisticated off-chain coordination. This can lead to increased latency, higher potential for partial failures, and a more complex user experience. APTBs aim to solve this by allowing developers to batch a series of actions into a single, atomic, and programmable unit.

## Specification

An APTB will consist of:
1.  A list of commands (e.g., \`moveCall\`, \`transferObject\`, \`splitCoin\`, \`mergeCoin\`, \`publish\`).
2.  The ability to reference outputs of previous commands as inputs to subsequent commands within the same block.
3.  Limited conditional execution capabilities (e.g., execute command B only if command A succeeds and returns a specific value).
4.  Enhanced gas metering to accurately reflect the cost of the entire block.

### Example Use Case: DeFi Arbitrage

An arbitrage bot could construct an APTB that:
1. Borrows asset X from protocol A.
2. Swaps asset X for asset Y on DEX B.
3. Swaps asset Y for asset X on DEX C (profiting from price difference).
4. Repays the loan of asset X to protocol A.
All these steps would execute atomically; if any step fails, the entire transaction block reverts.

## Rationale

*   **Atomicity:** Guarantees that complex operations either fully complete or have no effect, simplifying error handling.
*   **Efficiency:** Reduces the overhead of multiple separate transactions.
*   **Developer Experience:** Simplifies the development of dApps requiring multi-step interactions.
*   **New Possibilities:** Enables more sophisticated on-chain logic and application patterns.

## Backwards Compatibility

This proposal is designed to be backwards compatible. Existing transaction formats will continue to be supported. APTBs will be a new transaction type.

## Security Considerations

The expressiveness of APTBs requires careful consideration of gas limits and potential for complex transactions to consume significant resources. Gas scheduling for APTBs will be designed to prevent abuse and ensure fair network resource allocation. Static analysis and limits on command depth/count will be explored.
`,
    prUrl: "https://github.com/MystenLabs/sips/pull/2",
    createdAt: "2025-07-10T09:00:00Z",
    updatedAt: "2025-08-01T15:30:00Z",
    aiSummary: { whatItIs: "Allows complex multi-step operations.", whatItChanges: "Introduces flexible programmable transaction blocks.", whyItMatters: "Enables new application patterns."}
  },
  {
    id: "sip-003",
    title: "On-chain Governance Framework",
    status: "Draft",
    type: "Meta",
    labels: ["governance", "staking", "community"],
    summary: "Defines a framework for on-chain governance, enabling SUI token holders to propose and vote on network upgrades and parameter changes.",
    body: `## Introduction

This Sui Improvement Proposal (SIP) outlines a comprehensive framework for on-chain governance for the Sui network. The goal is to empower SUI token holders to participate directly in the decision-making process for network upgrades, parameter adjustments, and other significant changes.

## Core Principles

*   **Token-Weighted Voting:** Voting power will be proportional to the amount of SUI staked.
*   **Transparency:** All proposals, votes, and outcomes will be publicly auditable on-chain.
*   **Security:** The system must be resilient against manipulation and ensure the integrity of the voting process.
*   **Evolvability:** The governance framework itself should be upgradable via the same governance process.

## Proposal Lifecycle

1.  **Proposal Submission:**
    *   Any address holding a minimum threshold of SUI (e.g., 0.1% of total staked SUI) can submit a proposal.
    *   Proposals must include a detailed description, rationale, and executable code (if applicable).
    *   A deposit is required to submit a proposal, which is returned if the proposal passes a basic validity check and enters voting, or slashed if it's spam.

2.  **Voting Period:**
    *   A fixed duration (e.g., 7 days) during which staked SUI holders can cast their votes (\`Yes\`, \`No\`, \`Abstain\`).
    *   Delegation of voting power will be supported.

3.  **Execution:**
    *   If a proposal meets the quorum (e.g., 40% of total staked SUI participating) and threshold (e.g., >50% Yes votes of those participating), it is approved.
    *   Approved proposals with executable code can be automatically enacted after a timelock period (e.g., 2 days) to allow for preparation and potential emergency cancellation.

## Key Components

*   **Governor Contract:** The main smart contract managing the proposal lifecycle and vote counting.
*   **Timelock Contract:** Enforces a delay before executed proposals take effect.
*   **Treasury Management:** Mechanisms for funding community initiatives or protocol development through governance.

## Future Considerations

*   Liquid staking derivatives and their role in governance.
*   Cross-chain governance participation.
*   Council models for specialized decisions.
`,
    prUrl: "https://github.com/MystenLabs/sips/pull/3",
    createdAt: "2025-08-15T11:00:00Z",
    updatedAt: "2025-08-20T16:45:00Z",
    aiSummary: { whatItIs: "Defines on-chain governance.", whatItChanges: "Enables token holders to vote on upgrades.", whyItMatters: "Empowers community participation."}
  },
  {
    id: "sip-004",
    title: "Standardized NFT Metadata Extension",
    status: "Proposed",
    type: "Informational",
    labels: ["nfts", "standards", "interoperability"],
    summary: "Proposes a standardized metadata extension for NFTs on Sui to enhance interoperability across marketplaces and applications.",
    body: `## Abstract
This SIP proposes a standardized metadata structure for Non-Fungible Tokens (NFTs) on the Sui network. Adopting a common metadata schema will improve interoperability, allowing NFTs to be displayed and utilized consistently across various marketplaces, wallets, and dApps.

## Motivation
The current NFT ecosystem on Sui, while vibrant, lacks a universally adopted metadata standard. This leads to fragmentation, where different projects use disparate metadata formats. As a result, marketplaces and wallets must implement custom logic to parse and display NFT information for each collection, hindering user experience and developer efficiency. A standardized approach will foster a more cohesive and interoperable NFT ecosystem.

## Proposed Standard
The proposed standard extends the basic Sui object metadata with a dedicated \`extension\` field for NFTs. This field will point to an on-chain object or an off-chain URI (e.g., IPFS) containing structured metadata.

### Core Metadata Fields:
*   \`name\`: (String) The name of the NFT.
*   \`description\`: (String) A human-readable description of the NFT.
*   \`image\`: (URI) A URI pointing to the NFT's image. This should be a high-resolution image.
*   \`animation_url\`: (URI, Optional) A URI pointing to a multimedia attachment for the NFT.
*   \`external_url\`: (URI, Optional) A URI pointing to an external website or resource related to the NFT.
*   \`attributes\`: (Array of Objects) An array of attribute objects, each with \`trait_type\` (String) and \`value\` (String, Number, or Boolean).
    *   Example: \`{ "trait_type": "Color", "value": "Blue" }\`
    *   Example: \`{ "trait_type": "Level", "value": 5, "display_type": "number" }\`

### On-chain vs. Off-chain Metadata
*   The standard will support both fully on-chain metadata objects and links to off-chain (e.g., IPFS, Arweave) JSON files that adhere to this schema.
*   Guidelines will be provided for choosing the appropriate storage method based on data size and immutability requirements.

## Benefits
*   **Interoperability:** NFTs can be seamlessly integrated and displayed across different platforms.
*   **Developer Efficiency:** Simplifies the development of NFT-related tools and applications.
*   **User Experience:** Provides a consistent and richer experience for users interacting with NFTs.
*   **Discoverability:** Standardized attributes allow for better filtering and searching of NFTs.

## Implementation
*   A reference Move package defining the metadata struct and helper functions will be provided.
*   Marketplaces and wallet providers will be encouraged to adopt this standard.
`,
    prUrl: "https://github.com/MystenLabs/sips/pull/4",
    createdAt: "2025-09-01T14:20:00Z",
    updatedAt: "2025-09-05T10:00:00Z",
    aiSummary: { whatItIs: "Standardizes NFT metadata.", whatItChanges: "Proposes a common metadata schema.", whyItMatters: "Enhances interoperability across platforms."}
  },
  {
    id: "sip-005",
    title: "DeepBook Ecosystem Fund Proposal",
    status: "Draft (no file)",
    type: "Meta",
    labels: ["community", "funding", "deepbook"],
    summary: "Proposal for establishing a community fund to support projects building on or integrating with DeepBook, Sui's native central limit order book.",
    prUrl: "https://github.com/MystenLabs/sips/pull/5",
    createdAt: "2025-10-01T09:00:00Z",
    updatedAt: "2025-10-02T11:00:00Z",
    aiSummary: { whatItIs: "Fund for DeepBook projects.", whatItChanges: "Establishes a community fund.", whyItMatters: "Supports DeepBook ecosystem growth."},
    source: "pull_request_only",
    prNumber: 5,
    author: "deepbook_proposer"
  },
   {
    id: "sip-006",
    title: "Withdrawn Feature X",
    status: "Withdrawn",
    type: "Standard Track",
    labels: ["withdrawn", "feature-x"],
    summary: "This proposal for Feature X was withdrawn after initial discussion due to community feedback regarding complexity.",
    prUrl: "https://github.com/MystenLabs/sips/pull/6",
    createdAt: "2025-03-01T09:00:00Z",
    updatedAt: "2025-03-15T11:00:00Z",
    aiSummary: { whatItIs: "A withdrawn feature proposal.", whatItChanges: "Initially proposed Feature X.", whyItMatters: "Shows iterative process based on feedback."},
    source: "pull_request_only",
    prNumber: 6,
    author: "community_member_a"
  }
];
