import { Constants } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import type { TurnContextUpdates } from '../contextUpdates';
import type { FormattedMessageWithContent } from '../client';
import type { ContextEntry, SnapshotRequest, TurnContextAgent } from './registry';
import type { TurnContextMessage } from './anchor';
import type { PromptCacheConfig } from '../promptCache';
import type { ParsedServerConfig } from '~/mcp/types';
import type { LiveToolGroups } from './tools';
import type { TurnPlan } from './ledger';
import { createHistoryContextUpdates } from '../contextUpdates';
import { getMCPServerInstructions } from '~/mcp/instructions';
import { createSendSnapshot } from './registry';
import { isStableContextEnabled } from '../promptCache';
import { prependContextText } from '../client';
import { collectToolGroups } from './tools';
import { planTurnContext } from './ledger';

/** The request fields the turn context reads and writes. */
export interface TurnContextRequest extends SnapshotRequest {
  user?: { id?: string } | null;
  config?: SnapshotRequest['config'] & PromptCacheConfig;
  /** The conversation as the ingress read it, with its anchor when the lever is on. */
  resolvedConversation?: { contextAnchor?: readonly ContextEntry[] | null } | null;
  /** Set here for the user message this turn sends, stored with it by the save. */
  turnContextUpdates?: TurnContextUpdates;
  body?: { timezone?: string; isRegenerate?: boolean } | null;
}

/** An anchor this turn opened, stored once its conversation or summary message exists. */
export interface PendingContextAnchor {
  /** The message carrying the summary the segment starts after; null for the conversation. */
  messageId: string | null;
  conversationId: string;
  anchor: ContextEntry[];
}

export interface PreparedTurnContext {
  plan: TurnPlan;
  pending?: PendingContextAnchor;
}

type ConfigServers = Record<string, ParsedServerConfig> | undefined;

/** Reads the instructions of MCP servers, by server name. */
export type ServerInstructionsReader = (
  servers: string[],
  configServers?: ConfigServers,
) => Promise<Record<string, string>>;

type MemoryContext = { withKeys?: string; withoutKeys?: string } | null | undefined;

/** The database methods the turn context uses. */
export interface TurnContextDb {
  getConvoContextAnchor?: (
    user: string,
    conversationId: string,
  ) => Promise<readonly ContextEntry[] | null | undefined>;
  getMessages?: (
    filter: { conversationId: string; user: string },
    select: string,
  ) => Promise<TurnContextMessage[] | null | undefined>;
  setConvoContextAnchor: (input: {
    user: string;
    conversationId: string;
    anchor: ContextEntry[];
  }) => Promise<boolean>;
  setMessageContextAnchor: (input: {
    user: string;
    messageId: string;
    anchor: ContextEntry[];
  }) => Promise<boolean>;
}

/** The primary agent's tool groups, sampled for the turn context. */
async function sampleToolGroups(
  agent: TurnContextAgent,
  configServers: ConfigServers | Promise<ConfigServers>,
  getServerInstructions: ServerInstructionsReader,
): Promise<LiveToolGroups> {
  return collectToolGroups({
    agent,
    getInstructions: async (servers) => {
      try {
        return await getServerInstructions(servers, await configServers);
      } catch (error) {
        logger.warn('[turnContext] MCP server instructions unavailable', error);
        return {};
      }
    },
  });
}

function pendingFor(
  plan: TurnPlan,
  conversationId: string | undefined,
): PendingContextAnchor | undefined {
  return plan.anchorTarget != null && conversationId
    ? { ...plan.anchorTarget, conversationId, anchor: plan.anchor }
    : undefined;
}

/**
 * The anchor of the conversation's first context segment; null when none is stored or
 * `promptCache.stableContext` is off. Uses the conversation the ingress already read.
 */
export async function readConversationAnchor({
  req,
  conversationId,
  db,
}: {
  req: TurnContextRequest;
  conversationId?: string;
  db: Pick<TurnContextDb, 'getConvoContextAnchor'>;
}): Promise<readonly ContextEntry[] | null> {
  if (!isStableContextEnabled(req.config)) {
    return null;
  }
  const resolved = req.resolvedConversation;
  if (resolved === null) {
    return null;
  }
  /** Other ingress steps (the subagent thread guard, project context) may have read the
   *  conversation without the private anchor field; an absent key means "not loaded". */
  if (resolved !== undefined && 'contextAnchor' in resolved) {
    return resolved.contextAnchor ?? null;
  }
  const userId = req.user?.id;
  if (!userId || !conversationId || typeof db.getConvoContextAnchor !== 'function') {
    return null;
  }
  return (await db.getConvoContextAnchor(userId, conversationId)) ?? null;
}

