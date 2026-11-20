import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { appChatHost } from '../ChatHostContext';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getMessagesByConvoId: jest.fn() },
  };
});

const getMessages = dataService.getMessagesByConvoId as jest.MockedFunction<
  typeof dataService.getMessagesByConvoId
>;

const messages = [{ messageId: 'm-1', conversationId: 'convo-1' }] as TMessage[];

function renderMessages(queryClient: QueryClient, conversationId: string | undefined) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return renderHook(() => appChatHost.useMessages(conversationId, { isStreaming: false }), {
    wrapper,
  });
}

describe('appChatHost.useMessages', () => {
  beforeEach(() => {
    getMessages.mockReset();
    getMessages.mockResolvedValue(messages);
  });

  it('loads the conversation messages and reports when they settle', async () => {
    const { result } = renderMessages(new QueryClient(), 'convo-1');

    expect(result.current).toEqual({ messages: null, isLoading: true, isFetching: true });
    await waitFor(() =>
      expect(result.current).toEqual({ messages, isLoading: false, isFetching: false }),
    );
    expect(getMessages).toHaveBeenCalledWith('convo-1', { toolPreviews: true });
  });

  describe('for a second reader of the conversation', () => {
    const wrapperFor = (queryClient: QueryClient) =>
      function Wrapper({ children }: { children: React.ReactNode }) {
        return (
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
          </MemoryRouter>
        );
      };
    const follow = () => appChatHost.useMessages('convo-1', { isStreaming: false, enabled: false });

    it('follows what the session loads, without a load of its own', async () => {
      const { result } = renderHook(
        () => ({
          reader: follow(),
          session: appChatHost.useMessages('convo-1', { isStreaming: false }),
        }),
        { wrapper: wrapperFor(new QueryClient()) },
      );

      expect(result.current.reader).toMatchObject({ messages: null, isLoading: true });
      await waitFor(() => expect(result.current.session.isLoading).toBe(false));
      expect(result.current.reader).toMatchObject({ messages, isLoading: false });
      expect(getMessages).toHaveBeenCalledTimes(1);
    });

    it('loads nothing where no session does', async () => {
      const { result } = renderHook(follow, { wrapper: wrapperFor(new QueryClient()) });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getMessages).not.toHaveBeenCalled();
      expect(result.current.messages).toBeNull();
    });
  });

  it('serves a warm cache at once while it revalidates in the background', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], messages);
    queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, 'convo-1'] });

    const { result } = renderMessages(queryClient, 'convo-1');

    expect(result.current).toEqual({ messages, isLoading: false, isFetching: true });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
  });

  it.each([
    ['no conversation', undefined],
    ['search', Constants.SEARCH as string],
  ])('loads nothing for %s', (_label, conversationId) => {
    const { result } = renderMessages(new QueryClient(), conversationId);

    expect(result.current.messages).toBeNull();
    expect(result.current.isFetching).toBe(false);
    expect(getMessages).not.toHaveBeenCalled();
  });
});
