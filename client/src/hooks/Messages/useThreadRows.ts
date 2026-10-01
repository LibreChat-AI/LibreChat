import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'jotai';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { ThreadIndex, ThreadRow } from '~/utils/thread';
import {
  ROOT_KEY,
  buildThreadIndex,
  changedParentKeys,
  reconcileSiblingIdx,
  resolveThreadRows,
} from '~/utils/thread';
import {
  siblingIdxFamily,
  siblingKey,
  useSiblingIndexes,
} from '~/components/Chat/Messages/Thread/state';

const EMPTY_KEYS: string[] = [];

/**
 * The visible thread as a flat list of rows, derived from the messages cache
 * plus the sibling selection of the branch points only. A streaming delta
 * changes one message object, so every other row is reused by reference and
 * the memoized row components bail without a field diff.
 *
 * Selection reconciliation (follow an appended sibling, keep the viewed one
 * through churn) runs once per index change over the parents whose children
 * list actually changed, instead of once per rendered level.
 */
export default function useThreadRows(
  messages: TMessage[] | null | undefined,
  rootKey: string | null | undefined,
  fileMap?: Record<string, TFile>,
): ThreadRow[] | null {
  const jotaiStore = useStore();
  const rootSiblingKey = siblingKey(rootKey);
  const index = useMemo(
    () => (messages ? buildThreadIndex(messages, fileMap) : null),
    [messages, fileMap],
  );
  const branchKeys = useMemo(
    () =>
      index
        ? index.branchParentKeys.map((key) => (key === ROOT_KEY ? rootSiblingKey : key))
        : EMPTY_KEYS,
    [index, rootSiblingKey],
  );
  const siblingIndexes = useSiblingIndexes(branchKeys);

  const previousRowsRef = useRef<ThreadRow[] | null>(null);
  const rows = useMemo(() => {
    if (!index) {
      return null;
    }
    const next = resolveThreadRows(
      index,
      rootSiblingKey,
      (key) => siblingIndexes[key] ?? 0,
      previousRowsRef.current,
    );
    previousRowsRef.current = next;
    return next;
  }, [index, rootSiblingKey, siblingIndexes]);

  const previousIndexRef = useRef<{ rootKey: string; index: ThreadIndex } | null>(null);
  useEffect(() => {
    if (!index) {
      previousIndexRef.current = null;
      return;
    }
    const previous = previousIndexRef.current;
    previousIndexRef.current = { rootKey: rootSiblingKey, index };
    const previousIndex = previous && previous.rootKey === rootSiblingKey ? previous.index : null;
    for (const key of changedParentKeys(previousIndex, index)) {
      const atom = siblingIdxFamily(key === ROOT_KEY ? rootSiblingKey : key);
      const nextIdx = reconcileSiblingIdx(
        previousIndex?.children.get(key),
        index.children.get(key) ?? [],
        jotaiStore.get(atom),
      );
      if (nextIdx != null) {
        jotaiStore.set(atom, nextIdx);
      }
    }
  }, [index, rootSiblingKey, jotaiStore]);

  return rows;
}
