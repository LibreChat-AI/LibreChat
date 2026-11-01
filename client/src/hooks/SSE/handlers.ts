import type { TMessage, EventSubmission } from 'librechat-data-provider';
import type { EventServices } from '@librechat/chat/react';
import type { QueryClient } from '@tanstack/react-query';
import type { MutableRefObject } from 'react';
import type useAttachmentHandler from './useAttachmentHandler';
import type { EventHandlerParams } from './useEventHandlers';

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
    attachmentHandler: ReturnType<typeof useAttachmentHandler>;
    /** The saved id a new chat's own run moves to, so its subagent atoms survive the move. */
    preserveSubagentAtomsForNewConvoIdRef: MutableRefObject<string | null>;
  };
