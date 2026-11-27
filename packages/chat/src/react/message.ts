import { createContext, createElement, useContext, useMemo } from 'react';
import type { Context, ReactNode } from 'react';

/** The message a part renders in, as the view rendering it reports. */
export type MessageContext = {
  messageId: string;
  nextType?: string;
  partIndex?: number;
  isExpanded: boolean;
  conversationId?: string | null;
  /** Submission state for cursor display - only true for latest message when submitting */
  isSubmitting?: boolean;
  /** Whether this is the latest message in the conversation */
  isLatestMessage?: boolean;
};

export const MessageContext: Context<MessageContext> = createContext<MessageContext>(
  {} as MessageContext,
);
export const useMessageContext = (): MessageContext => useContext(MessageContext);

/** Provides the surrounding message to one part, at that part's position in the message's content. */
export function MessagePartIndex({
  index,
  children,
}: {
  index: number;
  children?: ReactNode;
}): ReactNode {
  const message = useMessageContext();
  const value = useMemo(() => ({ ...message, partIndex: index }), [message, index]);
  return createElement(MessageContext.Provider, { value }, children);
}
