import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TConversation } from 'librechat-data-provider';
import type { PrimitiveAtom } from 'jotai';

/**
 * The pane number a side chat keys its per-pane state by. Its own, so it shares none of that
 * state with the main chat (`0`), the added pane (`1`) or a subagent's thread (`2`).
 */
export const SIDE_CHAT_PANE = 3;

/** A conversation of the reader's own, open beside the main one. */
export type SideChat = {
  conversation: TConversation;
  /** Words the reader had already written for it, sent as its next turn once it has loaded. */
  text?: string;
};

/** The side chat on screen, if any. One at a time: it takes the page's side panel. */
export const sideChatAtom: PrimitiveAtom<SideChat | null> = atom<SideChat | null>(null);

/**
 * The words the reader has written for a side chat and not sent, by its conversation. Held
 * outside the panel, which is drawn again when the layout moves it between a column and a
 * sheet, and in memory only: an unsent draft is not written to storage.
 */
export const sideChatDraftFamily: (conversationId: string) => PrimitiveAtom<string> = atomFamily(
  (_conversationId: string) => atom(''),
);
