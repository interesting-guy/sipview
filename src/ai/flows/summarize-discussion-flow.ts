
'use server';
/**
 * @fileOverview AI flow to summarize GitHub discussion comments for a SIP.
 *
 * - summarizeDiscussion - A function that generates a summary of discussion points.
 * - SummarizeDiscussionInput - The input type for the summarizeDiscussion function.
 * - SummarizeDiscussionOutput - The output type for the summarizeDiscussion function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const CommentSchema = z.object({
  author: z.string().describe('The GitHub username of the commenter.'),
  body: z.string().describe('The text content of the comment.'),
});

const SummarizeDiscussionInputSchema = z.object({
  sipTitle: z.string().describe('The title of the Sui Improvement Proposal for context.'),
  comments: z.array(CommentSchema).describe('An array of comments from the GitHub discussion. Each comment includes the author and body text. Bodies may be truncated for brevity.'),
});
export type SummarizeDiscussionInput = z.infer<typeof SummarizeDiscussionInputSchema>;

const SummarizeDiscussionOutputSchema = z.object({
  summary: z.string().describe('A concise, plain English summary of the key discussion points (concerns, clarifications, approvals, decision drivers). Aim for 2-4 sentences. If comments are not substantial, this should be indicated.'),
});
export type SummarizeDiscussionOutput = z.infer<typeof SummarizeDiscussionOutputSchema>;

export async function summarizeDiscussion(input: SummarizeDiscussionInput): Promise<SummarizeDiscussionOutput> {
  if (!input.comments || input.comments.length === 0) {
    return { summary: "No comments were available to summarize for this proposal." };
  }
  if (input.comments.length < 2 && input.comments[0]?.body.length < 50) {
      return { summary: "The discussion appears to be minimal or too brief to provide a detailed summary."};
  }
  return summarizeDiscussionFlow(input);
}

const prompt = ai.definePrompt({
  name: 'summarizeDiscussionPrompt',
  input: {schema: SummarizeDiscussionInputSchema},
  output: {schema: SummarizeDiscussionOutputSchema},
  prompt: `You are an AI assistant tasked with summarizing a GitHub discussion related to a Sui Improvement Proposal (SIP).
The proposal is titled: "{{sipTitle}}"

Below is a series of comments from the discussion. Each comment is prefixed with "Comment by [author]:". Analyze these comments to identify the main themes.

Discussion Comments:
{{#each comments}}
Comment by {{author}}: {{{body}}}
---
{{/each}}

Based on these comments, please provide a concise summary (2-4 sentences) in plain English. Your summary should highlight:
- Key concerns or questions raised by participants.
- Important clarifications or answers provided.
- Points of general agreement or approval, if any.
- Any factors that seem to be driving decisions or influencing the proposal's direction.

Focus on the substance of the discussion. Do not just list who said what. Synthesize the information into a coherent overview.
If the provided comments are very sparse, repetitive, or do not contain substantial discussion points, state that the discussion was minimal or didn't offer significant new insights.
Do not use Markdown formatting in your summary.
`,
});

const summarizeDiscussionFlow = ai.defineFlow(
  {
    name: 'summarizeDiscussionFlow',
    inputSchema: SummarizeDiscussionInputSchema,
    outputSchema: SummarizeDiscussionOutputSchema,
  },
  async (input): Promise<SummarizeDiscussionOutput> => {
    try {
      const {output} = await prompt(input);
      if (!output || !output.summary || output.summary.trim() === "") {
        console.warn("AI prompt for summarizeDiscussionFlow returned empty or no summary. Returning a default message.");
        return { summary: "Could not automatically summarize discussion points at this time due to an unexpected AI response." };
      }
      return output;
    } catch (error) {
      console.error("Error during summarizeDiscussionFlow execution:", error);
      return { summary: `Failed to generate discussion summary. Error: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
);
