import { atom } from 'jotai';
import { createStorageAtom } from '~/store/jotai-utils';

/** Whether the session rail is showing: the reader's choice, kept across chats and reloads. */
export const sessionRailOpen = createStorageAtom<boolean>('sessionRailOpen', false);

/**
 * Where the docked rail is drawn. The chat layout owns the column and the header owns the rail,
 * so the header's control is the one reader of the session's tasks whether the rail shows or
 * not. Null until the layout has made the column.
 */
export const sessionRailSlot = atom<HTMLElement | null>(null);

/** Where the small-screen sheet is drawn: always there, and it takes no room in the layout. */
export const sessionRailSheetSlot = atom<HTMLElement | null>(null);

/**
 * Whether a docked rail is showing, which is when the layout gives it a column and a handle.
 * Written by the header's control, the only thing that knows; read by the layout alone.
 */
export const sessionRailDocked = atom(false);

/** The docked rail's width in pixels, as the reader last set it. */
export const sessionRailWidth = createStorageAtom<number>('sessionRailWidth', 320);
/** Narrower than this a row cannot show its title beside its controls. */
export const SESSION_RAIL_MIN_WIDTH = '15rem';
/** The conversation keeps at least half of the room. */
export const SESSION_RAIL_MAX_WIDTH = '50%';

/**
 * The reader's own switch for the rail showing itself when work starts. The deployment's comes
 * first: where it has turned this off, the reader is not offered the switch.
 */
export const sessionRailAutoOpen = createStorageAtom<boolean>('sessionRailAutoOpen', true);

/**
 * The conversations whose rail the reader closed, oldest first. The rail is not shown again by
 * itself for one of these, on this visit or after coming back to it, and the list is bounded so
 * it cannot grow with every conversation a reader ever closes it in.
 */
export const sessionRailDismissed = createStorageAtom<string[]>('sessionRailDismissed', []);
export const SESSION_RAIL_DISMISSED_LIMIT = 100;

export const SESSION_RAIL_ID = 'session-rail';
export const SESSION_TOGGLE_ID = 'session-rail-toggle';
