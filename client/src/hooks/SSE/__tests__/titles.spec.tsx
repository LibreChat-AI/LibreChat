import { useState } from 'react';
import { Provider } from 'jotai';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { EventSubmission, TConversation } from 'librechat-data-provider';
import { markTitleGenerationProcessed } from '~/data-provider/SSE/queries';
import useEventHandlers from '../useEventHandlers';

jest.mock('~/hooks/Agents', () => ({ useApplyAgentTemplate: () => jest.fn() }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ token: 'test' }) }));
jest.mock('~/Providers', () => ({ useLiveAnnouncer: () => ({ announcePolite: jest.fn() }) }));
jest.mock('../useContentHandler', () => () => ({}));
jest.mock('../useAttachmentHandler', () => () => jest.fn());
jest.mock('../useStepHandler', () => () => ({
  resetSubagentAtoms: jest.fn(),
  resetPtcAtoms: jest.fn(),
}));

const initialConversation = {
  conversationId: 'saved-chat',
  endpoint: EModelEndpoint.agents,
  title: 'Old title',
} as TConversation;
const submission: EventSubmission = {
  isTemporary: false,
  endpointOption: { endpoint: EModelEndpoint.agents },
  conversation: initialConversation,
  messages: [],
  userMessage: {
    messageId: 'user-1',
    text: 'Hello',
    sender: 'User',
    isCreatedByUser: true,
    parentMessageId: 'previous-reply',
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
};

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.conversation, 'saved-chat'], initialConversation);
  queryClient.setQueryData([QueryKeys.allConversations], {
    pages: [{ conversations: [initialConversation], nextCursor: null }],
    pageParams: [],
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider>
        <RecoilRoot>
          <MemoryRouter initialEntries={['/c/saved-chat']}>{children}</MemoryRouter>
        </RecoilRoot>
      </Provider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const [conversation, setConversation] = useState<TConversation | null>(initialConversation);
      const handlers = useEventHandlers({
        setConversation,
        setMessages: jest.fn(),
        getMessages: () => [submission.userMessage, submission.initialResponse],
        setCompleted: jest.fn(),
        setIsSubmitting: jest.fn(),
        setShowStopButton: jest.fn(),
      });
      return { conversation, ...handlers };
    },
    { wrapper },
  );
  const rename = (title: string) => {
    queryClient.setQueryData([QueryKeys.conversation, 'saved-chat'], {
      ...initialConversation,
      title,
      titleSetByUser: true,
    });
  };
  return { ...hook, queryClient, rename };
}

