import { createElement } from 'react';
import { createStore, Provider } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { dataService, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EventSubmission, TConversation, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useIsReplacingConversationCodeEnvironment } from '~/data-provider/CodeEnvironments';
import useEventHandlers from '../useEventHandlers';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getConversationById: jest.fn() } };
});
jest.mock('recoil', () => ({
  useSetRecoilState: () => jest.fn(),
  useRecoilCallback: () => jest.fn(),
}));
jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'saved' }),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/c/saved' }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { abortScroll: 'abortScroll', submissionStartFamily: () => 'start' },
}));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({}) }));
jest.mock('~/Providers', () => ({ useLiveAnnouncer: () => ({ announcePolite: jest.fn() }) }));
jest.mock('~/hooks/Agents', () => ({ useApplyAgentTemplate: () => jest.fn() }));
jest.mock('~/hooks/Chat/useFocusRegeneratedResponse', () => () => jest.fn());
jest.mock('../useContentHandler', () => () => ({
  contentHandler: jest.fn(),
  resetContentHandler: jest.fn(),
}));
jest.mock('../useAttachmentHandler', () => () => jest.fn());
jest.mock('../useStepHandler', () => () => ({
  stepHandler: jest.fn(),
  clearStepMaps: jest.fn(),
  resetSubagentAtoms: jest.fn(),
  resetPtcAtoms: jest.fn(),
  prunePtcTraces: jest.fn(),
  syncStepMessage: jest.fn(),
  cancelPendingDeltaFlush: jest.fn(),
  flushPendingDeltas: jest.fn(),
}));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/CodeEnvironments'),
  startupConfigKey: ['startup'],
  queueTitleGeneration: jest.fn(),
  markTitleGenerationProcessed: jest.fn(),
}));
jest.mock('~/utils', () => ({
  logger: { log: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
  setDraft: jest.fn(),
  scrollToEnd: jest.fn(),
  getConversationDraftId: jest.fn(),
  hasRealTitle: () => false,
  withoutListFlags: (value: unknown) => value,
  setDocumentTitle: jest.fn(),
  requestChatFocus: jest.fn(),
  getAllContentText: () => '',
  upsertConvoInAllQueries: jest.fn(),
  updateConvoInAllQueries: jest.fn(),
  removeConvoFromAllQueries: jest.fn(),
  findConversationInInfinite: () => undefined,
  preserveStreamedContentIdentity: (_old: unknown, current: unknown) => current,
  isEmptyContentPart: () => false,
  getPartKeyIndex: jest.fn(),
  CONVERSATION_LIST_KEYS: [],
}));

const attempted = {
  codeEnvironmentMode: 'attached' as const,
  codeWorkspaces: [{ environmentId: 'attempted', workspaceId: 'repo' }],
};
const user = {
  conversationId: 'saved',
  messageId: 'user',
  parentMessageId: 'root',
  text: 'run',
  isCreatedByUser: true,
} as TMessage;
const response = {
  conversationId: 'saved',
  messageId: 'response',
  parentMessageId: 'user',
  text: '',
  content: [],
  isCreatedByUser: false,
} as TMessage;
const submission = {
  isTemporary: false,
  endpointOption: { endpoint: EModelEndpoint.agents },
  conversation: { conversationId: 'saved', endpoint: EModelEndpoint.agents },
  userMessage: user,
  initialResponse: response,
  messages: [],
  ...attempted,
} as EventSubmission;

describe('local cancellation decision reconciliation', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it.each(['streamed', 'minimal', 'navigated'])(
    'does not use a synthetic %s cancel as evidence that the server settled',
    async (kind) => {
      const read = jest.spyOn(dataService, 'getConversationById');
      const store = createStore();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(
          Provider,
          { store },
          createElement(QueryClientProvider, { client: queryClient }, children),
        );
      const messages = kind === 'minimal' ? [] : [user, response];
      let current = { ...submission.conversation, ...attempted } as TConversation;
      const setConversation = jest.fn((update) => {
        current = typeof update === 'function' ? update(current) : update;
      });
      const setIsSubmitting = jest.fn();
      const newConversation = jest.fn();
      const { result } = renderHook(
        () => ({
          handlers: useEventHandlers({
            getMessages: () => (kind === 'navigated' ? [] : messages),
            setMessages: jest.fn(),
            setCompleted: jest.fn(),
            setConversation,
            setIsSubmitting,
            setShowStopButton: jest.fn(),
            newConversation,
          }),
          blocked: useIsReplacingConversationCodeEnvironment('saved'),
          otherBlocked: useIsReplacingConversationCodeEnvironment('other'),
        }),
        { wrapper },
      );
      const currentOther = { conversationId: 'other', ...attempted } as TConversation;
      if (kind === 'navigated') current = currentOther;

      await act(async () => {
        await result.current.handlers.abortConversation('saved', submission, messages);
      });
      expect(read).not.toHaveBeenCalled();
      expect(result.current.blocked).toBe(false);
      expect(result.current.otherBlocked).toBe(false);
      if (kind === 'minimal') expect(newConversation).toHaveBeenCalled();
      if (kind !== 'navigated') expect(setIsSubmitting).toHaveBeenCalledWith(false);

      if (kind === 'navigated') expect(current).toBe(currentOther);
      else expect(current.codeWorkspaces).toEqual(attempted.codeWorkspaces);
    },
  );
});
