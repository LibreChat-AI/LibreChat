import { RecoilRoot } from 'recoil';
import { render, screen, waitFor } from '@testing-library/react';
import { dataService, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { ShareContext } from '~/Providers/ShareContext';
import { agentAuthor, messageAuthor } from './author';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getAIEndpoints: jest.fn().mockResolvedValue({}) },
  };
});

const historicalMessage: TMessage = {
  messageId: 'parent',
  parentMessageId: null,
  conversationId: 'shared',
  isCreatedByUser: false,
  text: '',
  sender: 'Historical Parent',
  model: 'agent_deleted',
  endpoint: EModelEndpoint.agents,
  iconURL: '/historical.png',
};

it('draws public-share authors without private requests and enables them again in chat', async () => {
  const getEndpoints = jest.mocked(dataService.getAIEndpoints);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const child = agentAuthor(undefined, 'Agent');
  const parent = messageAuthor(historicalMessage, undefined, 'Parent agent');
  const tree = (isSharedConvo: boolean) => (
    <RecoilRoot>
      <QueryClientProvider client={queryClient}>
        <ShareContext.Provider value={{ isSharedConvo }}>
          {child.icon}
          {parent.icon}
        </ShareContext.Provider>
      </QueryClientProvider>
    </RecoilRoot>
  );
  const { rerender } = render(tree(true));

  expect(screen.getByRole('img', { name: 'Historical Parent' })).toHaveAttribute(
    'src',
    '/historical.png',
  );
  expect(queryClient.isFetching()).toBe(0);
  expect(getEndpoints).not.toHaveBeenCalled();

  rerender(tree(false));
  await waitFor(() => expect(getEndpoints).toHaveBeenCalledTimes(1));
  queryClient.clear();
});
