import React from 'react';
import { ChatContext } from '~/Providers';
import { useChatHelpers } from '~/hooks';

/**
 * Minimal marketplace provider that provides only what SidePanel actually needs
 * Replaces the bloated 44-function ChatContext implementation
 */
interface MarketplaceProviderProps {
  children: React.ReactNode;
  host: MarketplaceHost;
}

/**
 * App-global chat operations the marketplace invokes but does not own.
 *
 * Starting an agent from a card is a new conversation with that agent, not another
 * column beside whatever was already open and not the transcript the last new chat
 * left behind. Both of those live in the app's conversation state, so the host
 * performs the reset and the marketplace only asks for it. The host arrives as a prop
 * rather than being built here: a context this feature fills from `~/store` itself
 * would still be the feature reaching for shell state, and would not survive the move
 * to its own workspace.
 */
export interface MarketplaceHost {
  resetNewConversation: () => void;
}

export const MarketplaceHostContext = React.createContext<MarketplaceHost | null>(null);

/** Throws rather than defaulting to a no-op: a missing host would silently leave the
 *  previous conversations open, which is the whole reason the reset exists. */
export function useMarketplaceHost(): MarketplaceHost {
  const host = React.useContext(MarketplaceHostContext);
  if (host == null) {
    throw new Error('useMarketplaceHost must be used inside a MarketplaceProvider');
  }
  return host;
}

export const MarketplaceProvider: React.FC<MarketplaceProviderProps> = ({ children, host }) => {
  const chatHelpers = useChatHelpers(0, 'new');

  return (
    <ChatContext.Provider value={chatHelpers}>
      <MarketplaceHostContext.Provider value={host}>{children}</MarketplaceHostContext.Provider>
    </ChatContext.Provider>
  );
};
