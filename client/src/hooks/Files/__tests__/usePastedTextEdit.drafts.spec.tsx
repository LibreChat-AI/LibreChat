/** This jsdom build lacks `Blob.prototype.text`, which browsers have had for years; the paste
 * editor reads chip text through it, so give the test environment the same primitive. */
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function (): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this);
    });
  };
}

const mockShowToast = jest.fn();
const mockSetValue = jest.fn();
const mockRouteFiles = jest.fn();
const mockDeleteFiles = jest.fn();

/** What the mocked boundaries read: the conversation, the setting, and the server's file list. */
const mockState = {
  conversation: { conversationId: 'conversation-a', endpoint: 'openAI' },
  saveDrafts: true,
  fileList: [] as Array<Record<string, unknown>>,
};

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: () => jest.fn(),
}));

jest.mock('~/store', () => ({ ephemeralAgentByConvoId: (id: string) => id }));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/Providers/ChatSettingsContext', () => ({
  useChatSettings: () => ({ saveDrafts: mockState.saveDrafts }),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockState.conversation, isSubmitting: false }),
  useChatFormContext: () => ({ getValues: () => '', setValue: mockSetValue }),
}));

jest.mock('~/data-provider', () => ({
  useGetFiles: () => ({ data: mockState.fileList }),
  useDeleteFilesMutation: () => ({ mutateAsync: mockDeleteFiles }),
}));

/** The upload queue is the network boundary: the spec drives its callbacks by hand. */
jest.mock('../useFileUploadRouter', () => ({
  __esModule: true,
  default: () => mockRouteFiles,
}));

jest.mock('../useFileHandling', () => ({
  retainPasteUpload: jest.fn(),
  clearUploadRecovery: jest.fn(),
  hasInFlightUpload: jest.fn(() => false),
}));

import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { LocalStorageKeys } from 'librechat-data-provider';
import { partitionComposerFiles } from '@librechat/chat';
import type { UploadLifecycleCallbacks } from '../useFileHandling';
import type { ExtendedFile } from '~/common';
import { getFilesDraft, getPendingDraftId, setFilesDraft } from '~/utils';
import { useAutoSave } from '~/hooks/Input/useAutoSave';
import { markPastedTextFile } from '~/utils/files';
import usePastedTextEdit from '../usePastedTextEdit';
import { clearUploadRecovery } from '../useFileHandling';

const DRAFT_ID = 'conversation-a';
const ORIGINAL_ID = 'original-upload';
const ORIGINAL_SERVER_ID = 'original-server-id';

const originalChip = (overrides: Partial<ExtendedFile> = {}): ExtendedFile => ({
  file_id: ORIGINAL_SERVER_ID,
  temp_file_id: ORIGINAL_ID,
  filename: 'pasted-text.txt',
  type: 'text/plain',
  progress: 1,
  size: 4000,
  file: new File(['the original paste'], 'pasted-text.txt', { type: 'text/plain' }),
  ...overrides,
});

/** What the server's file list holds for the original once its upload has been stored. */
const originalRecord = {
  file_id: ORIGINAL_SERVER_ID,
  temp_file_id: ORIGINAL_ID,
  filename: 'pasted-text.txt',
  type: 'text/plain',
  bytes: 4000,
  text: 'the original paste',
  filepath: '/uploads/user-1/pasted-text.txt',
  source: 'local',
};

/** Marks another tab as still open, so a draft it stamped is a live claim and not residue. */
const markTabLive = (tabId: string): void =>
  localStorage.setItem(`librechat-live-tab:${tabId}`, JSON.stringify({ seenAt: Date.now() }));

const draftKey = (id: string): string => `${LocalStorageKeys.FILES_DRAFT}${id}`;

/** The composer as ChatForm wires it: autosave and the paste editor share one file map, so the
 * real restore and save effects react to what the editor does. */
