import { renderHook, act } from '@testing-library/react';

import type { MouseEvent } from 'react';
import type { FilesDraft } from '~/utils';

const mockNewConversation = jest.fn();
const mockClearMessagesCache = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockClearAllDrafts = jest.fn();
const mockClearFilesDraft = jest.fn();
const mockDeleteFiles = jest.fn();
const mockScheduleRetainedRetry = jest.fn();

/** A live composer entry: what the ownership check reads off the file map. */
type LiveFile = {
  file_id: string;
  attached?: boolean;
  progress?: number;
  filepath?: string;
  source?: string;
  embedded?: boolean;
};

/** Values the module-level mocks read, so each test can stage its own scenario. */
const mockState = {
  saveDrafts: false,
  isSubmitting: false,
  tabId: 'this-tab',
  filesDraft: { fileIds: [], pendingPastes: {} } as FilesDraft,
  pendingFilesDraft: { fileIds: [], pendingPastes: {} } as FilesDraft,
  files: new Map<string, LiveFile>(),
  retainedDeletions: [] as { file_id: string; filepath: string; source: string }[],
  markedPasteIds: [] as string[],
  submittedPasteIds: [] as string[],
  liveAttachmentIds: [] as string[],
  /** What other live tabs publish and have drafted; the real collectors read these from shared
   * storage, and a discard must treat them as protection while ignoring its own. */
  foreignLiveAttachmentIds: [] as string[],
  foreignDraftedIds: [] as string[],
  retainedPassInFlight: false,
  persistedPendingDiscardIds: [] as string[],
  retainedListener: null as (() => void) | null,
  pendingDiscardListener: null as (() => void) | null,
  fileList: undefined as
    | {
        file_id: string;
        filepath: string;
        source: string;
        embedded?: boolean;
        temp_file_id?: string;
      }[]
    | undefined,
};

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: (key: unknown) => {
    if (typeof key === 'string' && key.startsWith('conversationIdByIndex')) {
      return 'convo-1';
    }
    if (typeof key === 'string' && key.startsWith('files-by-index')) {
      return mockState.files;
    }
    if (typeof key === 'string' && key.startsWith('isSubmitting')) {
      return mockState.isSubmitting;
    }
    return mockState.saveDrafts;
  },
}));

jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: mockNewConversation }),
}));

