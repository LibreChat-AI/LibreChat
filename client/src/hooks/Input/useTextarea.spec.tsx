import { act, renderHook, waitFor } from '@testing-library/react';
import { Constants, EToolResources } from 'librechat-data-provider';
import type { UploadLifecycleCallbacks } from '~/hooks/Files/useFileHandling';
import type { PasteAsFileContext } from '~/utils/files';
import {
  getDraft,
  getFilesDraft,
  getNewConversationDraftId,
  getPendingDraftId,
  renewNewConversationDraftToken,
} from '~/utils/drafts';

const mockForceResize = jest.fn();
const mockInsertTextAtCursor = jest.fn();
const mockResolvePastedTextFile = jest.fn();
const mockRouteFiles = jest.fn();
const mockGetUploadOptions = jest.fn(() => [EToolResources.context]);
const mockSetFilesLoading = jest.fn();
const mockShowToast = jest.fn();
const mockOpenModal = jest.fn();
const mockLocalize = jest.fn((key: string) => key);
const mockSetActivePrompt = jest.fn();
const mockSetPendingComposerText = jest.fn();
const mockSetValue = jest.fn();
let mockActivePrompt: string | undefined;
let mockPendingComposerText: string | undefined;

let useTextarea: typeof import('./useTextarea').default;
let mockIndex = 0;
let mockIsSubmitting = false;
let mockIsUploadConfigPending = false;
let mockIsUnifiedMode = false;
let mockConversation: { endpoint: string; conversationId?: string } = {
  endpoint: 'openAI',
  conversationId: 'convo-1',
};

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/drafts'),
  ...jest.requireActual('~/utils/files'),
  forceResize: mockForceResize,
  insertTextAtCursor: mockInsertTextAtCursor,
  resolvePastedTextFile: mockResolvePastedTextFile,
  getEntityName: jest.fn(() => ''),
  getEntity: jest.fn(() => ({ entity: undefined, isAgent: false, isAssistant: false })),
  checkIfScrollable: jest.fn(() => false),
}));

jest.mock('recoil', () => ({
  useRecoilValue: jest.fn(() => true),
  useRecoilState: jest.fn((atom: { key?: string }) =>
    atom?.key === 'pendingComposerText'
      ? [mockPendingComposerText, mockSetPendingComposerText]
      : [mockActivePrompt, mockSetActivePrompt],
  ),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: jest.fn(() => ({ showToast: mockShowToast })),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    enterToSend: { key: 'enterToSend' },
    saveDrafts: { key: 'saveDrafts' },
    pasteLongTextAsFile: { key: 'pasteLongTextAsFile' },
    activePromptByIndex: jest.fn(() => ({ key: 'activePrompt' })),
    pendingComposerTextByConvoId: jest.fn(() => ({ key: 'pendingComposerText' })),
  },
}));

jest.mock('~/Providers/AssistantsMapContext', () => ({
  useAssistantsMapContext: jest.fn(() => ({})),
}));

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessageMeta: jest.fn(() => undefined),
}));

jest.mock('~/hooks/Input/useComposerBindings', () => ({
  __esModule: true,
  default: jest.fn(() => ({ submitOverride: undefined, yieldedChords: undefined })),
}));

jest.mock('~/hooks/Files/useFileUploadRouter', () => ({
  __esModule: true,
  default: jest.fn(() => mockRouteFiles),
}));

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: jest.fn(() => ({})),
}));

jest.mock('~/hooks/Conversations/useGetSender', () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn(() => 'Assistant')),
}));

jest.mock('~/hooks/Files/useUploadOptions', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getOptions: mockGetUploadOptions,
    uploadsDisabled: false,
    isConfigPending: mockIsUploadConfigPending,
    isConfigResolved: !mockIsUploadConfigPending,
    isUnifiedMode: mockIsUnifiedMode,
  })),
}));

jest.mock('~/data-provider', () => ({
  useInteractionHealthCheck: jest.fn(() => jest.fn(async () => true)),
}));

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: jest.fn(() => ({
    index: mockIndex,
    conversation: mockConversation,
    isSubmitting: mockIsSubmitting,
    files: new Map(),
    setFilesLoading: mockSetFilesLoading,
  })),
}));

