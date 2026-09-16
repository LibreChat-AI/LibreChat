import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { ReasoningEffort } from 'librechat-data-provider';
import { Provider as JotaiProvider, createStore } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { ExtendedFile } from '~/common';
import { pendingReasoningOverrideFamily } from '~/components/Chat/Input/Composer/state';
import useComposerRestore from '../useComposerRestore';
import store from '~/store';

/**
 * The guarded restore is the one path in the composer that can destroy text
 * outright: it reports back whether it took the words, and a `true` it did not
 * earn makes the caller drop them. Every refusal below is a round-trip that
 * resolved into a composer that had moved on since the click.
 */

const CONVO_ID = 'convo-restore';
const OTHER_CONVO = 'convo-elsewhere';

const stagedFile = (file_id: string): ExtendedFile =>
  ({ file_id, progress: 1, size: 1 }) as ExtendedFile;

function setup({
  conversationId = CONVO_ID,
  draft = '',
  files = new Map<string, ExtendedFile>(),
  answerModeActive = false,
  reasoningOverride,
  initialize,
}: {
  conversationId?: string;
  draft?: string;
  files?: Map<string, ExtendedFile>;
  answerModeActive?: boolean;
  reasoningOverride?: TMessage['reasoningOverride'];
  initialize?: (snapshot: MutableSnapshot) => void;
} = {}) {
  let text = draft;
  const setFiles = jest.fn();
  const methods = {
    setValue: jest.fn((_name: string, value: string) => {
      text = value;
    }),
    getValues: jest.fn(() => text),
  };
  const textAreaRef = { current: { focus: jest.fn() } };
  const reasoningStore = createStore();
  reasoningStore.set(pendingReasoningOverrideFamily(conversationId), reasoningOverride);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <JotaiProvider store={reasoningStore}>
      <RecoilRoot initializeState={initialize}>{children}</RecoilRoot>
    </JotaiProvider>
  );
  const view = renderHook(
    (props: { conversationId: string; answerModeActive: boolean }) =>
      useComposerRestore({
        conversationId: props.conversationId,
        methods: methods as never,
        files,
        setFiles,
        textAreaRef: textAreaRef as never,
        answerModeActive: props.answerModeActive,
      }),
    { wrapper, initialProps: { conversationId, answerModeActive } },
  );
  return { ...view, methods, setFiles, textAreaRef, reasoningStore, currentText: () => text };
}

const reclaim = (result: { current: ReturnType<typeof useComposerRestore> }, origin = CONVO_ID) =>
  result.current.restoreReclaimedSteer('reclaimed words', [], {}, origin);

