
'use server';
/**
 * @fileOverview AI flow to summarize SIP content in a simple, 3-bullet point, beginner-friendly format.
 *
 * - summarizeSipContent - A function that generates a summary for SIP content.
 * - SummarizeSipInput - The input type for the summarizeSipContent function.
 * - SummarizeSipOutput - The return type for the summarizeSipContent function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const SummarizeSipInputSchema = z.object({
  sipBody: z.string().describe('The full markdown body of the Sui Improvement Proposal.').optional(),
  abstractOrDescription: z.string().describe('A pre-existing abstract or description from the SIP frontmatter.').optional(),
});
export type SummarizeSipInput = z.infer<typeof SummarizeSipInputSchema>;

const SummarizeSipOutputSchema = z.object({
  summary: z.string().describe('A 3-bullet point summary in plain English, avoiding jargon, explaining the proposal to a non-developer. Or a message indicating insufficient detail.'),
});
export type SummarizeSipOutput = z.infer<typeof SummarizeSipOutputSchema>;

export async function summarizeSipContent(input: SummarizeSipInput): Promise<SummarizeSipOutput> {
  return summarizeSipFlow(input);
}

const prompt = ai.definePrompt({
  name: 'summarizeSipPrompt',
  input: {schema: SummarizeSipInputSchema},
  output: {schema: SummarizeSipOutputSchema},
  prompt: `Explain the following Sui Improvement Proposal (SIP) in simple English for a non-technical audience.
Format your response in 3 short bullet points, each starting with "- ":
- What it is: [1 sentence explanation]
- What it changes: [1 sentence explanation]
- Why it matters: [1 sentence explanation]

Keep each bullet point to 1 sentence. Avoid jargon, acronyms, and technical details. Be clear and beginner-friendly.
Use simple terms (e.g., "this helps apps load faster", "this makes staking easier", "this adds support for new tools").

If the provided content (prioritizing Abstract/Description if available and sufficient, otherwise using SIP Body) is too short, unclear, or insufficient to create a meaningful summary that meets these requirements, respond with the exact phrase: "This proposal does not contain enough information to summarize."

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
    name: 'summarizeSipFlow',
    inputSchema: SummarizeSipInputSchema,
    outputSchema: SummarizeSipOutputSchema,
  },
  async (input) => {
    if (!input.sipBody && !input.abstractOrDescription) {
      return { summary: "This proposal does not contain enough information to summarize." };
    }
    // If only abstract/description is present and it's very short, and no body, it might be insufficient.
    // Let the LLM decide based on the prompt's instructions for more nuanced cases.
    // The prompt itself handles prioritization of abstractOrDescription vs sipBody.

    const {output} = await prompt(input);
    if (!output) {
        // This case should ideally be handled by the prompt returning the "insufficient detail" message.
        // However, as a fallback if the LLM fails to follow that instruction and returns nothing.
        console.warn("AI prompt for summarizeSipFlow returned no output, defaulting to insufficient detail.");
        return { summary: "This proposal does not contain enough information to summarize." };
    }
    return output;
  }
);