jest.mock('~/utils', () => ({
  clearMessagesCache: (...args: unknown[]) => mockClearMessagesCache(...args),
  clearAllDrafts: (...args: unknown[]) => mockClearAllDrafts(...args),
  clearFilesDraft: (...args: unknown[]) => mockClearFilesDraft(...args),
  getNewConversationDraftId: (index = 0) => (index === 0 ? 'new' : `new:${index}`),
  getPendingDraftId: (index = 0) => (index === 0 ? 'pending' : `pending:${index}`),
  getComposerDraftId: (index = 0, conversationId?: string | null) => {
    if (conversationId != null && conversationId !== '') {
      return conversationId;
    }
    return index === 0 ? 'new' : `new:${index}`;
  },
  getFilesDraft: (id: string) =>
    id === 'pending' || (typeof id === 'string' && id.startsWith('pending:'))
      ? mockState.pendingFilesDraft
      : mockState.filesDraft,
  isFilesDraftOwnedByThisTab: (draft: { tabId?: string }) =>
    draft.tabId == null || draft.tabId === mockState.tabId,
  loadPendingDiscardIds: () => [...mockState.persistedPendingDiscardIds],
  storePendingDiscardIds: (_index: number, ids: string[]) => {
    mockState.persistedPendingDiscardIds = [...ids];
  },
  subscribePendingDiscardIds: (listener: () => void) => {
    mockState.pendingDiscardListener = listener;
    return () => {
      mockState.pendingDiscardListener = null;
    };
  },
  subscribeRetainedFileDeletions: (listener: () => void) => {
    mockState.retainedListener = listener;
    return () => {
      mockState.retainedListener = null;
      mockState.pendingDiscardListener = null;
    };
  },
  takeRetainedFileDeletions: () => mockState.retainedDeletions,
  clearRetainedFileDeletion: (fileId: string) => {
    mockState.retainedDeletions = mockState.retainedDeletions.filter(
      (record) => record.file_id !== fileId,
    );
  },
  failedFileIdsFrom: (result: { failedFileIds?: string[] } | void) =>
    result != null && Array.isArray(result.failedFileIds) ? result.failedFileIds : [],
  scheduleRetainedFileDeletionRetry: () => mockScheduleRetainedRetry(),
  isPastedTextFileMarked: (fileId: string) => mockState.markedPasteIds.includes(fileId),
  isPasteSubmitted: (fileId: string) => mockState.submittedPasteIds.includes(fileId),
  collectLiveAttachmentIds: ({ excludeOwnPane }: { excludeOwnPane?: number | 'tab' } = {}) =>
    new Set<string>(
      excludeOwnPane === undefined
        ? [...mockState.liveAttachmentIds, ...mockState.foreignLiveAttachmentIds]
        : mockState.foreignLiveAttachmentIds,
    ),
  /** The union every deletion path consults: other tabs' drafts and other tabs' live presence,
   * with the caller's own discarded draft keys left out. */
  collectForeignAttachmentClaims: (excludeDraftIds: string[] = []) => {
    const ids = new Set<string>(mockState.foreignDraftedIds);
    const excluded = new Set(excludeDraftIds);
    const own: [string, FilesDraft][] = [
      ['new', mockState.filesDraft],
      ['pending', mockState.pendingFilesDraft],
    ];
    for (const [draftId, draft] of own) {
      if (excluded.has(draftId)) {
        continue;
      }
      for (const fileId of draft.fileIds) {
        ids.add(fileId);
      }
      for (const pasteId of draft.pastedTextIds ?? []) {
        ids.add(pasteId);
      }
      for (const pendingId of Object.keys(draft.pendingPastes)) {
        ids.add(pendingId);
      }
    }
    for (const id of mockState.foreignLiveAttachmentIds) {
      ids.add(id);
    }
    return ids;
  },
  removeTabAttachmentPresence: (ids: string[]) => {
    const idSet = new Set(ids);
    mockState.liveAttachmentIds = mockState.liveAttachmentIds.filter((id) => !idSet.has(id));
  },
  beginRetainedDeletionPass: () => {
    if (mockState.retainedPassInFlight) {
      return false;
    }
    mockState.retainedPassInFlight = true;
    return true;
  },
  endRetainedDeletionPass: () => {
    mockState.retainedPassInFlight = false;
  },
  /** Stands in for the localStorage sweep: the ids every draft is holding, minus the keys the
   * caller is discarding. Other tabs' drafts are never excludable, which is the point. */
  collectDraftedAttachmentIds: (excludeIds: string[] = []) => {
    const ids = new Set<string>(mockState.foreignDraftedIds);
    const excluded = new Set(excludeIds);
    const own: [string, FilesDraft][] = [
      ['new', mockState.filesDraft],
      ['pending', mockState.pendingFilesDraft],
    ];
    for (const [draftId, draft] of own) {
      if (excluded.has(draftId)) {
        continue;
      }
      for (const fileId of draft.fileIds) {
        ids.add(fileId);
      }
      for (const pasteId of draft.pastedTextIds ?? []) {
        ids.add(pasteId);
      }
      for (const pendingId of Object.keys(draft.pendingPastes)) {
        ids.add(pendingId);
      }
    }
    return ids;
  },
}));

jest.mock('~/data-provider', () => ({
  useGetFiles: () => ({ data: mockState.fileList }),
  useDeleteFilesMutation: () => ({ mutateAsync: mockDeleteFiles }),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    conversationIdByIndex: (index: number) => `conversationIdByIndex-${index}`,
    filesByIndex: (index: number) => `files-by-index-${index}`,
    isSubmittingFamily: (index: number) => `isSubmitting-${index}`,
    saveDrafts: 'saveDrafts',
  },
}));

