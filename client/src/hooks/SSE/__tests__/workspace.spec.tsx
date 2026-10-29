import { useState } from 'react';
import { Provider } from 'jotai';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, EModelEndpoint, QueryKeys, LocalStorageKeys } from 'librechat-data-provider';
import type {
  ChatCreatedFrame,
  EventSubmission,
  TConversation,
  TMessage,
} from 'librechat-data-provider';
import {
  registerComposerDraft,
  adoptComposerConversation,
  bindComposerLaunch,
  captureComposerDraft,
  getActiveComposerDraftId,
} from '~/utils/drafts';
import { setFileSearchChoice, getFileSearchChoice, clearFileSearchChoices } from '~/utils/choices';
import { beginFileSearchUpload, completeFileSearchUpload } from '~/hooks/Files/search';
import useCodeWorkspace from '~/hooks/Agents/useCodeWorkspace';
import useEventHandlers from '../useEventHandlers';

const mockStatus = jest.fn();
const mockStartupConfig = jest.fn();
const mockApplyAgentTemplate = jest.fn();
const mockQueueTitleGeneration = jest.fn();
const mockAnnounce = jest.fn();
const mockReset = jest.fn();

jest.mock('~/hooks/Agents', () => ({ useApplyAgentTemplate: () => mockApplyAgentTemplate }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ token: 'test' }) }));
jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: mockAnnounce }),
  useAgentsMapContext: () => ({}),
}));
jest.mock('~/hooks/SSE/useContentHandler', () => () => ({}));
jest.mock('~/hooks/SSE/useAttachmentHandler', () => () => jest.fn());
jest.mock('~/hooks/SSE/useStepHandler', () => () => ({
  resetSubagentAtoms: mockReset,
  resetPtcAtoms: mockReset,
}));
jest.mock('~/hooks/Agents/workspacePreferences', () => ({
  useWorkspacePreferences: () => ({ get: () => undefined }),
}));
jest.mock('~/hooks/Roles/useHasAccess', () => () => true);
jest.mock('~/hooks/Agents/useAgentToolPermissions', () => () => ({
  agent: {
    id: 'agent_primary',
    stateful_code_sessions: true,
    code_environment_id: 'personal-vm',
    tools: ['execute_code'],
  },
}));
jest.mock('~/hooks/Agents/useGetAgentsConfig', () => () => ({
  agentsConfig: {
    capabilities: ['execute_code', 'stateful_code_sessions'],
    statefulCodeSessions: {
      environments: [{ id: 'personal-vm', type: 'attached', name: 'Personal VM' }],
    },
  },
}));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  /** The barrel can be partially initialized through the hook imports above. Keep these
   * real hooks rather than snapshotting missing exports or replacing recovery with a stub. */
  ...jest.requireActual('~/data-provider/CodeEnvironments'),
  queueTitleGeneration: (conversationId: string) => mockQueueTitleGeneration(conversationId),
  useCodeEnvironmentStatusQueries: () => mockStatus(),
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
}));

const selection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
const initialConversation = {
  conversationId: Constants.NEW_CONVO,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_primary',
  title: 'New Chat',
} as TConversation;

function setup(
  current = initialConversation,
  isAddedRequest = false,
  currentMessages: TMessage[] = [],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.allConversations], { pages: [], pageParams: [] });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider>
        <RecoilRoot>
          <MemoryRouter initialEntries={['/c/new']}>{children}</MemoryRouter>
        </RecoilRoot>
      </Provider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const [conversation, setConversation] = useState<TConversation | null>(current);
      const handlers = useEventHandlers({
        isAddedRequest,
        setConversation,
        setMessages: jest.fn(),
        getMessages: () => currentMessages,
        setCompleted: jest.fn(),
        setIsSubmitting: jest.fn(),
        setShowStopButton: jest.fn(),
      });
      return {
        conversation,
        setConversation,
        workspace: useCodeWorkspace(conversation),
        ...handlers,
      };
    },
    { wrapper },
  );
  const submission: EventSubmission = {
    isTemporary: false,
    endpointOption: { endpoint: EModelEndpoint.agents },
    conversation: current,
    messages: [],
    userMessage: {
      messageId: 'user-1',
      text: 'Hello',
      sender: 'User',
      isCreatedByUser: true,
      parentMessageId: String(Constants.NO_PARENT),
      conversationId: 'saved-chat',
    },
    initialResponse: {
      messageId: 'response-1',
      parentMessageId: 'user-1',
      conversationId: 'saved-chat',
      text: '',
      sender: 'Assistant',
      isCreatedByUser: false,
    },
    ...hook.result.current.workspace.resolveSubmission(
      current.codeWorkspaces,
      current.codeEnvironmentMode,
    ),
  };
  const createdData: ChatCreatedFrame = {
    created: true,
    message: submission.userMessage,
  };
  return { ...hook, submission, createdData, queryClient };
}