const renderComposer = (initialFiles: Map<string, ExtendedFile> = new Map()) =>
  renderHook(() => {
    const [files, setFiles] = React.useState<Map<string, ExtendedFile>>(initialFiles);
    const textAreaRef = React.useRef<HTMLTextAreaElement>(document.createElement('textarea'));
    useAutoSave({ conversationId: DRAFT_ID, isSubmitting: false, textAreaRef, files, setFiles });
    const edit = usePastedTextEdit({ files, setFiles, textAreaRef });
    return { files, setFiles, edit };
  });

type Composer = ReturnType<typeof renderComposer>;

const attachedFilenames = (composer: Composer): string[] =>
  Array.from(composer.result.current.files.values()).map((file) => file.filename ?? '');

/** Saves an edit, then lands the replacement upload the way the app does: the file cache is
 * written first and the success callback runs in the same turn. */
const saveAndFinishUpload = async (composer: Composer, original: ExtendedFile) => {
  await act(async () => {
    await composer.result.current.edit.openEditor(original);
  });
  await act(async () => {
    await composer.result.current.edit.saveEdit('corrected');
  });
  const lifecycle = mockRouteFiles.mock.calls[0][2] as UploadLifecycleCallbacks;
  const replacementId = lifecycle.fileId ?? '';
  act(() => {
    composer.result.current.setFiles((current) =>
      new Map(current).set(replacementId, {
        file_id: replacementId,
        filename: 'pasted-text-2.txt',
        type: 'text/plain',
        progress: 0.2,
        size: 4010,
        file: new File(['corrected'], 'pasted-text-2.txt', { type: 'text/plain' }),
      }),
    );
  });
  await act(async () => {
    mockState.fileList = [
      {
        file_id: 'replacement-server-id',
        temp_file_id: replacementId,
        filename: 'pasted-text-2.txt',
        type: 'text/plain',
        bytes: 4010,
        filepath: '/uploads/user-1/pasted-text-2.txt',
        source: 'local',
      },
      ...mockState.fileList,
    ];
    lifecycle.onSuccess?.(replacementId);
  });
  return replacementId;
};

