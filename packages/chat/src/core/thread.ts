import type { TFile, TMessage } from 'librechat-data-provider';

/** Parent key under which parentless (and self-parented) messages are filed. */
export const ROOT_KEY = '';

/**
 * Keyed view of the flat messages array. Nodes reference the cached message
 * objects themselves (no per-message copies), so an untouched message keeps
 * its identity across streaming writes and memoized rows can bail on a
 * reference check instead of a field diff.
 */
export type ThreadIndex = {
  /** Raw cache objects: the identity rows are reused by. */
  messages: Map<string, TMessage>;
  /** parent key -> child ids in creation (array) order */
  children: Map<string, string[]>;
  /** Parent keys with more than one child: the only levels whose selection matters. */
  branchParentKeys: string[];
  /** Applied to `files` when a row is built, so a hydrated copy never replaces the raw identity. */
  fileMap?: Record<string, TFile>;
};

/** One visible row of the thread: the active path from root to leaf. */
export type ThreadRow = {
  /** Cache identity of the message, for reuse checks. */
  source: TMessage;
  /** `source` with files hydrated and widened with the tree fields the row components read. */
  message: TMessage;
  /** The file map `message` was hydrated with; a new map rebuilds the row. */
  fileMap?: Record<string, TFile>;
  /** Sibling-selection key: parent message id, or the root key for top-level rows. */
  parentKey: string;
  depth: number;
  /** Reversed sibling index (0 = newest), matching the selection atoms. */
  siblingIdx: number;
  siblingCount: number;
  childCount: number;
};

type IndexCacheEntry = {
  bare?: ThreadIndex;
  fileMap?: Record<string, TFile>;
  hydrated?: ThreadIndex;
};

const indexCache = new WeakMap<(TMessage | undefined)[], IndexCacheEntry>();

const NO_CHILDREN: TMessage[] = [];

function hydrateFiles(message: TMessage, fileMap?: Record<string, TFile>): TMessage {
  if (!message.files || !fileMap) {
    return message;
  }
  return {
    ...message,
    files: message.files.map((file) => fileMap[file.file_id ?? ''] ?? file),
  };
}

function parentKeyOf(message: TMessage): string {
  const parentId = message.parentMessageId;
  if (parentId == null || parentId === message.messageId) {
    return ROOT_KEY;
  }
  return parentId;
}

/**
 * Order-robust like `buildTree`: linking happens after every message is
 * indexed, a message whose parent is absent becomes a root, and nodes on a
 * corrupt parent cycle (unreachable from any root) resurface as roots.
 */
function indexMessages(
  messages: (TMessage | undefined)[],
  fileMap?: Record<string, TFile>,
): ThreadIndex {
  const byId = new Map<string, TMessage>();
  const ordered: TMessage[] = [];
  for (const message of messages) {
    if (!message) {
      continue;
    }
    byId.set(message.messageId, message);
    ordered.push(message);
  }

  const children = new Map<string, string[]>();
  const link = (parentKey: string, id: string) => {
    const list = children.get(parentKey);
    if (list) {
      list.push(id);
      return;
    }
    children.set(parentKey, [id]);
  };
  for (const message of ordered) {
    const parentKey = parentKeyOf(message);
    link(parentKey !== ROOT_KEY && byId.has(parentKey) ? parentKey : ROOT_KEY, message.messageId);
  }

  /** Every node has one parent, so a roots-down walk reaches each node once;
   *  an already-visited child is a cycle back-edge and is severed so path
   *  resolution terminates. */
  const visited = new Set<string>();
  const walk = (startIds: string[]) => {
    const stack = [...startIds];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const kids = children.get(id);
      if (!kids) {
        continue;
      }
      const reachable = kids.filter((kid) => !visited.has(kid));
      if (reachable.length !== kids.length) {
        children.set(id, reachable);
      }
      for (let i = reachable.length - 1; i >= 0; i -= 1) {
        stack.push(reachable[i]);
      }
    }
  };
  walk(children.get(ROOT_KEY) ?? []);
  if (visited.size !== ordered.length) {
    for (const message of ordered) {
      if (!visited.has(message.messageId)) {
        link(ROOT_KEY, message.messageId);
        walk([message.messageId]);
      }
    }
  }

  const branchParentKeys: string[] = [];
  for (const [parentKey, ids] of children) {
    if (ids.length > 1) {
      branchParentKeys.push(parentKey);
    }
  }
  return { messages: byId, children, branchParentKeys, fileMap };
}

/** Memoized per messages-array identity, with one extra slot for the latest fileMap. */
export function buildThreadIndex(
  messages: (TMessage | undefined)[],
  fileMap?: Record<string, TFile>,
): ThreadIndex {
  const cached = indexCache.get(messages);
  if (cached) {
    if (fileMap == null && cached.bare) {
      return cached.bare;
    }
    if (fileMap != null && cached.fileMap === fileMap && cached.hydrated) {
      return cached.hydrated;
    }
  }
  const index = indexMessages(messages, fileMap);
  const entry = cached ?? {};
  if (fileMap == null) {
    entry.bare = index;
  } else {
    entry.fileMap = fileMap;
    entry.hydrated = index;
  }
  indexCache.set(messages, entry);
  return index;
}

