import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Constants } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MarketplaceRoute from '../Marketplace';

const mockClearAllConversations = jest.fn();
const mockClearMessagesCache = jest.fn();

jest.mock('~/hooks', () => ({
  useChatHelpers: jest.fn(() => ({})),
}));

jest.mock('~/utils/messages', () => ({
  clearMessagesCache: (...args: unknown[]) => mockClearMessagesCache(...args),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { useClearConvoState: () => mockClearAllConversations },
}));

const START_LABEL = 'start';

/** Stands in for the marketplace so the assertion is about what the shell supplies. */
jest.mock('~/components/Agents/Marketplace', () => () => {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { useMarketplaceHost: useHost } = require('~/components/Agents/MarketplaceContext');
  const { resetNewConversation } = useHost();
  return <button type="button" aria-label="start" onClick={resetNewConversation} />;
});

describe('MarketplaceRoute', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resets the open conversations and the new-chat transcript for the marketplace', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MarketplaceRoute />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: START_LABEL }));

    /* `true` clears every parallel conversation a multi-conversation session left open,
       not just the active one, so an agent started from a card is a new conversation
       rather than another column beside them. */
    expect(mockClearAllConversations).toHaveBeenCalledWith(true);
    expect(mockClearMessagesCache).toHaveBeenCalledWith(expect.anything(), Constants.NEW_CONVO);
  });
});
