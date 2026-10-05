import { useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EModelEndpoint, QueryKeys, ContentTypes } from 'librechat-data-provider';
import type { Agent, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { isDocumentId } from '~/components/Chat/Messages/ui/HeaderLabel';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { useAgentsMapContext } from '~/Providers';
import { findSubagentDispatch } from './dispatch';

/** Who wrote a turn, in the form main chat's message header shows an author. */
export type TurnAuthor = { name: string; icon: ReactNode; agent?: Agent; agentId?: string };

/** Keep graph and legacy aliases readable. A prefix alone cannot prove a
 *  stored agent identity; suppress known agent IDs and the non-graph self alias. */
export function readableSubagentType(
  subagentType?: string | null,
  agentId?: string,
  kind?: 'agent' | 'graph',
): string | undefined {
  if (subagentType == null || subagentType === '') return undefined;
  if (kind === 'graph') return subagentType;
  if (subagentType === 'self') return undefined;
  return subagentType === agentId || (kind === 'agent' && isDocumentId(subagentType))
    ? undefined
    : subagentType;
}

/** Stored display title, excluding legacy titles that contain storage keys. */
export function readableSubagentTitle(
  title: string | undefined,
  agentId?: string,
  kind?: 'agent' | 'graph',
): string | undefined {
  if (!title) return undefined;
  if (kind === 'graph') return title;
  const candidate = title.startsWith('Subagent: ') ? title.slice('Subagent: '.length) : title;
  if (candidate === agentId) return undefined;
  return title;
}

/** Explicit graph identity takes precedence over the legacy self alias. */
export function isSelfSpawn(subagentType?: string | null, kind?: 'agent' | 'graph'): boolean {
  return kind !== 'graph' && subagentType === 'self';
}

/** The agent a child runs as: its own saved agent, or — for a self-spawn,
 *  which records none — the agent that spawned it. */
export function resolveChildAgent(
  agentId: string | undefined,
  subagentType: string | null | undefined,
  spawningAgent: Agent | undefined,
  agentsMap: Record<string, Agent | undefined> | undefined,
  kind?: 'agent' | 'graph',
): Agent | undefined {
  if (kind === 'graph') return undefined;
  if (agentId != null) return agentsMap?.[agentId];
  return isSelfSpawn(subagentType, kind) ? spawningAgent : undefined;
}

/** Match the parallel lane that wrote the dispatch rather than its enclosing
 *  message's default author. */
export function findAgentLaneId(
  message: TMessage | undefined,
  toolCallId?: string,
  partIndex?: number,
): string | undefined {
  if (!toolCallId) return undefined;
  const indexed = partIndex == null ? undefined : message?.content?.[partIndex];
  if (indexed?.type === ContentTypes.TOOL_CALL && indexed.tool_call.id === toolCallId) {
    return indexed.agentId;
  }
  /** Durable legacy selections may have no usable index. Only a unique call
   *  can identify their lane; repeated provider IDs are ambiguous. */
  let laneId: string | undefined;
  let found = false;
  for (const part of message?.content ?? []) {
    if (part?.type !== ContentTypes.TOOL_CALL || part.tool_call.id !== toolCallId) continue;
    if (found) return undefined;
    found = true;
    laneId = part.agentId;
  }
  return laneId;
}

/** A validated self-child identity wins when it belongs to another lane;
 *  matching identities retain the historical name/avatar snapshot. */
export function resolveSelfAuthor(
  parent: TurnAuthor,
  agentId: string | undefined,
  agentsMap: Record<string, Agent | undefined> | undefined,
  fallbackName: string,
): TurnAuthor {
  if (agentId == null || agentId === parent.agentId) return parent;
  const agent = agentsMap?.[agentId];
  if (parent.agentId == null && agent == null) return parent;
  return agentAuthor(agent, fallbackName);
}

/** One display rule for live, restored and shared child tasks. Explicit graph
 *  aliases stay literal; self tasks retain the matching parent-turn snapshot. */
export function resolveSubagentAuthor(
  child: {
    subagentType?: string | null;
    subagentKind?: 'agent' | 'graph';
    agentId?: string;
    title?: string;
  },
  parent: TurnAuthor,
  agentsMap: Record<string, Agent | undefined> | undefined,
  fallbackName: string,
): TurnAuthor {
  if (isSelfSpawn(child.subagentType, child.subagentKind)) {
    return resolveSelfAuthor(parent, child.agentId, agentsMap, fallbackName);
  }
  return agentAuthor(
    resolveChildAgent(
      child.agentId,
      child.subagentType,
      parent.agent,
      agentsMap,
      child.subagentKind,
    ),
    readableSubagentTitle(child.title, child.agentId, child.subagentKind) ??
      readableSubagentType(child.subagentType, child.agentId, child.subagentKind) ??
      fallbackName,
  );
}

/** The author main chat draws for an agent turn: the agent's name and avatar,
 *  or the agents endpoint icon when it has none or is not resolvable. */
export function agentAuthor(agent: Agent | undefined, fallbackName: string): TurnAuthor {
  const name = agent?.name || fallbackName;
  return {
    agent,
    agentId: agent?.id,
    name,
    icon: (
      <MessageIcon
        iconData={{ endpoint: EModelEndpoint.agents, modelLabel: name, isCreatedByUser: false }}
        agent={agent}
      />
    ),
  };
}

type AuthorIndex = {
  byId: Map<string, TMessage>;
  byParentId: Map<string, TMessage>;
};

/** React Query replaces loaded message arrays. Weak keys let streamed snapshots
 *  be collected, while every wake-up in one snapshot shares a single pass. */
const authorIndexes = new WeakMap<TMessage[], AuthorIndex>();

/** The dispatching agent message, or the first agent reply to a user turn. */
export function findAgentAuthorMessage(
  messages: TMessage[] | undefined,
  messageId: string,
): TMessage | undefined {
  if (messages == null || messageId === '') return undefined;
  let index = authorIndexes.get(messages);
  if (index == null) {
    index = { byId: new Map(), byParentId: new Map() };
    for (const message of messages) {
      if (message.isCreatedByUser === true) continue;
      if (!index.byId.has(message.messageId)) index.byId.set(message.messageId, message);
      if (message.parentMessageId != null && !index.byParentId.has(message.parentMessageId)) {
        index.byParentId.set(message.parentMessageId, message);
      }
    }
    authorIndexes.set(messages, index);
  }
  return index.byId.get(messageId) ?? index.byParentId.get(messageId);
}

/** The author main chat's own header shows for `message`. */
export function messageAuthor(
  message: TMessage | undefined,
  agentsMap: Record<string, Agent | undefined> | undefined,
  fallbackName: string,
  laneId?: string,
): TurnAuthor {
  if (message == null) return agentAuthor(undefined, fallbackName);
  const agentId = laneId ?? message.model ?? undefined;
  const differentLane = laneId != null && laneId !== message.model;
  const agent = agentId == null ? undefined : agentsMap?.[agentId];
  const name = agent?.name || (differentLane ? undefined : message.sender) || fallbackName;
  return {
    agent,
    agentId,
    name,
    icon: (
      <MessageIcon
        iconData={{
          endpoint: message.endpoint,
          model: agentId,
          iconURL: differentLane ? undefined : message.iconURL,
          modelLabel: name,
          isCreatedByUser: false,
        }}
        agent={agent}
      />
    ),
  };
}

/** Wait for a missing historical author, then retain its snapshot so streamed
 *  content updates do not rerender every wake-up or open activity panel. */
export function useParentAuthor(
  conversationId: string,
  messageId: string,
  fallbackName: string,
  toolCallId?: string,
  partIndex?: number,
  threadId?: string,
): TurnAuthor {
  const queryClient = useQueryClient();
  const agentsMap = useAgentsMapContext();
  /** A different dispatch must read the latest message snapshot, even when
   *  both children belong to the same streamed parent turn. */
  const source = useMemo(
    () => ({ conversationId, messageId, toolCallId, partIndex, threadId }),
    [conversationId, messageId, toolCallId, partIndex, threadId],
  );
  const store = useMemo(() => {
    let snapshot: { message: TMessage; laneId?: string } | undefined;
    const getSnapshot = () => {
      if (snapshot != null) return snapshot;
      const messages = queryClient.getQueryData<TMessage[]>([
        QueryKeys.messages,
        source.conversationId,
      ]);
      const dispatch = findSubagentDispatch(messages, source.threadId);
      const message = dispatch?.message ?? findAgentAuthorMessage(messages, source.messageId);
      if (message == null) return undefined;
      /** Durable selections use a placeholder part index. A host-issued thread
       *  handle identifies the real occurrence; without it, accept only a unique ID. */
      const laneId =
        dispatch != null
          ? dispatch.agentId
          : findAgentLaneId(
              message,
              source.toolCallId,
              source.threadId ? undefined : source.partIndex,
            );
      snapshot = { message, laneId };
      return snapshot;
    };
    return {
      getSnapshot,
      subscribe: (onChange: () => void) => {
        if (source.messageId === '' || getSnapshot() != null) return () => {};
        const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
          const key = event.query.queryKey;
          if (key[0] !== QueryKeys.messages || key[1] !== source.conversationId) return;
          if (getSnapshot() == null) return;
          unsubscribe();
          onChange();
        });
        return unsubscribe;
      },
    };
  }, [queryClient, source]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(
    () => messageAuthor(snapshot?.message, agentsMap, fallbackName, snapshot?.laneId),
    [agentsMap, fallbackName, snapshot],
  );
}
