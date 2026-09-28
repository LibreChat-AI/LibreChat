import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { atom, useStore } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { Atom } from 'jotai';

/**
 * Sibling selection of the message thread: per parent, the REVERSED index of
 * the child on display (0 = newest). Feature-owned state, shared by the
 * recursive and flat renderers, the share view, and the writers that focus a
 * regenerated response, restore a resumed branch, or clear a conversation.
 */

/** Recoil keyed `null` and `undefined` parents distinctly from any id; one sentinel keeps that. */
export const NULL_SIBLING_KEY = '__null_parent__';

export const siblingKey = (parentId: string | null | undefined): string =>
  parentId ?? NULL_SIBLING_KEY;

export const siblingIdxFamily = atomFamily((_key: string) => atom(0));

/** Read-only atom over the selections of the given parents, for one subscription per consumer. */
export function siblingIndexesAtom(keys: readonly string[]): Atom<Record<string, number>> {
  return atom((get) => {
    const indexes: Record<string, number> = {};
    for (const key of keys) {
      indexes[key] = get(siblingIdxFamily(key));
    }
    return indexes;
  });
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Subscribes to the selections of `parentKeys` through one derived atom that
 * is only replaced when the KEYS change by content: callers derive the key
 * list from the messages cache on every write, and a fresh atom per write
 * would hand every consumer a new value object and a render per delta.
 * Read through `useSyncExternalStore` so a consumer renders exactly when the
 * selection object changes, with no mount-time re-render.
 */
export function useSiblingIndexes(parentKeys: readonly string[]): Record<string, number> {
  const jotaiStore = useStore();
  const stableRef = useRef(parentKeys);
  if (!sameKeys(stableRef.current, parentKeys)) {
    stableRef.current = parentKeys;
  }
  const stableKeys = stableRef.current;
  const indexesAtom = useMemo(() => siblingIndexesAtom(stableKeys), [stableKeys]);
  const subscribe = useCallback(
    (onChange: () => void) => jotaiStore.sub(indexesAtom, onChange),
    [jotaiStore, indexesAtom],
  );
  const read = useCallback(() => jotaiStore.get(indexesAtom), [jotaiStore, indexesAtom]);
  return useSyncExternalStore(subscribe, read, read);
}
