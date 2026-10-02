import React, { createContext, useContext, useMemo } from 'react';
import { useChatContext } from './ChatContext';

interface MessagesViewContextValue {
  /** Core conversation data */
  conversation: ReturnType<typeof useChatContext>['conversation'];
  conversationId: string | null | undefined;

  /** Submission and control states */
  isSubmitting: ReturnType<typeof useChatContext>['isSubmitting'];
  abortScroll: ReturnType<typeof useChatContext>['abortScroll'];
  setAbortScroll: ReturnType<typeof useChatContext>['setAbortScroll'];

  /** Message operations */
  ask: ReturnType<typeof useChatContext>['ask'];
  regenerate: ReturnType<typeof useChatContext>['regenerate'];
  handleContinue: ReturnType<typeof useChatContext>['handleContinue'];

  /** Message state management */
  index: ReturnType<typeof useChatContext>['index'];
  latestMessageId: ReturnType<typeof useChatContext>['latestMessageId'];
  latestMessageDepth: ReturnType<typeof useChatContext>['latestMessageDepth'];
  getMessages: ReturnType<typeof useChatContext>['getMessages'];
  setMessages: ReturnType<typeof useChatContext>['setMessages'];
}

type MessagesOperations = Pick<
  MessagesViewContextValue,
  'ask' | 'regenerate' | 'handleContinue' | 'getMessages' | 'setMessages'
>;

const MessagesViewContext = createContext<MessagesViewContextValue | undefined>(undefined);

/**
 * The view's operations alone. They are referentially stable, so components that
 * only call them (every message row's hover actions) are not re-rendered by the
 * submission and tail changes the combined context carries on each send.
 */
const MessagesOperationsContext = createContext<MessagesOperations | undefined>(undefined);

/**
 * Whether the view is generating, alone. A boolean context re-renders its consumers
 * only when a send starts or settles, which is when every row's rerun controls flip.
 */
const MessagesSubmittingContext = createContext(false);

// Export the contexts so they can be provided by other providers (e.g., ShareMessagesProvider)
export { MessagesViewContext, MessagesOperationsContext, MessagesSubmittingContext };
export type { MessagesViewContextValue, MessagesOperations };

export function MessagesViewProvider({ children }: { children: React.ReactNode }) {
  const chatContext = useChatContext();

  const {
    ask,
    index,
    regenerate,
    isSubmitting,
    conversation,
    latestMessageId,
    latestMessageDepth,
    setAbortScroll,
    handleContinue,
    abortScroll,
    getMessages,
    setMessages,
  } = chatContext;

  /** Memoize conversation-related values */
  const conversationValues = useMemo(
    () => ({
      conversation,
      conversationId: conversation?.conversationId,
    }),
    [conversation],
  );

  /** Memoize submission states */
  const submissionStates = useMemo(
    () => ({
      abortScroll,
      isSubmitting,
      setAbortScroll,
    }),
    [isSubmitting, abortScroll, setAbortScroll],
  );

  /** Memoize message operations (these are typically stable references) */
  const messageOperations = useMemo(
    () => ({
      ask,
      regenerate,
      getMessages,
      setMessages,
      handleContinue,
    }),
    [ask, regenerate, handleContinue, getMessages, setMessages],
  );

  /** Memoize message state values */
  const messageState = useMemo(
    () => ({
      index,
      latestMessageId,
      latestMessageDepth,
    }),
    [index, latestMessageId, latestMessageDepth],
  );

  /** Combine all values into final context value */
  const contextValue = useMemo<MessagesViewContextValue>(
    () => ({
      ...conversationValues,
      ...submissionStates,
      ...messageOperations,
      ...messageState,
    }),
    [conversationValues, submissionStates, messageOperations, messageState],
  );

  return (
    <MessagesOperationsContext.Provider value={messageOperations}>
      <MessagesSubmittingContext.Provider value={isSubmitting}>
        <MessagesViewContext.Provider value={contextValue}>{children}</MessagesViewContext.Provider>
      </MessagesSubmittingContext.Provider>
    </MessagesOperationsContext.Provider>
  );
}

/** Whether the view is generating; false outside a live messages view. */
export function useMessagesIsSubmitting(): boolean {
  return useContext(MessagesSubmittingContext);
}

export function useMessagesViewContext() {
  const context = useContext(MessagesViewContext);
  if (!context) {
    throw new Error('useMessagesViewContext must be used within MessagesViewProvider');
  }
  return context;
}

/** Hook for components that only need conversation data */
export function useMessagesConversation() {
  const { conversation, conversationId } = useMessagesViewContext();
  return useMemo(() => ({ conversation, conversationId }), [conversation, conversationId]);
}

/** Hook for components that only need submission states */
export function useMessagesSubmission() {
  const { isSubmitting, abortScroll, setAbortScroll } = useMessagesViewContext();
  return useMemo(
    () => ({ isSubmitting, abortScroll, setAbortScroll }),
    [isSubmitting, abortScroll, setAbortScroll],
  );
}

/** Hook for components that only need message operations */
export function useMessagesOperations(): MessagesOperations {
  const context = useContext(MessagesOperationsContext);
  if (!context) {
    throw new Error('useMessagesOperations must be used within MessagesViewProvider');
  }
  return context;
}

const NOOP_OPS: MessagesOperations = {
  ask: () => {},
  regenerate: () => {},
  handleContinue: () => {},
  getMessages: () => undefined,
  setMessages: () => {},
};

/**
 * Hook for components that need message operations but may render outside MessagesViewProvider
 * (e.g. the /search route). Returns no-op stubs when the provider is absent — UI actions will
 * be silently discarded rather than crashing. Callers must use optional chaining on
 * `getMessages()` results, as it returns `undefined` outside the provider.
 */
export function useOptionalMessagesOperations(): MessagesOperations {
  return useContext(MessagesOperationsContext) ?? NOOP_OPS;
}

/**
 * Hook for components that need conversation data but may render outside MessagesViewProvider
 * (e.g. the /search route). Returns `undefined` for both fields when the provider is absent.
 */
export function useOptionalMessagesConversation() {
  const context = useContext(MessagesViewContext);
  const conversation = context?.conversation;
  const conversationId = context?.conversationId;
  return useMemo(() => ({ conversation, conversationId }), [conversation, conversationId]);
}

/** Hook for components that only need message state */
export function useMessagesState() {
  const { index, latestMessageId, latestMessageDepth } = useMessagesViewContext();
  return useMemo(
    () => ({ index, latestMessageId, latestMessageDepth }),
    [index, latestMessageId, latestMessageDepth],
  );
}
