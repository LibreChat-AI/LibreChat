import { atom } from 'jotai';
import type { RefObject } from 'react';

/** Whether the shell-level file manager dialog is open. */
export const showFilesDialogAtom = atom(false);

/**
 * The control that opened the file manager, for focus restoration on close.
 *
 * `MyFilesModal` rejects an active element inside a menu, because the menu is
 * already unmounting by the time the dialog captures focus; an opener that
 * lives in a menu has to publish itself here instead, or the dialog closes
 * onto the document body. The shortcut path leaves this null on purpose: its
 * active element is the composer, which restores on its own.
 */
export const filesDialogTriggerAtom = atom<RefObject<HTMLElement | null> | null>(null);
