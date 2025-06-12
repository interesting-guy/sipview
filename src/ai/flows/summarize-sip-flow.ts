
'use server';
/**
 * @fileOverview AI flow to summarize SIP content into a structured, 3-point, beginner-friendly format.
 *
 * - summarizeSipContent - A function that generates a structured summary for SIP content.
 * - SummarizeSipInput - The input type for the summarizeSipContent function.
 * - AiSummary - The output type (structured summary) for the summarizeSipContent function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';
import type { AiSummary as AiSummaryType } from '@/types/sip'; // Ensure this path is correct

const SummarizeSipInputSchema = z.object({
  sipBody: z.string().describe('The full markdown body of the Sui Improvement Proposal.').optional(),
  abstractOrDescription: z.string().describe('A pre-existing abstract or description from the SIP frontmatter.').optional(),
});
export type SummarizeSipInput = z.infer<typeof SummarizeSipInputSchema>;

const AiSummaryOutputSchema = z.object({
  whatItIs: z.string().describe("A 1-sentence explanation of what the proposal is."),
  whatItChanges: z.string().describe("A 1-sentence explanation of what the proposal changes or introduces."),
  whyItMatters: z.string().describe("A 1-sentence explanation of why this proposal is important or beneficial."),
});
export type AiSummary = z.infer<typeof AiSummaryOutputSchema>;

const INSUFFICIENT_INFO_MESSAGE = "Insufficient information to summarize this aspect.";

export async function summarizeSipContent(input: SummarizeSipInput): Promise<AiSummary> {
  if (!input.sipBody && !input.abstractOrDescription) {
    return {
      whatItIs: INSUFFICIENT_INFO_MESSAGE,
      whatItChanges: INSUFFICIENT_INFO_MESSAGE,
      whyItMatters: INSUFFICIENT_INFO_MESSAGE,
    };
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
  async (input) => {
    // The initial check for no content is now handled in the exported summarizeSipContent function.
    // The prompt itself is designed to handle cases where content might be sparse for specific points.

    const {output} = await prompt(input);
    if (!output) {
        // This case should ideally be handled by the prompt returning the "insufficient detail" message for fields.
        // However, as a fallback if the LLM fails to follow that instruction and returns nothing.
        console.warn("AI prompt for summarizeSipStructuredFlow returned no output, defaulting to insufficient detail for all fields.");
        return {
            whatItIs: INSUFFICIENT_INFO_MESSAGE,
            whatItChanges: INSUFFICIENT_INFO_MESSAGE,
            whyItMatters: INSUFFICIENT_INFO_MESSAGE,
        };
    }
    return output;
  }
);

// Make sure the AiSummary type from types/sip.ts is compatible or use the local one.
// For clarity, ensure the return type of summarizeSipContent matches AiSummaryType from /types/sip.
async function typedSummarizeSipContent(input: SummarizeSipInput): Promise<AiSummaryType> {
    return summarizeSipContent(input) as Promise<AiSummaryType>;
}

export { typedSummarizeSipContent as summarizeSipContentStructured };