/**
 * Plans the primary agent's context for the turn being sent: the segment anchor its system
 * prompt is rendered from, and the `<context_update>` block of each history message. The user
 * message sent this turn stores its net change (`req.turnContextUpdates`); a regeneration
 * sends no message, so it renders the entries stored with the message and writes nothing.
 * Returns null, leaving the prompt live, when `promptCache.stableContext` is off, the anchor
 * cannot be read, or none is wanted.
 */
export async function prepareTurnContext({
  req,
  agent,
  allAgents,
  orderedMessages,
  opts,
  memories,
  rag,
  conversationId,
  anchorPromise,
  configServers,
  getServerInstructions = getMCPServerInstructions,
}: {
  req: TurnContextRequest;
  agent: TurnContextAgent | null | undefined;
  allAgents: ReadonlyArray<{ agent: { dynamicToolContextMap?: Record<string, unknown> } }>;
  orderedMessages: readonly (TurnContextMessage & { messageId?: string | null })[];
  opts?: { isEdited?: boolean; isCompaction?: boolean; isRegenerate?: boolean } | null;
  memories?: MemoryContext;
  rag?: string | null;
  conversationId?: string;
  anchorPromise?: Promise<readonly ContextEntry[] | null>;
  configServers?: ConfigServers | Promise<ConfigServers>;
  getServerInstructions?: ServerInstructionsReader;
}): Promise<PreparedTurnContext | null> {
  if (agent == null || anchorPromise == null || !isStableContextEnabled(req.config)) {
    return null;
  }
  let conversationAnchor: readonly ContextEntry[] | null;
  try {
    conversationAnchor = await anchorPromise;
  } catch (error) {
    logger.warn('[turnContext] Failed to read the context anchor; the prompt stays live', error);
    return null;
  }
  const lastIndex = orderedMessages.length - 1;
  const current = orderedMessages[lastIndex];
  const regenerates = opts?.isRegenerate === true || req.body?.isRegenerate === true;
  const sendsUserMessage =
    current?.isCreatedByUser === true &&
    opts?.isEdited !== true &&
    opts?.isCompaction !== true &&
    !regenerates;
  const plan = planTurnContext({
    messages: orderedMessages,
    conversationAnchor,
    currentIndex: sendsUserMessage ? lastIndex : undefined,
    snapshot: createSendSnapshot({
      agent,
      agents: allAgents.map((entry) => entry.agent),
      req,
      memories,
      rag,
      toolGroups: await sampleToolGroups(agent, configServers, getServerInstructions),
    }),
  });
  if (plan.currentEntries != null && plan.currentEntries.length > 0 && current?.messageId) {
    req.turnContextUpdates = { messageId: current.messageId, entries: plan.currentEntries };
  }
  return { plan, pending: pendingFor(plan, conversationId) };
}

/**
 * Plans the context of a paused turn again for its resumed run (tool approval or an answered
 * question), so the system prompt is rendered from the anchor the paused turn used rather than
 * from the live state. Nothing is announced: the paused messages are in the checkpoint already.
 * Returns null, leaving the prompt live, when the lever is off or the turn cannot be planned.
 */
export async function prepareResumedTurnContext({
  req,
  agent,
  conversationId,
  pausedMessageId,
  db,
  getBranch,
  loadMemories,
  configServers,
  getServerInstructions = getMCPServerInstructions,
}: {
  req: TurnContextRequest;
  agent: TurnContextAgent | null | undefined;
  conversationId?: string;
  pausedMessageId?: string | null;
  db: Pick<TurnContextDb, 'getConvoContextAnchor' | 'getMessages'>;
  /** The branch of `rows` that ends at `parentMessageId`, oldest first. */
  getBranch: (input: {
    messages: TurnContextMessage[];
    parentMessageId: string;
  }) => TurnContextMessage[];
  loadMemories: () => Promise<MemoryContext>;
  configServers?: ConfigServers | Promise<ConfigServers>;
  getServerInstructions?: ServerInstructionsReader;
}): Promise<PreparedTurnContext | null> {
  const userId = req.user?.id;
  if (
    agent == null ||
    !isStableContextEnabled(req.config) ||
    !userId ||
    !conversationId ||
    !pausedMessageId ||
    pausedMessageId === Constants.NO_PARENT ||
    typeof db.getMessages !== 'function'
  ) {
    return null;
  }
  try {
    const [conversationAnchor, rows, memories, toolGroups] = await Promise.all([
      readConversationAnchor({ req, conversationId, db }),
      db.getMessages({ conversationId, user: userId }, '+contextUpdates +contextAnchor'),
      /** Unreadable memory is withheld, as it would be on a new turn. */
      loadMemories().catch(() => undefined),
      sampleToolGroups(agent, configServers, getServerInstructions),
    ]);
    const plan = planTurnContext({
      messages: getBranch({ messages: rows ?? [], parentMessageId: pausedMessageId }),
      conversationAnchor,
      snapshot: createSendSnapshot({ agent, agents: [agent], req, memories, toolGroups }),
    });
    return { plan, pending: pendingFor(plan, conversationId) };
  } catch (error) {
    logger.warn(
      '[turnContext] Failed to plan the resumed turn context; the prompt stays live',
      error,
    );
    return null;
  }
}

