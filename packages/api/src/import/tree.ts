import { Constants } from 'librechat-data-provider';

/** The minimum a converted message must expose for the parent graph to be
 * repaired. Both the ChatGPT and Claude converters produce richer messages;
 * the guarantees below depend on nothing else. */
export interface TreeNode {
  messageId: string;
  parentMessageId: string;
  createdAt: Date;
}

export function indexById<T extends TreeNode>(messages: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const message of messages) {
    byId.set(message.messageId, message);
  }
  return byId;
}

/** Walk states for `breakCycles`. `IN_PROGRESS` marks the chain the current
 * walk is standing on, `SAFE` marks a chain already proven to reach a root. */
const UNVISITED = 0;
const IN_PROGRESS = 1;
const SAFE = 2;

/**
 * Breaks any cycle in the parent graph by rooting the message that closes the
 * loop. Real exports occasionally reference an ancestor as its own descendant;
 * `buildTree` requires an acyclic graph so this must run before rendering.
 *
 * Colouring each node once makes this linear. The obvious form (a fresh `Set`
 * per message, re-walking the whole ancestor chain) is quadratic and measured
 * at 1.06 s for a single 5,000-message conversation and 5.1 s at 10,000, which
 * a long real thread reaches. A walk that arrives at a node already proven
 * `SAFE` stops there instead of re-deriving the rest of the chain.
 *
 * It also roots the node that actually closes the loop rather than whichever
 * message the outer iteration happened to start from, so a message merely
 * descended from a cycle keeps its parent instead of being severed too.
 */
export function breakCycles<T extends TreeNode>(messages: T[], byId: Map<string, T>): void {
  const state = new Map<string, number>();
  const walked: T[] = [];

  for (const message of messages) {
    if (state.get(message.messageId) === SAFE) {
      continue;
    }

    walked.length = 0;
    let current: T | undefined = message;
    while (current) {
      const status = state.get(current.messageId) ?? UNVISITED;
      if (status === SAFE) {
        break;
      }
      if (status === IN_PROGRESS) {
        current.parentMessageId = Constants.NO_PARENT;
        break;
      }
      state.set(current.messageId, IN_PROGRESS);
      walked.push(current);
      if (current.parentMessageId === Constants.NO_PARENT) {
        break;
      }
      current = byId.get(current.parentMessageId);
    }

    for (const node of walked) {
      state.set(node.messageId, SAFE);
    }
  }
}

/**
 * Nudges a child's timestamp past its parent's when the export's creation
 * times are out of order, via a single BFS from the roots so every parent is
 * visited before its children.
 */
export function enforceOrdering<T extends TreeNode>(messages: T[], byId: Map<string, T>): void {
  const children = new Map<string, T[]>();
  for (const message of messages) {
    const siblings = children.get(message.parentMessageId);
    if (siblings) {
      siblings.push(message);
      continue;
    }
    children.set(message.parentMessageId, [message]);
  }

  /** Walked with a moving index rather than `shift()`: shifting re-indexes the
   * whole remaining array on every step, which turns this single BFS quadratic
   * on a wide or flat tree, and conversion runs synchronously on the event
   * loop, so that stalls unrelated requests. */
  const queue = [...(children.get(Constants.NO_PARENT) ?? [])];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    const parent = byId.get(node.parentMessageId);
    if (parent && node.createdAt.getTime() <= parent.createdAt.getTime()) {
      node.createdAt = new Date(parent.createdAt.getTime() + 1);
    }
    const kids = children.get(node.messageId);
    if (kids) {
      queue.push(...kids);
    }
  }
}

/**
 * Makes a converted message list safe for `buildTree`: acyclic, and with every
 * child timestamped after its parent. Both import formats need identical
 * guarantees, so both call this rather than reimplementing them.
 */
export function orderTree<T extends TreeNode>(messages: T[]): void {
  const byId = indexById(messages);
  breakCycles(messages, byId);
  enforceOrdering(messages, byId);
}
