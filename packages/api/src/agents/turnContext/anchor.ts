import type { ContextEntry, TurnContextAgent } from './registry';
import { LEDGER_PART_KEYS, compareContextKeys, findContextSource } from './registry';
import type { ToolPlan } from './tools';
import { setConversationContext } from '../systemParts';
import { applyToolPlan } from './tools';

/** The fields of a history row the turn context reads. */
export interface TurnContextMessage {
  messageId?: string | null;
  isCreatedByUser?: boolean;
  content?: unknown;
  /** Changes announced with this user message. */
  contextUpdates?: readonly ContextEntry[] | null;
  /** Anchor of the segment that starts after this message's summary. */
  contextAnchor?: readonly ContextEntry[] | null;
}

const isStateKey = (key: string) => findContextSource(key)?.kind === 'state';

const toEntry =
  (live: ReadonlyMap<string, string>) =>
  (key: string): ContextEntry => ({ key, value: live.get(key) as string });

/** The anchor of a conversation's first segment: the live state, in registry order. */
export function createAnchor(live: ReadonlyMap<string, string>): ContextEntry[] {
  return [...live.keys()].filter(isStateKey).sort(compareContextKeys).map(toEntry(live));
}

/**
 * The anchor of a segment opened by a compaction: the live state, keeping the
 * previous anchor's order so the system prompt changes as late as possible.
 * Keys switched off since are dropped, new keys are appended in registry order.
 */
export function reanchor(
  previous: readonly ContextEntry[] | null | undefined,
  live: ReadonlyMap<string, string>,
): ContextEntry[] {
  const kept = (previous ?? [])
    .map(({ key }) => key)
    .filter((key) => live.has(key) && isStateKey(key));
  const keptKeys = new Set(kept);
  const added = [...live.keys()]
    .filter((key) => isStateKey(key) && !keptKeys.has(key))
    .sort(compareContextKeys);
  return [...kept, ...added].map(toEntry(live));
}

/** Drops entries no registered source owns, e.g. written by a newer version. */
export function readEntries(entries: readonly ContextEntry[] | null | undefined): ContextEntry[] {
  return (entries ?? []).filter(
    (entry) =>
      typeof entry?.key === 'string' &&
      (entry.value === null || typeof entry.value === 'string') &&
      findContextSource(entry.key) != null,
  );
}

/**
 * Renders the agent's system prompt from the segment's anchor instead of the
 * live parts, so it stays byte-identical until the next compaction; the live
 * changes reach the model as updates in the history. With a tool plan, the
 * tools and the MCP server instructions come from the anchor too: the caller
 * leaves the live MCP instructions out of `instructions`.
 */
export function applyTurnContext(
  agent: TurnContextAgent,
  plan: { block: string; tools?: ToolPlan },
): void {
  setConversationContext(agent, LEDGER_PART_KEYS, plan.block);
  if (plan.tools == null) {
    return;
  }
  applyToolPlan(agent, plan.tools);
  if (plan.tools.mcpInstructions !== '') {
    agent.instructions = [agent.instructions, plan.tools.mcpInstructions]
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
}

/**
 * The agents whose run reads the conversation, so the sent message carries the retrieved
 * context for them; isolated subagents still take it in their system prompt. Empty without a
 * turn context.
 */
export function getConversationAgents<T extends object>(
  plan: unknown,
  primary: T,
  others: Iterable<T> = [],
): Set<T> {
  return new Set(plan != null ? [primary, ...others] : []);
}

/**
 * Renders the primary agent from the plan and records the memory and retrieved texts the
 * request now carries, for the content inspection of the model-bound context.
 */
export function applyTurnContextToRuntime(
  agent: TurnContextAgent,
  plan: {
    block: string;
    tools?: ToolPlan;
    memoryTexts: readonly string[];
    ragTexts: readonly string[];
  },
  sinks: { memories?: Set<string>; files?: Set<string> } = {},
): void {
  applyTurnContext(agent, plan);
  plan.memoryTexts.forEach((text) => sinks.memories?.add(text));
  plan.ragTexts.forEach((text) => sinks.files?.add(text));
}
