import { createContext, useContext } from 'react';
import type { Context } from 'react';

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
