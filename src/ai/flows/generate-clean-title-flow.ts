
'use server';
/**
 * @fileOverview AI flow to generate a short, clean, descriptive title for a SIP.
 *
 * - generateCleanSipTitle - A function that generates a clean title.
 * - GenerateCleanTitleInput - The input type.
 * - GenerateCleanTitleOutput - The output type.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const GenerateCleanTitleInputSchema = z.object({
  originalTitle: z.string().describe('The original title of the Sui Improvement Proposal.'),
  context: z.string().describe('Sufficient context about the SIP (e.g., summary, abstract, body snippet) for the AI to understand its purpose.'),
  proposalType: z.string().optional().describe('The type of proposal, e.g., "Standard Track", "Informational".'),
});
export type GenerateCleanTitleInput = z.infer<typeof GenerateCleanTitleInputSchema>;

const GenerateCleanTitleOutputSchema = z.object({
  cleanTitle: z.string().min(5).max(50).describe('The generated clean title, ideally 3-6 words, max 50 chars. It should summarize the proposal and exclude "SIP" and proposal numbers.'),
});
export type GenerateCleanTitleOutput = z.infer<typeof GenerateCleanTitleOutputSchema>;

const FALLBACK_CLEAN_TITLE_MESSAGE = "Could not generate a clean title with the provided information.";

export async function generateCleanSipTitle(input: GenerateCleanTitleInput): Promise<GenerateCleanTitleOutput> {
  if (!input.context || input.context.trim().length < 10) {
    console.warn(`[generateCleanSipTitleFlow] Context too short for original title "${input.originalTitle}". Falling back to original title.`);
    return { cleanTitle: input.originalTitle };
  }
  return generateCleanSipTitleFlow(input);
}

const prompt = ai.definePrompt({
  name: 'generateCleanSipTitlePrompt',
  input: {schema: GenerateCleanTitleInputSchema},
  output: {schema: GenerateCleanTitleOutputSchema},
  prompt: `You are an expert at creating concise and compelling titles.
Your task is to rephrase the given "Original Title" into a "Clean Title".

The "Clean Title" should:
- Be short and descriptive, ideally 3-6 words.
- Be a maximum of 50 characters.
- Summarize the main purpose or outcome of the proposal.
- Avoid technical jargon if possible, prefer plain English.
- CRUCIALLY: DO NOT include the original proposal number (e.g., "SIP-001") or the word "SIP" itself.
- Focus on what the proposal *does* or *enables*.

If the Original Title is already very descriptive and concise (e.g., "Enable Deterministic Gas Pricing"), you can make minimal changes or return a slightly rephrased version that meets the criteria.
If the Context is too short, unclear, or the Original Title is too vague (e.g. "Update README") to create a meaningful clean title based on the proposal's substance, it's acceptable to return a title that is very close to the original, but try to make it a statement if possible.

Original Title: {{{originalTitle}}}
{{#if proposalType}}Proposal Type: {{{proposalType}}}{{/if}}
Context:
{{{context}}}
`,
});

const generateCleanSipTitleFlow = ai.defineFlow(
  {
    name: 'generateCleanSipTitleFlow',
    inputSchema: GenerateCleanTitleInputSchema,
    outputSchema: GenerateCleanTitleOutputSchema,
  },
  async (input): Promise<GenerateCleanTitleOutput> => {
    try {
      const {output} = await prompt(input);

      const generatedTitleText = output?.cleanTitle?.trim();
      console.log(`[generateCleanSipTitleFlow] Original: "${input.originalTitle}", AI Generated Raw: "${generatedTitleText}"`);

      if (
        !generatedTitleText ||
        generatedTitleText.length < 5 ||
        generatedTitleText.length > 50
      ) {
        console.warn(`[generateCleanSipTitleFlow] Generated clean title for "${input.originalTitle}" was invalid (length constraints: 5-50 chars) or not generated: "${generatedTitleText}". Falling back to original title.`);
        return { cleanTitle: input.originalTitle };
      }
      
      // Additional check: if the generated title is exactly the same as original, maybe it's fine, or maybe AI couldn't improve.
      // For now, we accept it if it passes length checks. The prompt guides the AI to improve it.

      console.log(`[generateCleanSipTitleFlow] Accepted clean title for "${input.originalTitle}": "${generatedTitleText}"`);
      return { cleanTitle: generatedTitleText };

    } catch (error) {
      console.error(`[generateCleanSipTitleFlow] Error during clean title generation for "${input.originalTitle}":`, error);
      return { cleanTitle: input.originalTitle }; // Fallback to original on error
    }
  }
);
