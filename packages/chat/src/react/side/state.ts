import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { Atom, PrimitiveAtom, WritableAtom } from 'jotai';
import type { TConversation } from 'librechat-data-provider';
import type { SetStateAction } from 'react';

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

/**
 * The chat a side chat would sit beside: set while a chat is on screen and the deployment keeps
 * side chats on, and replaced whenever that chat becomes another. Something that opens a side
 * chat after a wait compares the value it started under with the one it finds, so it does not
 * open beside a chat the reader has since left.
 */
export type SideChatBeside = { conversationId: string | null };
export const sideChatBesideAtom: PrimitiveAtom<SideChatBeside | null> = atom<SideChatBeside | null>(
  null,
);

/** Whether the page can show a side chat right now, for whatever offers to open one. */
export const sideChatAvailableAtom: Atom<boolean> = atom((get) => get(sideChatBesideAtom) != null);

/**
 * The side chat as it is kept: read it for the one on screen. Written only through
 * `sideChatAtom`, so that every way of opening or closing one also withdraws a request still
 * on its way.
 */
const shownSideChatAtom = atom<SideChat | null>(null);

/**
 * The request to open a side chat that is waiting on something, if any: a conversation whose
 * record is being read. The newest request replaces the one before it, and a side chat opened
 * or closed by any other means withdraws it, so an answer that arrives late opens nothing over
 * what the reader chose since. A requester keeps the token it set and opens only while it is
 * still the one here.
 */
export const sideChatRequestAtom: PrimitiveAtom<object | null> = atom<object | null>(null);

/** Unsent words belong to their conversation, in memory rather than to the mounted panel. */
export const sideChatDraftFamily: (conversationId: string) => PrimitiveAtom<string> = atomFamily(
  (_conversationId: string) => atom(''),
);

/** The side chat on screen, if any. One at a time: it takes the page's side panel. */
export const sideChatAtom: WritableAtom<SideChat | null, [SetStateAction<SideChat | null>], void> =
  atom(
    (get) => get(shownSideChatAtom),
    (get, set, next: SetStateAction<SideChat | null>) => {
      const current = get(shownSideChatAtom);
      const refinement = typeof next === 'function';
      let value = refinement ? next(current) : next;
      /** A change of what is shown, not a refinement of it, is the reader's newest choice. */
      if (value?.conversation.conversationId !== current?.conversation.conversationId) {
        set(sideChatRequestAtom, null);
      }
      const id = value?.conversation.conversationId;
      const text = value?.text;
      /** Seed before any panel can load. Existing words stay manual, including equal text. */
      if (
        value &&
        id &&
        text &&
        ((!refinement && value !== current) ||
          id !== current?.conversation.conversationId ||
          text !== current?.text)
      ) {
        const draft = sideChatDraftFamily(id);
        if (get(draft) === '') set(draft, text);
        else value = { conversation: value.conversation };
      }
      set(shownSideChatAtom, value);
    },
  );

/** Retire only the draft captured by the accepted send or main-composer transfer. */
export const sideChatDraftTakenAtom: WritableAtom<null, [SideChat, string], void> = atom(
  null,
  (get, set, expected: SideChat, text: string) => {
    if (get(shownSideChatAtom) !== expected) return;
    const id = expected.conversation.conversationId;
    if (!id) return;
    const draft = sideChatDraftFamily(id);
    if (get(draft) === text) set(draft, '');
  },
);
