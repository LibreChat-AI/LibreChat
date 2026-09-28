import type { TMessageContentParts } from './types/content';
import type { TFile } from './types/files';
import type { TMessage } from './types';
import { ContentTypes } from './types/runs';

/** A generated reasoning title describes the text as it existed at generation time.
 *  Any manual edit or merge into a different reasoning step invalidates the entire
 *  title revision domain while preserving unrelated content metadata. */
export function stripReasoningLabelMetadata(part: TMessageContentParts): TMessageContentParts {
  if (part.type !== ContentTypes.THINK) {
    return part;
  }
  const {
    reasoning_label: _label,
    reasoning_label_step_id: _stepId,
    reasoning_label_attempts: _attempts,
    reasoning_label_submitted_chars: _submittedChars,
    reasoning_label_revision: _revision,
    reasoning_label_status: _status,
    ...unlabeledPart
  } = part;
  return unlabeledPart;
}

export type ParentMessage = TMessage & { children: TMessage[]; depth: number };

/**
 * Memoizes built trees per messages-array identity. The same query data feeds
 * several independent `select`s (ChatView plus the branch-tail helpers), which
 * used to rebuild the full tree five times per cache write. Exactly two slots
 * per array — the bare tree and the tree for the LATEST fileMap identity — so
 * a long-lived cached conversation cannot accumulate a tree per historical
 * file-map; entries die with the messages array itself.
 */
type TreeCacheEntry = {
  bare?: TMessage[];
  fileMap?: Record<string, TFile>;
  hydrated?: TMessage[];
};
const treeCache = new WeakMap<(TMessage | undefined)[], TreeCacheEntry>();

/**
 * Builds the render tree from the flat messages array. Order-robust: live
 * stream/steer/preempt cache writes can momentarily place a child before its
 * parent, and a single-pass link would hoist such rows into phantom root
 * branches — folding the visible thread to one dangling branch until a
 * refetch restores creation order. Linking happens only after every message
 * is indexed, so array order never changes the tree shape.
 */
export function buildTree({
  messages,
  fileMap,
}: {
  messages: (TMessage | undefined)[] | null;
  fileMap?: Record<string, TFile>;
}) {
  if (messages === null) {
    return null;
  }

  const cached = treeCache.get(messages);
  if (cached) {
    if (fileMap == null && cached.bare) {
      return cached.bare;
    }
    if (fileMap != null && cached.fileMap === fileMap && cached.hydrated) {
      return cached.hydrated;
    }
  }

  const messageMap: Record<string, ParentMessage> = {};
  const orderedMessages: ParentMessage[] = [];
  const rootMessages: ParentMessage[] = [];
  const childrenCount: Record<string, number> = {};

  for (const message of messages) {
    if (!message) {
      continue;
    }
    /** A self-parented row can never link under itself (it becomes a root),
     *  so count it with the parentless group — charging its own id would
     *  inflate the sibling indices of its real children past
     *  `children.length`. */
    const parentId =
      message.parentMessageId === message.messageId ? '' : (message.parentMessageId ?? '');
    childrenCount[parentId] = (childrenCount[parentId] || 0) + 1;

    const extendedMessage: ParentMessage = {
      ...message,
      children: [],
      depth: 0,
      siblingIndex: childrenCount[parentId] - 1,
    };

    if (message.files && fileMap) {
      extendedMessage.files = message.files.map((file) => fileMap[file.file_id ?? ''] ?? file);
    }

    messageMap[message.messageId] = extendedMessage;
    orderedMessages.push(extendedMessage);
  }

  for (const extendedMessage of orderedMessages) {
    const parentMessage = messageMap[extendedMessage.parentMessageId ?? ''];
    if (parentMessage && parentMessage !== extendedMessage) {
      parentMessage.children.push(extendedMessage);
    } else {
      rootMessages.push(extendedMessage);
    }
  }

  /** Depth comes from a roots-down walk (a child linked before its parent
   *  can't inherit depth at link time). The `visited` set doubles as the
   *  cycle guard: nodes on a corrupt parent cycle are unreachable from any
   *  root, so they resurface as roots instead of disappearing. */
  const visited = new Set<ParentMessage>();
  const assignDepths = (root: ParentMessage) => {
    visited.add(root);
    const stack: ParentMessage[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as ParentMessage;
      /** Every node has one parent, so this walk reaches each node once — an
       *  already-visited child is a cycle back-edge. Sever it (not just skip
       *  it) so consumers that recurse `children` terminate. */
      if ((node.children as ParentMessage[]).some((child) => visited.has(child))) {
        node.children = (node.children as ParentMessage[]).filter((child) => !visited.has(child));
      }
      for (const child of node.children as ParentMessage[]) {
        child.depth = node.depth + 1;
        visited.add(child);
        stack.push(child);
      }
    }
  };
  for (const root of rootMessages) {
    assignDepths(root);
  }
  for (const extendedMessage of orderedMessages) {
    if (!visited.has(extendedMessage)) {
      rootMessages.push(extendedMessage);
      assignDepths(extendedMessage);
    }
  }

  const tree = rootMessages as TMessage[];
  const entry = cached ?? {};
  if (fileMap == null) {
    entry.bare = tree;
  } else {
    entry.fileMap = fileMap;
    entry.hydrated = tree;
  }
  if (!cached) {
    treeCache.set(messages, entry);
  }
  return tree;
}

