import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import {
  AskAnswerHostProvider,
  collapsedAskActionsAtom,
  askAnswerSelectionAtom,
  askAnswerCheckedAtom,
  askAnswerTextAtom,
  releasedComposerTextAtom,
} from '~/components/Chat/ask/state';

const mockSubmitAskAnswer = jest.fn();
const mockResetComposer = jest.fn();
const mockGetComposerText = jest.fn(() => 'answer from A');
const mockSetComposerText = jest.fn();
const mockSetDraft = jest.fn();
let mockSaveDrafts = false;
let mockAskStatus = 'idle';
let jotaiStore = createStore();

const JotaiWrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(
    Provider,
    { store: jotaiStore },
    React.createElement(AskAnswerHostProvider, { saveDrafts: mockSaveDrafts }, children),
  );

jest.mock('~/data-provider', () => ({ useGetMessagesByConvoId: jest.fn() }));
jest.mock('~/components/Chat/Messages/Content/ApprovalContext', () => ({
  useAskSubmitStatus: () => ({ getAskStatus: () => mockAskStatus }),
  useResumeSubmit: () => ({ submitAskAnswer: mockSubmitAskAnswer }),
}));
jest.mock('~/Providers', () => ({
  useOptionalChatFormContext: () => ({
    reset: mockResetComposer,
    getValues: mockGetComposerText,
    setValue: mockSetComposerText,
  }),
}));
jest.mock('~/utils', () => ({
  getAskAnswerDraftId: (id: string) => `draft-${id}`,
  morphTransition: (update: () => void) => update(),
  setDraft: (...args: unknown[]) => mockSetDraft(...args),
}));

import { useGetMessagesByConvoId } from '~/data-provider';
import { findLiveAskUserQuestion } from '~/utils/approval';
import useAskAnswerMode from './useAskAnswerMode';

const mockUseGetMessages = useGetMessagesByConvoId as jest.Mock;

const liveAsk = {
  actionId: 'a1',
  question: { question: 'Pick one', options: [], multiSelect: false },
} as unknown as ReturnType<typeof findLiveAskUserQuestion>;

const batchAsk = {
  ...liveAsk,
  questions: [
    { id: 'environment', question: 'Which environment?' },
    { id: 'window', question: 'Which window?' },
  ],
} as typeof liveAsk;

