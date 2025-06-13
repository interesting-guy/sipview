
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
  cleanTitle: z.string().min(5).max(50).describe('The generated clean title, ideally 2-4 words, max 50 chars. It should summarize the proposal and EXCLUDE "SIP" and proposal numbers.'),
});
export type GenerateCleanTitleOutput = z.infer<typeof GenerateCleanTitleOutputSchema>;

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

The "Clean Title" MUST:
- Be very short and descriptive, ideally 2-4 words.
- Be a maximum of 50 characters.
- Summarize the main purpose or outcome of the proposal.
- Avoid technical jargon if possible, prefer plain English.
- CRUCIALLY: You MUST NOT include the original proposal number (e.g., "SIP-001") or the word "SIP" itself in your generated Clean Title. Generate a completely new phrase.
- Focus on what the proposal *does* or *enables*.

Original Title: {{{originalTitle}}}
{{#if proposalType}}Proposal Type: {{{proposalType}}}{{/if}}
Context:
{{{context}}}

Based ONLY on the provided Context, generate a "Clean Title" following all rules.

IMPORTANT RULE:
If the "Original Title" is non-descriptive (e.g., just "SIP <number>", "PR #123", "Update README") AND the provided "Context" is too limited to derive a specific, meaningful new title, you MUST generate a short, general but positive-sounding placeholder title. Examples of such placeholders: "Core Protocol Update", "System Enhancement", "Network Refinement", "General Improvement".
In such cases, DO NOT return the Original Title or a minor variation of it. You MUST provide one of the generic but clean placeholders.

If the "Original Title" is already descriptive and reasonably clean (e.g., "Enable Deterministic Gas Pricing"), you can refine it or return a similar quality title, but still ensure it meets all other rules (especially no "SIP" or numbers).
Your output MUST be a new phrase if the original is just a number/ID.
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
      console.log(`[generateCleanSipTitleFlow] Original: "${input.originalTitle}", AI Raw Generated: "${generatedTitleText}"`);

      if (!generatedTitleText) {
        console.warn(`[generateCleanSipTitleFlow] AI did not generate any title for "${input.originalTitle}". Falling back to original.`);
        return { cleanTitle: input.originalTitle };
      }

      if (generatedTitleText.length < 5 || generatedTitleText.length > 50) {
        console.warn(`[generateCleanSipTitleFlow] Generated title "${generatedTitleText}" for "${input.originalTitle}" failed length constraints (5-50). Falling back to original.`);
        return { cleanTitle: input.originalTitle };
      }

      const lowerGenerated = generatedTitleText.toLowerCase();
      const lowerOriginal = input.originalTitle.toLowerCase();
      
      const originalIsJustSipNumber = /^sip[-\s]?\d+$/.test(lowerOriginal);
      const generatedIsJustSipNumber = /^sip[-\s]?\d+$/.test(lowerGenerated);
      const generatedIsIdenticalSloppy = lowerGenerated === lowerOriginal && originalIsJustSipNumber;

      // If AI returned the original "SIP XX" or a new "SIP XX", it failed.
      if (generatedIsJustSipNumber || generatedIsIdenticalSloppy) {
          console.warn(`[generateCleanSipTitleFlow] AI returned a SIP-numeric title ("${generatedTitleText}") or identical sloppy title for "${input.originalTitle}". This is not a valid clean title per instructions. Falling back to original title.`);
          return { cleanTitle: input.originalTitle };
      }
      
      // If original was NOT just "SIP XX", but AI made it so, that's also bad.
      if (!originalIsJustSipNumber && generatedIsJustSipNumber) {
           console.warn(`[generateCleanSipTitleFlow] AI turned a non-SIP-numeric original ("${input.originalTitle}") into a SIP-numeric title ("${generatedTitleText}"). Falling back.`);
           return { cleanTitle: input.originalTitle };
      }

      console.log(`[generateCleanSipTitleFlow] Accepted AI clean title for "${input.originalTitle}": "${generatedTitleText}"`);
      return { cleanTitle: generatedTitleText };

    } catch (error) {
      console.error(`[generateCleanSipTitleFlow] Error during clean title generation for "${input.originalTitle}":`, error);
      return { cleanTitle: input.originalTitle }; 
    }
  }
);
