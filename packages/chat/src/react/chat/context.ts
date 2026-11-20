import { createContext, useContext } from 'react';
import type { Context } from 'react';
import type { ChatContract } from './contract';

/** The chat contract of the nearest pane, served by the host's chat provider. */
export const ChatContext: Context<ChatContract | null> = createContext<ChatContract | null>(null);

export const useChatContext = (): ChatContract => {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChatContext must be used within a ChatContext.Provider');
  }
  return ctx;
};
