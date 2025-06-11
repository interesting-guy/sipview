
'use server';
/**
 * @fileOverview AI flow to summarize SIP content.
 *
 * - summarizeSipContent - A function that generates a summary for SIP content.
 * - SummarizeSipInput - The input type for the summarizeSipContent function.
 * - SummarizeSipOutput - The return type for the summarizeSipContent function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const SummarizeSipInputSchema = z.object({
  sipBody: z.string().describe('The full markdown body of the Sui Improvement Proposal.'),
});
export type SummarizeSipInput = z.infer<typeof SummarizeSipInputSchema>;

const SummarizeSipOutputSchema = z.object({
  summary: z.string().describe('A 3-bullet point summary of the SIP: what it proposes, what it changes, and why it matters.'),
});
export type SummarizeSipOutput = z.infer<typeof SummarizeSipOutputSchema>;

export async function summarizeSipContent(input: SummarizeSipInput): Promise<SummarizeSipOutput> {
  return summarizeSipFlow(input);
}

const prompt = ai.definePrompt({
  name: 'summarizeSipPrompt',
  input: {schema: SummarizeSipInputSchema},
  output: {schema: SummarizeSipOutputSchema},
  prompt: `Summarize this Sui Improvement Proposal (SIP) in 3 concise bullet points. For each bullet point, clearly state:
- What the SIP proposes.
- What specific changes it introduces to the Sui network or ecosystem.
- Why this proposal is important or what benefits it aims to achieve.

Format the output as a single string, with each bullet point starting with '- '.

SIP Body:
{{{sipBody}}}
`,
});

const summarizeSipFlow = ai.defineFlow(
  {
    name: 'summarizeSipFlow',
    inputSchema: SummarizeSipInputSchema,
    outputSchema: SummarizeSipOutputSchema,
  },
  async (input) => {
    const {output} = await prompt(input);
    if (!output) {
        throw new Error("Failed to generate summary from AI prompt.");
    }
    return output;
  }
);
