
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

const Eli5SipInputSchema = z.object({
  title: z.string().describe('The title of the Sui Improvement Proposal.'),
  proposalContext: z.string().describe('The summary, abstract, or main descriptive content of the SIP. This should provide enough context for the ELI5 explanation.'),
});
export type Eli5SipInput = z.infer<typeof Eli5SipInputSchema>;

const Eli5SipOutputSchema = z.object({
  eli5Explanation: z.string().describe('The ELI5 explanation in two short paragraphs. It should answer: What is it doing? Why should I care?'),
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
  prompt: `You are explaining a blockchain governance proposal to a 5-year-old. Keep it super simple, but accurate. Avoid fluff.

Here’s what to answer in 2 short paragraphs:
1. What is this proposal trying to change or add? (Use metaphors or analogies only if they help)
2. Why should someone care about it?

Here’s the proposal info:
Title: {{{title}}}
Proposal Context (Summary/Description/Abstract):
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