/**
 * Prepends each history message's `<context_update>` block to its prompt copy and counts it
 * for the prompt.
 * @returns the tokens added, and whether any block was applied
 */
export function applyHistoryUpdates({
  plan,
  formattedMessages,
  indexTokenCountMap,
  countTokens,
}: {
  plan: { updates: ReadonlyMap<number, string> };
  formattedMessages: FormattedMessageWithContent[];
  indexTokenCountMap: Record<number, number>;
  countTokens: (message: FormattedMessageWithContent) => number;
}): { addedTokens: number; applied: boolean } {
  let addedTokens = 0;
  let applied = false;
  for (const [index, update] of plan.updates) {
    const message = formattedMessages[index];
    const before = countTokens(message);
    prependContextText(message, update, '\n\n');
    const added = countTokens(message) - before;
    if (Number.isFinite(added) && added > 0) {
      indexTokenCountMap[index] = (indexTokenCountMap[index] ?? 0) + added;
      addedTokens += added;
    }
    applied = true;
  }
  return { addedTokens, applied };
}

/**
 * Plans what a send adds to the prompt copy of the history and applies it: the turn context
 * when the lever is on, otherwise the date and send-time notes alone. This is the one place
 * `AgentClient.buildMessages` and the prompt-cache diagnostic group both go through.
 * @returns the prepared turn context (null when not planned), the tokens added, and whether
 *          any note was applied
 */
export async function planSendContext({
  formattedMessages,
  indexTokenCountMap,
  countTokens,
  ...turnArgs
}: Parameters<typeof prepareTurnContext>[0] & {
  formattedMessages: FormattedMessageWithContent[];
  indexTokenCountMap: Record<number, number>;
  countTokens: (message: FormattedMessageWithContent) => number;
}): Promise<{ prepared: PreparedTurnContext | null; addedTokens: number; applied: boolean }> {
  const prepared = await prepareTurnContext(turnArgs);
  const plan =
    prepared?.plan ??
    createHistoryContextUpdates({
      req: turnArgs.req as Parameters<typeof createHistoryContextUpdates>[0]['req'],
      messages: turnArgs.orderedMessages as Parameters<
        typeof createHistoryContextUpdates
      >[0]['messages'],
      agents: turnArgs.allAgents.map(({ agent }) => agent),
    });
  return {
    prepared,
    ...applyHistoryUpdates({ plan, formattedMessages, indexTokenCountMap, countTokens }),
  };
}

/**
 * Stores the anchor a turn opened, once the conversation (or the summary message) it belongs
 * to exists.
 * @returns whether it was stored; false keeps it pending for the next save
 */
export async function storePendingContextAnchor({
  pending,
  userId,
  db,
}: {
  pending: PendingContextAnchor | undefined;
  userId: string | null | undefined;
  db: Pick<TurnContextDb, 'setConvoContextAnchor' | 'setMessageContextAnchor'>;
}): Promise<boolean> {
  if (pending == null || !userId) {
    return false;
  }
  try {
    return pending.messageId == null
      ? await db.setConvoContextAnchor({
          user: userId,
          conversationId: pending.conversationId,
          anchor: pending.anchor,
        })
      : await db.setMessageContextAnchor({
          user: userId,
          messageId: pending.messageId,
          anchor: pending.anchor,
        });
  } catch (error) {
    logger.error('[turnContext] Failed to store the context anchor', error);
    return false;
  }
}
