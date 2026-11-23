import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { PrimitiveAtom, WritableAtom } from 'jotai';
import type { SetStateAction } from 'react';

/** A pane flag a binding reads and sets like React state. */
type FlagAtom = WritableAtom<boolean, [SetStateAction<boolean>], void>;

/**
 * Epoch ms baseline for the streaming elapsed indicator at this chat index.
 * Stamped when this session submits a generation (every path through `ask`),
 * cleared by the terminal handlers when that generation ends, and only FILLED
 * (never overwritten) when resume-on-load attaches a run, preferring the
 * server-recorded generation start so a reload reports real elapsed time.
 * The reading therefore survives mid-stream remounts (new-conversation id
 * hydration, navigating away from a still-live run and back) without a later,
 * externally-started generation inheriting a stale baseline. Known residual:
 * a run whose end this pane never observed (left mid-stream, finished
 * elsewhere) leaves its stamp for the next attach at this index to inherit.
 */
export const submissionStartFamily: (index: string | number) => PrimitiveAtom<number | null> =
  atomFamily((_index: string | number) => atom<number | null>(null));

/**
 * The conversation object of the submission this pane last launched, written by `useTurns` just
 * before it publishes the submission. An app that ties its composer drafts to a launch subscribes
 * to it (`store.sub`), which runs synchronously inside the write, so the binding is in place
 * before the submission's stream can acknowledge it. The object identity is the key: it is the
 * same `submission.conversation` the stream later reports back.
 */
export const launchedConversationFamily: (index: string | number) => PrimitiveAtom<object | null> =
  atomFamily((_index: string | number) => atom<object | null>(null));

/** Whether the pane at this index shows its Stop control. */
export const showStopButtonByIndex: (index: string | number) => PrimitiveAtom<boolean> = atomFamily(
  (_index: string | number) => atom<boolean>(false),
);

/** Whether the pane at this index has stopped following the stream to the bottom. */
export const abortScrollFamily: (index: string | number) => FlagAtom = atomFamily(
  (_index: string | number): FlagAtom => {
    const valueAtom = atom<boolean>(false);
    return atom(
      (get) => get(valueAtom),
      (get, set, update: SetStateAction<boolean>) => {
        const newValue = typeof update === 'function' ? update(get(valueAtom)) : update;
        set(valueAtom, newValue);
      },
    );
  },
);