describe('usePastedTextEdit with the real composer drafts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockDeleteFiles.mockResolvedValue(undefined);
    mockState.conversation = { conversationId: DRAFT_ID, endpoint: 'openAI' };
    mockState.saveDrafts = true;
    mockState.fileList = [originalRecord];
    mockRouteFiles.mockResolvedValue(true);
    markPastedTextFile(ORIGINAL_ID);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not bring the replaced original back when the replacement writes the file cache', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));

    await saveAndFinishUpload(composer, originalChip());

    /** The restore the cache write schedules runs before autosave rewrites the draft, so a draft
     * still naming the original would re-attach it from the server's file list. */
    expect(attachedFilenames(composer)).toEqual(['pasted-text-2.txt']);
    expect(composer.result.current.edit.isActionPending(originalChip())).toBe(false);
  });

  it('moves a pending correction inline without restoring its original from drafts', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));
    await act(async () => composer.result.current.edit.openEditor(originalChip()));
    await act(async () => composer.result.current.edit.saveEdit('corrected inline'));
    const lifecycle = mockRouteFiles.mock.calls[0][2] as UploadLifecycleCallbacks;
    const replacementId = lifecycle.fileId!;
    const correction = originalChip({
      file_id: replacementId,
      temp_file_id: undefined,
      progress: 0.2,
      pastedText: 'corrected inline',
      replacesFileId: ORIGINAL_ID,
    });
    act(() =>
      composer.result.current.setFiles((current) =>
        new Map(current).set(replacementId, correction),
      ),
    );
    jest.mocked(clearUploadRecovery).mockImplementation((id) => {
      if (id !== replacementId) return;
      lifecycle.onAbort?.(id);
      composer.result.current.setFiles((current) => {
        const remaining = new Map(current);
        remaining.delete(id);
        return remaining;
      });
    });
    await act(async () => composer.result.current.edit.moveInline(correction));
    expect(composer.result.current.files.size).toBe(0);
    expect(composer.result.current.edit.editing).toBeNull();
    expect(mockSetValue).toHaveBeenCalledWith('text', 'corrected inline', expect.anything());
    const draft = getFilesDraft(DRAFT_ID);
    expect(draft.fileIds).toEqual([]);
    expect(draft.pastedTextIds ?? []).toEqual([]);
    expect(draft.pendingPastes).toEqual({});
    jest.mocked(clearUploadRecovery).mockReset();
  });

  it('keeps only the latest pending correction when a superseded upload fails', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));
    await act(async () => composer.result.current.edit.openEditor(originalChip()));
    await act(async () => composer.result.current.edit.saveEdit('first correction'));
    const first = mockRouteFiles.mock.calls[0][2] as UploadLifecycleCallbacks;
    const correction = originalChip({
      file_id: first.fileId!,
      temp_file_id: undefined,
      progress: 0.2,
      pastedText: 'first correction',
      replacesFileId: ORIGINAL_ID,
    });
    act(() =>
      composer.result.current.setFiles((current) =>
        new Map(current).set(correction.file_id, correction),
      ),
    );
    await act(async () => composer.result.current.edit.openEditor(correction));
    jest.mocked(clearUploadRecovery).mockImplementation((id) => {
      if (id !== first.fileId) return;
      first.onAbort?.(id);
      composer.result.current.setFiles((current) => {
        const remaining = new Map(current);
        remaining.delete(id);
        return remaining;
      });
    });
    await act(async () => composer.result.current.edit.saveEdit('final correction'));
    const final = mockRouteFiles.mock.calls[1][2] as UploadLifecycleCallbacks;
    expect(final.replacesFileId).toBe(ORIGINAL_SERVER_ID);
    const latest = originalChip({
      file_id: final.fileId!,
      temp_file_id: undefined,
      progress: 0.2,
      pastedText: 'final correction',
      replacesFileId: final.replacesFileId,
    });
    act(() =>
      composer.result.current.setFiles((current) => new Map(current).set(latest.file_id, latest)),
    );
    await act(async () => first.onError?.(first.fileId!));
    expect(composer.result.current.edit.editing).toBeNull();
    const pending = partitionComposerFiles('Review this', composer.result.current.files);
    expect(pending.files).toEqual([]);
    expect(pending.text).toBe('Review this\n\n```text\nfinal correction\n```');
    await act(async () => final.onSuccess?.(final.fileId!));
    expect(composer.result.current.files.has(ORIGINAL_ID)).toBe(false);
    expect(composer.result.current.files.has(first.fileId!)).toBe(false);
    expect(composer.result.current.files.has(final.fileId!)).toBe(true);
    expect(getFilesDraft(DRAFT_ID).fileIds).not.toContain(ORIGINAL_ID);
    jest.mocked(clearUploadRecovery).mockReset();
  });

  it('drops the replaced original from the files draft and keeps the replacement', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));

    const replacementId = await saveAndFinishUpload(composer, originalChip());

    const draft = getFilesDraft(DRAFT_ID);
    expect(draft.fileIds).toEqual([replacementId]);
    expect(draft.pastedTextIds).toContain(replacementId);
    expect(draft.pastedTextIds).not.toContain(ORIGINAL_ID);
    expect(draft.pastedTextIds).not.toContain(ORIGINAL_SERVER_ID);
  });

  it('drops a restored original under both of its ids and still deletes its stored upload', async () => {
    /** A reload leaves only the draft and the server's record: the chip is rebuilt from them,
     * keyed by its temporary id, without a local copy of its text. */
    setFilesDraft(DRAFT_ID, {
      fileIds: [ORIGINAL_ID],
      pendingPastes: {},
      pastedTextIds: [ORIGINAL_ID, ORIGINAL_SERVER_ID],
    });
    const composer = renderComposer();
    const restored = composer.result.current.files.get(ORIGINAL_ID);
    expect(restored?.attached).toBe(true);
    expect(restored?.file).toBeUndefined();

    await saveAndFinishUpload(composer, restored as ExtendedFile);

    expect(attachedFilenames(composer)).toEqual(['pasted-text-2.txt']);
    const draft = getFilesDraft(DRAFT_ID);
    expect(draft.fileIds).not.toContain(ORIGINAL_ID);
    expect(draft.pastedTextIds).not.toContain(ORIGINAL_ID);
    expect(draft.pastedTextIds).not.toContain(ORIGINAL_SERVER_ID);
    /** The draft claim is read before it is pruned, so the stored upload is still this
     * composer's to delete. */
    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [expect.objectContaining({ file_id: ORIGINAL_SERVER_ID })],
    });
  });

  it('drops the original from the pending draft key a finishing run left it on', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));
    /** Seeded once the composer is mounted: a mount migrates a pending record to its conversation. */
    const pendingId = getPendingDraftId(0);
    setFilesDraft(pendingId, {
      fileIds: [ORIGINAL_ID, 'another-upload'],
      pendingPastes: {},
      pastedTextIds: [ORIGINAL_ID],
    });

    await saveAndFinishUpload(composer, originalChip());

    expect(getFilesDraft(pendingId).fileIds).toEqual(['another-upload']);
    expect(getFilesDraft(pendingId).pastedTextIds).toEqual([]);
  });

  it('leaves a draft another live tab owns alone', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));
    /** Another tab claims the record while the edit is open: a record stamped before mount would
     * start this composer empty instead. */
    markTabLive('other-tab');
    setFilesDraft(DRAFT_ID, {
      fileIds: [ORIGINAL_ID],
      pendingPastes: {},
      pastedTextIds: [ORIGINAL_ID],
      tabId: 'other-tab',
    });
    const before = localStorage.getItem(draftKey(DRAFT_ID));
    expect(getFilesDraft(DRAFT_ID).tabId).toBe('other-tab');

    await saveAndFinishUpload(composer, originalChip());

    /** The chip still leaves this composer; the record that tab stamped is not this tab's to
     * edit, and this tab's restore does not read it either. */
    expect(attachedFilenames(composer)).toEqual(['pasted-text-2.txt']);
    expect(localStorage.getItem(draftKey(DRAFT_ID))).toBe(before);
  });

  it('does not rewrite a draft that never named the original', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));
    const pendingId = getPendingDraftId(0);
    setFilesDraft(pendingId, {
      fileIds: ['another-upload'],
      pendingPastes: {},
      pastedTextIds: ['another-upload'],
    });
    const setItem = jest.spyOn(Storage.prototype, 'setItem');

    await saveAndFinishUpload(composer, originalChip());

    /** A rewrite alone can stamp this tab as the record's owner, so an untouched draft stays
     * untouched. */
    const pendingWrites = setItem.mock.calls.filter(([key]) => key === draftKey(pendingId));
    expect(pendingWrites).toHaveLength(0);
    expect(getFilesDraft(pendingId).fileIds).toEqual(['another-upload']);
  });

  it('does not touch drafts when draft saving is off', async () => {
    mockState.saveDrafts = false;
    setFilesDraft(DRAFT_ID, {
      fileIds: [ORIGINAL_ID],
      pendingPastes: {},
      pastedTextIds: [ORIGINAL_ID],
    });
    const before = localStorage.getItem(draftKey(DRAFT_ID));
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));

    await saveAndFinishUpload(composer, originalChip());

    expect(attachedFilenames(composer)).toEqual(['pasted-text-2.txt']);
    expect(localStorage.getItem(draftKey(DRAFT_ID))).toBe(before);
  });

  it('drops a paste moved back inline from the files draft', async () => {
    const composer = renderComposer(new Map([[ORIGINAL_ID, originalChip()]]));
    expect(getFilesDraft(DRAFT_ID).fileIds).toEqual([ORIGINAL_ID]);

    await act(async () => {
      await composer.result.current.edit.moveInline(originalChip());
    });

    expect(attachedFilenames(composer)).toEqual([]);
    const draft = getFilesDraft(DRAFT_ID);
    expect(draft.fileIds).toEqual([]);
    expect(draft.pastedTextIds ?? []).toEqual([]);
  });
});
