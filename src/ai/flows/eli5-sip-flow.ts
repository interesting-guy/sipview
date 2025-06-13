
'use server';
/**
 * @fileOverview AI flow to explain a Sui Improvement Proposal (SIP) like the user is 5 years old.
 *
 * - explainSipEli5 - A function that generates an ELI5 explanation for SIP content.
 * - Eli5SipInput - The input type for the explainSipEli5 function.
 * - Eli5SipOutput - The output type (ELI5 explanation) for the explainSipEli5 function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

export const Eli5SipInputSchema = z.object({
  title: z.string().describe('The title of the Sui Improvement Proposal.'),
  proposalContext: z.string().describe('The summary, abstract, or main descriptive content of the SIP. This should provide enough context for the ELI5 explanation.'),
});
export type Eli5SipInput = z.infer<typeof Eli5SipInputSchema>;

export const Eli5SipOutputSchema = z.object({
  eli5Explanation: z.string().describe('The 2-3 sentence ELI5 explanation. It should answer: What is it doing? Why should I care?'),
});
export type Eli5SipOutput = z.infer<typeof Eli5SipOutputSchema>;

const FALLBACK_ELI5_MESSAGE = "I'm not sure how to explain this one in a super simple way with the information I have!";

export async function explainSipEli5(input: Eli5SipInput): Promise<Eli5SipOutput> {
  if (!input.proposalContext || input.proposalContext.trim().length < 10) {
    // If context is too short (e.g. just a title or very brief description), it might be hard for LLM
    // We'll let the LLM try, but this is a consideration.
    // For now, proceed and let the LLM handle potentially sparse input.
  }
  return explainSipEli5Flow(input);
}

const prompt = ai.definePrompt({
  name: 'explainSipEli5Prompt',
  input: {schema: Eli5SipInputSchema},
  output: {schema: Eli5SipOutputSchema},
  prompt: `Explain this proposal like I’m 5 years old. Use simple words. No technical jargon.
Answer in 2-3 sentences. Make sure to cover:
- What is it doing?
- Why should I care?

Proposal Title: {{{title}}}

Proposal Context:
{{{proposalContext}}}
`,
});

const explainSipEli5Flow = ai.defineFlow(
  {
    name: 'explainSipEli5Flow',
    inputSchema: Eli5SipInputSchema,
    outputSchema: Eli5SipOutputSchema,
  },
  async (input): Promise<Eli5SipOutput> => {
    try {
      const {output} = await prompt(input);
      if (!output || typeof output.eli5Explanation !== 'string' || output.eli5Explanation.trim() === "") {
          console.warn("AI prompt for explainSipEli5Flow returned invalid, empty, or no output. Returning fallback message.");
          return { eli5Explanation: FALLBACK_ELI5_MESSAGE };
      }
      return output;
    } catch (error) {
      console.error("Error during explainSipEli5Flow execution:", error);
      return { eli5Explanation: `Sorry, I had trouble simplifying this right now. Please try again later. (Error: ${error instanceof Error ? error.message : 'Unknown'})` };
    }
  }
);