jest.mock('~/Providers', () => ({
  useChatFormContext: jest.fn(() => ({ setValue: mockSetValue })),
  useUploadModalContext: jest.fn(() => ({ openModal: mockOpenModal })),
}));

jest.mock('~/utils/shortcuts', () => ({
  resolveComposerKeyDown: jest.fn(),
}));

jest.mock('~/common', () => ({ globalAudioId: 'global-audio' }));

jest.mock('~/hooks', () => ({
  useLocalize: jest.fn(() => mockLocalize),
}));

const pastedText = 'a'.repeat(2501);

beforeAll(async () => {
  useTextarea = (await import('./useTextarea')).default;
});

const createPasteEvent = (files: File[] = []) => ({
  clipboardData: {
    files,
    getData: jest.fn(() => pastedText),
  },
  preventDefault: jest.fn(),
});

const renderTextareaHook = (initialAnswerModeActive = false) => {
  const textArea = document.createElement('textarea');
  const submitButton = document.createElement('button');
  const setIsScrollable = jest.fn();
  let answerModeActive = initialAnswerModeActive;
  const hook = renderHook(() =>
    useTextarea({
      textAreaRef: { current: textArea },
      submitButtonRef: { current: submitButton },
      setIsScrollable,
      answerModeActive,
    }),
  );
  const rerender = (nextAnswerModeActive = answerModeActive) => {
    answerModeActive = nextAnswerModeActive;
    hook.rerender();
  };

  return { ...hook, rerender, textArea };
};

