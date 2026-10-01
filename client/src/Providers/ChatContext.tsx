import { createContext, useContext } from 'react';
import type { ChatContract } from '~/hooks/Chat/contract';

export const ChatContext = createContext<ChatContract | null>(null);
export const useChatContext = () => {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChatContext must be used within a ChatContext.Provider');
  }
  return ctx;
};
