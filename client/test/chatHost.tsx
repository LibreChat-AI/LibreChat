import React from 'react';
import { ChatHostProvider } from '@librechat/chat/react';
import { appChatHost } from '~/Providers/ChatHostContext';

/** Mounts the app's chat host the way `routes/Root.tsx` does, for specs that render the chat
 *  hooks outside the app shell. Import it after the spec's module mocks so the host uses them. */
export function ChatHostTestProvider({ children }: { children?: React.ReactNode }) {
  return <ChatHostProvider host={appChatHost}>{children}</ChatHostProvider>;
}