describe('created composer identity', () => {
  beforeEach(() => {
    localStorage.clear();
    clearFileSearchChoices();
    mockApplyAgentTemplate.mockClear();
    mockQueueTitleGeneration.mockClear();
    mockStatus.mockReturnValue([]);
    mockStartupConfig.mockReturnValue({ codeEnvironmentDecisionVersion: 1 });
  });

  it.each([true, false])(
    'preserves current File Search preference across acknowledgement (%s)',
    (enabled) => {
      const { result, submission, unmount, queryClient } = setup();
      const release = registerComposerDraft(0, Constants.NEW_CONVO, 'pending', {});
      bindComposerLaunch(submission.conversation, 0);
      localStorage.setItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}new`, 'true');
      if (!enabled) setFileSearchChoice('saved-chat', false);
      act(() =>
        result.current.createdHandler(
          { created: true, message: submission.userMessage },
          {
            ...submission,
            ephemeralAgent: { file_search: false },
          },
        ),
      );
      expect(mockApplyAgentTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          targetId: 'saved-chat',
          ephemeralAgent: expect.objectContaining({ file_search: enabled }),
        }),
      );
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}saved-chat`)).toBe(
        JSON.stringify(enabled),
      );
      release();
      unmount();
      queryClient.clear();
    },
  );

  it.each([false, true])(
    'keeps a saved-chat upload preference on later acknowledgements (disabled later: %s)',
    (disabledLater) => {
      const { result, submission, createdData, unmount, queryClient } = setup();
      window.history.replaceState({}, '', '/c/new');
      const host = {};
      const release = registerComposerDraft(0, Constants.NEW_CONVO, 'pending', host);
      bindComposerLaunch(submission.conversation, 0);
      localStorage.setItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}new`, 'false');
      act(() => result.current.createdHandler(createdData, submission));
      window.history.replaceState({}, '', '/c/saved-chat');
      release();
      const releaseSaved = registerComposerDraft(0, 'saved-chat', 'saved-chat', host);
      setFileSearchChoice('saved-chat', false);
      beginFileSearchUpload('saved-explicit-upload', 'saved-chat');
      const revision = getFileSearchChoice('saved-chat')?.revision;
      if (disabledLater) setFileSearchChoice('saved-chat', false);
      expect(completeFileSearchUpload('saved-explicit-upload', 'saved-chat')).toBe(!disabledLater);
      if (disabledLater)
        localStorage.setItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}saved-chat`, 'false');
      const next = {
        ...submission,
        conversation: result.current.conversation!,
        ephemeralAgent: { file_search: !disabledLater },
      };
      bindComposerLaunch(next.conversation, 0);
      act(() => result.current.createdHandler(createdData, next));
      expect(mockApplyAgentTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ephemeralAgent: expect.objectContaining({ file_search: !disabledLater }),
        }),
      );
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}saved-chat`)).toBe(
        JSON.stringify(!disabledLater),
      );
      if (!disabledLater) expect(getFileSearchChoice('saved-chat')?.revision).toBe(revision);
      releaseSaved();
      unmount();
      queryClient.clear();
      window.history.replaceState({}, '', '/');
    },
  );

  it.each(
    ['created', 'final'].flatMap((event) =>
      ['saved', 'resumable'].flatMap((origin) =>
        [
          'accepted',
          'disabled-before',
          'disabled-after',
          'blocked-storage',
          'accepted-unset',
          'blocked-unset',
        ].map((completion) => ({
          event,
          origin,
          completion,
        })),
      ),
    ),
  )(
    'keeps the current File Search value over a stale template ($event, $origin, $completion)',
    ({ event, origin, completion }) => {
      const currentMessages: TMessage[] = [];
      const saved = { ...initialConversation, conversationId: 'saved-chat' };
      const { result, submission, createdData, unmount, queryClient } = setup(
        origin === 'saved' ? saved : initialConversation,
        false,
        currentMessages,
      );
      window.history.replaceState({}, '', origin === 'saved' ? '/c/saved-chat' : '/c/new');
      const host = {};
      let release = registerComposerDraft(
        0,
        submission.conversation!.conversationId!,
        'pending',
        host,
      );
      bindComposerLaunch(submission.conversation, 0);
      if (origin === 'resumable') {
        expect(adoptComposerConversation(submission.conversation, 'saved-chat', 0)).toBe(true);
        window.history.replaceState({}, '', '/c/saved-chat');
        release();
        release = registerComposerDraft(0, 'saved-chat', 'pending', host);
      }
      if (!completion.endsWith('unset')) setFileSearchChoice('saved-chat', false);
      localStorage.setItem(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}saved-chat`, 'false');
      const previousRevision = getFileSearchChoice('saved-chat')?.revision ?? null;
      const stale = { ...submission, ephemeralAgent: { file_search: false, web_search: true } };
      currentMessages.push(stale.userMessage, stale.initialResponse);
      beginFileSearchUpload('late-accepted-upload', 'saved-chat');
      const writer = Storage.prototype.setItem;
      const storage = completion.startsWith('blocked')
        ? jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
            this: Storage,
            key: string,
            value: string,
          ) {
            if (
              key.startsWith('file-search-choice:') ||
              key.startsWith(`${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}saved-chat`)
            )
              throw new Error('Preference storage unavailable');
            writer.call(this, key, value);
          })
        : undefined;
      try {
        if (completion === 'disabled-before') setFileSearchChoice('saved-chat', false);
        expect(completeFileSearchUpload('late-accepted-upload', 'saved-chat')).toBe(
          completion !== 'disabled-before',
        );
        if (completion === 'disabled-after') setFileSearchChoice('saved-chat', false);
        const enabled = !completion.startsWith('disabled');
        if (!enabled) stale.ephemeralAgent.file_search = true;
        act(() => {
          for (let replay = 0; replay < 2; replay++) {
            if (event === 'created') result.current.createdHandler(createdData, stale);
            else {
              result.current.finalHandler(
                {
                  conversation: saved,
                  requestMessage: stale.userMessage,
                  responseMessage: { ...stale.initialResponse, text: 'Finished reply' },
                },
                stale,
              );
            }
          }
        });
        expect(mockApplyAgentTemplate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            ephemeralAgent: expect.objectContaining({ file_search: enabled, web_search: true }),
          }),
        );
        if (enabled) expect(getFileSearchChoice('saved-chat')?.revision).toBe(previousRevision);
        if (event === 'final' && origin === 'resumable') {
          expect(mockQueueTitleGeneration).toHaveBeenCalledWith('saved-chat');
        } else {
          expect(mockQueueTitleGeneration).not.toHaveBeenCalled();
        }
      } finally {
        storage?.mockRestore();
        release();
        unmount();
        queryClient.clear();
        window.history.replaceState({}, '', '/');
      }
    },
  );

  it('adopts only the composer bound to the acknowledged launch', () => {
    const { result, submission, unmount } = setup();
    const release = registerComposerDraft(0, Constants.NEW_CONVO, 'pending', {});
    bindComposerLaunch(submission.conversation, 0);
    const captured = captureComposerDraft(0, Constants.NEW_CONVO);
    act(() =>
      result.current.createdHandler({ created: true, message: submission.userMessage }, submission),
    );
    expect(captured.conversationId()).toBe('saved-chat');
    expect(getActiveComposerDraftId(0, 'saved-chat')).toBe('pending');
    release();
    unmount();
  });
});