describe('stream title reconciliation', () => {
  it.each(['created', 'sync'] as const)(
    'keeps a rename on %s, even with a root parent',
    (frame) => {
      const { result, rename } = setup();
      rename('Renamed chat');
      const rootSubmission = {
        ...submission,
        userMessage: { ...submission.userMessage, parentMessageId: String(Constants.NO_PARENT) },
      };
      act(() => {
        if (frame === 'created') {
          result.current.createdHandler(
            { created: true, message: rootSubmission.userMessage },
            rootSubmission,
          );
        } else {
          result.current.syncHandler(
            {
              sync: true,
              conversationId: 'saved-chat',
              thread_id: 'thread',
              requestMessage: rootSubmission.userMessage,
              responseMessage: rootSubmission.initialResponse,
            },
            rootSubmission,
          );
        }
      });
      expect(result.current.conversation?.title).toBe('Renamed chat');
    },
  );

  it.each(['Old title', 'New Chat', null])(
    'keeps an in-flight rename over final title %s',
    (title) => {
      const { result, queryClient, rename } = setup();
      act(() =>
        result.current.createdHandler(
          { created: true, message: submission.userMessage },
          submission,
        ),
      );
      rename('Renamed while running');
      act(() =>
        result.current.finalHandler(
          {
            conversation: { ...initialConversation, title },
            requestMessage: submission.userMessage,
            responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
          },
          submission,
        ),
      );
      expect(result.current.conversation?.title).toBe('Renamed while running');
      expect(
        queryClient.getQueryData<TConversation>([QueryKeys.conversation, 'saved-chat'])?.title,
      ).toBe('Renamed while running');
    },
  );

  it('ignores a pending or replayed automatic title after an explicit rename', () => {
    const { result, queryClient, rename } = setup();
    rename('New Chat');
    markTitleGenerationProcessed('saved-chat');
    act(() =>
      result.current.titleHandler({
        event: 'title',
        data: { conversationId: 'saved-chat', title: 'Late generated title' },
      }),
    );
    expect(
      queryClient.getQueryData<TConversation>([QueryKeys.conversation, 'saved-chat'])?.title,
    ).toBe('New Chat');
  });

  it('does not replace a manual title when an old title event is replayed after reload', () => {
    const { result, queryClient } = setup();
    queryClient.setQueryData([QueryKeys.conversation, 'saved-chat'], {
      ...initialConversation,
      title: 'New Chat',
      titleSetByUser: true,
    });
    act(() =>
      result.current.titleHandler({
        event: 'title',
        data: { conversationId: 'saved-chat', title: 'Old generated title' },
      }),
    );
    expect(
      queryClient.getQueryData<TConversation>([QueryKeys.conversation, 'saved-chat'])?.title,
    ).toBe('New Chat');
  });

  it('accepts a server-owned rename over an unowned stale point record', () => {
    const { result } = setup();
    act(() =>
      result.current.finalHandler(
        {
          conversation: { ...initialConversation, title: 'Persisted rename', titleSetByUser: true },
          requestMessage: submission.userMessage,
          responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
        },
        submission,
      ),
    );
    expect(result.current.conversation?.title).toBe('Persisted rename');
  });

  it.each([
    [1, 2],
    [3, 2],
  ])(
    'chooses the newer manual revision (cache %s, server %s)',
    (cachedRevision, serverRevision) => {
      const { result, queryClient } = setup();
      queryClient.setQueryData([QueryKeys.conversation, 'saved-chat'], {
        ...initialConversation,
        title: 'Cached rename',
        titleSetByUser: true,
        titleRevision: cachedRevision,
      });
      act(() =>
        result.current.finalHandler(
          {
            conversation: {
              ...initialConversation,
              title: 'Remote rename',
              titleSetByUser: true,
              titleRevision: serverRevision,
            },
            requestMessage: submission.userMessage,
            responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
          },
          submission,
        ),
      );
      const expected = {
        title: serverRevision >= cachedRevision ? 'Remote rename' : 'Cached rename',
        titleSetByUser: true,
        titleRevision: Math.max(cachedRevision, serverRevision),
      };
      expect(result.current.conversation).toEqual(expect.objectContaining(expected));
      expect(queryClient.getQueryData([QueryKeys.conversation, 'saved-chat'])).toEqual(
        expect.objectContaining(expected),
      );
      expect(
        queryClient.getQueryData<{ pages: { conversations: TConversation[] }[] }>([
          QueryKeys.allConversations,
        ])?.pages[0].conversations[0],
      ).toEqual(expect.objectContaining(expected));
    },
  );

  it('preserves a sidebar-only manual placeholder on a replayed title event', () => {
    const { result, queryClient } = setup();
    queryClient.removeQueries([QueryKeys.conversation, 'saved-chat']);
    queryClient.setQueryData([QueryKeys.allConversations], {
      pages: [
        {
          conversations: [
            { ...initialConversation, title: 'New Chat', titleSetByUser: true, titleRevision: 1 },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [],
    });
    act(() =>
      result.current.titleHandler({
        event: 'title',
        data: { conversationId: 'saved-chat', title: 'Old generated title' },
      }),
    );
    expect(result.current.conversation?.title).toBe('New Chat');
    expect(
      queryClient.getQueryData<{ pages: { conversations: TConversation[] }[] }>([
        QueryKeys.allConversations,
      ])?.pages[0].conversations[0],
    ).toEqual(
      expect.objectContaining({
        title: 'New Chat',
        titleSetByUser: true,
        titleRevision: 1,
      }),
    );
  });

  it('accepts a newer remote rename to the default placeholder', () => {
    const { result, queryClient } = setup();
    queryClient.setQueryData([QueryKeys.conversation, 'saved-chat'], {
      ...initialConversation,
      title: 'First rename',
      titleSetByUser: true,
      titleRevision: 1,
    });
    act(() =>
      result.current.finalHandler(
        {
          conversation: {
            ...initialConversation,
            title: 'New Chat',
            titleSetByUser: true,
            titleRevision: 2,
          },
          requestMessage: submission.userMessage,
          responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
        },
        submission,
      ),
    );
    expect(result.current.conversation).toEqual(
      expect.objectContaining({
        title: 'New Chat',
        titleSetByUser: true,
        titleRevision: 2,
      }),
    );
  });

  it('accepts an authoritative legacy final title over an unowned stale cache', () => {
    const { result, queryClient } = setup();
    act(() =>
      result.current.finalHandler(
        {
          conversation: { ...initialConversation, title: 'Legacy remote rename' },
          requestMessage: submission.userMessage,
          responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
        },
        submission,
      ),
    );
    expect(result.current.conversation?.title).toBe('Legacy remote rename');
    expect(
      queryClient.getQueryData<TConversation>([QueryKeys.conversation, 'saved-chat'])?.title,
    ).toBe('Legacy remote rename');
  });

  it('does not propagate an older owned point snapshot over a newer list rename', async () => {
    const { result, queryClient } = setup();
    queryClient.clear();
    const old = {
      ...initialConversation,
      title: 'Old owned title',
      titleSetByUser: true,
      titleRevision: 1,
      lastResponseAt: '2026-08-16T10:05:00.000Z',
    };
    await queryClient.fetchQuery([QueryKeys.allConversations], async () => ({
      pages: [
        {
          conversations: [{ ...old, title: 'New owned title', titleRevision: 2 }],
          nextCursor: null,
        },
      ],
      pageParams: [],
    }));
    await queryClient.fetchQuery([QueryKeys.conversation, 'saved-chat'], async () => old);
    act(() =>
      result.current.finalHandler(
        {
          conversation: old,
          requestMessage: submission.userMessage,
          responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
        },
        submission,
      ),
    );
    const expected = { title: 'New owned title', titleSetByUser: true, titleRevision: 2 };
    expect(result.current.conversation).toEqual(expect.objectContaining(expected));
    expect(queryClient.getQueryData([QueryKeys.conversation, 'saved-chat'])).toEqual(
      expect.objectContaining(expected),
    );
    expect(
      queryClient.getQueryData<{ pages: { conversations: TConversation[] }[] }>([
        QueryKeys.allConversations,
      ])?.pages[0].conversations[0],
    ).toEqual(expect.objectContaining(expected));
  });

  it('does not mistake a processed automatic title for a manual placeholder rename', () => {
    const { result, queryClient } = setup();
    markTitleGenerationProcessed('saved-chat');
    queryClient.clear();
    queryClient.setQueryData([QueryKeys.conversation, 'saved-chat'], {
      ...initialConversation,
      title: 'New Chat',
    });
    act(() =>
      result.current.finalHandler(
        {
          conversation: { ...initialConversation, title: 'Generated title' },
          requestMessage: submission.userMessage,
          responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
        },
        submission,
      ),
    );
    expect(result.current.conversation?.title).toBe('Generated title');
  });

  it('accepts the final server title when no local title is available', () => {
    const { result, queryClient } = setup();
    queryClient.clear();
    act(() =>
      result.current.finalHandler(
        {
          conversation: { conversationId: 'new-saved-chat', title: 'Generated title' },
          requestMessage: submission.userMessage,
          responseMessage: { ...submission.initialResponse, text: 'Finished reply' },
        },
        submission,
      ),
    );
    expect(result.current.conversation?.title).toBe('Generated title');
  });
});
