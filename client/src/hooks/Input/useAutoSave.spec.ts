jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn(),
}));

jest.mock('~/store', () => ({
  saveDrafts: { key: 'saveDrafts', default: true },
}));

jest.mock('~/Providers', () => ({
  useChatFormContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetFiles: jest.fn(),
}));

jest.mock('~/hooks/Files/useFileHandling', () => ({
  hasInFlightUpload: jest.fn(() => false),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getDraft: jest.fn(),
  setDraft: jest.fn(),
  clearDraft: jest.fn(),
  clearAllDrafts: jest.fn(),
}));

import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useRecoilValue } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { useChatFormContext } from '~/Providers';
import { useGetFiles } from '~/data-provider';
import { hasInFlightUpload } from '~/hooks/Files/useFileHandling';
import {
  encodeBase64,
  clearDraft,
  clearAllDrafts,
  getAskAnswerDraftId,
  getDraft,
  getFilesDraft,
  setDraft,
  setFilesDraft,
} from '~/utils';
import { markPastedTextFile } from '~/utils/files';
import store from '~/store';
import { useAutoSave } from '~/hooks';

const mockSetValue = jest.fn();
const mockGetDraft = getDraft as jest.Mock;
const mockSetDraft = setDraft as jest.Mock;

const makeTextAreaRef = (value = '') =>
  ({
    current: { value, addEventListener: jest.fn(), removeEventListener: jest.fn() },
  }) as unknown as React.RefObject<HTMLTextAreaElement>;

/** The registry `isTabLive` reads. A stamped tab keeps its claim only while it keeps reporting,
 * so a scenario about another tab has to say whether that tab is still open. */
const markTabLive = (tabId: string): void =>
  localStorage.setItem(`librechat-live-tab:${tabId}`, JSON.stringify({ seenAt: Date.now() }));

const markTabGone = (tabId: string): void => localStorage.removeItem(`librechat-live-tab:${tabId}`);

beforeEach(() => {
  localStorage.clear();
  (useRecoilValue as jest.Mock).mockImplementation((atom) => {
    if (atom === store.saveDrafts) return true;
    return undefined;
  });
  (useChatFormContext as jest.Mock).mockReturnValue({ setValue: mockSetValue });
  (useGetFiles as jest.Mock).mockReturnValue({ data: [] });
  (hasInFlightUpload as jest.Mock).mockReturnValue(false);
  mockGetDraft.mockReturnValue('');
});

describe('useAutoSave — conversation switching', () => {
  it('clears the textarea when switching to a conversation with no draft', () => {
    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({
          conversationId,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', '');
  });

  it('restores the saved draft when switching to a conversation with one', () => {
    mockGetDraft.mockImplementation((id: string) => (id === 'convo-2' ? 'Hello, world!' : ''));

    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({
          conversationId,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'Hello, world!');
  });

  it('saves the current textarea content before switching away', () => {
    const textAreaRef = makeTextAreaRef('draft in progress');

    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({ conversationId, textAreaRef, files: new Map(), setFiles: jest.fn() }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetDraft).toHaveBeenCalledWith({ id: 'convo-1', value: 'draft in progress' });
  });

  it('restores an incomplete pasted-text upload into the composer after reload', () => {
    mockGetDraft.mockReturnValue('before  after');
    setFilesDraft('convo-1', {
      fileIds: ['pending-paste-file'],
      pendingPastes: {
        'pending-paste-file': {
          text: 'recovered pasted text',
          selectionStart: 7,
        },
      },
    });

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'before recovered pasted text after');
    expect(mockSetDraft).toHaveBeenCalledWith({
      id: 'convo-1',
      value: 'before recovered pasted text after',
    });
    expect(getFilesDraft('convo-1')).toEqual({ fileIds: [], pendingPastes: {} });
  });

  it('does not recover a paste whose upload is still in flight', () => {
    (hasInFlightUpload as jest.Mock).mockReturnValue(true);
    mockGetDraft.mockReturnValue('before  after');
    setFilesDraft('convo-1', {
      fileIds: ['pending-paste-file'],
      pendingPastes: {
        'pending-paste-file': {
          text: 'recovered pasted text',
          selectionStart: 7,
        },
      },
    });

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'before  after');
    expect(getFilesDraft('convo-1').pendingPastes['pending-paste-file']?.text).toBe(
      'recovered pasted text',
    );
  });

  it('replaces a stale selected range when recovering a pending paste after reload', () => {
    mockGetDraft.mockReturnValue('before selected after');
    setFilesDraft('convo-1', {
      fileIds: ['pending-paste-file'],
      pendingPastes: {
        'pending-paste-file': {
          text: 'recovered pasted text',
          selectionStart: 7,
          selectionEnd: 15,
          replacedText: 'selected',
        },
      },
    });

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'before recovered pasted text after');
    expect(mockSetDraft).toHaveBeenCalledWith({
      id: 'convo-1',
      value: 'before recovered pasted text after',
    });
  });

  it('rebases two pending replacements so the earlier paste is not restored stale', () => {
    mockGetDraft.mockReturnValue('AAAA BBBB CCCC');
    setFilesDraft('convo-1', {
      fileIds: ['end-file', 'start-file'],
      pendingPastes: {
        'end-file': {
          text: 'END',
          selectionStart: 10,
          replacedText: 'CCCC',
          sequence: 1,
        },
        'start-file': {
          text: 'START',
          selectionStart: 0,
          replacedText: 'AAAA',
          sequence: 2,
        },
      },
    });

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'START BBBB END');
  });
});