export type SiblingIndexLookup = (parentKey: string) => number;

function clampSiblingIdx(siblingIdx: number, siblingCount: number): number {
  return siblingIdx >= 0 && siblingIdx < siblingCount ? siblingIdx : 0;
}

function rowsEqual(
  previous: ThreadRow,
  index: ThreadIndex,
  source: TMessage,
  depth: number,
  siblingIdx: number,
  siblingCount: number,
  childCount: number,
): boolean {
  return (
    previous.source === source &&
    previous.fileMap === index.fileMap &&
    previous.depth === depth &&
    previous.siblingIdx === siblingIdx &&
    previous.siblingCount === siblingCount &&
    previous.childCount === childCount
  );
}

/**
 * Walks the active branch (root -> leaf) following the per-level sibling
 * selection, O(depth). Rows whose inputs are unchanged are reused from
 * `previousRows` so memoized row components bail by reference; when every
 * row is reused, `previousRows` itself is returned.
 *
 * `rootKey` is the selection key of the top level (the conversation id), the
 * same key the sibling atoms have always used for root siblings.
 */
export function resolveThreadRows(
  index: ThreadIndex,
  rootKey: string,
  getSiblingIdx: SiblingIndexLookup,
  previousRows: ThreadRow[] | null,
): ThreadRow[] {
  const previousById = new Map<string, ThreadRow>();
  if (previousRows) {
    for (const row of previousRows) {
      previousById.set(row.source.messageId, row);
    }
  }

  const rows: ThreadRow[] = [];
  let reusedAll = previousRows != null;
  let siblings = index.children.get(ROOT_KEY) ?? [];
  let parentKey = rootKey;
  let atomKey = rootKey;
  let depth = 0;

  while (siblings.length > 0) {
    const siblingCount = siblings.length;
    const siblingIdx = clampSiblingIdx(getSiblingIdx(atomKey), siblingCount);
    const id = siblings[siblingCount - siblingIdx - 1];
    const source = index.messages.get(id);
    if (!source) {
      break;
    }
    const childIds = index.children.get(id) ?? [];
    const childCount = childIds.length;
    const previous = previousById.get(id);
    if (
      previous &&
      rowsEqual(previous, index, source, depth, siblingIdx, siblingCount, childCount)
    ) {
      rows.push(previous);
    } else {
      reusedAll = false;
      const children =
        childCount === 0
          ? NO_CHILDREN
          : childIds
              .map((childId) => index.messages.get(childId))
              .filter((child): child is TMessage => child != null);
      rows.push({
        source,
        message: { ...hydrateFiles(source, index.fileMap), depth, children },
        fileMap: index.fileMap,
        parentKey,
        depth,
        siblingIdx,
        siblingCount,
        childCount,
      });
    }
    parentKey = id;
    atomKey = id;
    siblings = childIds;
    depth += 1;
  }

  if (reusedAll && previousRows && previousRows.length === rows.length) {
    return previousRows;
  }
  return rows;
}

/**
 * Sibling-selection reconciliation for one level, ported from the recursive
 * `MultiMessage` effect: an APPENDED newest child is followed (send, regenerate
 * and edit-resubmit all append); any other change to the children list keeps
 * the message the user was viewing, recomputing its reversed index, and falls
 * back to the newest only when it no longer exists. Returns the next reversed
 * index, or `null` when the current one stands.
 */
export function reconcileSiblingIdx(
  previousIds: string[] | undefined,
  nextIds: string[],
  currentIdx: number,
): number | null {
  const length = nextIds.length;
  if (length === 0) {
    return null;
  }
  if (!previousIds) {
    return currentIdx >= length ? 0 : null;
  }
  const newestId = nextIds[length - 1];
  const previousNewestId = previousIds[previousIds.length - 1];
  const appendedNewest =
    previousNewestId == null ||
    (newestId !== previousNewestId &&
      !previousIds.includes(newestId) &&
      nextIds.includes(previousNewestId));
  let nextIdx = currentIdx;
  if (appendedNewest) {
    nextIdx = 0;
  } else if (currentIdx > 0) {
    const viewedId = previousIds[previousIds.length - currentIdx - 1];
    const viewedIndex = viewedId == null ? -1 : nextIds.indexOf(viewedId);
    nextIdx = viewedIndex >= 0 ? length - viewedIndex - 1 : 0;
  } else if (currentIdx >= length) {
    nextIdx = 0;
  }
  return nextIdx === currentIdx ? null : nextIdx;
}

function sameIds(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Index keys whose children list changed between two indexes. */
export function changedParentKeys(previous: ThreadIndex | null, next: ThreadIndex): string[] {
  const changed: string[] = [];
  for (const [key, ids] of next.children) {
    if (!sameIds(previous?.children.get(key), ids)) {
      changed.push(key);
    }
  }
  return changed;
}
