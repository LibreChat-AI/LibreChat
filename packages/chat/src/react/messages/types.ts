import type { TMessage, TConversation } from 'librechat-data-provider';
import type { Dispatch, MouseEvent, SetStateAction } from 'react';
import type { TAskFunction } from '../../core';

/**
 * Stable chat-context object passed from wrapper components to memo'd message components.
 *
 * This avoids subscribing to ChatContext inside memo'd components, which would bypass React.memo
 * and cause unnecessary re-renders when `isSubmitting` changes during streaming.
 *
 * The `isSubmitting` property should use a getter backed by a ref so it returns the current
 * value at call-time (for callback guards) without being a reactive dependency.
 */
export type TMessageChatContext = {
  ask: TAskFunction;
  index: number;
  regenerate: (message: TMessage, options?: { addedConvo?: TConversation | null }) => void;
  conversation: TConversation | null;
  /** Getter backed by a ref, for reads at call time. Rendering reads the row's
   *  `latestMessageId` prop, which its comparator gates on the row's relation. */
  readonly latestMessageId: string | undefined;
  /** Getter backed by a ref, for reads at call time (see `latestMessageId`). */
  readonly latestMessageDepth: number | undefined;
  handleContinue: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Resolved once per chat from `interface.feedback`; false until the config loads */
  feedbackEnabled: boolean;
  /** Should be a getter backed by a ref, reads current value without triggering re-renders */
  readonly isSubmitting: boolean;
};

/** What a message row is rendered from. */
export type TMessageProps = {
  conversation?: TConversation | null;
  messageId?: string | null;
  message?: TMessage;
  messagesTree?: TMessage[];
  currentEditId: string | number | null;
  isSearchView?: boolean;
  siblingIdx?: number;
  siblingCount?: number;
  setCurrentEditId?: Dispatch<SetStateAction<string | number | null>> | null;
  setSiblingIdx?: ((value: number) => void | Dispatch<SetStateAction<number>>) | null;
};

/** What the thread renders one visible row from. */
export type ThreadMessageProps = {
  message: TMessage;
  /** Position of the message among its siblings, oldest first. */
  siblingIdx: number;
  siblingCount: number;
  /** Shows the sibling at the given position, oldest first. */
  setSiblingIdx: (value: number) => void;
  currentEditId: string | number | null;
  setCurrentEditId: Dispatch<SetStateAction<string | number | null>>;
};
