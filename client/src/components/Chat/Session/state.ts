import { atom } from 'jotai';
import { createStorageAtom } from '~/store/jotai-utils';

/** Whether the session rail is showing: the reader's choice, kept across chats and reloads. */
export const sessionRailOpen = createStorageAtom<boolean>('sessionRailOpen', false);

/**
 * Where the rail is drawn. The chat layout owns the column and the header owns the rail, so
 * the header's control is the one reader of the session's tasks whether the rail shows or not.
 */
export const sessionRailSlot = atom<HTMLElement | null>(null);

export const SESSION_RAIL_ID = 'session-rail';
export const SESSION_TOGGLE_ID = 'session-rail-toggle';
