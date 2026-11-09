import { findMessageById } from 'librechat-data-provider';
import type { ErrorRendererProps } from './parts';
import { ErrorAction, ErrorActions, ErrorBody, readString } from './parts';
import {
  useOptionalMessagesOperations,
  useOptionalMessagesConversation,
  useMessagesIsSubmitting,
} from '~/Providers/MessagesViewContext';
import { useNmbSubmissionQuery } from '~/data-provider';
import { useMessageContext } from '~/Providers/MessageContext';
import { useLocalize } from '~/hooks';

const REVIEW_ID = /^rev_[a-f0-9]{12}$/;

/**
 * Gateway outcomes for a message or file that was not sent: held for review, rejected, scanner
 * unavailable or not cleared. A held message polls its own status and, once approved, offers to
 * send the approved (masked) version. Nothing here ever shows the sensitive content.
 */
export default function NmbError({ json }: ErrorRendererProps) {
  const localize = useLocalize();
  const type = readString(json, 'type');
  const rawId = readString(json, 'review_id');
  const reviewId = rawId != null && REVIEW_ID.test(rawId) ? rawId : undefined;
  const isPending = type === 'nmb_review_pending';
  const { data } = useNmbSubmissionQuery(isPending ? reviewId : undefined);
  const { ask, getMessages } = useOptionalMessagesOperations();
  const { conversation } = useOptionalMessagesConversation();
  const isSubmitting = useMessagesIsSubmitting();
  const { messageId } = useMessageContext();

  if (type === 'nmb_rejected') {
    const reason = readString(json, 'reason');
    return (
      <ErrorBody>
        <div>{localize('com_nmb_chat_rejected')}</div>
        {reason && (
          <div className="text-text-secondary">
            {localize('com_nmb_chat_reason', { 0: reason })}
          </div>
        )}
      </ErrorBody>
    );
  }
  if (type === 'nmb_unavailable') {
    return localize('com_nmb_chat_unavailable');
  }
  if (type === 'nmb_file_not_cleared') {
    return localize('com_nmb_chat_file_not_cleared');
  }
  if (type === 'nmb_forbidden') {
    return localize('com_nmb_chat_forbidden');
  }
  if (!isPending) {
    return localize('com_nmb_chat_unavailable');
  }

  if (data?.status === 'rejected') {
    return (
      <ErrorBody>
        <div>{localize('com_nmb_chat_rejected')}</div>
        {data.reason && (
          <div className="text-text-secondary">
            {localize('com_nmb_chat_reason', { 0: data.reason })}
          </div>
        )}
      </ErrorBody>
    );
  }

  if (data?.status === 'approved-masked' && reviewId != null) {
    const send = () => {
      const row = findMessageById(getMessages(), messageId);
      const userMessage = row?.parentMessageId
        ? findMessageById(getMessages(), row.parentMessageId)
        : undefined;
      ask(
        {
          text: `[[nmb:release:${reviewId}]]`,
          parentMessageId: userMessage?.parentMessageId ?? null,
          conversationId: conversation?.conversationId ?? userMessage?.conversationId ?? null,
        },
        {},
      );
    };
    return (
      <ErrorBody>
        <div>{localize('com_nmb_chat_approved')}</div>
        <ErrorActions>
          <ErrorAction onClick={send} disabled={isSubmitting}>
            {localize('com_nmb_chat_send_approved')}
          </ErrorAction>
        </ErrorActions>
      </ErrorBody>
    );
  }

  return localize('com_nmb_chat_pending');
}
