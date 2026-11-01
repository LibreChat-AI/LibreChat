import type { TMessage, TConversation, EventSubmission } from 'librechat-data-provider';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { NewConversationParams } from '../../chat/contract';
import type { AttachmentHandler } from '../attachments';
import type { EventServices } from '../services';

/** The pane a set of stream event handlers writes to. */
export type EventHandlerParams = {
  isAddedRequest?: boolean;
  runIndex?: number;
  setCompleted: Dispatch<SetStateAction<Set<unknown>>>;
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
  setIsSubmitting: Dispatch<SetStateAction<boolean>>;
  setConversation?: Dispatch<SetStateAction<TConversation | null>>;
  newConversation?: (params: NewConversationParams) => void | TConversation;
  setShowStopButton: Dispatch<SetStateAction<boolean>>;
};

/** What the stream event handlers share: the pane they write to and the app around it. */
export type EventHandlerContext = Required<
  Pick<EventHandlerParams, 'isAddedRequest' | 'runIndex'>
> &
  Pick<
    EventHandlerParams,
    | 'setMessages'
    | 'getMessages'
    | 'setCompleted'
    | 'setConversation'
    | 'setIsSubmitting'
    | 'setShowStopButton'
  > & {
    queryClient: QueryClient;
    /** Clears the elapsed anchor on every terminal path. */
    setSubmissionStart: (start: number | null) => void;
    /** The app's caches, drafts, route, focus, templates and transport, grouped by owner. */
    services: EventServices;
    lastAnnouncementTimeRef: MutableRefObject<number>;
    /** Re-stages request context when an early abort restores the draft. */
    restorePendingContext: (
      convoId: string,
      quotes?: string[],
      reasoningOverride?: TMessage['reasoningOverride'],
    ) => void;
    reconcileFailedCodeDecision: (submission: EventSubmission, conversationId?: string) => void;
    recoverConversation: (conversationId: string, submission: EventSubmission) => void;
    attachmentHandler: AttachmentHandler;
    /** The saved id a new chat's own run moves to, so its subagent atoms survive the move. */
    preserveSubagentAtomsForNewConvoIdRef: MutableRefObject<string | null>;
  };
