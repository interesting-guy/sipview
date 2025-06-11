
'use server';
/**
 * @fileOverview AI flow to summarize SIP content in simple, beginner-friendly language.
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
  summary: z.string().describe('A 1-3 sentence summary in plain English, avoiding jargon, explaining the proposal to a non-developer. Or a message indicating insufficient detail.'),
});
export type SummarizeSipOutput = z.infer<typeof SummarizeSipOutputSchema>;

export async function summarizeSipContent(input: SummarizeSipInput): Promise<SummarizeSipOutput> {
  return summarizeSipFlow(input);
}

const prompt = ai.definePrompt({
  name: 'summarizeSipPrompt',
  input: {schema: SummarizeSipInputSchema},
  output: {schema: SummarizeSipOutputSchema},
  prompt: `Write a short summary (1-3 sentences) of the following Sui Improvement Proposal (SIP) in plain English. Avoid technical jargon. Explain it as if you're helping someone who is not a developer understand the purpose of the proposal.

Focus on what the proposal aims to achieve and why it matters in simple terms (e.g., "this helps apps load faster", "this makes staking easier", "this adds support for new tools").

Do not include code, technical acronyms, or complex phrasing.

If the provided content (prioritizing Abstract/Description if available and sufficient, otherwise using SIP Body) is too short, unclear, or insufficient to create a meaningful summary that meets these requirements, respond with the exact phrase: "This proposal does not have enough detail to summarize yet."

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
      return { summary: "This proposal does not have enough detail to summarize yet." };
    }
    // Prefer abstract/description if it's substantial enough
    if (input.abstractOrDescription && input.abstractOrDescription.length > 50) {
        // Provide both to the prompt, let the prompt decide via handlebars
    } else if (!input.sipBody) {
         // Only abstract is available, and it's short, or no body
        return { summary: "This proposal does not have enough detail to summarize yet." };
    }


    const {output} = await prompt(input);
    if (!output) {
        // This case should ideally be handled by the prompt returning the "insufficient detail" message.
        // However, as a fallback if the LLM fails to follow that instruction and returns nothing.
        console.warn("AI prompt for summarizeSipFlow returned no output, defaulting to insufficient detail.");
        return { summary: "This proposal does not have enough detail to summarize yet." };
    }
    return output;
  }
);