describe('useTextarea long-paste fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockActivePrompt = undefined;
    mockPendingComposerText = undefined;
    mockIndex = 0;
    mockIsSubmitting = false;
    mockIsUploadConfigPending = false;
    mockIsUnifiedMode = false;
    mockConversation = { endpoint: 'openAI', conversationId: 'convo-1' };
    mockGetUploadOptions.mockReturnValue([EToolResources.context]);
    mockSetValue.mockReset();
    mockResolvePastedTextFile.mockImplementation((text: string) => ({
      file: new File([text], 'pasted-text.txt', { type: 'text/plain' }),
      toolResource: EToolResources.context,
    }));
  });

  it('inserts a preset prompt when the textarea refuses focus', () => {
    mockActivePrompt = 'selected prompt';
    const textArea = document.createElement('textarea');
    textArea.value = 'draft text';
    textArea.setSelectionRange(6, 10);
    const focus = jest.spyOn(textArea, 'focus').mockImplementation();
    mockSetValue.mockImplementation((_name: string, value: string) => {
      textArea.value = value;
    });

    renderHook(() =>
      useTextarea({
        textAreaRef: { current: textArea },
        submitButtonRef: { current: null },
        setIsScrollable: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenCalledWith('text', 'draft selected prompt', {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(textArea);
    expect(textArea.selectionStart).toBe(21);
    expect(textArea.selectionEnd).toBe(21);
    expect(mockSetActivePrompt).toHaveBeenCalledWith(undefined);
  });

  it('dispatches an input event when handing text to the composer', () => {
    mockPendingComposerText = 'continued text';
    const textArea = document.createElement('textarea');
    const inputListener = jest.fn();
    textArea.addEventListener('input', inputListener);
    mockSetValue.mockImplementation((_name: string, value: string) => {
      textArea.value = value;
    });

    renderHook(() =>
      useTextarea({
        textAreaRef: { current: textArea },
        submitButtonRef: { current: null },
        setIsScrollable: jest.fn(),
      }),
    );

    expect(mockSetValue).toHaveBeenCalledWith('text', 'continued text', {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(mockSetPendingComposerText).toHaveBeenCalledWith(undefined);
  });

  it('keeps long pasted text inline while the composer is the answer box', () => {
    const { result } = renderTextareaHook(true);
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockResolvePastedTextFile).not.toHaveBeenCalled();
    expect(mockRouteFiles).not.toHaveBeenCalled();
  });

  it('restores the paste when attachment validation rejects the file', async () => {
    mockRouteFiles.mockResolvedValueOnce(false);
    const { result, textArea } = renderTextareaHook();
    textArea.value = 'before selected after';
    textArea.setSelectionRange(7, 15);
    mockInsertTextAtCursor.mockImplementationOnce((element: HTMLTextAreaElement, text: string) => {
      element.setRangeText(text, element.selectionStart, element.selectionEnd, 'end');
    });
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockInsertTextAtCursor).toHaveBeenCalledTimes(1));
    expect(mockInsertTextAtCursor).toHaveBeenCalledWith(textArea, pastedText);
    expect(textArea.value).toBe(`before ${pastedText} after`);
    expect(mockForceResize).toHaveBeenCalledWith(textArea);
  });

  it('does not restore the paste when the attachment is accepted', async () => {
    mockRouteFiles.mockResolvedValueOnce(true);
    const { result, textArea } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_file_attached_as_text',
        status: 'info',
      }),
    );
    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(textArea.value).toBe('');
  });

  it('replaces selected draft text when the attachment is accepted', async () => {
    mockRouteFiles.mockResolvedValueOnce(true);
    const { result, textArea } = renderTextareaHook();
    const inputListener = jest.fn();
    textArea.value = 'before selected after';
    textArea.setSelectionRange(7, 15);
    textArea.addEventListener('input', inputListener);
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(textArea.value).toBe('before  after');
    expect(textArea.selectionStart).toBe(7);
    expect(textArea.selectionEnd).toBe(7);
    expect(inputListener).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockRouteFiles).toHaveBeenCalledTimes(1));
    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
  });

  it('restores the paste after an upload failure when the composer is unchanged', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('file-1');
        return Promise.resolve(true);
      },
    );
    const { result, textArea } = renderTextareaHook();
    textArea.value = 'before selected after';
    textArea.setSelectionRange(7, 15);
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    expect(textArea.value).toBe('before  after');
    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();

    act(() => uploadLifecycle?.onError?.('file-1'));

    expect(mockInsertTextAtCursor).toHaveBeenCalledWith(textArea, pastedText);
    expect(mockForceResize).toHaveBeenCalledWith(textArea);
    expect(getFilesDraft('convo-1')).toEqual(
      expect.objectContaining({ fileIds: [], pendingPastes: {} }),
    );
  });

  it('skips upload-failure recovery when the conversation changed', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('file-1');
        return Promise.resolve(true);
      },
    );
    const { result, rerender } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    mockConversation = { endpoint: 'openAI', conversationId: 'convo-2' };
    rerender();

    act(() => uploadLifecycle?.onError?.('file-1'));

    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockForceResize).not.toHaveBeenCalled();
    expect(getFilesDraft('convo-1').pendingPastes['file-1']?.text).toBe(pastedText);
  });

  it('skips upload-failure recovery when answer mode becomes active', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        return Promise.resolve(true);
      },
    );
    const { result, rerender } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    rerender(true);

    act(() => uploadLifecycle?.onError?.('file-1'));

    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockForceResize).not.toHaveBeenCalled();
  });

  it('skips upload-failure recovery when the composer content changed', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('file-1');
        return Promise.resolve(true);
      },
    );
    const { result, textArea } = renderTextareaHook();
    textArea.value = 'draft at paste time';
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    textArea.value = 'draft after more typing';

    act(() => uploadLifecycle?.onError?.('file-1'));

    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockForceResize).not.toHaveBeenCalled();
    expect(getFilesDraft('convo-1').pendingPastes['file-1']?.text).toBe(pastedText);
  });

  it('reinserts a failed paste at its anchor when another tab owns the draft', async () => {
    /** The ownership guard skips the only durable copy of the paste, so this callback is all that
     * is left holding it: refusing because the composer moved on would lose the text outright. */
    localStorage.setItem('librechat-live-tab:other-tab', JSON.stringify({ seenAt: Date.now() }));
    localStorage.setItem(
      'filesDraft_convo-1',
      JSON.stringify({ fileIds: ['other-tab-file'], pendingPastes: {}, tabId: 'other-tab' }),
    );
    let insertOffset = -1;
    mockInsertTextAtCursor.mockImplementationOnce((element: HTMLTextAreaElement) => {
      insertOffset = element.selectionStart;
    });
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        return Promise.resolve(true);
      },
    );
    const { result, textArea } = renderTextareaHook();
    textArea.value = 'draft at paste time';
    textArea.setSelectionRange('draft at paste time'.length, 'draft at paste time'.length);
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    expect(getFilesDraft('convo-1').pendingPastes).toEqual({});
    textArea.value = 'draft at paste time and more';

    act(() => uploadLifecycle?.onError?.('file-1'));

    expect(mockInsertTextAtCursor).toHaveBeenCalledWith(textArea, pastedText);
    expect(insertOffset).toBe('draft at paste time'.length);
  });

  it('forwards upload recovery through the assistants route', async () => {
    mockConversation = { endpoint: 'assistants' };
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (
        _files: File[],
        _toolResource: EToolResources | undefined,
        lifecycle?: UploadLifecycleCallbacks,
      ) => {
        uploadLifecycle = lifecycle;
        return Promise.resolve(true);
      },
    );
    const { result, textArea } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    expect(mockRouteFiles).toHaveBeenCalledWith(expect.any(Array), undefined, uploadLifecycle);

    act(() => uploadLifecycle?.onError?.('file-1'));

    expect(mockInsertTextAtCursor).toHaveBeenCalledWith(textArea, pastedText);
    expect(mockForceResize).toHaveBeenCalledWith(textArea);
  });

  it('does not restore a failed paste into a second unsaved draft', async () => {
    mockConversation = { endpoint: 'openAI', conversationId: Constants.NEW_CONVO as string };
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('first-draft-file');
        return Promise.resolve(true);
      },
    );
    const { result, rerender } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    renewNewConversationDraftToken();
    mockConversation = { endpoint: 'openAI', conversationId: Constants.NEW_CONVO as string };
    rerender();

    act(() => uploadLifecycle?.onError?.('first-draft-file'));

    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockForceResize).not.toHaveBeenCalled();
  });

  it('still restores a failed paste when another pane starts a new conversation', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('first-draft-file');
        return Promise.resolve(true);
      },
    );
    const { result, textArea } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    renewNewConversationDraftToken(1);

    act(() => uploadLifecycle?.onError?.('first-draft-file'));

    expect(mockInsertTextAtCursor).toHaveBeenCalledWith(textArea, pastedText);
    expect(mockForceResize).toHaveBeenCalledWith(textArea);
    expect(getFilesDraft('convo-1')).toEqual(
      expect.objectContaining({ fileIds: [], pendingPastes: {} }),
    );
  });

  it('stores a pending paste under the submitting pane draft key', async () => {
    mockIndex = 1;
    mockIsSubmitting = true;
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('pane-1-file');
        return Promise.resolve(true);
      },
    );
    const { result } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() =>
      expect(getFilesDraft(getPendingDraftId(1)).pendingPastes['pane-1-file']?.text).toBe(
        pastedText,
      ),
    );
    expect(getFilesDraft(Constants.PENDING_CONVO)).toEqual(
      expect.objectContaining({ fileIds: [], pendingPastes: {} }),
    );
    expect(uploadLifecycle).toBeDefined();
  });

  it('stores a pending paste under the idle unsaved pane draft key', async () => {
    mockIndex = 1;
    mockConversation = { endpoint: 'openAI', conversationId: Constants.NEW_CONVO as string };
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('pane-1-new-file');
        return Promise.resolve(true);
      },
    );
    const { result } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() =>
      expect(
        getFilesDraft(getNewConversationDraftId(1)).pendingPastes['pane-1-new-file']?.text,
      ).toBe(pastedText),
    );
    expect(getFilesDraft(Constants.NEW_CONVO)).toEqual(
      expect.objectContaining({ fileIds: [], pendingPastes: {} }),
    );
    expect(uploadLifecycle).toBeDefined();
  });

  it('persists paste recovery before the upload route resolves', async () => {
    let finish!: (accepted: boolean) => void;
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const { result } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    expect(uploadLifecycle?.fileId).toEqual(expect.any(String));
    expect(getFilesDraft('convo-1').pendingPastes[uploadLifecycle?.fileId ?? '']?.text).toBe(
      pastedText,
    );

    await act(async () => {
      finish(true);
    });
  });

  it('does not restore a delayed rejection after the conversation changes', async () => {
    let finish!: (accepted: boolean) => void;
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const { result, rerender } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    const fileId = uploadLifecycle?.fileId ?? '';
    expect(getFilesDraft('convo-1').pendingPastes[fileId]?.text).toBe(pastedText);
    mockConversation = { endpoint: 'openAI', conversationId: 'convo-2' };
    rerender();

    await act(async () => {
      finish(false);
    });

    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockForceResize).not.toHaveBeenCalled();
    expect(getFilesDraft('convo-1').pendingPastes[fileId]?.text).toBe(pastedText);
  });

  it('does not restore a delayed rejection after the composer changes', async () => {
    let finish!: (accepted: boolean) => void;
    mockRouteFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, textArea } = renderTextareaHook();
    textArea.value = 'draft at paste time';
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    textArea.value = 'draft after more typing';

    await act(async () => {
      finish(false);
    });

    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockForceResize).not.toHaveBeenCalled();
  });

  it('persists the replaced selection so reload recovery can drop stale draft text', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('replaced-file');
        return Promise.resolve(true);
      },
    );
    const { result, textArea } = renderTextareaHook();
    textArea.value = 'before selected after';
    textArea.setSelectionRange(7, 15);
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() =>
      expect(getFilesDraft('convo-1').pendingPastes['replaced-file']).toEqual({
        text: pastedText,
        selectionStart: 7,
        selectionEnd: 15,
        replacedText: 'selected',
        sequence: 1,
        replacedApplied: true,
        anchorBefore: 'before ',
        anchorAfter: ' after',
      }),
    );
    expect(getDraft('convo-1')).toBe('before  after');
    expect(textArea.value).toBe('before  after');
    expect(uploadLifecycle).toBeDefined();
  });

  it('persists a one-character composer snapshot while the paste upload is pending', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('one-char-file');
        return Promise.resolve(true);
      },
    );
    const { result, textArea } = renderTextareaHook();
    textArea.value = 'x';
    textArea.setSelectionRange(1, 1);
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle).toBeDefined());
    expect(textArea.value).toBe('x');
    expect(getDraft('convo-1')).toBe('x');
  });

  it('still starts the paste upload when draft persistence throws', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    mockRouteFiles.mockResolvedValueOnce(true);
    const { result } = renderTextareaHook();
    const event = createPasteEvent();

    expect(() =>
      act(() =>
        result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
      ),
    ).not.toThrow();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockRouteFiles).toHaveBeenCalledTimes(1));
    setItem.mockRestore();
  });

  it('removes durable pasted text after a successful upload', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        lifecycle?.onStart?.('successful-file');
        return Promise.resolve(true);
      },
    );
    const { result } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() =>
      expect(getFilesDraft('convo-1').pendingPastes['successful-file']?.text).toBe(pastedText),
    );
    act(() => uploadLifecycle?.onSuccess?.('successful-file'));

    expect(getFilesDraft('convo-1')).toEqual(
      expect.objectContaining({
        fileIds: ['successful-file'],
        pendingPastes: {},
      }),
    );
  });

  it('does not treat a successful upload as failed when draft storage reads throw', async () => {
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        return Promise.resolve(true);
      },
    );
    const { result } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(uploadLifecycle?.fileId).toEqual(expect.any(String)));
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() =>
      act(() => {
        uploadLifecycle?.onSuccess?.(uploadLifecycle?.fileId ?? 'missing-file');
      }),
    ).not.toThrow();
    getItem.mockRestore();
  });

  it('restores the paste when attachment routing rejects unexpectedly', async () => {
    const error = new Error('upload failed');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRouteFiles.mockRejectedValueOnce(error);
    const { result, textArea } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(mockInsertTextAtCursor).toHaveBeenCalledTimes(1));
    expect(mockInsertTextAtCursor).toHaveBeenCalledWith(textArea, pastedText);
    expect(mockForceResize).toHaveBeenCalledWith(textArea);
    expect(consoleError).toHaveBeenCalledWith('clipboard file routing error', error);
    consoleError.mockRestore();
  });

  it('clears the loading state when clipboard file routing rejects unexpectedly', async () => {
    const error = new Error('upload failed');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRouteFiles.mockRejectedValueOnce(error);
    const { result } = renderTextareaHook();
    const event = createPasteEvent([new File(['file'], 'notes.txt', { type: 'text/plain' })]);

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(mockSetFilesLoading).toHaveBeenLastCalledWith(false));
    expect(consoleError).toHaveBeenCalledWith('clipboard file routing error', error);
    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('routes a paste to context while the file config is still pending', async () => {
    mockIsUploadConfigPending = true;
    mockGetUploadOptions.mockReturnValue([]);
    mockRouteFiles.mockResolvedValueOnce(true);
    const { result } = renderTextareaHook();

    act(() =>
      result.current.handlePaste(
        createPasteEvent() as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
      ),
    );

    await waitFor(() => expect(mockRouteFiles).toHaveBeenCalledTimes(1));
    expect(mockRouteFiles.mock.calls[0][1]).toBe(EToolResources.context);
    expect(mockGetUploadOptions).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_error_files_unsupported' }),
    );
    expect(mockOpenModal).not.toHaveBeenCalled();
  });

  it('still rejects a paste once the loaded config offers nothing', async () => {
    mockGetUploadOptions.mockReturnValue([]);
    const { result } = renderTextareaHook();

    act(() =>
      result.current.handlePaste(
        createPasteEvent() as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
      ),
    );

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_error_files_unsupported',
        status: 'error',
      }),
    );
    expect(mockRouteFiles).not.toHaveBeenCalled();
  });

  it('numbers a second paste made while the first is still queued', async () => {
    mockResolvePastedTextFile.mockImplementation((text: string, ctx: PasteAsFileContext) => {
      const name = ctx.attachedFilenames.has('pasted-text.txt')
        ? 'pasted-text-2.txt'
        : 'pasted-text.txt';
      return {
        file: new File([text], name, { type: 'text/plain' }),
        toolResource: EToolResources.context,
      };
    });
    let finishFirst!: (accepted: boolean) => void;
    mockRouteFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    mockRouteFiles.mockResolvedValueOnce(true);
    const { result } = renderTextareaHook();

    act(() =>
      result.current.handlePaste(
        createPasteEvent() as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
      ),
    );
    act(() =>
      result.current.handlePaste(
        createPasteEvent() as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
      ),
    );

    expect(mockRouteFiles.mock.calls[0][0][0].name).toBe('pasted-text.txt');
    expect(mockRouteFiles.mock.calls[1][0][0].name).toBe('pasted-text-2.txt');

    await act(async () => {
      finishFirst(true);
    });

    mockRouteFiles.mockResolvedValueOnce(true);
    act(() =>
      result.current.handlePaste(
        createPasteEvent() as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
      ),
    );

    expect(mockRouteFiles.mock.calls[2][0][0].name).toBe('pasted-text.txt');
  });

  it('abandons a queued paste upload once the composer moved to another conversation', async () => {
    let finish!: (accepted: boolean) => void;
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const { result, rerender } = renderTextareaHook();

    act(() =>
      result.current.handlePaste(
        createPasteEvent() as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
      ),
    );

    expect(uploadLifecycle?.shouldCommit?.()).toBe(true);

    mockConversation = { endpoint: 'openAI', conversationId: 'convo-2' };
    rerender();

    expect(uploadLifecycle?.shouldCommit?.()).toBe(false);

    await act(async () => {
      finish(false);
    });

    expect(getFilesDraft('convo-1').pendingPastes[uploadLifecycle?.fileId ?? '']?.text).toBe(
      pastedText,
    );
  });

  it('abandons a queued paste upload once the pane started another unsaved chat', async () => {
    mockConversation = { endpoint: 'openAI', conversationId: Constants.NEW_CONVO as string };
    let finish!: (accepted: boolean) => void;
    let uploadLifecycle: UploadLifecycleCallbacks | undefined;
    mockRouteFiles.mockImplementationOnce(
      (_files: File[], _toolResource: EToolResources, lifecycle?: UploadLifecycleCallbacks) => {
        uploadLifecycle = lifecycle;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const { result } = renderTextareaHook();

    act(() =>
      result.current.handlePaste(
        createPasteEvent() as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
      ),
    );

    expect(uploadLifecycle?.shouldCommit?.()).toBe(true);

    renewNewConversationDraftToken(0);

    expect(uploadLifecycle?.shouldCommit?.()).toBe(false);

    await act(async () => {
      finish(false);
    });
  });
});

