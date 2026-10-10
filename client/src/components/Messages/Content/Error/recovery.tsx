import { useContext, useRef } from 'react';
import { useToastContext } from '@librechat/client';
import { ContentTypes, ForkOptions, findMessageById } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { AttachmentRecovery } from './attachments';
import type { TranslationKeys } from '~/hooks';
import {
  useMessagesIsSubmitting,
  useIsMessagesViewReadOnly,
  useOptionalMessagesOperations,
  useOptionalMessagesConversation,
} from '~/Providers/MessagesViewContext';
import { findAttachmentRecovery, isAttachmentError, mayBeAttachmentError } from './attachments';
import { useMessageContext } from '~/Providers/MessageContext';
import { useLocalize, useNavigateToConvo } from '~/hooks';
import { useForkConvoMutation } from '~/data-provider';
import { ChatContext } from '~/Providers/ChatContext';
import { ErrorAction, ErrorActions } from './parts';
import { useGetAddedConvo } from '~/hooks/Chat';
import { setDraft } from '~/utils/drafts';

/** What the card says the actions do, matched to the ones it offers. */
function getExplanationKey({ canRetry, branchTargetId }: AttachmentRecovery): TranslationKeys {
  if (!canRetry) {
    return 'com_error_attachments_branch_info';
  }
  return branchTargetId == null
    ? 'com_error_attachments_retry_info'
    : 'com_error_attachments_both_info';
}

/** An error row renders one card per error part; the recovery belongs under the last one. */
function isLastErrorPart(message: TMessage, partIndex: number | undefined): boolean {
  if (partIndex == null || !Array.isArray(message.content)) {
    return true;
  }
  for (let i = message.content.length - 1; i >= 0; i--) {
    if (message.content[i]?.type === ContentTypes.ERROR) {
      return i === partIndex;
    }
  }
  return true;
}

const getStatus = (error: unknown): number | undefined => {
  const candidate = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return candidate?.response?.status ?? candidate?.status ?? candidate?.statusCode;
};

/**
 * The way out of a turn that fails because of the files its branch carries. Every later turn
 * resends those files, so a plain retry fails the same way; this offers to send the failed message
 * again without its own files, and, when earlier turns carry files too, to continue in a copy of
 * the conversation that has none. Both leave the original untouched: the retry is a new version of
 * the message beside the old one, and the copy is a new conversation.
 */
function RecoveryActions({
  text,
  recovery,
  conversationId,
}: {
  text: string;
  recovery: AttachmentRecovery;
  conversationId: string;
}) {
  const localize = useLocalize();
  const isSubmitting = useMessagesIsSubmitting();
  const { ask } = useOptionalMessagesOperations();
  const getAddedConvo = useGetAddedConvo();
  const { navigateToConvo } = useNavigateToConvo();
  const { showToast } = useToastContext();
  /** The failed message's text, put back in the copy's composer so it can be sent again. */
  const draftRef = useRef<string | undefined>(undefined);

  const forkConvo = useForkConvoMutation({
    onSuccess: (data) => {
      const draft = draftRef.current;
      const forkedId = data.conversation.conversationId;
      if (draft != null && forkedId) {
        setDraft({ id: forkedId, value: draft });
      }
      navigateToConvo(data.conversation);
      showToast({
        message: localize(
          draft != null ? 'com_ui_branch_without_files_draft' : 'com_ui_branch_without_files_done',
        ),
        status: 'success',
      });
    },
    onError: (error) => {
      showToast({
        message: localize(
          getStatus(error) === 429 ? 'com_ui_fork_error_rate_limit' : 'com_ui_fork_error',
        ),
        status: 'error',
      });
    },
  });

  const { parent, canRetry, branchTargetId } = recovery;
  const busy = isSubmitting || forkConvo.isLoading;

  const retryWithoutFiles = () => {
    ask(
      { text: parent.text, parentMessageId: parent.parentMessageId, conversationId },
      {
        overrideFiles: [],
        overrideManualSkills: parent.manualSkills,
        overrideQuotes: parent.quotes,
        overrideReasoning: parent.reasoningOverride ?? null,
        addedConvo: getAddedConvo() || undefined,
      },
    );
  };

  const branchWithoutFiles = () => {
    if (branchTargetId == null) {
      return;
    }
    draftRef.current = parent.text.trim() === '' ? undefined : parent.text;
    forkConvo.mutate({
      conversationId,
      messageId: branchTargetId,
      option: ForkOptions.DIRECT_PATH,
      excludeFiles: true,
    });
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <p className="text-text-secondary">
        {isAttachmentError(text) && <>{localize('com_error_attachments_cause')} </>}
        {localize(getExplanationKey(recovery))}
      </p>
      <ErrorActions>
        {canRetry && (
          <ErrorAction onClick={retryWithoutFiles} disabled={busy}>
            {localize('com_ui_retry_without_files')}
          </ErrorAction>
        )}
        {branchTargetId != null && (
          <ErrorAction
            onClick={branchWithoutFiles}
            disabled={busy}
            variant={canRetry ? 'outline' : undefined}
          >
            {localize('com_ui_branch_without_files')}
          </ErrorAction>
        )}
      </ErrorActions>
    </div>
  );
}

/**
 * Offers `RecoveryActions` under a failed response whose branch carries files. Only a live,
 * writable chat can act on them, so a search result, a shared link or a read-only subagent thread
 * shows the error alone, and none of them mounts the hooks the actions need.
 */
export default function AttachmentRecoveryActions({
  text,
  messageId: rowMessageId,
}: {
  text: string;
  messageId?: string;
}) {
  const chat = useContext(ChatContext);
  const readOnly = useIsMessagesViewReadOnly();
  const { conversation } = useOptionalMessagesConversation();
  const { getMessages } = useOptionalMessagesOperations();
  const { messageId: contextMessageId, partIndex } = useMessageContext();

  if (
    chat == null ||
    readOnly ||
    conversation?.subagentThread != null ||
    !mayBeAttachmentError(text)
  ) {
    return null;
  }
  const messages = getMessages();
  const message = findMessageById(messages, rowMessageId ?? contextMessageId);
  if (message == null || !isLastErrorPart(message, rowMessageId ? undefined : partIndex)) {
    return null;
  }
  const recovery = findAttachmentRecovery(messages, message);
  const conversationId = recovery?.parent.conversationId ?? conversation?.conversationId;
  if (recovery == null || !conversationId) {
    return null;
  }
  return <RecoveryActions text={text} recovery={recovery} conversationId={conversationId} />;
}