describe('useAutoSave — ask-answer draft swap', () => {
  const askDraftId = getAskAnswerDraftId('action-1');
  const pendingTextKey = `${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`;

  afterEach(() => {
    localStorage.clear();
  });

  it('stashes the conversation draft and empties the box when answer mode takes the key', () => {
    const textAreaRef = makeTextAreaRef('half-typed message');

    const { rerender } = renderHook(
      ({ draftId }: { draftId: string | null }) =>
        useAutoSave({
          conversationId: 'convo-1',
          draftId,
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { draftId: null as string | null } },
    );

    act(() => {
      rerender({ draftId: askDraftId });
    });

    expect(mockSetDraft).toHaveBeenCalledWith({ id: 'convo-1', value: 'half-typed message' });
    expect(mockSetValue).toHaveBeenLastCalledWith('text', '');
  });

  it('wins over the PENDING_CONVO redirect without migrating the pending draft', () => {
    // A question pause happens mid-run (isSubmitting), where drafts normally
    // go to PENDING_CONVO. The ask key must take over AND be exempt from the
    // PENDING → new-id migration, which would move-and-delete the very draft
    // the swap-back is supposed to restore.
    localStorage.setItem(pendingTextKey, encodeBase64('pre-pause draft'));
    const textAreaRef = makeTextAreaRef('mid-run typing');

    const { rerender } = renderHook(
      ({ draftId }: { draftId: string | null }) =>
        useAutoSave({
          conversationId: 'convo-1',
          isSubmitting: true,
          draftId,
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { draftId: null as string | null } },
    );

    act(() => {
      rerender({ draftId: askDraftId });
    });

    expect(mockSetDraft).toHaveBeenCalledWith({
      id: Constants.PENDING_CONVO,
      value: 'mid-run typing',
    });
    expect(localStorage.getItem(pendingTextKey)).toBe(encodeBase64('pre-pause draft'));
    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${askDraftId}`)).toBeNull();
  });

  it('restores the stashed draft when the question resolves', () => {
    mockGetDraft.mockImplementation((id: string) =>
      id === Constants.PENDING_CONVO ? 'pre-pause draft' : '',
    );

    const { rerender } = renderHook(
      ({ draftId }: { draftId: string | null }) =>
        useAutoSave({
          conversationId: 'convo-1',
          isSubmitting: true,
          draftId,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { draftId: askDraftId as string | null } },
    );

    act(() => {
      rerender({ draftId: null });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'pre-pause draft');
  });

  it('restores a half-typed answer for the same question (reload while paused)', () => {
    mockGetDraft.mockImplementation((id: string) => (id === askDraftId ? 'half-typed answer' : ''));

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        draftId: askDraftId,
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'half-typed answer');
  });
});

describe('useAutoSave — debounced autosave', () => {
  /** Grabs the `input` listener the hook registered on the textarea. */
  const getInputListener = (textAreaRef: React.RefObject<HTMLTextAreaElement>) =>
    (textAreaRef.current!.addEventListener as unknown as jest.Mock).mock.calls.find(
      ([event]) => event === 'input',
    )![1] as (e: unknown) => void;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('flushes the live composer value, not the value captured when typing', () => {
    jest.useFakeTimers();
    // A run is active, so the draft is keyed under PENDING_CONVO.
    const textAreaRef = makeTextAreaRef('queued follow up');
    renderHook(() =>
      useAutoSave({
        isSubmitting: true,
        conversationId: 'convo-1',
        textAreaRef,
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    act(() => {
      getInputListener(textAreaRef)({ target: { value: 'queued follow up' } });
    });

    // A during-run steer/queue took the text and cleared the composer inside
    // the 25ms debounce window. The in-flight write must not resurrect it:
    // run end migrates a surviving pending draft back into the textarea.
    textAreaRef.current!.value = '';
    act(() => {
      jest.advanceTimersByTime(50);
    });

    expect(mockSetDraft).toHaveBeenLastCalledWith({
      id: Constants.PENDING_CONVO,
      value: '',
    });
  });

  it('still saves typed text when the composer is untouched', () => {
    jest.useFakeTimers();
    const textAreaRef = makeTextAreaRef('still typing');
    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef,
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    act(() => {
      getInputListener(textAreaRef)({ target: { value: 'still typing' } });
      jest.advanceTimersByTime(50);
    });

    expect(mockSetDraft).toHaveBeenLastCalledWith({ id: 'convo-1', value: 'still typing' });
  });
});

describe('useAutoSave — typing as a run finishes', () => {
  /** Real storage for these, because the loss is in what the record holds at the moment the key
   * changes: a mock that answers every read with the same string cannot express it. */
  const actualUtils = jest.requireActual('~/utils');

  const getInputListener = (textAreaRef: React.RefObject<HTMLTextAreaElement>) =>
    (textAreaRef.current!.addEventListener as unknown as jest.Mock).mock.calls.find(
      ([event]) => event === 'input',
    )![1] as (e: unknown) => void;

  /** Types into the composer the way the browser does: the value is already there when the event
   * fires, so a debounced write reads it whether or not the event carried it. */
  const type = (textAreaRef: React.RefObject<HTMLTextAreaElement>, value: string) => {
    textAreaRef.current!.value = value;
    getInputListener(textAreaRef)({ target: { value } });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetDraft.mockImplementation(actualUtils.getDraft);
    mockSetDraft.mockImplementation(actualUtils.setDraft);
  });

  afterEach(() => {
    jest.useRealTimers();
    /** Hand the rest of the suite its stubs back. An implementation set here outlives the block,
     * and a real `setDraft` leaking into a later test writes records that test never asked for. */
    mockGetDraft.mockReset();
    mockSetDraft.mockReset();
  });

  /** The reported bug. The composer is keyed under PENDING while a run streams and under the
   * conversation once it ends, and the key change tore off whatever the 25ms debounce had not
   * written yet: the pending record still held the previous flush, run end migrated that record,
   * and the restore put it back over the composer. Every keystroke since the last flush was
   * silently rolled back mid-sentence. */
  it('keeps the keystrokes the debounce had not written when the run ends', () => {
    const textAreaRef = makeTextAreaRef();
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-1',
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );

    act(() => {
      type(textAreaRef, 'my follow up');
      jest.advanceTimersByTime(50);
    });

    /** Still typing when the response lands, inside the debounce window. */
    act(() => {
      type(textAreaRef, 'my follow up question');
      rerender({ isSubmitting: false });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'my follow up question');
    expect(actualUtils.getDraft('convo-1')).toBe('my follow up question');
  });

  it('keeps the whole message when the run ends before anything was written', () => {
    const textAreaRef = makeTextAreaRef();
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-1',
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );

    act(() => {
      type(textAreaRef, 'a whole sentence typed quickly');
      rerender({ isSubmitting: false });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'a whole sentence typed quickly');
  });

  /** A debounced record can still lag the character visible in the composer at run end. */
  it('keeps a single character typed as the run ends', () => {
    const textAreaRef = makeTextAreaRef();
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-1',
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );

    act(() => {
      type(textAreaRef, 'k');
      rerender({ isSubmitting: false });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'k');
  });

  /** The same key change in the other direction. `useSubmitMessage` asks and then resets the form
   * in one handler, so the composer is already empty when the render that flips to PENDING lands:
   * the write flushed on the way out records the emptiness. Were it to record the sent text, run
   * end would migrate it straight back into the composer as a duplicate of the message. */
  it('does not keep the sent text as a draft when submitting mid-keystroke', () => {
    const textAreaRef = makeTextAreaRef();
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-1',
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: false } },
    );

    act(() => {
      type(textAreaRef, 'sent message');
    });

    /** Submit: `ask` then `methods.reset()`, batched into the render that starts the run. */
    act(() => {
      textAreaRef.current!.value = '';
      rerender({ isSubmitting: true });
    });

    expect(actualUtils.getDraft('convo-1')).toBe('');
    expect(actualUtils.getDraft(Constants.PENDING_CONVO)).toBe('');
  });

  /** The other side of the same key change, and the reason the in-flight write was dropped rather
   * than flushed: a steer consumes the composer and clears it programmatically, and run end must
   * not put the just-sent text back. An empty composer has nothing to defend, so the record wins. */
  it('does not resurrect text a steer consumed as the run ended', () => {
    const textAreaRef = makeTextAreaRef();
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-1',
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );

    act(() => {
      type(textAreaRef, 'steered message');
      jest.advanceTimersByTime(50);
    });

    /** The steer took the text and emptied the composer, and dropped the pending draft with it. */
    act(() => {
      actualUtils.clearAllDrafts(Constants.PENDING_CONVO);
      type(textAreaRef, '');
      rerender({ isSubmitting: false });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', '');
    expect(actualUtils.getDraft('convo-1')).toBe('');
  });
});

describe('useAutoSave — side-by-side pending drafts', () => {
  const pane0PendingId = Constants.PENDING_CONVO;
  const pane1PendingId = `${Constants.PENDING_CONVO}:1`;

  it('migrates only this pane pending file draft when a run finishes', () => {
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          index: 1,
          isSubmitting,
          conversationId: 'convo-side',
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );

    setFilesDraft(pane0PendingId, {
      fileIds: ['pane-0-file'],
      pendingPastes: {
        'pane-0-file': { text: 'pane 0 paste', selectionStart: 0 },
      },
    });
    setFilesDraft(pane1PendingId, {
      fileIds: ['pane-1-file'],
      pendingPastes: {
        'pane-1-file': { text: 'pane 1 paste', selectionStart: 0 },
      },
    });

    act(() => {
      rerender({ isSubmitting: false });
    });

    expect(getFilesDraft(pane0PendingId).pendingPastes['pane-0-file']?.text).toBe('pane 0 paste');
    expect(getFilesDraft(pane1PendingId)).toEqual({ fileIds: [], pendingPastes: {} });
    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'pane 1 paste');
  });

  it('recovers a pending paste the destination key has no room for', () => {
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          index: 1,
          isSubmitting,
          conversationId: 'convo-side',
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );

    setFilesDraft(pane1PendingId, {
      fileIds: ['pane-1-file'],
      pendingPastes: {
        'pane-1-file': { text: 'pane 1 paste', selectionStart: 0 },
      },
    });

    const realSetItem = Storage.prototype.setItem;
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === `${LocalStorageKeys.FILES_DRAFT}convo-side`) {
        throw new Error('quota exceeded');
      }
      realSetItem.call(this, key, value);
    });

    act(() => {
      rerender({ isSubmitting: false });
    });

    setItem.mockRestore();
    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'pane 1 paste');
    expect(getFilesDraft(pane1PendingId)).toEqual({ fileIds: [], pendingPastes: {} });
  });

  it('restores only this pane idle unsaved file draft', () => {
    mockGetDraft.mockImplementation((id: string) =>
      id === `${Constants.NEW_CONVO}:1` ? 'pane 1 draft' : 'pane 0 draft',
    );
    setFilesDraft(Constants.NEW_CONVO, {
      fileIds: ['pane-0-file'],
      pendingPastes: {
        'pane-0-file': { text: 'pane 0 paste', selectionStart: 0 },
      },
    });
    setFilesDraft(`${Constants.NEW_CONVO}:1`, {
      fileIds: ['pane-1-file'],
      pendingPastes: {
        'pane-1-file': { text: 'pane 1 paste', selectionStart: 12 },
      },
    });

    renderHook(() =>
      useAutoSave({
        index: 1,
        conversationId: Constants.NEW_CONVO as string,
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'pane 1 draftpane 1 paste');
    expect(getFilesDraft(Constants.NEW_CONVO).pendingPastes['pane-0-file']?.text).toBe(
      'pane 0 paste',
    );
    expect(getFilesDraft(`${Constants.NEW_CONVO}:1`)).toEqual({ fileIds: [], pendingPastes: {} });
  });
});

describe('useAutoSave — file cache updates', () => {
  const liveAttachment = {
    file_id: 'client-temp-id',
    type: 'image/png',
    size: 2048,
    progress: 0.9,
    preview: 'blob:local-preview',
    tool_resource: 'file_search',
    file: new File(['bytes'], 'cat.png', { type: 'image/png' }),
  };
  const persistedRecord = {
    file_id: 'server-file-id',
    temp_file_id: 'client-temp-id',
    filename: 'cat.png',
    filepath: '/images/cat.png',
    type: 'image/png',
    bytes: 2048,
    object: 'file',
    usage: 0,
    user: 'user-1',
    embedded: false,
  };

  const applySetFiles = (setFiles: jest.Mock, current: Map<string, unknown>) =>
    setFiles.mock.calls.reduce(
      (files, [update]) => (typeof update === 'function' ? update(files) : update),
      current,
    ) as Map<string, Record<string, unknown>>;

  /**
   * The file cache is rewritten on every upload and on every attachment an agent
   * emits mid-run, and this hook restores from it. An empty draft there means the
   * draft write has not caught up — not that the composer is empty — so clearing
   * would drop an attachment the user just added (and, with no text typed, leave
   * them with nothing submittable).
   */
  it('leaves live attachments alone when the file cache changes with no saved draft', () => {
    const setFiles = jest.fn();
    const files = new Map([['client-temp-id', liveAttachment]]);

    const { rerender } = renderHook(
      ({ fileList }: { fileList: unknown[] }) => {
        (useGetFiles as jest.Mock).mockReturnValue({ data: fileList });
        return useAutoSave({
          conversationId: 'convo-1',
          textAreaRef: makeTextAreaRef(),
          files,
          setFiles,
        });
      },
      { initialProps: { fileList: [] as unknown[] } },
    );

    setFiles.mockClear();
    /** The draft is gone the moment storage refuses or evicts the write — another
     * tab clearing it, a quota failure, private browsing. The attachment the user
     * just added is still in the composer either way. */
    localStorage.clear();
    act(() => {
      rerender({ fileList: [persistedRecord] });
    });

    expect(applySetFiles(setFiles, files).size).toBe(1);
  });

  /**
   * The restore also lands on entries the composer still owns, so it has to layer
   * the persisted record over them rather than replace them: the blob preview the
   * chip renders from and the tool resource the upload was staged under exist only
   * locally, and `attached` decides whether removing the chip deletes the file.
   */
  it('layers the persisted record over a live attachment instead of replacing it', () => {
    const setFiles = jest.fn();
    const files = new Map([['client-temp-id', liveAttachment]]);
    setFilesDraft('convo-1', { fileIds: ['client-temp-id'], pendingPastes: {} });

    const { rerender } = renderHook(
      ({ fileList }: { fileList: unknown[] }) => {
        (useGetFiles as jest.Mock).mockReturnValue({ data: fileList });
        return useAutoSave({
          conversationId: 'convo-1',
          textAreaRef: makeTextAreaRef(),
          files,
          setFiles,
        });
      },
      { initialProps: { fileList: [] as unknown[] } },
    );

    /** Past the mount swap, which clears the composer itself before restoring. */
    setFiles.mockClear();
    act(() => {
      rerender({ fileList: [persistedRecord] });
    });

    const restored = applySetFiles(setFiles, files).get('client-temp-id');
    expect(restored).toMatchObject({
      file_id: 'server-file-id',
      filepath: '/images/cat.png',
      progress: 1,
      preview: 'blob:local-preview',
      tool_resource: 'file_search',
      attached: false,
    });
    expect(restored?.file).toBeInstanceOf(File);
  });

  it('marks a file restored from a draft alone as attached', () => {
    const setFiles = jest.fn();
    setFilesDraft('convo-1', { fileIds: ['client-temp-id'], pendingPastes: {} });

    renderHook(() => {
      (useGetFiles as jest.Mock).mockReturnValue({ data: [persistedRecord] });
      return useAutoSave({
        conversationId: 'convo-1',
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles,
      });
    });

    expect(applySetFiles(setFiles, new Map()).get('client-temp-id')).toMatchObject({
      attached: true,
      progress: 1,
    });
  });

  it('prunes paste provenance ids that left the composer', () => {
    setFilesDraft('convo-1', {
      fileIds: ['live-file', 'removed-file'],
      pendingPastes: {},
      pastedTextIds: ['live-file', 'removed-file'],
    });
    const files = new Map([['live-file', { file_id: 'live-file', progress: 1, size: 0 }]]);

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef: makeTextAreaRef(),
        files,
        setFiles: jest.fn(),
      }),
    );

    expect(getFilesDraft('convo-1').pastedTextIds).toEqual(['live-file']);
  });

  it('rebuilds paste provenance for a queued upload restored without a draft', () => {
    /** A paste queued during a run has its pending draft taken by `takeComposerDraft`, so Edit
     * message later restores the upload into an otherwise empty composer with nothing recording
     * that it was a generated paste. Unmarked, it reads as a shared attachment: removing it would
     * not delete it and New Chat would skip it, orphaning the unsent upload. */
    markPastedTextFile('queued-paste');
    setFilesDraft('convo-1', { fileIds: ['queued-paste'], pendingPastes: {} });
    const files = new Map([
      ['queued-paste', { file_id: 'queued-paste', progress: 1, size: 0, attached: true }],
    ]);

    renderHook(() =>
      useAutoSave({
        conversationId: 'convo-1',
        textAreaRef: makeTextAreaRef(),
        files,
        setFiles: jest.fn(),
      }),
    );

    expect(getFilesDraft('convo-1').pastedTextIds).toEqual(['queued-paste']);
  });

  it('does not restore a files draft another open tab owns', () => {
    markTabLive('other-tab');
    mockGetDraft.mockImplementation((id: string) => (id === 'convo-2' ? 'other tab text' : ''));
    setFilesDraft('convo-2', {
      fileIds: ['other-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    });
    const setFiles = jest.fn();
    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({
          conversationId,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles,
        }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetValue).not.toHaveBeenCalledWith('text', 'other tab text');
    expect(getFilesDraft('convo-2').tabId).toBe('other-tab');
  });
  it('consumes the retained pending draft without clearing a foreign conversation draft', () => {
    markTabLive('other-tab');
    (clearAllDrafts as jest.Mock).mockImplementation(jest.requireActual('~/utils').clearAllDrafts);
    const { result, rerender, unmount } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-2',
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );
    setFilesDraft(Constants.PENDING_CONVO, { fileIds: ['ours'], pendingPastes: {} });
    setFilesDraft('convo-2', {
      fileIds: ['theirs'],
      pendingPastes: {},
      tabId: 'other-tab',
    });
    const pendingTextKey = `${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`;
    const foreignTextKey = `${LocalStorageKeys.TEXT_DRAFT}convo-2`;
    localStorage.setItem(pendingTextKey, encodeBase64('submitted text'));
    localStorage.setItem(foreignTextKey, encodeBase64('their text'));
    act(() => rerender({ isSubmitting: false }));
    act(() => result.current());
    expect(clearAllDrafts).toHaveBeenLastCalledWith(Constants.PENDING_CONVO);
    expect(localStorage.getItem(pendingTextKey)).toBeNull();
    expect(getFilesDraft(Constants.PENDING_CONVO).fileIds).toEqual([]);
    expect(localStorage.getItem(foreignTextKey)).toBe(encodeBase64('their text'));
    expect(getFilesDraft('convo-2').fileIds).toEqual(['theirs']);
    unmount();
    (clearAllDrafts as jest.Mock).mockReset();
  });

  it('keeps autosaving to the pending key while the destination is owned by another live tab', () => {
    jest.useFakeTimers();
    markTabLive('other-tab');
    const savedDrafts = new Map<string, string>();
    mockGetDraft.mockImplementation((id: string) => savedDrafts.get(id) ?? '');
    mockSetDraft.mockImplementation(({ id, value }: { id: string; value?: string }) => {
      if (value != null && value.length > 1) {
        savedDrafts.set(id, value);
      }
    });
    const textAreaRef = makeTextAreaRef('queued draft');
    const { rerender, unmount } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-2',
          textAreaRef,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { isSubmitting: true } },
    );

    setFilesDraft(Constants.PENDING_CONVO, {
      fileIds: ['queued-file'],
      pendingPastes: {},
    });
    setFilesDraft('convo-2', {
      fileIds: ['other-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    });

    act(() => {
      rerender({ isSubmitting: false });
    });

    const inputListeners = (textAreaRef.current!.addEventListener as jest.Mock).mock.calls.filter(
      ([event]) => event === 'input',
    );
    const inputListener = inputListeners[inputListeners.length - 1][1] as (event: unknown) => void;
    textAreaRef.current!.value = 'later edit';
    act(() => {
      inputListener({ target: { value: 'later edit' } });
      jest.advanceTimersByTime(50);
    });

    expect(savedDrafts.get(Constants.PENDING_CONVO)).toBe('later edit');

    unmount();
    mockSetValue.mockClear();
    renderHook(() =>
      useAutoSave({
        isSubmitting: false,
        conversationId: 'convo-2',
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );
    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'later edit');
    jest.useRealTimers();
  });

  it('leaves an ordinary conversation on its own key when the pending draft is empty', () => {
    /** Mounting straight onto a conversation reports no previous key, and treating that alone as
     * the awaited pending transition ran the migration on every such load: the conversation was
     * put on the pending key and a just-sent attachment came back into the composer. A reload with
     * real queued work still has to be recognised, so the pending record has to hold something. */
    mockGetDraft.mockImplementation((id: string) =>
      id === 'convo-9' ? 'text that belongs to convo-9' : '',
    );

    renderHook(() =>
      useAutoSave({
        isSubmitting: false,
        conversationId: 'convo-9',
        textAreaRef: makeTextAreaRef(),
        files: new Map(),
        setFiles: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'text that belongs to convo-9');
  });
  it('keeps live attachments when both pending and destination drafts belong to other tabs', () => {
    markTabLive('pending-owner');
    markTabLive('destination-owner');
    setFilesDraft(Constants.PENDING_CONVO, {
      fileIds: ['pending-tab-file'],
      pendingPastes: {},
      tabId: 'pending-owner',
    });
    setFilesDraft('conversation-foreign', {
      fileIds: ['destination-tab-file'],
      pendingPastes: {},
      tabId: 'destination-owner',
    });

    const files = new Map([
      ['queued-file', { file_id: 'queued-file', progress: 1, size: 1, attached: true }],
    ]);
    const setFiles = jest.fn();
    const { rerender } = renderHook(
      ({ isSubmitting }: { isSubmitting: boolean }) =>
        useAutoSave({
          conversationId: 'conversation-foreign',
          isSubmitting,
          textAreaRef: makeTextAreaRef(),
          files,
          setFiles,
        }),
      { initialProps: { isSubmitting: true } },
    );

    act(() => {
      rerender({ isSubmitting: false });
    });

    const updates = setFiles.mock.calls.map(([update]) =>
      typeof update === 'function' ? update(new Map()) : update,
    );
    expect(updates.some((update) => update.has('queued-file'))).toBe(true);
  });

  it('does not migrate blocked pending drafts to an unrelated conversation', () => {
    const pendingTextKey = `${LocalStorageKeys.TEXT_DRAFT}${Constants.PENDING_CONVO}`;
    localStorage.setItem(pendingTextKey, encodeBase64('draft for conversation C'));
    markTabLive('other-tab');
    (hasInFlightUpload as jest.Mock).mockReturnValue(true);
    setFilesDraft(Constants.PENDING_CONVO, {
      fileIds: ['pending-file'],
      pendingPastes: {
        'pending-file': { text: 'pending paste', selectionStart: 0 },
      },
    });
    setFilesDraft('conversation-c', {
      fileIds: ['other-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    });

    const { rerender } = renderHook(
      ({ conversationId, isSubmitting }: { conversationId: string; isSubmitting: boolean }) =>
        useAutoSave({
          conversationId,
          isSubmitting,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      {
        initialProps: {
          conversationId: 'conversation-c',
          isSubmitting: true,
        },
      },
    );

    act(() => {
      rerender({ conversationId: 'conversation-c', isSubmitting: false });
    });
    act(() => {
      rerender({ conversationId: 'conversation-d', isSubmitting: false });
    });

    expect(localStorage.getItem(pendingTextKey)).toBe(encodeBase64('draft for conversation C'));
    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}conversation-d`)).toBeNull();
    expect(getFilesDraft(Constants.PENDING_CONVO).pendingPastes['pending-file']?.text).toBe(
      'pending paste',
    );
    expect(getFilesDraft('conversation-d')).toEqual({ fileIds: [], pendingPastes: {} });
    markTabGone('other-tab');
    act(() => {
      rerender({ conversationId: 'conversation-c', isSubmitting: false });
    });

    expect(localStorage.getItem(pendingTextKey)).toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}conversation-c`)).toBe(
      encodeBase64('draft for conversation C'),
    );
    expect(getFilesDraft('conversation-c').pendingPastes['pending-file']?.text).toBe(
      'pending paste',
    );
  });
  it('restores a files draft whose owning tab has closed', () => {
    /** A closed tab's id can never be presented again, so without reclaiming it the draft and
     * the text saved beside it would stay unreachable for the rest of the profile's life. */
    markTabLive('other-tab');
    setFilesDraft('convo-2', {
      fileIds: ['closed-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    });
    markTabGone('other-tab');
    mockGetDraft.mockImplementation((id: string) => (id === 'convo-2' ? 'closed tab text' : ''));
    (useGetFiles as jest.Mock).mockReturnValue({
      data: [{ ...persistedRecord, file_id: 'closed-tab-file' }],
    });

    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({
          conversationId,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetValue).toHaveBeenCalledWith('text', 'closed tab text');
  });
});

describe('useAutoSave — exact text across navigation', () => {
  const draftStorage = jest.requireActual<typeof import('~/utils/drafts')>('~/utils/drafts');

  beforeEach(() => {
    mockGetDraft.mockImplementation(draftStorage.getDraft);
    mockSetDraft.mockImplementation(draftStorage.setDraft);
    (clearDraft as jest.Mock).mockImplementation(draftStorage.clearDraft);
  });

  afterEach(() => {
    mockGetDraft.mockReset();
    mockSetDraft.mockReset();
    (clearDraft as jest.Mock).mockReset();
  });

  it.each(['x', '字', ' ', '\n', 'first line\nsecond line'])(
    'restores %j after switching through an empty conversation and new chat',
    (value) => {
      const textarea = document.createElement('textarea');
      const textAreaRef = { current: textarea };
      const files = new Map<string, never>();
      const setFiles = jest.fn();
      mockSetValue.mockImplementation((_name: string, text: string) => {
        textarea.value = text;
      });
      const { rerender } = renderHook(
        ({ conversationId }: { conversationId: string }) =>
          useAutoSave({ conversationId, textAreaRef, files, setFiles }),
        { initialProps: { conversationId: 'convo-exact' } },
      );
      textarea.value = value;
      act(() => rerender({ conversationId: 'convo-empty' }));
      expect(textarea.value).toBe('');
      expect(draftStorage.getDraft('convo-exact')).toBe(value);
      act(() => rerender({ conversationId: String(Constants.NEW_CONVO) }));
      expect(textarea.value).toBe('');
      act(() => rerender({ conversationId: 'convo-exact' }));
      expect(textarea.value).toBe(value);
      textarea.value = '';
      act(() => rerender({ conversationId: 'convo-empty' }));
      act(() => rerender({ conversationId: 'convo-exact' }));
      expect(textarea.value).toBe('');
      mockSetValue.mockReset();
    },
  );
});
