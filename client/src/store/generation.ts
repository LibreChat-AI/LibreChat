import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { SetStateAction } from 'react';
import { logger } from '~/utils';

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
export const submissionStartFamily = atomFamily((_index: string | number) =>
  atom<number | null>(null),
);

export const showStopButtonByIndex = atomFamily((_index: string | number) => atom<boolean>(false));

export const abortScrollFamily = atomFamily((index: string | number) => {
  const valueAtom = atom<boolean>(false);
  return atom(
    (get) => get(valueAtom),
    (get, set, update: SetStateAction<boolean>) => {
      const newValue = typeof update === 'function' ? update(get(valueAtom)) : update;
      logger.log('message_scrolling', 'Setting abortScrollByIndex', { key: index, newValue });
      set(valueAtom, newValue);
    },
  );
});
