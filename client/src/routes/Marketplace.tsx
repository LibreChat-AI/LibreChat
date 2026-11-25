import React, { useMemo } from 'react';
import { Constants } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { MarketplaceHost } from '~/components/Agents/MarketplaceContext';
import { MarketplaceProvider } from '~/components/Agents/MarketplaceContext';
import AgentMarketplace from '~/components/Agents/Marketplace';
import { clearMessagesCache } from '~/utils/messages';
import store from '~/store';

/**
 * The shell side of the marketplace: it owns the conversation state that starting an
 * agent from a card resets, and hands the feature an operation rather than letting it
 * reach into `~/store`. Keeping this here is what lets the marketplace move to its own
 * workspace without carrying the app's conversation store with it.
 */
export default function MarketplaceRoute() {
  const queryClient = useQueryClient();
  const clearAllConversations = store.useClearConvoState();
  const host = useMemo<MarketplaceHost>(
    () => ({
      resetNewConversation: () => {
        /* `true` clears every parallel conversation a multi-conversation session left
           open, not just the active one. */
        clearAllConversations(true);
        clearMessagesCache(queryClient, Constants.NEW_CONVO);
      },
    }),
    [clearAllConversations, queryClient],
  );

  return (
    <MarketplaceProvider host={host}>
      <AgentMarketplace />
    </MarketplaceProvider>
  );
}
