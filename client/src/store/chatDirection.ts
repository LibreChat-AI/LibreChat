import { atom } from 'jotai';
import { createStorageAtom } from './jotai-utils';

/** `auto` lets each field resolve its direction from what is typed; the others force it. */
export type ChatDirection = 'auto' | 'ltr' | 'rtl';

/** Older clients stored `LTR`/`RTL`; anything unrecognized falls back to `auto`. */
export const normalizeChatDirection = (direction: unknown): ChatDirection => {
  const value = typeof direction === 'string' ? direction.toLowerCase() : '';
  return value === 'ltr' || value === 'rtl' ? value : 'auto';
};

const storedChatDirection = createStorageAtom<string>('chatDirection', 'auto');

export const chatDirectionAtom = atom(
  (get) => normalizeChatDirection(get(storedChatDirection)),
  (_get, set, direction: ChatDirection) => set(storedChatDirection, direction),
);
