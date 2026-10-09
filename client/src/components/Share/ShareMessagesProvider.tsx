import React, { useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { MessagesViewContextValue, MessagesOperations } from '~/Providers/MessagesViewContext';
import { MessagesViewContext, MessagesOperationsContext } from '~/Providers/MessagesViewContext';

interface ShareMessagesProviderProps {
  messages: TMessage[];
  children: React.ReactNode;
}

/**
 * Minimal MessagesViewContext provider for share view.
 * Provides conversation data needed by message components.
 * Uses the same MessagesViewContext as the main app for compatibility with existing hooks.
 *
 * Note: conversationId is set to undefined because share view is read-only and doesn't
 * need to check Recoil state for in-flight messages during streaming.
 */
export function ShareMessagesProvider({ messages, children }: ShareMessagesProviderProps) {
  const contextValue = useMemo<MessagesViewContextValue>(
    () => ({
      conversation: null,
      conversationId: undefined,
      // Read-only so app bridges never proxy auth-bearing calls against the viewer's MCP servers.
      readOnly: true,
      // These are required by the context but not used in share view
      ask: () => {},
      regenerate: () => {},
      handleContinue: () => {},
      latestMessageId: messages[messages.length - 1]?.messageId,
      latestMessageDepth: messages[messages.length - 1]?.depth,
      isSubmitting: false,
      abortScroll: false,
      setAbortScroll: () => {},
      index: 0,
      getMessages: () => messages,
      setMessages: () => {},
    }),
    [messages],
  );

  const operations = useMemo<MessagesOperations>(
    () => ({
      ask: contextValue.ask,
      regenerate: contextValue.regenerate,
      handleContinue: contextValue.handleContinue,
      getMessages: contextValue.getMessages,
      setMessages: contextValue.setMessages,
    }),
    [contextValue],
  );

  return (
    <MessagesOperationsContext.Provider value={operations}>
      <MessagesViewContext.Provider value={contextValue}>{children}</MessagesViewContext.Provider>
    </MessagesOperationsContext.Provider>
  );
}
