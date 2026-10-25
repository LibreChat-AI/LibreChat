import React from 'react';
import { getDefaultStore, useAtom } from 'jotai';
import { filesFamily } from '@librechat/chat/react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, LocalStorageKeys, EModelEndpoint } from 'librechat-data-provider';
import type { EventSubmission, TConversation } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import {
  setFilesDraft,
  getFilesDraft,
  registerComposerDraft,
  getAskAnswerDraftId,
  bindComposerLaunch,
  captureComposerDraft,
  adoptComposerConversation,
} from '~/utils/drafts';
import {
  beginFileSearchUpload,
  captureFileSearchUpload,
  completeFileSearchUpload,
  transferFileSearchPreference,
} from '~/hooks/Files/search';
import { setFileSearchChoice, transferFileSearchChoice } from '~/utils/choices';
import { clearUploadRecovery } from '~/hooks/Files/useFileHandling';
import { useAutoSave } from '~/hooks/Input/useAutoSave';
import useTurnHandlers from '~/hooks/SSE/opening';

const mockDeleteFiles = jest.fn();
const mockUploadFile = jest.fn();
let mockUploadOptions: { onSuccess?: (data: object, body: FormData) => void } = {};
let mockPreparationGate: Promise<void> | undefined;
let mockConfigPending = false;
let mockDownloadedFiles: File[] = [];
const mockResizeFile = jest.fn(async (file: File) => ({ file, resized: false }));
const mockConvertFile = jest.fn(
  async (file: File, _quality?: number, _onProgress?: (progress: number) => void) => file,
);

let mockSaveDrafts = false;
let mockPreviousConversation: { conversationId: string; endpoint: EModelEndpoint } | null = null;
let mockFileList: object[] = [];
const mockSetEphemeralAgent = jest.fn();
const mockRemoveTabAttachmentPresence = jest.fn();
const mockCollectForeignAttachmentClaims = jest.fn(
  (_excludeDraftIds: string[], _excludeOwnPane?: number | 'tab') => new Set(mockForeignClaims),
);
const mockForeignClaims = new Set<string>();
const mockMarkedPasteIds = new Set<string>();
const mockPendingDiscardIds = new Set<string>();
const mockStorePendingDiscardIds = jest.fn((_index: number, ids: string[]) => {
  mockPendingDiscardIds.clear();
  ids.forEach((id) => mockPendingDiscardIds.add(id));
});
const mockFiles = new Map<
  string,
  {
    file_id: string;
    temp_file_id?: string;
    filepath?: string;
    source?: string;
    embedded?: boolean;
    attached?: boolean;
    progress?: number;
  }
>();

jest.mock('react-router-dom', () => ({
  useNavigate: () => jest.fn(),
  useSearchParams: () => [new URLSearchParams()],
}));

jest.mock('~/Providers/ChatSettingsContext', () => ({
  useChatSettings: () => ({ saveDrafts: mockSaveDrafts }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: (key: string) => {
    if (key === 'saveBadgesState') {
      return true;
    }
    return null;
  },
  useSetRecoilState: (key: string) => (update: unknown) => mockSetEphemeralAgent(key, update),
  useRecoilCallback: (callback) =>
    callback.length === 0
      ? jest.fn()
      : callback({ set: (key, update) => mockSetEphemeralAgent(key, update) }),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: {} }),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/drafts'),
  ...jest.requireActual('~/utils/files'),
  ...jest.requireActual('~/utils/previewCache'),
  updateLastSelectedModel: jest.fn(),
  getLocalStorageItems: () => ({}),
  getDefaultModelSpec: () => ({}),
  getDefaultEndpoint: () => undefined,
  getModelSpecPreset: jest.fn(),
  hasModelSelection: () => false,
  isPastedTextFileMarked: (fileId?: string | null) =>
    fileId != null && mockMarkedPasteIds.has(fileId),
  collectForeignAttachmentClaims: (excludeDraftIds: string[], excludeOwnPane?: number | 'tab') =>
    mockCollectForeignAttachmentClaims(excludeDraftIds, excludeOwnPane),
  getNewConversationDraftId: (index = 0) => (index === 0 ? 'new' : `new:${index}`),
  getPendingDraftId: (index = 0) => (index === 0 ? 'pending' : `pending:${index}`),
  renewNewConversationDraftToken: jest.fn(
    jest.requireActual('~/utils/drafts').renewNewConversationDraftToken,
  ),
  removeTabAttachmentPresence: (...args: unknown[]) => mockRemoveTabAttachmentPresence(...args),
  loadPendingDiscardIds: () => [...mockPendingDiscardIds],
  storePendingDiscardIds: (index: number, ids: string[]) => mockStorePendingDiscardIds(index, ids),
  scheduleRetainedFileDeletionRetry: jest.fn(),
  retainFileDeletion: jest.fn(),
  failedFileIdsFrom: () => [],
  logger: { log: jest.fn() },
}));

jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: () => ({ mutateAsync: mockDeleteFiles }),
  useGetEndpointsQuery: () => ({ data: {} }),
  useGetStartupConfig: () => ({ data: {} }),
  useGetFiles: () => ({ data: mockFileList }),
  useGetFileConfig: () => ({ data: null }),
  useGetAgentByIdQuery: () => ({ data: undefined }),
  useUploadFileMutation: (options) => {
    mockUploadOptions = options;
    return { mutate: mockUploadFile };
  },
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/Providers/AgentsMapContext', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('../Files/useDelayedUploadToast', () => ({
  useDelayedUploadToast: () => ({ startUploadTimer: jest.fn(), clearUploadTimer: jest.fn() }),
}));
jest.mock('../Files/useClientResize', () => ({
  __esModule: true,
  default: () => ({
    isConfigPending: mockConfigPending,
    waitForConfig: () => mockPreparationGate,
    resizeImageIfNeeded: mockResizeFile,
  }),
}));
jest.mock('~/utils/heicConverter', () => ({
  processFileForUpload: (...args: [File]) => mockConvertFile(...args),
}));
jest.mock('../Files/useSharePointDownload', () => ({
  __esModule: true,
  default: () => ({
    downloadSharePointFiles: async () => {
      await mockPreparationGate;
      return mockDownloadedFiles;
    },
    isDownloading: false,
    downloadProgress: null,
    error: null,
  }),
}));

jest.mock('../Conversations/useNavigateToConvo', () => ({
  __esModule: true,
  supersedeNavigation: jest.fn(),
}));
jest.mock('../Conversations/useGetConversation', () => ({
  __esModule: true,
  default: () => () => mockPreviousConversation,
}));
jest.mock('../Assistants/useAssistantListMap', () => ({
  __esModule: true,
  default: () => ({}),
}));
jest.mock('../Files/useFileHandling', () => {
  const actual = jest.requireActual('../Files/useFileHandling');
  return { __esModule: true, ...actual, clearUploadRecovery: jest.fn(actual.clearUploadRecovery) };
});
jest.mock('../Agents', () => ({ useApplyModelSpecEffects: () => jest.fn() }));
jest.mock('../Audio', () => ({ usePauseGlobalAudio: () => ({ pauseGlobalAudio: jest.fn() }) }));
jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({}),
  useChatFormContext: () => ({ setValue: jest.fn() }),
}));
jest.mock('~/hooks', () => ({ useHasAccess: () => true }));
jest.mock('~/store', () => ({
  __esModule: true,
  ephemeralAgentByConvoId: (id: string) => id,
  default: {
    defaultPreset: 'defaultPreset',
    saveBadgesState: 'saveBadgesState',
    useClearConvoState: () => jest.fn(),
    useSetConversationAtom: () => ({ setConversation: jest.fn() }),
  },
}));