jest.mock('librechat-data-provider', () => ({
  QueryKeys: { messages: 'messages' },
}));

import useNewChat from '../useNewChat';

const clickEvent = (overrides: Partial<MouseEvent<HTMLElement>> = {}) =>
  ({
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: jest.fn(),
    ...overrides,
  }) as unknown as MouseEvent<HTMLElement>;

describe('useNewChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteFiles.mockResolvedValue(undefined);
    mockState.saveDrafts = false;
    mockState.isSubmitting = false;
    mockState.tabId = 'this-tab';
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.pendingFilesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map();
    mockState.fileList = undefined;
    mockState.retainedDeletions = [];
    mockState.persistedPendingDiscardIds = [];
    mockState.retainedListener = null;
    mockState.pendingDiscardListener = null;
    mockState.markedPasteIds = [];
    mockState.submittedPasteIds = [];
    mockState.liveAttachmentIds = [];
    mockState.foreignLiveAttachmentIds = [];
    mockState.foreignDraftedIds = [];
    mockState.retainedPassInFlight = false;
    mockScheduleRetainedRetry.mockClear();
  });

  it('clears the outgoing conversation before resetting', () => {
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockClearMessagesCache).toHaveBeenCalledWith(expect.anything(), 'convo-1');
    expect(mockInvalidateQueries).toHaveBeenCalledWith(['messages']);
    expect(mockNewConversation).toHaveBeenCalledTimes(1);
  });

  it('drops the unsaved-chat attachments before the reset restores from them', () => {
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockClearFilesDraft).toHaveBeenCalledWith('new');
    expect(mockClearFilesDraft.mock.invocationCallOrder[0]).toBeLessThan(
      mockNewConversation.mock.invocationCallOrder[0],
    );
  });

  /** The reset is also how a user gets back to an unsaved chat they typed in and left, and the
   * restore that puts an unwanted paste back is the same one that puts the message back. */
  it('keeps what was typed in the unsaved chat', () => {
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockClearAllDrafts).not.toHaveBeenCalledWith('new');
  });

  it('drops only its own pane unsaved-chat attachments', () => {
    const { result } = renderHook(() => useNewChat({ index: 1 }));

    act(() => result.current.startNewChat());

    expect(mockClearFilesDraft).toHaveBeenCalledWith('new:1');
    expect(mockClearFilesDraft).not.toHaveBeenCalledWith('new');
  });

  it('deletes the draft uploads a draft-saving user is discarding with the draft', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['stored-file'],
      pendingPastes: { 'in-flight-paste': { text: 'x', selectionStart: 0 } },
    };
    mockState.files = new Map([
      ['stored-file', { file_id: 'stored-file', progress: 1 }],
      ['in-flight-paste', { file_id: 'in-flight-paste', progress: 0.4 }],
    ]);
    mockState.fileList = [
      { file_id: 'stored-file', filepath: '/uploads/stored.txt', source: 'local' },
      { file_id: 'in-flight-paste', filepath: '/uploads/pending.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'stored-file',
          embedded: false,
          filepath: '/uploads/stored.txt',
          source: 'local',
        },
        {
          file_id: 'in-flight-paste',
          embedded: false,
          filepath: '/uploads/pending.txt',
          source: 'local',
        },
      ],
    });
    expect(mockDeleteFiles.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearFilesDraft.mock.invocationCallOrder[0],
    );
  });

  it('leaves deletion to the reset path when draft saving is off', () => {
    mockState.saveDrafts = false;
    mockState.filesDraft = {
      fileIds: ['stored-file'],
      pendingPastes: {},
    };
    mockState.fileList = [
      { file_id: 'stored-file', filepath: '/uploads/stored.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it('discards a live generated paste the draft could not record', () => {
    /** Persisting the draft can fail outright (private mode, quota) while the upload and its
     * chip still succeed, leaving the draft empty and the upload with nothing to clean it up. */
    mockState.saveDrafts = true;
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.markedPasteIds = ['unrecorded-paste'];
    mockState.files = new Map([
      [
        'unrecorded-paste',
        {
          file_id: 'unrecorded-paste',
          progress: 1,
          filepath: '/uploads/unrecorded.txt',
          source: 'local',
        },
      ],
    ]);
    mockState.fileList = [];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [expect.objectContaining({ file_id: 'unrecorded-paste' })],
    });
  });

  it('spares a paste a message already took, even after the run ends', () => {
    /** Submitting empties the file map but leaves the draft's provenance behind, and Stop and
     * error paths clear the submitting flag without clearing the draft. */
    mockState.saveDrafts = true;
    mockState.submittedPasteIds = ['sent-paste'];
    mockState.filesDraft = { fileIds: [], pendingPastes: {}, pastedTextIds: ['sent-paste'] };
    mockState.files = new Map();
    mockState.fileList = [
      { file_id: 'sent-paste', filepath: '/uploads/sent.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it('discards a completed paste marked under its temporary upload id', () => {
    /** The registry holds the client id; the finished entry carries the server one and keeps the
     * original as temp_file_id. */
    mockState.saveDrafts = true;
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.markedPasteIds = ['client-upload-id'];
    mockState.files = new Map([
      [
        'client-upload-id',
        {
          file_id: 'server-file-id',
          temp_file_id: 'client-upload-id',
          progress: 1,
          filepath: '/uploads/paste.txt',
          source: 'local',
        },
      ],
    ]);
    mockState.fileList = [];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [expect.objectContaining({ file_id: 'server-file-id' })],
    });
  });

  it('defers an in-flight paste upload even with draft saving off', () => {
    /** It has no filepath yet, so nothing can build a payload for it now; the id has to outlive
     * the reset or the record it becomes is orphaned. */
    mockState.saveDrafts = false;
    mockState.markedPasteIds = ['in-flight-paste'];
    mockState.files = new Map([['in-flight-paste', { file_id: 'in-flight-paste', progress: 0.3 }]]);
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockState.persistedPendingDiscardIds).toContain('in-flight-paste');
  });

  it('spares a marked paste that came back re-attached from the library', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.markedPasteIds = ['sent-paste'];
    mockState.files = new Map([
      [
        'sent-paste',
        {
          file_id: 'sent-paste',
          progress: 1,
          attached: true,
          filepath: '/uploads/sent.txt',
          source: 'local',
        },
      ],
    ]);
    mockState.fileList = [];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it('deletes embedded owned uploads with the discarded draft', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['known', 'embedded', 'missing'],
      pendingPastes: {},
    };
    mockState.files = new Map([
      ['known', { file_id: 'known', progress: 1 }],
      ['embedded', { file_id: 'embedded', progress: 1 }],
    ]);
    mockState.fileList = [
      { file_id: 'known', filepath: '/uploads/known.txt', source: 'local' },
      { file_id: 'embedded', filepath: '/uploads/embedded.txt', source: 'local', embedded: true },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        { file_id: 'known', embedded: false, filepath: '/uploads/known.txt', source: 'local' },
        {
          file_id: 'embedded',
          embedded: true,
          filepath: '/uploads/embedded.txt',
          source: 'local',
        },
      ],
    });
  });

  it('spares a draft another browser tab still owns', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['other-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    };
    mockState.fileList = [
      { file_id: 'other-tab-file', filepath: '/uploads/other.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
    expect(mockClearFilesDraft).not.toHaveBeenCalledWith('new');
    expect(mockClearAllDrafts).toHaveBeenCalledWith('pending');
  });

  it('deletes a draft carrying this tab stamp', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['own-file'],
      pendingPastes: {},
      tabId: 'this-tab',
    };
    mockState.files = new Map([['own-file', { file_id: 'own-file', progress: 1 }]]);
    mockState.fileList = [{ file_id: 'own-file', filepath: '/uploads/own.txt', source: 'local' }];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        { file_id: 'own-file', embedded: false, filepath: '/uploads/own.txt', source: 'local' },
      ],
    });
  });

  it('spares a discarded paste another live tab is holding', () => {
    /** The retry effect consults other tabs before deleting; this direct path has to as well, or
     * New Chat here deletes the server file out from under the other tab's chip. */
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['shared-file'],
      pendingPastes: {},
      tabId: 'this-tab',
    };
    mockState.files = new Map([['shared-file', { file_id: 'shared-file', progress: 1 }]]);
    mockState.fileList = [
      { file_id: 'shared-file', filepath: '/uploads/shared.txt', source: 'local' },
    ];
    mockState.foreignLiveAttachmentIds = ['shared-file'];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it('spares a discarded paste another tab has drafted elsewhere', () => {
    /** That tab reattached the file to a conversation this pane has never opened, so only its
     * persisted draft records it. This tab's own discarded keys are excluded from that lookup,
     * or every discard would protect itself and nothing would ever be cleaned up. */
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['shared-file'],
      pendingPastes: {},
      tabId: 'this-tab',
    };
    mockState.files = new Map([['shared-file', { file_id: 'shared-file', progress: 1 }]]);
    mockState.fileList = [
      { file_id: 'shared-file', filepath: '/uploads/shared.txt', source: 'local' },
    ];
    mockState.foreignDraftedIds = ['shared-file'];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it('spares library files the draft recorded through a re-attach', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['library-file', 'own-file'],
      pendingPastes: {},
    };
    /** `attached: true` is how a re-attached stored file enters the composer: it has other
     * references, so discarding this draft must not delete it. */
    mockState.files = new Map([
      ['library-file', { file_id: 'library-file', attached: true, progress: 1 }],
      ['own-file', { file_id: 'own-file', progress: 1 }],
    ]);
    mockState.fileList = [
      { file_id: 'library-file', filepath: '/uploads/library.txt', source: 'local' },
      { file_id: 'own-file', filepath: '/uploads/own.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        { file_id: 'own-file', embedded: false, filepath: '/uploads/own.txt', source: 'local' },
      ],
    });
  });

  it('deletes a draft-owned paste before the composer map is rebuilt after a reload', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['late-paste'],
      pendingPastes: {},
      pastedTextIds: ['late-paste'],
    };
    /** The reload just happened: the files query has not restored any chips into the map yet. */
    mockState.fileList = [
      { file_id: 'late-paste', filepath: '/uploads/late.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        { file_id: 'late-paste', embedded: false, filepath: '/uploads/late.txt', source: 'local' },
      ],
    });
  });

  it('defers a draft-owned paste whose record has not arrived after a reload', async () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['late-paste'],
      pendingPastes: {},
      pastedTextIds: ['late-paste'],
    };
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();

    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.fileList = [
      { file_id: 'late-paste', filepath: '/uploads/late.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        { file_id: 'late-paste', embedded: false, filepath: '/uploads/late.txt', source: 'local' },
      ],
    });
  });

  it('drains a deletion another flow retained after a failed request', async () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['stored-file'],
      pendingPastes: {},
    };
    mockState.files = new Map([['stored-file', { file_id: 'stored-file', progress: 1 }]]);
    mockState.retainedDeletions = [
      { file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' },
    ];
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    /** The retained payload rides along the retry effect's next files-cache tick. */
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map();
    mockState.fileList = [
      { file_id: 'stored-file', filepath: '/uploads/stored.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'stored-file',
          embedded: false,
          filepath: '/uploads/stored.txt',
          source: 'local',
        },
        { file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' },
      ],
    });
    expect(mockState.retainedDeletions).toHaveLength(0);
  });

  it('keeps retained deletions when the retried request fails again', async () => {
    mockDeleteFiles.mockRejectedValueOnce(new Error('offline'));
    mockState.retainedDeletions = [
      { file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' },
    ];
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    mockState.fileList = [];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledTimes(1);
    expect(mockState.retainedDeletions).toHaveLength(1);
    /** A second failure moves nothing this effect watches, so the payload only gets another
     * attempt if one is scheduled. */
    expect(mockScheduleRetainedRetry).toHaveBeenCalled();
  });

  it('retries a deferred deletion whose request failed', async () => {
    mockDeleteFiles.mockRejectedValueOnce(new Error('offline'));
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['in-flight'],
      pendingPastes: {},
    };
    mockState.files = new Map([['in-flight', { file_id: 'in-flight', progress: 0.4 }]]);
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map();
    mockState.fileList = [
      { file_id: 'in-flight', filepath: '/uploads/in-flight.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });
    expect(mockDeleteFiles).toHaveBeenCalledTimes(1);

    /** The failed delete kept the id; the next cache update retries it. */
    mockState.fileList = [
      { file_id: 'in-flight', filepath: '/uploads/in-flight.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledTimes(2);
  });

  it('retains an immediate deletion whose request failed for a retry', async () => {
    mockDeleteFiles.mockRejectedValueOnce(new Error('offline'));
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['stored-file'],
      pendingPastes: {},
    };
    mockState.files = new Map([['stored-file', { file_id: 'stored-file', progress: 1 }]]);
    mockState.fileList = [
      { file_id: 'stored-file', filepath: '/uploads/stored.txt', source: 'local' },
    ];
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());
    expect(mockDeleteFiles).toHaveBeenCalledTimes(1);

    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map();
    mockState.fileList = [
      { file_id: 'stored-file', filepath: '/uploads/stored.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledTimes(2);
    expect(mockDeleteFiles).toHaveBeenLastCalledWith({
      files: [
        {
          file_id: 'stored-file',
          embedded: false,
          filepath: '/uploads/stored.txt',
          source: 'local',
        },
      ],
    });
  });

  it('spares draft ids the composer no longer shows, whose ownership is unknowable', () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['absent-file'],
      pendingPastes: {},
    };
    mockState.fileList = [
      { file_id: 'absent-file', filepath: '/uploads/absent.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it('deletes an in-flight upload once its record arrives in the files cache', async () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['in-flight'],
      pendingPastes: {},
    };
    mockState.files = new Map([['in-flight', { file_id: 'in-flight', progress: 0.4 }]]);
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();

    /** What the reset itself does: the draft key is dropped and the composer map cleared. */
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map();
    mockState.fileList = [
      { file_id: 'in-flight', filepath: '/uploads/in-flight.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'in-flight',
          embedded: false,
          filepath: '/uploads/in-flight.txt',
          source: 'local',
        },
      ],
    });
  });

  it('deletes a deferred upload by its temporary request id once the record arrives', async () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['request-uuid'],
      pendingPastes: {},
    };
    mockState.files = new Map([['request-uuid', { file_id: 'request-uuid', progress: 0.4 }]]);
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();

    /** The cache keys the record by the server-assigned id and keeps the request uuid as
     * its temp id; the discard was tracked under the request uuid. */
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map();
    mockState.fileList = [
      {
        file_id: 'server-id',
        temp_file_id: 'request-uuid',
        filepath: '/uploads/uploaded.txt',
        source: 'local',
      },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'server-id',
          embedded: false,
          filepath: '/uploads/uploaded.txt',
          source: 'local',
        },
      ],
    });
  });

  it('keeps earlier deferred deletions when a second reset defers more', async () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = { fileIds: ['upload-a'], pendingPastes: {} };
    mockState.files = new Map([['upload-a', { file_id: 'upload-a', progress: 0.4 }]]);
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    /** A second new chat before the first upload completed, with a fresh upload of its own.
     * The rerender stands in for the re-render the map change causes in a live composer. */
    mockState.filesDraft = { fileIds: ['upload-b'], pendingPastes: {} };
    mockState.files = new Map([['upload-b', { file_id: 'upload-b', progress: 0.4 }]]);
    act(() => rerender());
    act(() => result.current.startNewChat());

    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map();
    mockState.fileList = [
      { file_id: 'upload-a', filepath: '/uploads/a.txt', source: 'local' },
      { file_id: 'upload-b', filepath: '/uploads/b.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        { file_id: 'upload-a', embedded: false, filepath: '/uploads/a.txt', source: 'local' },
        { file_id: 'upload-b', embedded: false, filepath: '/uploads/b.txt', source: 'local' },
      ],
    });
  });

  it('clears the pending draft a running response parked this pane under', () => {
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockClearAllDrafts).toHaveBeenCalledWith('pending');
    expect(mockClearFilesDraft).toHaveBeenCalledWith('new');
  });

  it('deletes pending-draft uploads before clearing them', () => {
    mockState.saveDrafts = true;
    mockState.pendingFilesDraft = {
      fileIds: ['queued-file'],
      pendingPastes: {},
    };
    mockState.files = new Map([['queued-file', { file_id: 'queued-file', progress: 1 }]]);
    mockState.fileList = [
      { file_id: 'queued-file', filepath: '/uploads/queued.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'queued-file',
          embedded: false,
          filepath: '/uploads/queued.txt',
          source: 'local',
        },
      ],
    });
    expect(mockDeleteFiles.mock.invocationCallOrder[0]).toBeLessThan(
      mockClearAllDrafts.mock.invocationCallOrder[0],
    );
    expect(mockClearAllDrafts).toHaveBeenCalledWith('pending');
  });

  it('spares a pending draft another browser tab still owns', () => {
    mockState.saveDrafts = true;
    mockState.pendingFilesDraft = {
      fileIds: ['other-pending-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    };
    mockState.fileList = [
      { file_id: 'other-pending-file', filepath: '/uploads/other-pending.txt', source: 'local' },
    ];
    const { result } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    expect(mockDeleteFiles).not.toHaveBeenCalled();
    expect(mockClearAllDrafts).not.toHaveBeenCalledWith('pending');
    expect(mockClearFilesDraft).toHaveBeenCalledWith('new');
  });

  it('spares a reattached file from a retained deletion retry', async () => {
    mockState.retainedDeletions = [
      { file_id: 'reattached-file', filepath: '/uploads/reattached.txt', source: 'local' },
    ];
    mockState.files = new Map([['reattached-file', { file_id: 'reattached-file', progress: 1 }]]);
    mockState.fileList = [
      { file_id: 'reattached-file', filepath: '/uploads/reattached.txt', source: 'local' },
    ];
    const { result, rerender } = renderHook(() => useNewChat());

    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).not.toHaveBeenCalled();
    expect(mockState.retainedDeletions).toHaveLength(0);
    expect(result.current).toBeDefined();
  });

  it('spares a submitted file from a retained deletion retry', async () => {
    /** The tab that sent the message can be suspended, or have sent it longer ago than presence
     * remembers, so neither its draft nor its published chips are here to speak for the file. The
     * submitted ledger is durable and shared, and it is the only thing left that can. */
    mockState.retainedDeletions = [
      { file_id: 'sent-file', filepath: '/uploads/sent.txt', source: 'local' },
    ];
    mockState.submittedPasteIds = ['sent-file'];
    mockState.fileList = [{ file_id: 'sent-file', filepath: '/uploads/sent.txt', source: 'local' }];
    const { result, rerender } = renderHook(() => useNewChat());

    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).not.toHaveBeenCalled();
    expect(result.current).toBeDefined();
  });

  it('spares a discard whose server record a submission consumed under another id', async () => {
    /** The discard is keyed by the temporary upload id while the pane that sent it marked only the
     * server id, so the record has to be resolved before the ledger is consulted. */
    mockState.persistedPendingDiscardIds = ['client-temp-id'];
    mockState.submittedPasteIds = ['server-file-id'];
    mockState.fileList = [
      {
        file_id: 'server-file-id',
        temp_file_id: 'client-temp-id',
        filepath: '/uploads/sent.txt',
        source: 'local',
      },
    ];
    const { result, rerender } = renderHook(() => useNewChat());

    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).not.toHaveBeenCalled();
    expect(result.current).toBeDefined();
  });

  it('keeps retained deletions when the API reports a partial failure', async () => {
    mockDeleteFiles.mockResolvedValueOnce({
      message: 'Some files could not be deleted',
      deletedFileIds: [],
      failedFileIds: ['retained-file'],
    });
    mockState.retainedDeletions = [
      { file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' },
    ];
    mockState.fileList = [
      { file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' },
    ];
    const { rerender } = renderHook(() => useNewChat());

    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).toHaveBeenCalledTimes(1);
    expect(mockState.retainedDeletions).toHaveLength(1);
  });

  it('retries a retained deletion when the retain store notifies', async () => {
    mockState.fileList = [
      { file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' },
    ];
    renderHook(() => useNewChat());

    mockState.retainedDeletions = [
      { file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' },
    ];
    await act(async () => {
      mockState.retainedListener?.();
    });

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [{ file_id: 'retained-file', filepath: '/uploads/retained.txt', source: 'local' }],
    });
  });

  it('resumes deferred discards persisted from a previous mount', async () => {
    mockState.persistedPendingDiscardIds = ['late-paste'];
    mockState.fileList = [
      { file_id: 'late-paste', filepath: '/uploads/late.txt', source: 'local' },
    ];
    renderHook(() => useNewChat());

    await act(async () => undefined);

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'late-paste',
          embedded: false,
          filepath: '/uploads/late.txt',
          source: 'local',
        },
      ],
    });
  });

  it('spares a deferred upload that came back attached to the fresh composer', async () => {
    mockState.saveDrafts = true;
    mockState.filesDraft = {
      fileIds: ['in-flight'],
      pendingPastes: {},
    };
    mockState.files = new Map([['in-flight', { file_id: 'in-flight', progress: 0.4 }]]);
    const { result, rerender } = renderHook(() => useNewChat());

    act(() => result.current.startNewChat());

    /** The user immediately re-attached the same file (dedupe lands on the same id). */
    mockState.filesDraft = { fileIds: [], pendingPastes: {} };
    mockState.files = new Map([['in-flight', { file_id: 'in-flight', progress: 1 }]]);
    mockState.fileList = [
      { file_id: 'in-flight', filepath: '/uploads/in-flight.txt', source: 'local' },
    ];
    await act(async () => {
      rerender();
    });

    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });

  it('runs the optional callback after the reset', () => {
    const onNewChat = jest.fn();
    const { result } = renderHook(() => useNewChat({ onNewChat }));

    act(() => result.current.startNewChat());

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(mockNewConversation.mock.invocationCallOrder[0]).toBeLessThan(
      onNewChat.mock.invocationCallOrder[0],
    );
  });

  it('works without a callback', () => {
    const { result } = renderHook(() => useNewChat());

    expect(() => act(() => result.current.startNewChat())).not.toThrow();
    expect(mockNewConversation).toHaveBeenCalledTimes(1);
  });

  it('takes over a plain left click', () => {
    const { result } = renderHook(() => useNewChat());
    const event = clickEvent();

    act(() => result.current.handleNewChatClick(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockNewConversation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['middle', { button: 1 }],
  ])('lets a %s click fall through to the browser', (_label, overrides) => {
    const { result } = renderHook(() => useNewChat());
    const event = clickEvent(overrides);

    act(() => result.current.handleNewChatClick(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockNewConversation).not.toHaveBeenCalled();
  });
});
