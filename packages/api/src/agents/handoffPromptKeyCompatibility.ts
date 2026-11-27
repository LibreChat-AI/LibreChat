import { Constants } from '@librechat/agents';
import { ToolMessage } from '@librechat/agents/langchain/messages';
import type { GraphEdge, IState, Run, RunConfig } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';

type HandoffReceptionResult = {
  filteredMessages: BaseMessage[];
  instructions: string | null;
  sourceAgentName: string | null;
  parallelSiblings: string[];
} | null;

type ProcessHandoffReception = (messages: BaseMessage[], agentId: string) => HandoffReceptionResult;

const PROCESS_HANDOFF_RECEPTION = 'processHandoffReception';
const patchedGraphs = new WeakSet<object>();
const sdkSupportedPromptKeys = new Set(['instruction', 'instructions', 'context']);

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hasDestination(edge: GraphEdge, agentId: string): boolean {
  const destinations = Array.isArray(edge.to) ? edge.to : [edge.to];
  return destinations.includes(agentId);
}

function getCustomPromptLabels(edges: GraphEdge[], agentId: string): string[] {
  const labels = new Set<string>();

  for (const edge of edges) {
    const promptKey = edge.promptKey;
    if (
      edge.edgeType === 'direct' ||
      typeof edge.prompt !== 'string' ||
      !promptKey ||
      sdkSupportedPromptKeys.has(promptKey.toLowerCase()) ||
      !hasDestination(edge, agentId)
    ) {
      continue;
    }
    labels.add(capitalizeFirst(promptKey));
  }

  return [...labels];
}

function findTransferMessageIndex(messages: BaseMessage[], agentId: string): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!ToolMessage.isInstance(message)) {
      continue;
    }

    const isStandardTransfer = message.name === `${Constants.LC_TRANSFER_TO_}${agentId}`;
    const isConditionalTransfer =
      message.name === 'conditional_transfer' &&
      message.additional_kwargs.handoff_destination === agentId;

    if (isStandardTransfer || isConditionalTransfer) {
      return index;
    }
  }

  return -1;
}

function normalizeCustomPromptLabel(content: string, labels: string[]): string | null {
  let matchedNeedle: string | null = null;
  let matchedIndex = Number.POSITIVE_INFINITY;

  for (const label of labels) {
    const needle = `\n\n${label}:`;
    const index = content.indexOf(needle);
    if (index >= 0 && index < matchedIndex) {
      matchedNeedle = needle;
      matchedIndex = index;
    }
  }

  if (matchedNeedle === null) {
    return null;
  }

  return (
    content.slice(0, matchedIndex) +
    '\n\nInstructions:' +
    content.slice(matchedIndex + matchedNeedle.length)
  );
}

function cloneToolMessageWithContent(message: ToolMessage, content: string): ToolMessage {
  return new ToolMessage({
    content,
    id: message.id,
    name: message.name,
    tool_call_id: message.tool_call_id,
    status: message.status,
    artifact: message.artifact,
    metadata: message.metadata,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

/**
 * Compatibility adapter for @librechat/agents 3.2.68, whose handoff receiver
 * recognizes only Instructions/Context even though handoff tools can emit an
 * arbitrary configured promptKey. The SDK remains authoritative: its method runs first,
 * and the adapter retries with a cloned, normalized ToolMessage only when the
 * SDK found the transfer but did not extract instructions.
 *
 * The adapter patches only the current Run graph and is intentionally
 * self-disabling when the upstream receiver begins handling custom keys.
 */
export function applyCustomHandoffPromptKeyCompatibility(
  run: Run<IState>,
  graphConfig: RunConfig['graphConfig'],
): void {
  if (graphConfig.type !== 'multi-agent') {
    return;
  }

  const edges = graphConfig.edges ?? [];
  const hasCustomPromptKey = edges.some((edge) => {
    const promptKey = edge.promptKey;
    return (
      edge.edgeType !== 'direct' &&
      typeof edge.prompt === 'string' &&
      !!promptKey &&
      !sdkSupportedPromptKeys.has(promptKey.toLowerCase())
    );
  });
  if (!hasCustomPromptKey || !run.Graph || patchedGraphs.has(run.Graph)) {
    return;
  }

  const graph = run.Graph;
  const graphMethods = graph as unknown as Record<string, unknown>;
  const candidate = graphMethods[PROCESS_HANDOFF_RECEPTION];
  if (typeof candidate !== 'function') {
    return;
  }
  const original = candidate as ProcessHandoffReception;

  graphMethods[PROCESS_HANDOFF_RECEPTION] = function (
    this: unknown,
    messages: BaseMessage[],
    agentId: string,
  ): HandoffReceptionResult {
    const result = original.call(this, messages, agentId);
    if (result === null || result.instructions !== null) {
      return result;
    }

    const labels = getCustomPromptLabels(edges, agentId);
    if (labels.length === 0) {
      return result;
    }

    const transferIndex = findTransferMessageIndex(messages, agentId);
    if (transferIndex < 0) {
      return result;
    }

    const transferMessage = messages[transferIndex];
    if (!ToolMessage.isInstance(transferMessage) || typeof transferMessage.content !== 'string') {
      return result;
    }

    const normalizedContent = normalizeCustomPromptLabel(transferMessage.content, labels);
    if (normalizedContent === null) {
      return result;
    }

    const normalizedMessages = [...messages];
    normalizedMessages[transferIndex] = cloneToolMessageWithContent(
      transferMessage,
      normalizedContent,
    );
    return original.call(this, normalizedMessages, agentId);
  };

  patchedGraphs.add(graph);
}
