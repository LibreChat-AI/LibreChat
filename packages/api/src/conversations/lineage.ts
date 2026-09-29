import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';

/** The identity, parent link and timestamp of a message whose lineage is being ordered. */
export interface LineageMessage {
  messageId: string;
  parentMessageId?: string | null;
  createdAt: Date;
}

/** A message as it is read before cloning, with the timestamp still in its stored form. */
export interface LineageSource {
  messageId: string;
  parentMessageId?: string | null;
  createdAt?: Date | string | number | null;
}

/** A source message's clone identity: its new id, re-linked parent and ordered timestamp. */
export interface ClonedLineageEntry<T extends LineageSource> {
  source: T;
  messageId: string;
  /** Undefined when the source's parent had not been cloned yet in clone order. */
  parentMessageId: string | undefined;
  createdAt: Date;
}

export interface ClonedLineage<T extends LineageSource> {
  entries: ClonedLineageEntry<T>[];
  /** Source message id to cloned message id. */
  idMapping: Map<string, string>;
}

function indexById<T extends LineageMessage>(messages: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const message of messages) {
    byId.set(message.messageId, message);
  }
  return byId;
}

function parentOf<T extends LineageMessage>(message: T, byId: Map<string, T>): T | undefined {
  const { parentMessageId } = message;
  if (!parentMessageId || parentMessageId === Constants.NO_PARENT) {
    return undefined;
  }
  return byId.get(parentMessageId);
}

/**
 * Severs the parent link that closes each cycle so the messages form a forest.
 * Every message joins at most one walk, so the pass is linear in the message count.
 * @returns Whether any cycle was found.
 */
export function breakParentCycles<T extends LineageMessage>(messages: readonly T[]): boolean {
  const byId = indexById(messages);
  const settled = new Set<T>();
  let cycleFound = false;

  for (const message of messages) {
    const chain = new Set<T>();
    let current: T | undefined = message;
    while (current != null && !settled.has(current)) {
      if (chain.has(current)) {
        current.parentMessageId = Constants.NO_PARENT;
        cycleFound = true;
        break;
      }
      chain.add(current);
      current = parentOf(current, byId);
    }
    for (const member of chain) {
      settled.add(member);
    }
  }

  return cycleFound;
}

/**
 * Moves each child's `createdAt` to one millisecond after its parent's whenever the child
 * would otherwise sort at or before it. Each chain is resolved once, downward from its
 * nearest settled ancestor, so the pass is linear in the message count. A cycle that
 * remains is treated as rooted where the walk re-entered it.
 */
export function orderParentTimestamps<T extends LineageMessage>(messages: readonly T[]): void {
  const byId = indexById(messages);
  const settled = new Set<T>();

  for (const message of messages) {
    const chain: T[] = [];
    const pending = new Set<T>();
    let current: T | undefined = message;
    while (current != null && !settled.has(current) && !pending.has(current)) {
      chain.push(current);
      pending.add(current);
      current = parentOf(current, byId);
    }

    let parentCreatedAt = current != null && settled.has(current) ? current.createdAt : undefined;
    for (let i = chain.length - 1; i >= 0; i--) {
      const member = chain[i];
      if (parentCreatedAt != null && member.createdAt <= parentCreatedAt) {
        member.createdAt = new Date(parentCreatedAt.getTime() + 1);
      }
      parentCreatedAt = member.createdAt;
      settled.add(member);
    }
  }
}

/**
 * Makes imported messages a forest whose children sort after their parents:
 * cyclic parent links are severed first, then timestamps are ordered in one pass.
 */
export function orderMessageLineage<T extends LineageMessage>(messages: readonly T[]): void {
  if (breakParentCycles(messages)) {
    logger.warn(
      '[importers] Detected cyclic parent relationships while adjusting import timestamps',
    );
  }
  orderParentTimestamps(messages);
}

const toDate = (value: LineageSource['createdAt']): Date => {
  if (!value) {
    return new Date();
  }
  return value instanceof Date ? value : new Date(value);
};

/**
 * Assigns each message a new id, re-links it to its parent's clone and moves its timestamp
 * after that clone's. Root messages are cloned first; a message whose parent is cloned later
 * keeps an undefined parent link, as the caller's persistence decides where it attaches.
 */
export function cloneLineage<T extends LineageSource>(
  messages: readonly T[],
  createId: () => string,
): ClonedLineage<T> {
  const idMapping = new Map<string, string>();
  const clonedCreatedAt = new Map<string, Date>();
  const ordered = [...messages].sort((a, b) => {
    if (a.parentMessageId === Constants.NO_PARENT) {
      return -1;
    }
    if (b.parentMessageId === Constants.NO_PARENT) {
      return 1;
    }
    return 0;
  });

  const entries = ordered.map((source): ClonedLineageEntry<T> => {
    const messageId = createId();
    idMapping.set(source.messageId, messageId);

    const parentMessageId =
      source.parentMessageId && source.parentMessageId !== Constants.NO_PARENT
        ? idMapping.get(source.parentMessageId)
        : Constants.NO_PARENT;

    let createdAt = toDate(source.createdAt);
    const parentCreatedAt =
      parentMessageId == null ? undefined : clonedCreatedAt.get(parentMessageId);
    if (parentCreatedAt != null && createdAt <= parentCreatedAt) {
      createdAt = new Date(parentCreatedAt.getTime() + 1);
    }
    clonedCreatedAt.set(messageId, createdAt);

    return { source, messageId, parentMessageId, createdAt };
  });

  return { entries, idMapping };
}

/**
 * Retrieves the target message, its ancestors up to the root, and every sibling along that
 * path, excluding the target's own children. The first message listed under an id wins.
 */
export function getAllMessagesUpToParent<T extends Omit<LineageSource, 'createdAt'>>(
  messages: readonly T[],
  targetMessageId: string,
): T[] {
  const messagesById = new Map<string, T>();
  for (const message of messages) {
    if (!messagesById.has(message.messageId)) {
      messagesById.set(message.messageId, message);
    }
  }

  const targetMessage = messagesById.get(targetMessageId);
  if (!targetMessage) {
    return [];
  }

  const pathToRoot = new Set<string>();
  let current: T | undefined = targetMessage;
  while (current != null && !pathToRoot.has(current.messageId)) {
    pathToRoot.add(current.messageId);
    const parentId: string = current.parentMessageId ?? Constants.NO_PARENT;
    if (parentId === Constants.NO_PARENT) {
      break;
    }
    current = messagesById.get(parentId);
  }

  return messages.filter(
    (message) =>
      message.messageId === targetMessageId ||
      (pathToRoot.has(message.messageId) && message.messageId !== targetMessageId) ||
      (message.parentMessageId != null &&
        pathToRoot.has(message.parentMessageId) &&
        message.parentMessageId !== targetMessageId),
  );
}