import useNewConvo, { clearInheritedAgentWorkspace } from '../useNewConvo';

describe('clearInheritedAgentWorkspace', () => {
  const workspaceBinding = [{ environmentId: 'machine-a', workspaceId: 'project-a' }];

  it('clears a workspace inherited by a new chat when the agent changes', () => {
    expect(
      clearInheritedAgentWorkspace(
        {
          conversationId: Constants.NEW_CONVO,
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent-b',
          codeWorkspaces: workspaceBinding,
        } as TConversation,
        { agent_id: 'agent-a' } as TConversation,
      ).codeWorkspaces,
    ).toBeUndefined();
  });

  it('preserves an existing conversation workspace binding', () => {
    expect(
      clearInheritedAgentWorkspace(
        {
          conversationId: 'conversation-1',
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent-b',
          codeWorkspaces: workspaceBinding,
        } as TConversation,
        { agent_id: 'agent-a' } as TConversation,
      ).codeWorkspaces,
    ).toEqual(workspaceBinding);
  });

  it('preserves a new-chat workspace binding when the agent is unchanged', () => {
    expect(
      clearInheritedAgentWorkspace(
        {
          conversationId: Constants.NEW_CONVO,
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent-a',
          codeWorkspaces: workspaceBinding,
        } as TConversation,
        { agent_id: 'agent-a' } as TConversation,
      ).codeWorkspaces,
    ).toEqual(workspaceBinding);
  });
});

