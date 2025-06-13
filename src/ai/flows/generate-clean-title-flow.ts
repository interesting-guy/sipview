
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

Based ONLY on the provided Context, generate a completely new descriptive title according to the rules above.
If the Context is extremely limited or unclear, make your best attempt to capture a general theme in a 2-4 word phrase.
Do not return the Original Title or a minor variation of it. Be creative and ensure it's descriptive.
If you absolutely cannot create a descriptive title from the context that meets all rules, return the original title.
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
      
      const lowerGenerated = generatedTitleText.toLowerCase();
      const lowerOriginal = input.originalTitle.toLowerCase();
      const containsSipPrefix = lowerGenerated.includes("sip-") || lowerGenerated.includes("sip ");
      const isJustNumber = /^\d+$/.test(generatedTitleText.replace(/^sip\s*/i, '').trim()); // Check if it's "SIP 20" or just "20"

      if (lowerGenerated === lowerOriginal) {
         console.warn(`[generateCleanSipTitleFlow] AI returned a title ("${generatedTitleText}") that is identical to the original ("${input.originalTitle}"). This might be acceptable if AI was explicitly instructed it could. Forcing use of original.`);
         return { cleanTitle: input.originalTitle }; // If AI returns exactly original, use it.
      }

      // If it still contains "SIP" or is just a number AFTER "SIP" despite prompt
      if (containsSipPrefix || isJustNumber) {
          // Check if the original title itself was just "SIP XX" or "XX"
          const originalIsSipNumeric = lowerOriginal.startsWith("sip-") || lowerOriginal.startsWith("sip ") || /^\d+$/.test(lowerOriginal.replace(/^sip\s*/i, '').trim());
          if (originalIsSipNumeric && (containsSipPrefix || isJustNumber)) {
             console.warn(`[generateCleanSipTitleFlow] AI returned problematic title ("${generatedTitleText}") for a numeric original ("${input.originalTitle}"). Falling back to original to avoid bad title.`);
             return { cleanTitle: input.originalTitle };
          }
          // If original was not numeric but AI made it so, this is also bad.
          if (!originalIsSipNumeric && (containsSipPrefix || isJustNumber)) {
             console.warn(`[generateCleanSipTitleFlow] AI returned problematic numeric/SIP title ("${generatedTitleText}") for a non-numeric original ("${input.originalTitle}"). Falling back to original.`);
             return { cleanTitle: input.originalTitle };
          }
      }


      console.log(`[generateCleanSipTitleFlow] Accepted clean title for "${input.originalTitle}": "${generatedTitleText}"`);
      return { cleanTitle: generatedTitleText };

    } catch (error) {
      console.error(`[generateCleanSipTitleFlow] Error during clean title generation for "${input.originalTitle}":`, error);
      return { cleanTitle: input.originalTitle }; // Fallback to original on error
    }
  }
);

