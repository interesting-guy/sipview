
'use server';
/**
 * @fileOverview AI flow to summarize SIP content into a structured, 3-point, beginner-friendly format.
 *
 * - summarizeSipContentStructured - A function that generates a structured summary for SIP content.
 * - SummarizeSipInput - The input type for the summarizeSipContentStructured function.
 * - AiSummary - The output type (structured summary) for the summarizeSipContentStructured function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
import type { AiSummary as AiSummaryType } from '@/types/sip';

const SummarizeSipInputSchema = z.object({
  sipBody: z.string().describe('The full markdown body of the Sui Improvement Proposal.').optional(),
  abstractOrDescription: z.string().describe('A pre-existing abstract or description from the SIP frontmatter, or the SIP title as a last resort.').optional(),
});
export type SummarizeSipInput = z.infer<typeof SummarizeSipInputSchema>;

const AiSummaryOutputSchema = z.object({
  whatItIs: z.string().describe("A 1-sentence explanation of what the proposal is."),
  whatItChanges: z.string().describe("A 1-sentence explanation of what the proposal changes or introduces."),
  whyItMatters: z.string().describe("A 1-sentence explanation of why this proposal is important or beneficial."),
});
export type AiSummary = z.infer<typeof AiSummaryOutputSchema>;

const INSUFFICIENT_INFO_MESSAGE = "Insufficient information to summarize this aspect.";
const USER_REQUESTED_FALLBACK_AI_SUMMARY: AiSummaryType = {
  whatItIs: "No summary available yet.",
  whatItChanges: "-",
  whyItMatters: "-",
};


export async function summarizeSipContentStructured(input: SummarizeSipInput): Promise<AiSummaryType> {
  if (!input.sipBody && !input.abstractOrDescription) {
    console.warn("summarizeSipContentStructured: No body or abstract/description provided. Returning fallback summary.");
    return USER_REQUESTED_FALLBACK_AI_SUMMARY;
  }
  // Check if content is too minimal (e.g. less than a few words)
  const bodyLength = input.sipBody?.trim().length || 0;
  const abstractLength = input.abstractOrDescription?.trim().length || 0;
  if (bodyLength < 20 && abstractLength < 20) { // Heuristic for minimal content
    console.warn(`summarizeSipContentStructured: Content too short (body: ${bodyLength}, abstract: ${abstractLength}). Returning fallback summary.`);
    return USER_REQUESTED_FALLBACK_AI_SUMMARY;
  }

  return summarizeSipFlow(input);
}

const prompt = ai.definePrompt({
  name: 'summarizeSipStructuredPrompt',
  input: {schema: SummarizeSipInputSchema},
  output: {schema: AiSummaryOutputSchema},
  prompt: `You are an AI assistant tasked with explaining Sui Improvement Proposals (SIPs) in simple, non-technical language.
Your goal is to make the SIP understandable to someone who is not a developer.

Based on the provided content, generate a JSON object with three keys: "whatItIs", "whatItChanges", and "whyItMatters".
- "whatItIs": Provide a 1-sentence explanation of what the proposal is.
- "whatItChanges": Provide a 1-sentence explanation of what the proposal changes or introduces.
- "whyItMatters": Provide a 1-sentence explanation of why this proposal is important or beneficial.

Each explanation MUST be a single sentence.
Avoid technical jargon, acronyms, and complex phrasing. Use simple terms (e.g., "this helps apps load faster," "this makes staking easier," "this adds support for new tools").

If the provided content is too short, unclear, or insufficient to create a meaningful answer for a specific point, set the value for that key to the exact string "${INSUFFICIENT_INFO_MESSAGE}". Do not make up information.
If all three points cannot be meaningfully determined from the content, set all three values to "${INSUFFICIENT_INFO_MESSAGE}".

Prioritize the Abstract/Description if available and sufficient. Use the Full SIP Body for additional context if needed or if Abstract/Description is insufficient/missing.

Content to summarize:
{{#if abstractOrDescription}}
Abstract/Description:
{{{abstractOrDescription}}}

{{#if sipBody}}
Full SIP Body (for additional context if needed):
{{{sipBody}}}
{{/if}}

{{else if sipBody}}
SIP Body:
{{{sipBody}}}

{{else}}
No content provided.
{{/if}}
`,
});

const summarizeSipFlow = ai.defineFlow(
  {
    name: 'summarizeSipStructuredFlow',
    inputSchema: SummarizeSipInputSchema,
    outputSchema: AiSummaryOutputSchema,
  },
  async (input): Promise<AiSummaryType> => {
    try {
      const {output} = await prompt(input);
      if (!output || typeof output.whatItIs !== 'string' || typeof output.whatItChanges !== 'string' || typeof output.whyItMatters !== 'string') {
          console.warn("AI prompt for summarizeSipStructuredFlow returned invalid or no output. Defaulting to fallback summary.");
          return USER_REQUESTED_FALLBACK_AI_SUMMARY;
      }
      return output as AiSummaryType; // Cast is safe due to the checks above
    } catch (error) {
      console.error("Error during summarizeSipFlow execution:", error);
      return USER_REQUESTED_FALLBACK_AI_SUMMARY;
    }
  }
);
