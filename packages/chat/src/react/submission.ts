import { useCallback } from 'react';
import { atomFamily } from 'jotai/utils';
import { atom, useAtomValue, useStore } from 'jotai';
import type { Atom, WritableAtom, createStore } from 'jotai';
import type { TSubmission } from 'librechat-data-provider';
import type { SetStateAction } from 'react';

/** Pane index a generation runs in: `0` for the main chat, `1` for the added one. */
export type PaneIndex = string | number;

type Store = ReturnType<typeof createStore>;

const submittingIndexesAtom = atom<ReadonlySet<PaneIndex>>(new Set<PaneIndex>());

/** Whether a generation is in flight in the pane at this index. */
export type SubmittingAtom = WritableAtom<boolean, [SetStateAction<boolean>], void>;

export const isSubmittingFamily: (index: PaneIndex) => SubmittingAtom = atomFamily(
  (index: PaneIndex): SubmittingAtom => {
    const valueAtom = atom(false);
    return atom(
      (get) => get(valueAtom),
      (get, set, update: SetStateAction<boolean>) => {
        const previous = get(valueAtom);
        const next = typeof update === 'function' ? update(previous) : update;
        if (next === previous) {
          return;
        }
        set(valueAtom, next);
        const indexes = new Set(get(submittingIndexesAtom));
        if (next) {
          indexes.add(index);
        } else {
          indexes.delete(index);
        }
        set(submittingIndexesAtom, indexes);
      },
    );
  },
);

/** Whether any pane is generating, for what must stay awake while a reply streams. */
export const anySubmittingAtom: Atom<boolean> = atom((get) => get(submittingIndexesAtom).size > 0);

/** Clears every pane's in-flight flag in the given store, for teardown between runs. */
export function resetSubmitting(store: Pick<Store, 'get' | 'set'>): void {
  store.get(submittingIndexesAtom).forEach((index) => store.set(isSubmittingFamily(index), false));
}

/**
 * Whether the pane at this index is generating, read from the store at render time.
 * A render triggered by another state library (the app's Recoil atoms) can otherwise see this
 * flag one commit old, so a decision that combines the two would act on a mismatched pair.
 * The subscription still re-renders the caller when the flag changes.
 */
export function useIsSubmitting(index: PaneIndex): boolean {
  const store = useStore();
  useAtomValue(isSubmittingFamily(index));
  return store.get(isSubmittingFamily(index));
}

const submissionIndexesAtom = atom<ReadonlySet<PaneIndex>>(new Set<PaneIndex>());

/** The submission a pane is running, or `null`; setting a new value is what sends a message. */
export type SubmissionAtom = WritableAtom<
  TSubmission | null,
  [SetStateAction<TSubmission | null>],
  void
>;

export const submissionByIndex: (index: PaneIndex) => SubmissionAtom = atomFamily(
  (index: PaneIndex): SubmissionAtom => {
    const valueAtom = atom<TSubmission | null>(null);
    return atom(
      (get) => get(valueAtom),
      (get, set, update: SetStateAction<TSubmission | null>) => {
        const next = typeof update === 'function' ? update(get(valueAtom)) : update;
        set(valueAtom, next);
        const indexes = new Set(get(submissionIndexesAtom));
        if (next === null) {
          indexes.delete(index);
        } else {
          indexes.add(index);
        }
        set(submissionIndexesAtom, indexes);
      },
    );
  },
);

/** Drops every pane's submission, keeping the main pane's when `skipFirst` is set. */
export function clearSubmissions(store: Pick<Store, 'get' | 'set'>, skipFirst?: boolean): void {
  store.get(submissionIndexesAtom).forEach((index) => {
    if (skipFirst === true && index == 0) {
      return;
    }
    store.set(submissionByIndex(index), null);
  });
}

/** Stable callback that clears the submissions of the store the caller renders in. */
export function useClearSubmissions(): (skipFirst?: boolean) => void {
  const store = useStore();
  return useCallback((skipFirst?: boolean) => clearSubmissions(store, skipFirst), [store]);
}

/** The pane's submission read from the store at render time, for the same reason as `useIsSubmitting`. */
export function useSubmission(index: PaneIndex): TSubmission | null {
  const store = useStore();
  useAtomValue(submissionByIndex(index));
  return store.get(submissionByIndex(index));
}
