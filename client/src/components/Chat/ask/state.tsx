import { createContext, useContext } from 'react';
import { atom } from 'jotai';
import type { ReactNode } from 'react';

/**
 * Action ids the user moved into the chat: the popover is hidden and the
 * composer is released, so the chat card is the question's only surface.
 */
export const collapsedAskActionsAtom = atom<string[]>([]);

/** Currently highlighted option row (keyboard cursor), or nothing. */
export const askAnswerSelectionAtom = atom<number | null>(null);

/** Checked option rows for a multi-select question. */
export const askAnswerCheckedAtom = atom<number[]>([]);

/** Free-form answers keyed by pending action id. */
export const askAnswerTextAtom = atom<Record<string, string>>({});

/**
 * Ordinary composer text stashed while the card owns the composer, keyed by
 * pending action id. The conversation rides along because every hand-back is
 * scoped to it: a resume that settles after the user navigated away leaves no
 * one watching the exit, so returning to that conversation is the only
 * remaining chance to give the message back.
 */
export type ReleasedComposerStash = { conversationId: string | null; text: string };
export const releasedComposerTextAtom = atom<Record<string, ReleasedComposerStash>>({});

/** Submission lifecycle shared by composer and message-content surfaces. */
export type AskAnswerStatus = 'idle' | 'submitting' | 'submitted' | 'expired' | 'error';
export const askSubmitStatusAtom = atom<Record<string, AskAnswerStatus>>({});

const AskAnswerHostContext = createContext(false);

export function AskAnswerHostProvider({
  saveDrafts,
  children,
}: {
  saveDrafts: boolean;
  children?: ReactNode;
}) {
  return (
    <AskAnswerHostContext.Provider value={saveDrafts}>{children}</AskAnswerHostContext.Provider>
  );
}

export function useAskAnswerHost(): boolean {
  return useContext(AskAnswerHostContext);
}