describe('useNewConvo reset cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockSaveDrafts = false;
    mockPreviousConversation = null;
    mockFileList = [];
    mockDeleteFiles.mockResolvedValue({});
    mockForeignClaims.clear();
    mockMarkedPasteIds.clear();
    mockPendingDiscardIds.clear();
    mockFiles.clear();
    mockFiles.set('claimed-file', {
      file_id: 'claimed-file',
      temp_file_id: 'client-claimed-file',
      filepath: '/uploads/claimed-file.txt',
      source: 'local',
    });
    mockFiles.set('own-file', {
      file_id: 'own-file',
      temp_file_id: 'client-own-file',
      filepath: '/uploads/own-file.txt',
      source: 'local',
    });
    /** The hook reads the real pane atom, so each pane a test renders starts on this map. */
    for (const index of [0, 2]) {
      getDefaultStore().set(filesFamily(index), mockFiles as Map<string, ExtendedFile>);
    }
  });

  it.each(['before-ack', 'after-ack', 'later-disable'])(
    'keeps the accepted upload preference when completion is %s',
    (order) => {
      const sourceKey = `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}new`;
      const targetKey = `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}assigned-preference`;
      setFileSearchChoice('new', false);
      localStorage.setItem(sourceKey, order === 'before-ack' ? 'true' : 'false');
      transferFileSearchPreference('new', 'assigned-preference');
      if (order === 'after-ack') localStorage.setItem(targetKey, 'true');
      if (order === 'later-disable') setFileSearchChoice('assigned-preference', false);
      expect(transferFileSearchPreference('new', 'assigned-preference')).toBe(
        order !== 'later-disable',
      );
      expect(localStorage.getItem(targetKey)).toBe(JSON.stringify(order !== 'later-disable'));
    },
  );

  it.each(
    ['remove', 'replace'].flatMap((change) =>
      [undefined, 'file_search'].map((resource) => ({ change, resource })),
    ),
  )('accepts a fresh $resource upload after project $change', async ({ change, resource }) => {
    const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
    mockSaveDrafts = false;
    mockFiles.clear();
    mockConfigPending = false;
    mockPreparationGate = undefined;
    window.history.replaceState({}, '', '/c/new?projectId=project-a');
    global.URL.createObjectURL = jest.fn(() => 'blob:project-change');
    global.URL.revokeObjectURL = jest.fn();
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, cacheTime: Infinity },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    const { result, rerender, unmount } = renderHook(
      ({ projectId }: { projectId: string | null }) => {
        const [files, setFiles] = useAtom(filesFamily(2));
        useAutoSave({ index: 2, conversationId: 'new', files, setFiles });
        return {
          files,
          handler: useFileHandlingNoChatContext(undefined, {
            index: 2,
            files,
            setFiles,
            conversation: {
              conversationId: 'new',
              endpoint: EModelEndpoint.openAI,
              chatProjectId: projectId,
            } as TConversation,
          }),
        };
      },
      { wrapper, initialProps: { projectId: 'project-a' as string | null } },
    );
    const previousOwner = captureComposerDraft(2, 'new');
    const previousLaunch = { conversationId: 'new' };
    bindComposerLaunch(previousLaunch, 2);
    act(() => {
      const projectId = change === 'replace' ? 'project-b' : null;
      window.history.replaceState({}, '', projectId ? `/c/new?projectId=${projectId}` : '/c/new');
      rerender({ projectId });
    });
    expect(previousOwner()).toBe(false);
    const currentOwner = captureComposerDraft(2, 'new');
    expect(currentOwner()).toBe(true);
    await act(async () => {
      expect(
        await result.current.handler.handleFiles(
          [new File(['project'], 'project.txt', { type: 'text/plain' })],
          resource,
        ),
      ).toBe(true);
    });
    const body = mockUploadFile.mock.calls[0][0] as FormData;
    expect(body.get('tool_resource')).toBe(resource ?? null);
    await act(async () => {
      mockUploadOptions.onSuccess?.(
        {
          file_id: 'persisted-project-upload',
          temp_file_id: body.get('file_id'),
          filename: 'project.txt',
          filepath: '/files/project.txt',
          type: 'text/plain',
          embedded: resource === 'file_search',
        },
        body,
      );
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(result.current.files.get(body.get('file_id') as string)?.progress).toBe(1);
    expect(mockSetEphemeralAgent.mock.calls.length > 0).toBe(resource === 'file_search');
    expect(adoptComposerConversation(previousLaunch, 'stale-project', 2)).toBe(false);
    const launch = { conversationId: 'new' };
    bindComposerLaunch(launch, 2);
    expect(adoptComposerConversation(launch, 'fresh-project', 2)).toBe(true);
    unmount();
    client.clear();
    window.history.replaceState({}, '', '/');
  });

  it.each(
    [false, true].flatMap((saveDrafts) =>
      [undefined, 'file_search'].map((resource) => ({ saveDrafts, resource })),
    ),
  )(
    'keeps acknowledged $resource completion before props catch up (saveDrafts: $saveDrafts)',
    async ({ saveDrafts, resource }) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = saveDrafts;
      mockFiles.clear();
      mockConfigPending = false;
      mockPreparationGate = undefined;
      window.history.replaceState({}, '', '/c/new');
      global.URL.createObjectURL = jest.fn(() => 'blob:acknowledged-gap');
      global.URL.revokeObjectURL = jest.fn();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const { result, rerender, unmount } = renderHook(
        ({ conversationId, tick }) => {
          const [files, setFiles] = useAtom(filesFamily(2));
          useAutoSave({ index: 2, conversationId, isSubmitting: true, files, setFiles });
          return {
            files,
            tick,
            handler: useFileHandlingNoChatContext(undefined, {
              index: 2,
              files,
              setFiles,
              conversation: { conversationId, endpoint: EModelEndpoint.openAI } as TConversation,
            }),
          };
        },
        { wrapper, initialProps: { conversationId: 'new', tick: 0 } },
      );
      const launch = { conversationId: 'new' };
      bindComposerLaunch(launch, 2);
      const captured = captureComposerDraft(2, 'new');
      await act(async () => {
        await result.current.handler.handleFiles(
          [new File(['search'], 'ack.txt', { type: 'text/plain' })],
          resource,
        );
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      const options = mockUploadOptions;
      expect(adoptComposerConversation(launch, 'acknowledged-chat', 2)).toBe(true);
      act(() => {
        window.history.replaceState({}, '', '/c/acknowledged-chat');
        rerender({ conversationId: 'new', tick: 1 });
      });
      expect(captured()).toBe(true);
      expect(captured.conversationId()).toBe('acknowledged-chat');
      expect(adoptComposerConversation(launch, 'acknowledged-chat', 2)).toBe(true);
      act(() => rerender({ conversationId: 'acknowledged-chat', tick: 2 }));
      mockSetEphemeralAgent.mockClear();
      await act(async () => {
        const persisted = {
          file_id: 'persisted-ack',
          temp_file_id: body.get('file_id'),
          filepath: '/files/ack.txt',
          filename: 'ack.txt',
          type: 'text/plain',
          bytes: 6,
          embedded: resource === 'file_search',
        };
        mockFileList = [persisted];
        options.onSuccess?.(persisted, body);
        rerender({ conversationId: 'acknowledged-chat', tick: 3 });
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      expect(result.current.files.get(body.get('file_id') as string)?.progress).toBe(1);
      if (resource === 'file_search') {
        expect(mockSetEphemeralAgent).toHaveBeenCalledWith(
          'acknowledged-chat',
          expect.any(Function),
        );
        expect(mockSetEphemeralAgent).not.toHaveBeenCalledWith('new', expect.anything());
      } else expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
      unmount();
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each(
    [EModelEndpoint.assistants, EModelEndpoint.azureAssistants].flatMap((endpoint) =>
      [false, true].map((reset) => ({ endpoint, reset })),
    ),
  )(
    'keeps only the bound upload through Assistants sync ($endpoint, reset: $reset)',
    async ({ endpoint, reset }) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = false;
      mockFiles.clear();
      mockConfigPending = false;
      mockPreparationGate = undefined;
      window.history.replaceState({}, '', '/c/new');
      global.URL.createObjectURL = jest.fn(() => 'blob:assistants-sync');
      global.URL.revokeObjectURL = jest.fn();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const { result, rerender, unmount } = renderHook(
        ({ conversationId }) => {
          const [files, setFiles] = useAtom(filesFamily(2));
          useAutoSave({ index: 2, conversationId, isSubmitting: true, files, setFiles });
          const handlers = useTurnHandlers({
            queryClient: client,
            runIndex: 2,
            isAddedRequest: false,
            setMessages: jest.fn(),
            getMessages: () => [],
            setCompleted: jest.fn(),
            setIsSubmitting: jest.fn(),
            setShowStopButton: jest.fn(),
            setSubmissionStart: jest.fn(),
            announcePolite: jest.fn(),
            lastAnnouncementTimeRef: { current: 0 },
            applyAgentTemplate: jest.fn(),
            focusRegeneratedResponse: jest.fn(),
            location: {
              pathname: window.location.pathname,
              search: '',
              hash: '',
              state: null,
              key: 'sync',
            },
            navigate: jest.fn(),
            restorePendingContext: jest.fn(),
            reconcileFailedCodeDecision: jest.fn(),
            recoverConversation: jest.fn(),
            attachmentHandler: jest.fn(),
            preserveSubagentAtomsForNewConvoIdRef: { current: null },
          });
          return {
            files,
            handlers,
            upload: useFileHandlingNoChatContext(undefined, {
              index: 2,
              files,
              setFiles,
              conversation: {
                conversationId,
                endpoint,
                assistant_id: 'assistant-sync',
                model: 'gpt-4o',
              } as TConversation,
            }),
          };
        },
        { wrapper, initialProps: { conversationId: 'new' } },
      );
      const launch = { conversationId: 'new', endpoint };
      bindComposerLaunch(launch, 2);
      const owner = captureComposerDraft(2, 'new');
      await act(async () => {
        await result.current.upload.handleFiles([
          new File(['sync'], 'sync.txt', { type: 'text/plain' }),
        ]);
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      expect(body.get('assistant_id')).toBe('assistant-sync');
      const options = mockUploadOptions;
      const next = renderHook(() => useNewConvo(2), { wrapper });
      if (reset) act(() => next.result.current.newConversation());
      const submission: EventSubmission = {
        isTemporary: false,
        endpointOption: { endpoint },
        conversation: launch,
        messages: [],
        userMessage: {
          messageId: 'sync-user',
          conversationId: 'saved-sync',
          parentMessageId: String(Constants.NO_PARENT),
          title: 'New Chat',
          text: 'Hello',
          isCreatedByUser: true,
          createdAt: '',
          updatedAt: '',
        },
        initialResponse: {
          messageId: 'sync-response',
          conversationId: 'saved-sync',
          parentMessageId: 'sync-user',
          title: 'New Chat',
          text: '',
          isCreatedByUser: false,
          createdAt: '',
          updatedAt: '',
        },
      };
      act(() => {
        result.current.handlers.syncHandler(
          {
            sync: true,
            conversationId: 'saved-sync',
            thread_id: 'thread-sync',
            requestMessage: submission.userMessage,
            responseMessage: submission.initialResponse,
          },
          submission,
        );
        window.history.replaceState({}, '', '/c/saved-sync');
        rerender({ conversationId: 'saved-sync' });
      });
      expect(owner()).toBe(!reset);
      await act(async () => {
        options.onSuccess?.({ file_id: 'persisted-sync', filepath: '/files/sync.txt' }, body);
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      if (reset) expect(result.current.files.size).toBe(0);
      else expect(result.current.files.get(body.get('file_id') as string)?.progress).toBe(1);
      expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
      next.unmount();
      unmount();
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each(
    [false, true].flatMap((saveDrafts) =>
      ['remove', 'replace'].flatMap((change) =>
        [undefined, 'file_search'].map((resource) => ({ saveDrafts, change, resource })),
      ),
    ),
  )(
    'discards only the retired $resource project upload after $change (saveDrafts: $saveDrafts)',
    async ({ saveDrafts, change, resource }) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = saveDrafts;
      mockFiles.clear();
      mockConfigPending = false;
      mockPreparationGate = undefined;
      window.history.replaceState({}, '', '/c/new?projectId=project-a');
      global.URL.createObjectURL = jest.fn(() => 'blob:retired-project');
      global.URL.revokeObjectURL = jest.fn();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const { result, rerender, unmount } = renderHook(
        ({ projectId, tick }) => {
          const [files, setFiles] = useAtom(filesFamily(2));
          useAutoSave({ index: 2, conversationId: 'new', files, setFiles });
          return {
            files,
            tick,
            handler: useFileHandlingNoChatContext(undefined, {
              index: 2,
              files,
              setFiles,
              conversation: {
                conversationId: 'new',
                endpoint: EModelEndpoint.openAI,
                chatProjectId: projectId,
              } as TConversation,
            }),
          };
        },
        { wrapper, initialProps: { projectId: 'project-a' as string | null, tick: 0 } },
      );
      const owner = captureComposerDraft(2, 'new');
      const completed = { file_id: 'kept-completed', progress: 1, size: 1, attached: true };
      act(() => {
        getDefaultStore().set(filesFamily(2), new Map([['kept-completed', completed]]));
      });
      await act(async () => {
        await result.current.handler.handleFiles(
          [new File(['search'], 'retired.txt', { type: 'text/plain' })],
          resource,
        );
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      const options = mockUploadOptions;
      const projectId = change === 'replace' ? 'project-b' : null;
      act(() => {
        window.history.replaceState({}, '', projectId ? `/c/new?projectId=${projectId}` : '/c/new');
        rerender({ projectId, tick: 1 });
      });
      expect(owner()).toBe(false);
      const retiredId = body.get('file_id') as string;
      expect(result.current.files.has(retiredId)).toBe(false);
      expect(result.current.files.get('kept-completed')).toEqual(completed);
      await act(async () => {
        await result.current.handler.handleFiles(
          [new File(['fresh'], 'fresh.txt', { type: 'text/plain' })],
          resource,
        );
      });
      const freshBody = mockUploadFile.mock.calls[1][0] as FormData;
      const freshId = freshBody.get('file_id') as string;
      const fresh = result.current.files.get(freshId);
      expect(fresh).toBeDefined();
      mockSetEphemeralAgent.mockClear();
      const persisted = {
        file_id: 'persisted-retired',
        temp_file_id: body.get('file_id'),
        filepath: '/files/retired.txt',
        filename: 'retired.txt',
        type: 'text/plain',
        bytes: 6,
        embedded: resource === 'file_search',
        llmDeliveryPath: 'none',
      };
      // The real mutation caches the response before invoking its success callback.
      await act(async () => {
        mockFileList = [persisted];
        rerender({ projectId, tick: 2 });
      });
      await act(async () => {
        options.onSuccess?.(persisted, body);
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      expect(result.current.files.has(retiredId)).toBe(false);
      expect(result.current.files.get('kept-completed')).toEqual(completed);
      expect(result.current.files.get(freshId)).toBe(fresh);
      expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}new`)).not.toBe(
        'true',
      );
      unmount();
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each([false, true])(
    'activates after navigation only when the owning saved draft retains the upload (%s)',
    async (retained) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = retained;
      mockFiles.clear();
      mockConfigPending = false;
      window.history.replaceState({}, '', '/c/retained-origin');
      global.URL.createObjectURL = jest.fn(() => 'blob:retained-origin');
      global.URL.revokeObjectURL = jest.fn();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const { result, rerender, unmount } = renderHook(
        ({ conversationId, tick }) => {
          const [files, setFiles] = useAtom(filesFamily(2));
          useAutoSave({ index: 2, conversationId, files, setFiles });
          return {
            files,
            tick,
            handler: useFileHandlingNoChatContext(undefined, {
              index: 2,
              files,
              setFiles,
              conversation: { conversationId, endpoint: EModelEndpoint.openAI } as TConversation,
            }),
          };
        },
        { wrapper, initialProps: { conversationId: 'retained-origin', tick: 0 } },
      );
      await act(async () => {
        await result.current.handler.handleFiles(
          [new File(['search'], 'retained.txt', { type: 'text/plain' })],
          'file_search',
        );
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      const options = mockUploadOptions;
      act(() => {
        window.history.pushState({}, '', '/c/destination');
        rerender({ conversationId: 'destination', tick: 1 });
      });
      mockSetEphemeralAgent.mockClear();
      await act(async () => {
        const persisted = {
          file_id: 'persisted-retained',
          temp_file_id: body.get('file_id'),
          filepath: '/files/retained.txt',
          filename: 'retained.txt',
          type: 'text/plain',
          bytes: 6,
          embedded: true,
        };
        mockFileList = [persisted];
        rerender({ conversationId: 'destination', tick: 2 });
        options.onSuccess?.(persisted, body);
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      expect(mockSetEphemeralAgent).not.toHaveBeenCalledWith('destination', expect.anything());
      if (retained)
        expect(mockSetEphemeralAgent).toHaveBeenCalledWith('retained-origin', expect.any(Function));
      else expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
      unmount();
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each([false, true])(
    'keeps the live completion fence when intent storage is blocked (retire: %s)',
    (retire) => {
      window.history.replaceState({}, '', '/c/new?projectId=source-project');
      const release = registerComposerDraft(28, 'new', 'new:28', {});
      const owner = captureComposerDraft(28, 'new');
      const write = Storage.prototype.setItem;
      const unavailable = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (key.startsWith('file-search-upload:')) throw new Error('Intent storage unavailable');
        write.call(this, key, value);
      });
      const intent = beginFileSearchUpload('blocked-owner', captureFileSearchUpload('new', owner));
      expect(intent.persisted).toBe(false);
      // Cache restoration lacks a fallback revision; it cannot consume the mutation's live fence.
      expect(completeFileSearchUpload('blocked-owner', 'new')).toBe(false);
      let releaseReplacement: (() => void) | undefined;
      if (retire) {
        window.history.replaceState({}, '', '/c/new?projectId=replacement');
        release();
        releaseReplacement = registerComposerDraft(28, 'new', 'new:28', {});
      }
      expect(completeFileSearchUpload('blocked-owner', 'new', intent.choiceRevision)).toBe(!retire);
      unavailable.mockRestore();
      releaseReplacement?.();
      release();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each([false, true])(
    'restores persisted intent only in its original new-chat project (%s)',
    (sameProject) => {
      window.history.replaceState({}, '', '/c/new?projectId=original-project');
      beginFileSearchUpload('persisted-project-intent', 'new');
      if (!sameProject) window.history.replaceState({}, '', '/c/new?projectId=other-project');
      expect(completeFileSearchUpload('persisted-project-intent', 'new')).toBe(sameProject);
      window.history.replaceState({}, '', '/');
    },
  );

  it('rejects a late upload after browser history returns to its acknowledged source URL', async () => {
    const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
    mockSaveDrafts = false;
    mockFiles.clear();
    mockConfigPending = false;
    window.history.replaceState({}, '', '/c/new');
    global.URL.createObjectURL = jest.fn(() => 'blob:history-source');
    global.URL.revokeObjectURL = jest.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    const { result, rerender, unmount } = renderHook(
      ({ conversationId }) => {
        const [files, setFiles] = useAtom(filesFamily(2));
        useAutoSave({ index: 2, conversationId, files, setFiles });
        return {
          files,
          handler: useFileHandlingNoChatContext(undefined, {
            index: 2,
            files,
            setFiles,
            conversation: { conversationId, endpoint: EModelEndpoint.openAI } as TConversation,
          }),
        };
      },
      { wrapper, initialProps: { conversationId: 'new' } },
    );
    const launch = { conversationId: 'new' };
    bindComposerLaunch(launch, 2);
    const owner = captureComposerDraft(2, 'new');
    await act(async () => {
      await result.current.handler.handleFiles(
        [new File(['search'], 'history.txt', { type: 'text/plain' })],
        'file_search',
      );
    });
    const body = mockUploadFile.mock.calls[0][0] as FormData;
    const options = mockUploadOptions;
    expect(adoptComposerConversation(launch, 'saved-history', 2)).toBe(true);
    act(() => {
      window.history.replaceState({}, '', '/c/saved-history');
      rerender({ conversationId: 'saved-history' });
    });
    expect(owner()).toBe(true);
    // Browser history changes before React reconciles the old conversation prop.
    window.history.pushState({}, '', '/c/new');
    expect(owner()).toBe(false);
    expect(owner.retainsFile(body.get('file_id') as string)).toBe(false);
    expect(adoptComposerConversation(launch, 'saved-history', 2)).toBe(false);
    mockSetEphemeralAgent.mockClear();
    await act(async () => {
      options.onSuccess?.(
        {
          file_id: 'history-persisted',
          temp_file_id: body.get('file_id'),
          filepath: '/files/history',
          embedded: true,
        },
        body,
      );
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
    expect(result.current.files.has(body.get('file_id') as string)).toBe(false);
    unmount();
    client.clear();
    window.history.replaceState({}, '', '/');
  });

  it.each(
    ['reset', 'live', 'saved'].flatMap((origin) =>
      ['cache-first', 'success-first', 'batched'].map((order) => ({ origin, order })),
    ),
  )(
    'restores only owned uploads after composer replacement ($origin, $order)',
    async ({ origin, order }) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = true;
      mockFiles.clear();
      mockConfigPending = false;
      const conversationId = origin === 'saved' ? 'saved-cache-origin' : 'new';
      mockPreviousConversation = { conversationId, endpoint: EModelEndpoint.openAI };
      window.history.replaceState({}, '', `/c/${conversationId}`);
      global.URL.createObjectURL = jest.fn(() => 'blob:reset-cache');
      global.URL.revokeObjectURL = jest.fn();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const composer = renderHook(
        ({ conversationId, tick }) => {
          const [files, setFiles] = useAtom(filesFamily(2));
          useAutoSave({ index: 2, conversationId, files, setFiles });
          return {
            files,
            tick,
            handler: useFileHandlingNoChatContext(undefined, {
              index: 2,
              files,
              setFiles,
              conversation: { conversationId, endpoint: EModelEndpoint.openAI } as TConversation,
            }),
          };
        },
        { wrapper, initialProps: { conversationId, tick: 0 } },
      );
      await act(async () => {
        await composer.result.current.handler.handleFiles(
          [new File(['search'], 'reset-cache.txt', { type: 'text/plain' })],
          'file_search',
        );
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      const fileId = body.get('file_id') as string;
      const options = mockUploadOptions;
      expect(getFilesDraft(origin === 'saved' ? conversationId : 'new:2').fileIds).toContain(
        fileId,
      );
      const persisted = {
        file_id: 'reset-cache-persisted',
        temp_file_id: fileId,
        filepath: '/files/reset-cache',
        filename: 'reset-cache.txt',
        type: 'text/plain',
        bytes: 6,
        embedded: true,
        llmDeliveryPath: 'none',
      };
      const next = renderHook(() => useNewConvo(2), { wrapper });
      const reset = () => {
        if (origin === 'live') return;
        window.history.replaceState({}, '', '/c/new');
        next.result.current.newConversation({ preset: { endpoint: EModelEndpoint.openAI } });
        composer.rerender({ conversationId: 'new', tick: 1 });
      };
      const cache = () => {
        mockFileList = [persisted];
        composer.rerender({ conversationId: 'new', tick: 2 });
      };
      if (order === 'batched') {
        await act(async () => {
          reset();
          options.onSuccess?.(persisted, body);
          cache();
        });
      } else {
        act(reset);
        if (order === 'cache-first') {
          act(cache);
          act(() => options.onSuccess?.(persisted, body));
        } else {
          act(() => options.onSuccess?.(persisted, body));
          act(cache);
        }
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      if (origin === 'live') {
        expect(composer.result.current.files.get(fileId)?.progress).toBe(1);
        expect(mockSetEphemeralAgent).toHaveBeenCalledWith('new', expect.any(Function));
      } else {
        expect(composer.result.current.files.size).toBe(0);
        expect(getFilesDraft('new:2').fileIds).not.toContain(fileId);
        expect(mockSetEphemeralAgent).not.toHaveBeenCalledWith('new', expect.anything());
      }
      if (origin === 'saved') {
        composer.unmount();
        window.history.replaceState({}, '', `/c/${conversationId}`);
        const restored = renderHook(
          () => {
            const [files, setFiles] = React.useState<Map<string, ExtendedFile>>(new Map());
            useAutoSave({ index: 2, conversationId, files, setFiles });
            return files;
          },
          { wrapper },
        );
        expect(restored.result.current.get(fileId)?.progress).toBe(1);
        expect(mockSetEphemeralAgent).toHaveBeenCalledWith(conversationId, expect.any(Function));
        restored.unmount();
      }
      next.unmount();
      composer.unmount();
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each(['bootstrap', 'metadata', 'reset'])(
    'preserves logical composer ownership only for passive initialization (%s)',
    (action) => {
      mockFiles.clear();
      window.history.replaceState({}, '', '/c/new?projectId=bootstrap-project');
      const release = registerComposerDraft(2, 'new', 'new:2', {});
      const owner = captureComposerDraft(2, 'new');
      beginFileSearchUpload('bootstrap-file', captureFileSearchUpload('new', owner));
      const client = new QueryClient();
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const initialized = renderHook(() => useNewConvo(2), { wrapper });
      const options = {
        template: { chatProjectId: 'bootstrap-project' },
        ...(action === 'bootstrap' ? { modelsData: {} } : {}),
        ...(action === 'metadata' ? { keepComposerState: true } : {}),
      };
      act(() => {
        initialized.result.current.newConversation(options);
        initialized.result.current.newConversation(options);
      });
      expect(owner()).toBe(action !== 'reset');
      expect(completeFileSearchUpload('bootstrap-file', 'new')).toBe(action !== 'reset');
      initialized.unmount();
      release();
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each(['project', 'answer', 'teardown', 'saved'])(
    'keeps logical ownership retirement across reload (%s)',
    async (boundary) => {
      const saved = boundary === 'saved';
      const conversationId = saved ? 'saved-reload-owner' : 'new';
      window.history.replaceState({}, '', '/c/new?projectId=original');
      const host = {};
      const release = registerComposerDraft(
        34,
        conversationId,
        saved ? conversationId : 'new:34',
        host,
      );
      const owner = captureComposerDraft(34, conversationId);
      beginFileSearchUpload('reload-logical-owner', captureFileSearchUpload(conversationId, owner));
      release();
      let releaseReplacement: (() => void) | undefined;
      if (boundary === 'project') {
        window.history.replaceState({}, '', '/c/new?projectId=replacement');
        releaseReplacement = registerComposerDraft(34, 'new', 'new:34', host);
      } else if (boundary === 'answer') {
        releaseReplacement = registerComposerDraft(
          34,
          'new',
          getAskAnswerDraftId('reload-answer'),
          host,
        );
      }
      await Promise.resolve();
      window.history.replaceState({}, '', '/c/new?projectId=original');
      const navigation = Object.getOwnPropertyDescriptor(performance, 'getEntriesByType');
      Object.defineProperty(performance, 'getEntriesByType', {
        configurable: true,
        value: () => [{ type: 'reload' }],
      });
      try {
        jest.isolateModules(() => {
          const reloaded = jest.requireActual<typeof import('../Files/search')>('../Files/search');
          expect(reloaded.completeFileSearchUpload('reload-logical-owner', conversationId)).toBe(
            saved,
          );
        });
      } finally {
        if (navigation) Object.defineProperty(performance, 'getEntriesByType', navigation);
        else Reflect.deleteProperty(performance, 'getEntriesByType');
        releaseReplacement?.();
        window.history.replaceState({}, '', '/');
      }
    },
  );

  it.each(
    [false, true].flatMap((reset) => [false, true].map((bootstrap) => ({ reset, bootstrap }))),
  )(
    'keeps new-chat intent ownership after reload (reset: $reset, bootstrap: $bootstrap)',
    async ({ reset, bootstrap }) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = true;
      mockFiles.clear();
      mockConfigPending = false;
      mockPreviousConversation = { conversationId: 'new', endpoint: EModelEndpoint.openAI };
      window.history.replaceState({}, '', '/c/new?projectId=reload-project');
      global.URL.createObjectURL = jest.fn(() => 'blob:reset-reload');
      global.URL.revokeObjectURL = jest.fn();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const composer = renderHook(
        () => {
          const [files, setFiles] = useAtom(filesFamily(2));
          useAutoSave({ index: 2, conversationId: 'new', files, setFiles });
          return {
            files,
            handler: useFileHandlingNoChatContext(undefined, {
              index: 2,
              files,
              setFiles,
              conversation: {
                conversationId: 'new',
                endpoint: EModelEndpoint.openAI,
                chatProjectId: 'reload-project',
              } as TConversation,
            }),
          };
        },
        { wrapper },
      );
      await act(async () => {
        await composer.result.current.handler.handleFiles(
          [new File(['search'], 'reload.txt', { type: 'text/plain' })],
          'file_search',
        );
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      const fileId = body.get('file_id') as string;
      if (reset) {
        const next = renderHook(() => useNewConvo(2), { wrapper });
        act(() =>
          next.result.current.newConversation({ template: { chatProjectId: 'reload-project' } }),
        );
        next.unmount();
      }
      composer.unmount();
      if (bootstrap) {
        const initialized = renderHook(() => useNewConvo(2), { wrapper });
        act(() =>
          initialized.result.current.newConversation({
            modelsData: {},
            template: { chatProjectId: 'reload-project' },
          }),
        );
        initialized.unmount();
      }
      // Re-execute the real intent module with no live assignments map, preserving browser storage.
      const navigationDescriptor = Object.getOwnPropertyDescriptor(performance, 'getEntriesByType');
      Object.defineProperty(performance, 'getEntriesByType', {
        configurable: true,
        value: () => [{ type: 'reload' }],
      });
      try {
        jest.isolateModules(() => {
          const reloaded = jest.requireActual<typeof import('../Files/search')>('../Files/search');
          expect(reloaded.completeFileSearchUpload(fileId, 'new')).toBe(!reset);
        });
      } finally {
        if (navigationDescriptor)
          Object.defineProperty(performance, 'getEntriesByType', navigationDescriptor);
        else Reflect.deleteProperty(performance, 'getEntriesByType');
      }
      expect(
        localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}new`) === 'true',
      ).toBe(!reset);
      client.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each([false, true])(
    'completes the next first-ID upload after a same-route reset (saveDrafts: %s)',
    async (saveDrafts) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = saveDrafts;
      mockFiles.clear();
      mockPreviousConversation = {
        conversationId: 'new',
        endpoint: EModelEndpoint.openAI,
      };
      window.history.replaceState({}, '', '/c/new');
      global.URL.createObjectURL = jest.fn(() => 'blob:reset-generation');
      global.URL.revokeObjectURL = jest.fn();
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, cacheTime: Infinity },
          mutations: { retry: false },
        },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
      const { result, rerender, unmount } = renderHook(
        ({ conversationId, isSubmitting }) => {
          const [files, setFiles] = useAtom(filesFamily(2));
          useAutoSave({ index: 2, conversationId, isSubmitting, files, setFiles });
          return {
            files,
            handler: useFileHandlingNoChatContext(undefined, {
              index: 2,
              files,
              setFiles,
              conversation: { conversationId, endpoint: EModelEndpoint.openAI } as TConversation,
            }),
          };
        },
        { wrapper, initialProps: { conversationId: 'new', isSubmitting: false } },
      );
      const oldLaunch = { conversationId: 'new' };
      bindComposerLaunch(oldLaunch, 2);
      const next = renderHook(() => useNewConvo(2), { wrapper });
      const launch = { conversationId: 'new' };
      act(() => {
        next.result.current.newConversation();
        bindComposerLaunch(launch, 2);
      });
      expect(adoptComposerConversation(oldLaunch, 'stale-generation', 2)).toBe(false);
      act(() => rerender({ conversationId: 'new', isSubmitting: true }));
      await act(async () => {
        expect(
          await result.current.handler.handleFiles(
            [new File(['search'], 'reset.txt', { type: 'text/plain' })],
            'file_search',
          ),
        ).toBe(true);
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      const options = mockUploadOptions;
      expect(adoptComposerConversation(launch, 'saved-after-reset', 2)).toBe(true);
      act(() => rerender({ conversationId: 'saved-after-reset', isSubmitting: false }));
      mockSetEphemeralAgent.mockClear();
      await act(async () => {
        const persisted = {
          temp_file_id: body.get('file_id'),
          file_id: 'persisted-after-reset',
          filename: 'reset.txt',
          filepath: '/files/reset.txt',
          type: 'text/plain',
          bytes: 6,
          embedded: true,
        };
        mockFileList = [persisted];
        options.onSuccess?.(persisted, body);
        rerender({ conversationId: 'saved-after-reset', isSubmitting: false });
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      expect(result.current.files.get(body.get('file_id') as string)?.progress).toBe(1);
      expect(mockSetEphemeralAgent).toHaveBeenCalledWith('saved-after-reset', expect.any(Function));
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}new`)).not.toBe(
        'true',
      );
      expect(
        localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}saved-after-reset`),
      ).toBe('true');
      next.unmount();
      unmount();
      queryClient.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each(['upload', 'composer'])(
    'keeps acknowledged first-ID completion when the %s host remounts',
    async (remount) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      mockSaveDrafts = false;
      mockFiles.clear();
      mockConfigPending = false;
      global.URL.createObjectURL = jest.fn(() => 'blob:remount');
      global.URL.revokeObjectURL = jest.fn();
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, cacheTime: Infinity },
          mutations: { retry: false },
        },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
      const useDraft = ({ conversationId }: { conversationId: string }) => {
        const [files, setFiles] = useAtom(filesFamily(2));
        useAutoSave({ index: 2, conversationId, files, setFiles });
        return { files, setFiles };
      };
      let draft = renderHook(useDraft, { wrapper, initialProps: { conversationId: 'new' } });
      const upload = renderHook(
        () =>
          useFileHandlingNoChatContext(undefined, {
            index: 2,
            ...draft.result.current,
            conversation: {
              conversationId: 'new',
              endpoint: EModelEndpoint.openAI,
            } as TConversation,
          }),
        { wrapper },
      );
      const launch = { conversationId: 'new' };
      bindComposerLaunch(launch, 2);
      await act(async () => {
        await upload.result.current.handleFiles(
          [new File(['file'], 'remount.txt', { type: 'text/plain' })],
          'file_search',
        );
      });
      const body = mockUploadFile.mock.calls[0][0] as FormData;
      const options = mockUploadOptions;
      expect(adoptComposerConversation(launch, 'saved-remount', 2)).toBe(true);
      act(() => draft.rerender({ conversationId: 'saved-remount' }));
      upload.unmount();
      if (remount === 'composer') {
        draft.unmount();
        draft = renderHook(useDraft, {
          wrapper,
          initialProps: { conversationId: 'saved-remount' },
        });
      }
      const replacement = renderHook(
        () =>
          useFileHandlingNoChatContext(undefined, {
            index: 2,
            ...draft.result.current,
            conversation: {
              conversationId: 'saved-remount',
              endpoint: EModelEndpoint.openAI,
            } as TConversation,
          }),
        { wrapper },
      );
      await act(async () => {
        options.onSuccess?.(
          {
            temp_file_id: body.get('file_id'),
            file_id: 'persisted-remount',
            filename: 'remount.txt',
            filepath: '/files/remount',
            type: 'text/plain',
            embedded: true,
          },
          body,
        );
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      expect(draft.result.current.files.get(body.get('file_id') as string)?.progress).toBe(1);
      replacement.unmount();
      draft.unmount();
      queryClient.clear();
    },
  );

  it.each([
    'pending-no-drafts',
    'assigned',
    'assigned-disable',
    'source-disable',
    'unrelated-navigation',
  ])('keeps logical upload ownership through %s', async (mode) => {
    const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
    mockConfigPending = false;
    mockPreparationGate = undefined;
    mockFiles.clear();
    mockSaveDrafts = mode !== 'pending-no-drafts';
    const sourceId = mode === 'pending-no-drafts' ? 'existing-chat' : 'new';
    const sourceConversation = { conversationId: sourceId };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, cacheTime: Infinity },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    global.URL.createObjectURL = jest.fn(() => 'blob:logical');
    global.URL.revokeObjectURL = jest.fn();
    const { result, rerender, unmount } = renderHook(
      ({ conversationId, isSubmitting }) => {
        const [files, setFiles] = useAtom(filesFamily(2));
        useAutoSave({ index: 2, conversationId, isSubmitting, files, setFiles });
        return {
          files,
          handler: useFileHandlingNoChatContext(undefined, {
            index: 2,
            files,
            setFiles,
            conversation: { conversationId, endpoint: EModelEndpoint.openAI } as TConversation,
          }),
        };
      },
      { wrapper, initialProps: { conversationId: sourceId, isSubmitting: true } },
    );
    if (mode !== 'pending-no-drafts') bindComposerLaunch(sourceConversation, 2);
    await act(async () => {
      expect(
        await result.current.handler.handleFiles(
          [new File(['text'], 'logical.txt', { type: 'text/plain' })],
          'file_search',
        ),
      ).toBe(true);
    });
    const body = mockUploadFile.mock.calls[0][0] as FormData;
    const options = mockUploadOptions;
    const targetId = mode === 'pending-no-drafts' ? sourceId : 'saved-chat';
    if (mode !== 'pending-no-drafts' && mode !== 'unrelated-navigation') {
      expect(adoptComposerConversation(sourceConversation, targetId, 2)).toBe(true);
      transferFileSearchChoice('new', targetId);
    }
    act(() => rerender({ conversationId: targetId, isSubmitting: false }));
    if (mode === 'assigned-disable') setFileSearchChoice(targetId, false);
    if (mode === 'source-disable') setFileSearchChoice('new', false);
    mockSetEphemeralAgent.mockClear();
    await act(async () => {
      const persisted = {
        temp_file_id: body.get('file_id'),
        file_id: 'server-file',
        filepath: '/files/logical',
        filename: 'logical.txt',
        type: 'text/plain',
        bytes: 4,
        embedded: true,
      };
      mockFileList = [persisted];
      options.onSuccess?.(persisted, body);
      rerender({ conversationId: targetId, isSubmitting: false });
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    if (mode === 'pending-no-drafts' || mode === 'assigned') {
      expect(result.current.files.get(body.get('file_id') as string)?.progress).toBe(1);
      expect(mockSetEphemeralAgent).toHaveBeenCalledWith(targetId, expect.any(Function));
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}${targetId}`)).toBe(
        'true',
      );
    } else if (mode !== 'unrelated-navigation')
      expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
    if (mode !== 'pending-no-drafts' && mode !== 'unrelated-navigation')
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}new`)).not.toBe(
        'true',
      );
    unmount();
    queryClient.clear();
  });

  it.each(
    [
      'config',
      'queue',
      'sharepoint',
      'sharepoint-no-context',
      'heic',
      'decode',
      'route',
      'answer',
      'unmount',
    ].flatMap((boundary) => ['new', 'origin'].map((origin) => ({ boundary, origin }))),
  )(
    'abandons $boundary upload after $origin composer resets before staging',
    async ({ boundary, origin }) => {
      const { useFileHandlingNoChatContext } = await import('../Files/useFileHandling');
      const { default: useSharePoint, useSharePointFileHandlingNoChatContext } = await import(
        '../Files/useSharePointFileHandling'
      );
      const { ChatContext } = await import('~/Providers/ChatContext');
      let release: () => void = () => undefined;
      mockPreparationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockConfigPending = ['config', 'queue', 'route', 'answer', 'unmount'].includes(boundary);
      mockSaveDrafts = true;
      mockPreviousConversation = { conversationId: origin, endpoint: EModelEndpoint.openAI };
      mockFiles.clear();
      global.URL.createObjectURL = jest.fn(() => 'blob:deferred');
      global.URL.revokeObjectURL = jest.fn();
      mockDownloadedFiles = [new File(['search'], 'search.txt', { type: 'text/plain' })];
      mockConvertFile.mockImplementation(async (file, _quality, onProgress) => {
        await mockPreparationGate;
        onProgress?.(0.8);
        return file;
      });
      const imageCallbacks: (() => void)[] = [];
      const originalImage = global.Image;
      if (boundary === 'decode') {
        Object.defineProperty(global, 'Image', {
          configurable: true,
          writable: true,
          value: class {
            width = 640;
            height = 480;
            onload: (() => void) | null = null;
            set src(_value: string) {
              imageCallbacks.push(() => this.onload?.());
            }
          },
        });
      }
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, cacheTime: Infinity },
          mutations: { retry: false },
        },
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
      const { result, rerender, unmount } = renderHook(
        ({ conversationId, draftId }) => {
          const [files, setFiles] = useAtom(filesFamily(2));
          const state = {
            index: 2,
            files,
            setFiles,
            conversation: { conversationId, endpoint: EModelEndpoint.openAI } as TConversation,
          };
          useAutoSave({ ...state, index: 2, conversationId, draftId });
          const handler = useFileHandlingNoChatContext(undefined, state);
          const sharepoint = useSharePointFileHandlingNoChatContext(
            { toolResource: 'file_search' },
            state,
          );
          return { handler, sharepoint, files, state };
        },
        { wrapper, initialProps: { conversationId: origin, draftId: null as string | null } },
      );
      const contextState = result.current.state;
      const contextSharePoint = renderHook(() => useSharePoint({ toolResource: 'file_search' }), {
        wrapper: ({ children }) =>
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(
              ChatContext.Provider,
              {
                value: contextState as ReturnType<
                  typeof import('~/Providers/ChatContext').useChatContext
                >,
              },
              children,
            ),
          ),
      });
      const next = renderHook(() => useNewConvo(2), { wrapper });
      let first: Promise<boolean> | undefined;
      let pending: Promise<boolean | void> = Promise.resolve();
      act(() => {
        if (boundary === 'queue')
          first = result.current.handler.handleFiles(mockDownloadedFiles, 'file_search');
        if (boundary === 'sharepoint') {
          pending = contextSharePoint.result.current.handleSharePointFiles([]);
        } else if (boundary === 'sharepoint-no-context') {
          pending = result.current.sharepoint.handleSharePointFiles([]);
        } else {
          let selectedFiles = mockDownloadedFiles;
          if (boundary === 'heic')
            selectedFiles = [new File(['heic'], 'search.heic', { type: 'image/heic' })];
          else if (boundary === 'decode')
            selectedFiles = [new File(['image'], 'search.png', { type: 'image/png' })];
          pending = result.current.handler.handleFiles(selectedFiles, 'file_search');
        }
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        if (boundary === 'unmount') unmount();
        else if (boundary === 'route') {
          window.history.pushState({}, '', '/c/destination');
          rerender({ conversationId: 'destination', draftId: null });
        } else if (boundary === 'answer') {
          rerender({ conversationId: origin, draftId: getAskAnswerDraftId('next-question') });
        } else {
          next.result.current.newConversation();
          rerender({ conversationId: 'new', draftId: null });
        }
      });
      await act(async () => {
        release();
        await first;
        const accepted = await pending;
        if (!boundary.startsWith('sharepoint') && boundary !== 'decode')
          expect(accepted).toBe(false);
        imageCallbacks.forEach((decode) => decode());
      });
      expect(mockUploadFile).not.toHaveBeenCalled();
      if (boundary !== 'unmount') expect(result.current.files.size).toBe(0);
      expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
      contextSharePoint.unmount();
      next.unmount();
      unmount();
      mockConfigPending = false;
      mockPreparationGate = undefined;
      window.history.replaceState({}, '', '/');
      global.Image = originalImage;
      queryClient.clear();
    },
  );

  it.each(['retained', 'discarded', 'disabled', 'unrelated', 'other-conversation'])(
    'restores File Search only for a retained explicit upload (%s)',
    (mode) => {
      mockSaveDrafts = mode !== 'discarded';
      mockPreviousConversation = {
        conversationId: 'origin-conversation',
        endpoint: EModelEndpoint.openAI,
      };
      mockFiles.clear();
      mockFiles.set('pending-search', {
        file_id: 'pending-search',
        attached: false,
        progress: 0.2,
      });
      setFilesDraft('origin-conversation', { fileIds: ['pending-search'], pendingPastes: {} });
      if (mode !== 'unrelated') {
        beginFileSearchUpload(
          'pending-search',
          mode === 'other-conversation' ? 'other-conversation' : 'origin-conversation',
        );
        if (mode === 'disabled') {
          setFileSearchChoice('origin-conversation', false);
        }
      }
      const next = renderHook(() => useNewConvo());
      act(() => next.result.current.newConversation());
      expect(clearUploadRecovery).toHaveBeenCalledWith('pending-search', mockSaveDrafts);
      expect(getDefaultStore().get(filesFamily(0)).size).toBe(0);
      next.unmount();

      // Persistence finishes after leaving; restoration reads the real saved draft and file cache.
      mockSaveDrafts = true;
      mockFileList = [
        {
          file_id: 'persisted-search',
          temp_file_id: 'pending-search',
          filepath: '/files/search.txt',
          filename: 'search.txt',
          bytes: 5,
          type: 'text/plain',
          embedded: true,
          llmDeliveryPath: 'none',
        },
      ];
      const setFiles = jest.fn();
      const restored = renderHook(() =>
        useAutoSave({
          conversationId: 'origin-conversation',
          files: new Map(),
          setFiles,
        }),
      );
      const files = setFiles.mock.calls.reduce(
        (current, [update]) => (typeof update === 'function' ? update(current) : update),
        new Map(),
      );
      expect(files.get('pending-search')).toMatchObject({
        file_id: 'persisted-search',
        progress: 1,
        llmDeliveryPath: 'none',
      });
      if (mode === 'retained') {
        expect(mockSetEphemeralAgent).toHaveBeenCalledWith(
          'origin-conversation',
          expect.any(Function),
        );
        const update = mockSetEphemeralAgent.mock.calls.at(-1)?.[1];
        expect(update({ web_search: true })).toEqual({ web_search: true, file_search: true });
        expect(
          localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}origin-conversation`),
        ).toBe('true');
      } else {
        expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
      }
      restored.unmount();
    },
  );

  it.each(['active', 'other-question', 'other-conversation', 'other-pane'])(
    'retains only the owning active answer draft on New Chat (%s)',
    (mode) => {
      mockSaveDrafts = true;
      mockPreviousConversation = {
        conversationId: 'answer-origin',
        endpoint: EModelEndpoint.openAI,
      };
      mockFiles.clear();
      mockFiles.set('answer-upload', { file_id: 'answer-upload', attached: false, progress: 0.2 });
      const draftId = getAskAnswerDraftId('active-question');
      const source = renderHook(() =>
        useAutoSave({
          index: mode === 'other-pane' ? 0 : 2,
          conversationId: mode === 'other-conversation' ? 'unrelated-origin' : 'answer-origin',
          draftId,
          files: mockFiles as Map<string, ExtendedFile>,
          setFiles: jest.fn(),
        }),
      );
      if (mode === 'other-question') {
        setFilesDraft(draftId, { fileIds: [], pendingPastes: {} });
        setFilesDraft(getAskAnswerDraftId('other-question'), {
          fileIds: ['answer-upload'],
          pendingPastes: {},
        });
      }
      beginFileSearchUpload('answer-upload', 'answer-origin');
      const next = renderHook(() => useNewConvo(2));
      act(() => next.result.current.newConversation());
      expect(clearUploadRecovery).toHaveBeenCalledWith('answer-upload', mode === 'active');
      next.unmount();
      source.unmount();
      mockFileList = [
        { file_id: 'saved-answer', temp_file_id: 'answer-upload', bytes: 3, embedded: true },
      ];
      setFilesDraft(draftId, { fileIds: ['answer-upload'], pendingPastes: {} });
      mockSetEphemeralAgent.mockClear();
      const restored = renderHook(() =>
        useAutoSave({
          index: 2,
          conversationId: 'answer-origin',
          draftId,
          files: new Map(),
          setFiles: jest.fn(),
        }),
      );
      expect(mockSetEphemeralAgent.mock.calls.length > 0).toBe(mode === 'active');
      restored.unmount();
    },
  );

  it('does not delete a file claimed by another tab but deletes an unclaimed file', () => {
    mockForeignClaims.add('claimed-file');
    const { result } = renderHook(() => useNewConvo(2));

    act(() => {
      result.current.newConversation();
    });

    expect(mockCollectForeignAttachmentClaims).toHaveBeenCalledWith(['new:2', 'pending:2'], 2);
    expect(mockRemoveTabAttachmentPresence).toHaveBeenCalledWith(expect.any(Array), 2);

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      files: [
        {
          file_id: 'own-file',
          embedded: false,
          filepath: '/uploads/own-file.txt',
          source: 'local',
        },
      ],
    });
  });

  it('defers an in-flight generated paste when drafts are disabled', () => {
    /** Direct `newConversation()` callers never pass through useNewChat, so this reset is the only
     * thing that can remember an upload with no filepath yet: nothing else would be left to delete
     * the server record once the request finally lands. */
    mockFiles.clear();
    mockFiles.set('inflight-paste', {
      file_id: 'inflight-paste',
      attached: false,
      progress: 0,
    });
    mockMarkedPasteIds.add('inflight-paste');
    const { result } = renderHook(() => useNewConvo());

    act(() => {
      result.current.newConversation();
    });

    expect(mockStorePendingDiscardIds).toHaveBeenCalledWith(0, ['inflight-paste']);
    expect(mockPendingDiscardIds).toEqual(new Set(['inflight-paste']));
  });
});