/**
 * Memoizes a messages array's id index. Every row that needs to look another
 * message up (the hover controls resolving the turn a rerun would replay) would
 * otherwise scan the whole array, which is quadratic in the conversation. A
 * cache write replaces the array, so the index dies with the array it indexes
 * and can never answer from stale rows.
 */
const indexCache = new WeakMap<(TMessage | undefined)[], Map<string, TMessage>>();

/** The message with this id, resolved through the array's memoized index. */
export function findMessageById(
  messages: (TMessage | undefined)[] | null | undefined,
  messageId?: string | null,
): TMessage | undefined {
  if (messages == null || messageId == null) {
    return undefined;
  }
  let index = indexCache.get(messages);
  if (index == null) {
    index = new Map<string, TMessage>();
    for (const message of messages) {
      if (message?.messageId != null && !index.has(message.messageId)) {
        index.set(message.messageId, message);
      }
    }
    indexCache.set(messages, index);
  }
  return index.get(messageId);
}

/**
 * True when a turn carries the marker the server stamps on a manual compaction:
 * `markCompactionOutcome` sets `initiatedBy: 'user'` on whichever part carries
 * the outcome — the summary a Compact action produced, or the error part a run
 * that produced none recorded instead — and nothing else writes it, so an
 * automatic summary detour is not one. This is the compaction's own identity,
 * independent of where it hangs: Compact runs on whatever leaf the branch ends
 * with, so its response can parent onto a user message as easily as onto the
 * answer it summarized. Redoing one is the context indicator's Compact action,
 * never a rerun of the turn behind it.
 *
 * Compactions stored before the marker existed carry none, so callers keep
 * their own ancestry test as the fallback.
 */
export function isUserInitiatedCompaction(message?: Pick<TMessage, 'content'> | null): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (part) =>
      (part?.type === ContentTypes.SUMMARY || part?.type === ContentTypes.ERROR) &&
      part.initiatedBy === 'user',
  );
}

/**
 * True when a message is a finished manual compaction: every content part is a
 * summary and at least one of them carries text. A part that is still streaming
 * or that failed contributes no text of its own, so an interrupted compaction
 * can be retried.
 */
export function isCompactedLeaf(message?: Pick<TMessage, 'content'> | null): boolean {
  const content = message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  let usable = false;
  for (const part of content) {
    if (part?.type !== ContentTypes.SUMMARY) {
      return false;
    }
    /** No `boundary` means the round never completed: only the final summary
     *  block carries one, so a part holding streamed deltas alone lacks it. */
    if (part.summarizing === true || part.failed === true || part.boundary == null) {
      continue;
    }
    const hasText = (part.content ?? []).some(
      (block) => typeof block?.text === 'string' && block.text.trim().length > 0,
    );
    usable = usable || hasText;
  }
  return usable;
}