describe('workspace decision at stream acknowledgement', () => {
  beforeEach(() => {
    mockStartupConfig.mockReturnValue({ codeEnvironmentDecisionVersion: 1 });
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          workspaces: [{ id: 'project-a', name: 'Project A' }],
        },
        isLoading: false,
        isError: false,
      },
    ]);
  });

  it.each([
    ['created', true, false],
    ['sync', true, false],
    ['created', false, false],
    ['sync', false, false],
    ['created', true, true],
    ['sync', true, true],
  ] as const)(
    'seals an automatic workspace on %s (decision protocol %s, added pane %s)',
    (event, decisions, isAddedRequest) => {
      mockStartupConfig.mockReturnValue(decisions ? { codeEnvironmentDecisionVersion: 1 } : {});
      const { result, submission, createdData } = setup(initialConversation, isAddedRequest);
      expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
      expect(submission.codeWorkspaces).toEqual([selection]);
      expect(result.current.workspace.locked).toBe(false);

      act(() => {
        if (event === 'created') {
          result.current.createdHandler(createdData, submission);
        } else {
          result.current.syncHandler(
            {
              sync: true,
              thread_id: 'thread',
              conversationId: 'saved-chat',
              requestMessage: submission.userMessage,
              responseMessage: submission.initialResponse,
            },
            submission,
          );
        }
      });

      expect(result.current.conversation).toMatchObject({
        conversationId: 'saved-chat',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      });
      expect(result.current.workspace).toMatchObject({
        locked: true,
        canSubmit: true,
        state: 'ready',
      });
    },
  );

  it('seals a without-attached submission while multiple workspaces remain available', () => {
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          workspaces: [{ id: 'project-a' }, { id: 'project-b' }],
        },
      },
    ]);
    const { result, submission, createdData } = setup();
    expect(submission.codeEnvironmentMode).toBe('without_attached');
    act(() => result.current.createdHandler(createdData, submission));
    expect(result.current.workspace).toMatchObject({
      locked: true,
      canSubmit: true,
      state: 'without_attached',
    });
  });

  it('does not replace a saved decision with a replay of an older submission', () => {
    const { result, submission, createdData } = setup({
      ...initialConversation,
      conversationId: 'saved-chat',
      codeEnvironmentMode: 'without_attached',
    });
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      }),
    );
    expect(result.current.conversation?.codeEnvironmentMode).toBe('without_attached');
    expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
  });

  it.each(['created', 'sync'] as const)(
    'records No workspace on %s for a saved chat that has not granted workspace access',
    (event) => {
      const { result, submission, createdData } = setup({
        ...initialConversation,
        conversationId: 'saved-chat',
      });
      expect(result.current.workspace.locked).toBe(false);
      expect(submission.codeEnvironmentMode).toBe('without_attached');
      expect(submission.codeWorkspaces).toBeUndefined();
      act(() => {
        if (event === 'created') result.current.createdHandler(createdData, submission);
        else
          result.current.syncHandler(
            {
              sync: true,
              thread_id: 'thread',
              conversationId: 'saved-chat',
              requestMessage: submission.userMessage,
              responseMessage: submission.initialResponse,
            },
            submission,
          );
      });
      expect(result.current.conversation?.codeEnvironmentMode).toBe('without_attached');
      expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
      expect(result.current.workspace).toMatchObject({ locked: true, canSubmit: true });
    },
  );

  it('records an explicitly selected first workspace on a previously undecided saved chat', () => {
    const { result, submission, createdData } = setup({
      ...initialConversation,
      conversationId: 'saved-chat',
    });
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      }),
    );
    expect(result.current.conversation?.codeWorkspaces).toEqual([selection]);
    expect(result.current.workspace).toMatchObject({ locked: true, canSubmit: true });
  });

  it('uses the submitted without-attached choice rather than a stale draft selection', () => {
    const { result, submission, createdData } = setup({
      ...initialConversation,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: 'without_attached',
        codeWorkspaces: undefined,
      }),
    );
    expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
    expect(result.current.workspace).toMatchObject({ locked: true, state: 'without_attached' });
  });

  it('leaves an undecided conversation editable when the submission has no decision', () => {
    const { result, submission, createdData } = setup();
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: undefined,
        codeWorkspaces: undefined,
      }),
    );
    expect(result.current.conversation?.codeEnvironmentMode).toBeUndefined();
    expect(result.current.workspace.locked).toBe(false);
  });
});
