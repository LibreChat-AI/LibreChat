import { createContext, useContext } from 'react';
import { atom } from 'jotai';
import type { PrimitiveAtom } from 'jotai';
import type { ReactNode } from 'react';

/**
 * Action ids the user moved into the composer popover. A question starts in the chat card, where
 * it reads in thread order and fits narrow screens; only these ids take over the composer.
 */
export const expandedAskActionsAtom: PrimitiveAtom<string[]> = atom<string[]>([]);

/** Currently highlighted option row (keyboard cursor), or nothing. */
export const askAnswerSelectionAtom: PrimitiveAtom<number | null> = atom<number | null>(null);

/** Checked option rows for a multi-select question. */
export const askAnswerCheckedAtom: PrimitiveAtom<number[]> = atom<number[]>([]);

/** Free-form answers keyed by pending action id. */
export const askAnswerTextAtom: PrimitiveAtom<Record<string, string>> = atom<
  Record<string, string>
>({});

/**
 * Ordinary composer text stashed while the card owns the composer, keyed by
 * pending action id. The conversation rides along because every hand-back is
 * scoped to it: a resume that settles after the user navigated away leaves no
 * one watching the exit, so returning to that conversation is the only
 * remaining chance to give the message back.
 */
export type ReleasedComposerStash = { conversationId: string | null; text: string };
export const releasedComposerTextAtom: PrimitiveAtom<Record<string, ReleasedComposerStash>> = atom<
  Record<string, ReleasedComposerStash>
>({});

/** Submission lifecycle shared by composer and message-content surfaces. */
export type AskAnswerStatus = 'idle' | 'submitting' | 'submitted' | 'expired' | 'error';
export const askSubmitStatusAtom: PrimitiveAtom<Record<string, AskAnswerStatus>> = atom<
  Record<string, AskAnswerStatus>
>({});

/** Live ask pauses already on screen, keyed the way the progress card matches a call. */
export type LiveAskPauses = {
  ids: string[];
  hasUnattributed: boolean;
};

/** What a card submits, and the free-form draft it restores after a remount. */
export type AskAnswerSubmit = (
  actionId: string,
  resolution: string | Record<string, string>,
  opts?: { onSuccess?: () => void },
) => void;

const AskAnswerHostContext = createContext(false);

/** No live pause. A card outside the host stays visible rather than hiding itself. */
const readNoLiveAskPauses = (): LiveAskPauses | null => null;

/**
 * The reader's live-pause lookup. It is a hook: the progress card calls it on every render, and
 * only while that card is mounted, so settled history does not subscribe.
 */
const LiveAskPausesContext = createContext<() => LiveAskPauses | null>(readNoLiveAskPauses);

export function AskAnswerHostProvider({
  saveDrafts,
  useLiveAskPauses = readNoLiveAskPauses,
  children,
}: {
  saveDrafts: boolean;
  /**
   * Which ask calls already have an interactive pause. Called by the in-progress card. Absent,
   * no pause is treated as live.
   */
  useLiveAskPauses?: () => LiveAskPauses | null;
  children?: ReactNode;
}): ReactNode {
  return (
    <AskAnswerHostContext.Provider value={saveDrafts}>
      <LiveAskPausesContext.Provider value={useLiveAskPauses}>
        {children}
      </LiveAskPausesContext.Provider>
    </AskAnswerHostContext.Provider>
  );
}

export function useAskAnswerHost(): boolean {
  return useContext(AskAnswerHostContext);
}

/** The host's live pauses, or none where the host did not supply a reader. */
export function useLiveAskPauses(): LiveAskPauses | null {
  return useContext(LiveAskPausesContext)();
}
