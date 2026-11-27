import { PromptTemplate } from '@librechat/agents/langchain/prompts';
import { BaseMessage, getBufferString } from '@librechat/agents/langchain/messages';
import type { GraphEdge } from '@librechat/agents';

const DEFAULT_PROMPT_TEMPLATE = `Based on the following conversation and analysis from previous agents, please provide your insights:\n\n{convo}\n\nPlease add your specific expertise and perspective to this discussion.`;

/**
 * Helper function to create sequential chain edges with buffer string prompts
 *
 * @deprecated Agent Chain helper
 * @param agentIds - Array of agent IDs in order of execution
 * @param promptTemplate - Optional prompt template string; defaults to a predefined template if not provided
 * @returns Array of edges configured for sequential chain with buffer prompts
 */
export async function createSequentialChainEdges(
  agentIds: string[],
  promptTemplate: string = DEFAULT_PROMPT_TEMPLATE,
): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];

  for (let i = 0; i < agentIds.length - 1; i++) {
    const fromAgent = agentIds[i];
    const toAgent = agentIds[i + 1];

    edges.push({
      from: fromAgent,
      to: toAgent,
      edgeType: 'direct',
      // Use a prompt function to create the buffer string from all previous results
      prompt: async (messages: BaseMessage[], startIndex: number) => {
        /** Only the messages from this run (after startIndex) are passed in */
        const runMessages = messages.slice(startIndex);
        const bufferString = getBufferString(runMessages);
        const template = PromptTemplate.fromTemplate(promptTemplate);
        const result = await template.invoke({
          convo: bufferString,
        });
        return result.value;
      },
      /** Critical: exclude previous results so only the prompt is passed */
      excludeResults: true,
      description: `Sequential chain from ${fromAgent} to ${toAgent}`,
    });
  }

  return edges;
}
