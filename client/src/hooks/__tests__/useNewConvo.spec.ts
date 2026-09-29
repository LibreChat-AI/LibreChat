import { renderHook, act } from '@testing-library/react';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';

const mockDeleteFiles = jest.fn();
const mockSetFiles = jest.fn();
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

jest.mock('recoil', () => ({
  useRecoilState: () => [mockFiles, mockSetFiles],
  useRecoilValue: (key: string) => {
    if (key === 'saveDrafts') {
      return false;
    }
    if (key === 'saveBadgesState') {
      return true;
    }
    return null;
  },
  useSetRecoilState: () => jest.fn(),
  useRecoilCallback: () => jest.fn(),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: {} }),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/utils', () => ({
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
  renewNewConversationDraftToken: jest.fn(),
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
}));

jest.mock('../Conversations/useNavigateToConvo', () => ({
  __esModule: true,
  supersedeNavigation: jest.fn(),
}));
jest.mock('../Conversations/useGetConversation', () => ({
  __esModule: true,
  default: () => () => null,
}));
jest.mock('../Assistants/useAssistantListMap', () => ({
  __esModule: true,
  default: () => ({}),
}));
jest.mock('../Files/useFileHandling', () => ({ clearUploadRecovery: jest.fn() }));
jest.mock('../useChatBadges', () => ({ useResetChatBadges: () => jest.fn() }));
jest.mock('../Agents', () => ({ useApplyModelSpecEffects: () => jest.fn() }));
jest.mock('../Audio', () => ({ usePauseGlobalAudio: () => ({ pauseGlobalAudio: jest.fn() }) }));
jest.mock('~/Providers', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('~/hooks', () => ({ useHasAccess: () => true }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    defaultPreset: 'defaultPreset',
    saveBadgesState: 'saveBadgesState',
    saveDrafts: 'saveDrafts',
    filesByIndex: () => 'filesByIndex',
    submissionByIndex: () => 'submissionByIndex',
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
  });

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