describe('useTextarea composer handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetValue.mockReset();
    mockActivePrompt = undefined;
    mockPendingComposerText = undefined;
    mockConversation = { endpoint: 'openAI', conversationId: 'convo-1' };
  });

  /** A surface the reader is leaving (a continued subagent thread) hands its
   *  words to the destination conversation. It travels in memory, so it is
   *  delivered whatever the Save Drafts preference is. */
  it('drains text handed to this conversation into the composer exactly once', () => {
    mockPendingComposerText = 'Take this further.';
    mockSetValue.mockImplementation((_name: string, value: string) => {
      expect(value).toBe('Take this further.');
    });
    const { textArea } = renderTextareaHook();

    expect(mockSetValue).toHaveBeenCalledWith('text', 'Take this further.', {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockForceResize).toHaveBeenCalledWith(textArea);
    expect(mockSetPendingComposerText).toHaveBeenCalledWith(undefined);
    expect(getDraft('convo-1')).toBe('');
  });

  it('leaves the composer alone when nothing was handed to this conversation', () => {
    renderTextareaHook();

    expect(mockInsertTextAtCursor).not.toHaveBeenCalled();
    expect(mockSetPendingComposerText).not.toHaveBeenCalled();
  });
});

describe('useTextarea clipboard routing in unified mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockIndex = 0;
    mockIsSubmitting = false;
    mockIsUploadConfigPending = false;
    mockIsUnifiedMode = true;
    mockConversation = { endpoint: 'openAI', conversationId: 'convo-1' };
    mockGetUploadOptions.mockReturnValue([EToolResources.context, EToolResources.execute_code]);
  });

  it('routes a pasted file without offering the destination chooser', async () => {
    /* The attach button no longer shows the chooser in unified mode, so raising it here
     * would deliver the same file differently depending on how it was added. */
    mockRouteFiles.mockResolvedValueOnce(true);
    const { result } = renderTextareaHook();
    const pastedFile = new File(['%PDF-'], 'report.pdf', { type: 'application/pdf' });
    const event = createPasteEvent([pastedFile]);

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(mockRouteFiles).toHaveBeenCalledTimes(1));
    expect(mockRouteFiles.mock.calls[0][1]).toBeUndefined();
    expect(mockOpenModal).not.toHaveBeenCalled();
  });

  it('holds a paste rather than offering the chooser before the config lands', async () => {
    /* Neither answer is safe while pending: the chooser sends an explicit destination a
     * unified deployment no longer uses, and skipping it sends none, which a legacy one
     * refuses. */
    mockIsUnifiedMode = false;
    mockIsUploadConfigPending = true;
    const { result } = renderTextareaHook();
    const pastedFile = new File(['%PDF-'], 'report.pdf', { type: 'application/pdf' });
    const event = createPasteEvent([pastedFile]);

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    expect(mockOpenModal).not.toHaveBeenCalled();
    expect(mockRouteFiles).not.toHaveBeenCalled();
  });

  it('still honors a destination the caller already resolved', async () => {
    /* The long-text paste knows the file belongs in the text context, and unified routing
     * does not override a caller that already decided. */
    mockRouteFiles.mockResolvedValueOnce(true);
    const { result } = renderTextareaHook();
    const event = createPasteEvent();

    act(() =>
      result.current.handlePaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>),
    );

    await waitFor(() => expect(mockRouteFiles).toHaveBeenCalledTimes(1));
    expect(mockRouteFiles.mock.calls[0][1]).toBe(EToolResources.context);
    expect(mockOpenModal).not.toHaveBeenCalled();
  });
});
