
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
  sipBody: z.string().describe('The full markdown body of the Sui Improvement Proposal or the body of a Pull Request.').optional(),
  abstractOrDescription: z.string().describe('A pre-existing abstract or description from the SIP frontmatter, or the SIP title, or a Pull Request title.').optional(),
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
  // Check if content is too minimal (e.g. less than a few words)
  const bodyLength = input.sipBody?.trim().length || 0;
  const abstractLength = input.abstractOrDescription?.trim().length || 0;

  // If both primary and secondary content are very short, return fallback summary.
  if (bodyLength < 20 && abstractLength < 20) {
    console.warn(`summarizeSipContentStructured: Content too short (body: ${bodyLength}, abstract: ${abstractLength}). Returning user-requested fallback summary.`);
    return USER_REQUESTED_FALLBACK_AI_SUMMARY;
  }

  return summarizeSipFlow(input);
}

const prompt = ai.definePrompt({
  name: 'summarizeSipStructuredPrompt',
  input: {schema: SummarizeSipInputSchema},
  output: {schema: AiSummaryOutputSchema},
  prompt: `You are an AI assistant tasked with explaining Sui Improvement Proposals (SIPs) or GitHub Pull Requests related to SIPs.
Your goal is to make the proposal understandable to someone new to crypto.

Based on the provided content, generate a JSON object with three keys: "whatItIs", "whatItChanges", and "whyItMatters".
For each key, provide a 1-sentence explanation:
- "whatItIs": Explain what the proposal is or does.
- "whatItChanges": Explain what the proposal changes or introduces.
- "whyItMatters": Explain why this proposal is important or beneficial.

Each explanation MUST be a single sentence.
Use simple, clear English. Avoid technical jargon, acronyms, and complex phrasing.
Focus on the real intent and outcome of the proposal, not just its structure.
Crucially, do NOT reference GitHub, Pull Requests, issues, or the proposal process itself. For example, do not say "this PR proposes", "the SIP discusses", or "refer to the document for more details".
Instead, directly explain the *substance* of what is being done or changed. If a proposal is about prioritizing transactions, explain the new transaction behavior and its benefits for users or developers.

If the provided content is too short, unclear, or insufficient to create a meaningful answer for a specific point, set the value for that key to the exact string "${INSUFFICIENT_INFO_MESSAGE}". Do not make up information.
If all three points cannot be meaningfully determined from the content (e.g., the input is just a vague title like "Update README"), set all three values to "${INSUFFICIENT_INFO_MESSAGE}".

Prioritize the Primary Content (Abstract/Description/PR Title) if available and sufficient. Use the Additional Context (Full SIP Body/PR Body) if needed or if the primary content is insufficient/missing.

Content to summarize:
{{#if abstractOrDescription}}
Primary Content (Abstract/Description/PR Title):
{{{abstractOrDescription}}}

{{#if sipBody}}
Additional Context (Full SIP Body/PR Body):
{{{sipBody}}}
{{/if}}

{{else if sipBody}}
Content (SIP Body/PR Body):
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
          console.warn("AI prompt for summarizeSipStructuredFlow returned invalid or no output. Defaulting to user-requested fallback summary.");
          return USER_REQUESTED_FALLBACK_AI_SUMMARY;
      }
      // Check if all fields are the insufficient message
      if (output.whatItIs === INSUFFICIENT_INFO_MESSAGE &&
          output.whatItChanges === INSUFFICIENT_INFO_MESSAGE &&
          output.whyItMatters === INSUFFICIENT_INFO_MESSAGE) {
          console.warn("AI determined all summary points are insufficient. Returning user-requested fallback.");
          return USER_REQUESTED_FALLBACK_AI_SUMMARY;
      }
      return output as AiSummaryType; // Cast is safe due to the checks above
    } catch (error) {
      console.error("Error during summarizeSipFlow execution:", error);
      return USER_REQUESTED_FALLBACK_AI_SUMMARY;
    }
  }
);