describe('useAskAnswerMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveDrafts = false;
    mockAskStatus = 'idle';
    jotaiStore = createStore();
    mockGetComposerText.mockReturnValue('answer from A');
    mockSetComposerText.mockReset();
    mockSubmitAskAnswer.mockReset();
  });

  it('is active when a live ask is available', () => {
    mockUseGetMessages.mockReturnValue({ data: liveAsk });

    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    expect(result.current.liveAsk).toBe(liveAsk);
    expect(result.current.active).toBe(true);
    expect(result.current.popoverVisible).toBe(true);
  });

  it('is inactive without a live ask', () => {
    mockUseGetMessages.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    expect(result.current.liveAsk).toBeNull();
    expect(result.current.active).toBe(false);
    expect(result.current.popoverVisible).toBe(false);
  });

  it('locks the composer for a batch, and hands it back the moment it collapses', () => {
    mockUseGetMessages.mockReturnValue({ data: batchAsk });

    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    expect(result.current.active).toBe(true);
    expect(result.current.batchMode).toBe(true);
    expect(result.current.options).toEqual([]);
    expect(result.current.draftId).toBeNull();
    /** The bounded form owns the answer, so the composer never speaks for it. */
    expect(result.current.composerAnswers).toBe(false);
    expect(result.current.composerLocked).toBe(true);
    /** Text is declined, not claimed: claiming it dropped whatever was staged
     *  when the pause began. */
    expect(result.current.submitText('must stay out of the normal send path')).toBe(false);
    expect(mockSubmitAskAnswer).not.toHaveBeenCalled();
  });

  it('does not move the normal composer draft into a collapsed batch answer', () => {
    mockUseGetMessages.mockReturnValue({ data: batchAsk });
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => result.current.collapse());

    expect(jotaiStore.get(askAnswerTextAtom)).toEqual({});
    expect(mockResetComposer).not.toHaveBeenCalled();
  });

  it('does not overwrite normal composer text when expanding a batch', () => {
    jotaiStore.set(collapsedAskActionsAtom, ['a1']);
    jotaiStore.set(askAnswerTextAtom, { a1: 'stale batch handoff' });
    mockUseGetMessages.mockReturnValue({ data: batchAsk });
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => result.current.expand());

    expect(mockSetComposerText).not.toHaveBeenCalled();
  });

  it('is inactive for a new unsaved conversation', () => {
    mockUseGetMessages.mockReturnValue({ data: liveAsk });

    const { result } = renderHook(() => useAskAnswerMode('new'), {
      wrapper: JotaiWrapper,
    });
    expect(result.current.liveAsk).toBeNull();
    expect(result.current.active).toBe(false);
  });

  it('forces liveAsk null when there is no conversation id', () => {
    mockUseGetMessages.mockReturnValue({ data: liveAsk });

    const { result } = renderHook(() => useAskAnswerMode(null), {
      wrapper: JotaiWrapper,
    });

    expect(result.current.liveAsk).toBeNull();
  });

  it('moves the composer answer into the card and clears it when drafts are disabled', () => {
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => result.current.collapse());

    expect(jotaiStore.get(askAnswerTextAtom)).toEqual({ a1: 'answer from A' });
    expect(mockResetComposer).toHaveBeenCalledTimes(1);
  });

  it('lets draft handoff restore the conversation composer when drafts are enabled', () => {
    mockSaveDrafts = true;
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => result.current.collapse());

    expect(mockResetComposer).not.toHaveBeenCalled();
  });

  it('restores the card answer into the composer when drafts are disabled', () => {
    jotaiStore.set(collapsedAskActionsAtom, ['a1']);
    jotaiStore.set(askAnswerTextAtom, { a1: 'answer edited in the card' });
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => result.current.expand());

    expect(mockSetComposerText).toHaveBeenCalledWith('text', 'answer edited in the card');
  });

  it('keeps the ask-specific draft current while editing the card', () => {
    mockSaveDrafts = true;
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => result.current.setAnswerText('answer edited in the card'));

    expect(jotaiStore.get(askAnswerTextAtom)).toEqual({ a1: 'answer edited in the card' });
    expect(mockSetDraft).toHaveBeenCalledWith({
      id: 'draft-a1',
      value: 'answer edited in the card',
    });
  });

  it("preserves another paused question's answer when a second one is edited", () => {
    jotaiStore.set(askAnswerTextAtom, { a1: 'answer from A' });
    const otherAsk = {
      actionId: 'a2',
      question: { question: 'Pick one', options: [], multiSelect: false },
    } as unknown as typeof liveAsk;
    mockUseGetMessages.mockReturnValue({ data: otherAsk });
    const { result } = renderHook(() => useAskAnswerMode('conversation-2'), {
      wrapper: JotaiWrapper,
    });

    act(() => result.current.setAnswerText('answer from B'));

    /** A single shared slot dropped A's unsent answer the moment B claimed
     *  it, and the action-scoped reader then showed A an empty box. */
    expect(jotaiStore.get(askAnswerTextAtom)).toEqual({
      a1: 'answer from A',
      a2: 'answer from B',
    });
  });

  it.each(['expired', 'submitted', 'removed'])(
    'restores the released message when the question is %s',
    (terminal) => {
      let composerText = 'answer from A';
      mockGetComposerText.mockImplementation(() => composerText);
      mockSetComposerText.mockImplementation((_name: string, text: string) => {
        composerText = text;
      });
      mockUseGetMessages.mockReturnValue({ data: liveAsk });
      const { result, rerender } = renderHook(() => useAskAnswerMode('conversation-1'), {
        wrapper: JotaiWrapper,
      });
      act(() => result.current.collapse());
      composerText = 'an ordinary unsent message';
      act(() => result.current.expand());
      expect(composerText).toBe('answer from A');

      if (terminal === 'removed') {
        mockUseGetMessages.mockReturnValue({ data: null });
      } else {
        mockAskStatus = terminal;
      }
      rerender();

      expect(result.current.active).toBe(false);
      expect(composerText).toBe('an ordinary unsent message');
      expect(jotaiStore.get(releasedComposerTextAtom)).toEqual({});
    },
  );

  it('preserves newer composer edits when an in-flight question expires', () => {
    jotaiStore.set(releasedComposerTextAtom, {
      a1: { conversationId: 'conversation-1', text: 'an older message' },
    });
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    const { rerender } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });
    mockAskStatus = 'submitting';
    rerender();
    mockGetComposerText.mockReturnValue('newer message typed during submission');
    mockAskStatus = 'expired';
    rerender();

    expect(mockSetComposerText).not.toHaveBeenCalled();
    expect(jotaiStore.get(releasedComposerTextAtom)).toEqual({});
  });

  it('does not restore a departed conversation stash into a different composer', () => {
    jotaiStore.set(releasedComposerTextAtom, {
      a1: { conversationId: 'conversation-1', text: 'message for conversation A' },
    });
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    const { rerender } = renderHook(({ id }) => useAskAnswerMode(id), {
      initialProps: { id: 'conversation-1' },
      wrapper: JotaiWrapper,
    });
    mockUseGetMessages.mockReturnValue({ data: null });
    rerender({ id: 'conversation-2' });

    expect(mockSetComposerText).not.toHaveBeenCalled();
    expect(jotaiStore.get(releasedComposerTextAtom)).toEqual({
      a1: { conversationId: 'conversation-1', text: 'message for conversation A' },
    });
  });

  it('hands a stash back when its conversation is revisited after the answer settled', () => {
    /** Navigating away mid-resume leaves nobody watching the exit, so the
     *  settle drops the question without restoring anything. The stash has to
     *  survive until its own conversation comes back, or the ordinary unsent
     *  message is unreachable for the rest of the session. */
    jotaiStore.set(releasedComposerTextAtom, {
      a1: { conversationId: 'conversation-1', text: 'message for conversation A' },
    });
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    mockAskStatus = 'submitting';
    const { rerender } = renderHook(({ id }) => useAskAnswerMode(id), {
      initialProps: { id: 'conversation-1' },
      wrapper: JotaiWrapper,
    });
    mockUseGetMessages.mockReturnValue({ data: null });
    rerender({ id: 'conversation-2' });
    expect(mockSetComposerText).not.toHaveBeenCalled();

    /** Drafts are off, so the revisited composer opens empty — the only state
     *  in which handing the stash back cannot overwrite something newer. */
    mockGetComposerText.mockReturnValue('');
    mockAskStatus = 'submitted';
    rerender({ id: 'conversation-1' });

    expect(mockSetComposerText).toHaveBeenLastCalledWith('text', 'message for conversation A');
    expect(jotaiStore.get(releasedComposerTextAtom)).toEqual({});
  });

  it('hands the released composer text back when the answer is submitted', () => {
    /** Stashed by a prior expand: the question was collapsed, an ordinary
     *  message was typed in the released composer, then the question was moved
     *  back. Submitting from there never goes through `collapse`, so the
     *  message has to be restored here or it dies with the question. */
    jotaiStore.set(releasedComposerTextAtom, {
      a1: { conversationId: 'conversation-1', text: 'an ordinary unsent message' },
    });
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    mockSubmitAskAnswer.mockImplementation(
      (_actionId: string, _answer: string, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      },
    );
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => {
      result.current.submitText('answer from A');
    });

    expect(mockSetComposerText).toHaveBeenLastCalledWith('text', 'an ordinary unsent message');
    expect(mockResetComposer).not.toHaveBeenCalled();
    expect(jotaiStore.get(releasedComposerTextAtom)).toEqual({});
  });

  it('hands the released text back for an option answer too', () => {
    /** Only the free-text path sets `consumedComposerText`, so gating the
     *  restore on it discarded the stash whenever the user answered by
     *  clicking an option (or skipping) instead of typing. */
    jotaiStore.set(releasedComposerTextAtom, {
      a1: { conversationId: 'conversation-1', text: 'an ordinary unsent message' },
    });
    const askWithOptions = {
      actionId: 'a1',
      question: {
        question: 'Pick one',
        options: [
          { label: 'Blue', value: 'blue' },
          { label: 'Green', value: 'green' },
        ],
        multiSelect: false,
      },
    } as unknown as typeof liveAsk;
    mockUseGetMessages.mockReturnValue({ data: askWithOptions });
    mockSubmitAskAnswer.mockImplementation(
      (_actionId: string, _answer: string, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      },
    );
    const { result } = renderHook(() => useAskAnswerMode('conversation-1'), {
      wrapper: JotaiWrapper,
    });

    act(() => {
      result.current.submitOption(0);
    });

    expect(mockSubmitAskAnswer).toHaveBeenCalledWith('a1', 'blue', expect.anything());
    expect(mockSetComposerText).toHaveBeenLastCalledWith('text', 'an ordinary unsent message');
    expect(jotaiStore.get(releasedComposerTextAtom)).toEqual({});
  });

  it('does not let a delayed answer success clear the composer or selection after navigation', () => {
    let finishAnswer: (() => void) | undefined;
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    mockSubmitAskAnswer.mockImplementation(
      (_actionId: string, _answer: string, options?: { onSuccess?: () => void }) => {
        finishAnswer = options?.onSuccess;
      },
    );
    const { result, rerender } = renderHook(
      ({ conversationId }) => useAskAnswerMode(conversationId),
      { initialProps: { conversationId: 'conversation-A' }, wrapper: JotaiWrapper },
    );

    expect(result.current.submitText('answer from A')).toBe(true);
    expect(mockSubmitAskAnswer).toHaveBeenCalledWith(
      'a1',
      'answer from A',
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const nextAsk = {
      ...liveAsk,
      actionId: 'b1',
    } as typeof liveAsk;
    mockUseGetMessages.mockReturnValue({ data: nextAsk });
    mockGetComposerText.mockReturnValue('draft typed in B');
    rerender({ conversationId: 'conversation-B' });
    act(() => {
      jotaiStore.set(askAnswerSelectionAtom, 1);
      jotaiStore.set(askAnswerCheckedAtom, [0]);
    });
    act(() => finishAnswer?.());

    expect(mockResetComposer).not.toHaveBeenCalled();
    expect(jotaiStore.get(askAnswerSelectionAtom)).toBe(1);
    expect(jotaiStore.get(askAnswerCheckedAtom)).toEqual([0]);
  });

  it('keeps newer composer text when the answer settles on the same question', () => {
    let finishAnswer: (() => void) | undefined;
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    mockSubmitAskAnswer.mockImplementation(
      (_actionId: string, _answer: string, options?: { onSuccess?: () => void }) => {
        finishAnswer = options?.onSuccess;
      },
    );
    const { result } = renderHook(() => useAskAnswerMode('conversation-A'), {
      wrapper: JotaiWrapper,
    });

    expect(result.current.submitText('answer from A')).toBe(true);
    mockGetComposerText.mockReturnValue('new text typed while resuming');
    act(() => {
      jotaiStore.set(askAnswerSelectionAtom, 1);
      jotaiStore.set(askAnswerCheckedAtom, [0]);
    });
    act(() => finishAnswer?.());

    expect(mockResetComposer).not.toHaveBeenCalled();
    expect(jotaiStore.get(askAnswerSelectionAtom)).toBeNull();
    expect(jotaiStore.get(askAnswerCheckedAtom)).toEqual([]);
  });

  it('clears the consumed answer when the same question and composer value still own it', () => {
    let finishAnswer: (() => void) | undefined;
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    mockSubmitAskAnswer.mockImplementation(
      (_actionId: string, _answer: string, options?: { onSuccess?: () => void }) => {
        finishAnswer = options?.onSuccess;
      },
    );
    const { result } = renderHook(() => useAskAnswerMode('conversation-A'), {
      wrapper: JotaiWrapper,
    });

    expect(result.current.submitText('answer from A')).toBe(true);
    act(() => finishAnswer?.());

    expect(mockResetComposer).toHaveBeenCalledTimes(1);
    expect(jotaiStore.get(askAnswerSelectionAtom)).toBeNull();
    expect(jotaiStore.get(askAnswerCheckedAtom)).toEqual([]);
  });

  it('ignores a delayed answer success after its answer-mode owner unmounts', () => {
    let finishAnswer: (() => void) | undefined;
    mockUseGetMessages.mockReturnValue({ data: liveAsk });
    mockSubmitAskAnswer.mockImplementation(
      (_actionId: string, _answer: string, options?: { onSuccess?: () => void }) => {
        finishAnswer = options?.onSuccess;
      },
    );
    const { unmount } = renderHook(() => useAskAnswerMode('conversation-A'), {
      wrapper: JotaiWrapper,
    });
    act(() => {
      jotaiStore.set(askAnswerSelectionAtom, 1);
      jotaiStore.set(askAnswerCheckedAtom, [0]);
    });
    unmount();
    act(() => finishAnswer?.());

    expect(mockResetComposer).not.toHaveBeenCalled();
    expect(jotaiStore.get(askAnswerSelectionAtom)).toBe(1);
    expect(jotaiStore.get(askAnswerCheckedAtom)).toEqual([0]);
  });
});