describe('useComposerRestore', () => {
  describe('restoreReclaimedSteer', () => {
    it('takes the words into an empty composer', () => {
      const { result, currentText, textAreaRef } = setup();
      let taken = false;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(true);
      expect(currentText()).toBe('reclaimed words');
      expect(textAreaRef.current.focus).toHaveBeenCalled();
    });

    it('refuses rather than overwrite a draft typed while the reclaim was in flight', () => {
      const { result, currentText } = setup({ draft: 'something I was writing' });
      let taken = true;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(false);
      expect(currentText()).toBe('something I was writing');
    });

    /* Whitespace is not a draft: refusing on it would strand the words for the
       sake of a stray space. */
    it('takes the words over a whitespace-only draft', () => {
      const { result } = setup({ draft: '   \n ' });
      let taken = false;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(true);
    });

    it('refuses when a file has been staged since', () => {
      const { result } = setup({ files: new Map([['f1', stagedFile('f1')]]) });
      let taken = true;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(false);
    });

    /* A quote or a skill pick is staged context the restore would MERGE with,
       gluing two submissions together: the box being empty is not enough. */
    it.each([
      [
        'a quote',
        (snapshot: MutableSnapshot) =>
          snapshot.set(store.pendingQuotesByConvoId(CONVO_ID), ['an excerpt']),
      ],
      [
        'a skill pick',
        (snapshot: MutableSnapshot) =>
          snapshot.set(store.pendingManualSkillsByConvoId(CONVO_ID), ['writer']),
      ],
    ])('refuses when %s is staged', (_label, initialize) => {
      const { result } = setup({ initialize });
      let taken = true;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(false);
    });

    it('refuses when a reasoning override is staged', () => {
      const { result } = setup({
        reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
      });
      let taken = true;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(false);
    });

    /* One form object is reused across conversations, so a restore that does
       not check would write the old chat's steer into the new chat's box. */
    it('refuses once the user has navigated to another chat', () => {
      const { result, rerender, currentText } = setup();
      rerender({ conversationId: OTHER_CONVO, answerModeActive: false });
      let taken = true;
      act(() => {
        taken = reclaim(result, CONVO_ID);
      });
      expect(taken).toBe(false);
      expect(currentText()).toBe('');
    });

    /* The origin is read live, not captured: the same steer restored after the
       user came BACK to its chat is still its chat. */
    it('takes the words again once the user returns to the origin chat', () => {
      const { result, rerender } = setup();
      rerender({ conversationId: OTHER_CONVO, answerModeActive: false });
      rerender({ conversationId: CONVO_ID, answerModeActive: false });
      let taken = false;
      act(() => {
        taken = reclaim(result, CONVO_ID);
      });
      expect(taken).toBe(true);
    });

    /* Answer mode owns the composer: `onSubmit` hands its text to the paused
       question, so a restore here becomes the tool's answer on the next Enter. */
    it('refuses while a question pause owns the composer', () => {
      const { result, rerender, currentText } = setup();
      /* The pause can begin mid-reclaim, so the flag is read live rather than
         captured when the restore was handed out. */
      rerender({ conversationId: CONVO_ID, answerModeActive: true });
      let taken = true;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(false);
      expect(currentText()).toBe('');
    });

    /* Its refs still hold the origin chat after unmount, so every check above
       would pass and the restore would report success into a dead form. */
    it('refuses after the composer has unmounted', () => {
      const { result, unmount } = setup();
      unmount();
      let taken = true;
      act(() => {
        taken = reclaim(result);
      });
      expect(taken).toBe(false);
    });
  });

  describe('editToComposer', () => {
    it('replaces the draft outright, unlike the guarded restore', () => {
      const { result, currentText } = setup({ draft: 'half a thought' });
      let taken = false;
      act(() => {
        taken = result.current.editToComposer('the queued message');
      });
      expect(taken).toBe(true);
      expect(currentText()).toBe('the queued message');
    });

    /* The one thing it refuses: while a question pause is live the composer is
       the answer box, so a queued message dropped in here reads as a draft and
       answers the tool on the next Enter instead of being edited. */
    it('refuses while a paused question owns the composer', () => {
      const { result, currentText, setFiles } = setup({ answerModeActive: true });
      let taken = true;
      act(() => {
        taken = result.current.editToComposer('the queued message', [
          { file_id: 'f1', filename: 'notes.pdf', filepath: '/f1', type: 'application/pdf' },
        ]);
      });
      expect(taken).toBe(false);
      expect(currentText()).toBe('');
      expect(setFiles).not.toHaveBeenCalled();
    });

    /* A question can start pausing the run between render and click. */
    it('refuses on a pause that started after the last render it was read in', () => {
      const { result, rerender, currentText } = setup();
      rerender({ conversationId: CONVO_ID, answerModeActive: true });
      let taken = true;
      act(() => {
        taken = result.current.editToComposer('too late');
      });
      expect(taken).toBe(false);
      expect(currentText()).toBe('');
    });

    it('restores attachments as already-uploaded entries', () => {
      const { result, setFiles } = setup();
      act(() => {
        result.current.editToComposer('with a file', [
          { file_id: 'f9', filename: 'notes.pdf', filepath: '/f9', type: 'application/pdf' },
        ]);
      });
      const next = setFiles.mock.calls[0][0](new Map()) as Map<string, ExtendedFile>;
      expect(next.get('f9')).toEqual(
        expect.objectContaining({ file_id: 'f9', progress: 1, attached: true }),
      );
    });

    it('restores the request-scoped reasoning override', () => {
      const { result, reasoningStore } = setup();
      act(() => {
        result.current.editToComposer('reason about this', undefined, {
          reasoningOverride: { key: 'reasoning_effort', value: ReasoningEffort.high },
        });
      });
      expect(reasoningStore.get(pendingReasoningOverrideFamily(CONVO_ID))).toEqual({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
    });

    /* Skipped rather than stored under `undefined`, which would put an
       unremovable card in the tray. */
    it('skips an attachment with no id', () => {
      const { result, setFiles } = setup();
      act(() => {
        result.current.editToComposer('with a broken file', [{ filename: 'ghost' } as never]);
      });
      const next = setFiles.mock.calls[0][0](new Map()) as Map<string, ExtendedFile>;
      expect(next.size).toBe(0);
    });
  });
});
