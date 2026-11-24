import { useContext, useRef } from 'react';
import { useStore } from 'jotai';
import { useRecoilCallback } from 'recoil';
import { useToastContext } from '@librechat/client';
import {
  ForkOptions,
  ContentTypes,
  findMessageById,
  messageCarriesFiles,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import {
  isCountLimitError,
  isAttachmentError,
  collectOlderFileIds,
  mayBeAttachmentError,
  findAttachmentRecovery,
} from '@librechat/chat';
import {
  pendingQuotesByConvoId,
  getReasoningStateKey,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '@librechat/chat/react';
import type { AttachmentRecovery } from '@librechat/chat';
import type { TMessage } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  useMessagesIsSubmitting,
  useIsMessagesViewReadOnly,
  useOptionalMessagesOperations,
  useOptionalMessagesConversation,
} from '~/Providers/MessagesViewContext';
import {
  useForkConvoMutation,
  useFileExclusionQuery,
  useFileExclusionMutation,
} from '~/data-provider';
import useGetAddedConvo from '~/hooks/Conversations/useGetAddedConvo';
import { useMessageContext } from '~/Providers/MessageContext';
import { useLocalize, useNavigateToConvo } from '~/hooks';
import { isSubmittableMessage } from '~/utils/messages';
import { ChatContext } from '~/Providers/ChatContext';
import { ErrorAction, ErrorActions } from './parts';
import store from '~/store';

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
 * resends those files, so a plain retry fails the same way. When earlier turns carry files, the
 * first offer is to leave those out of the conversation and send the failed message again with
 * its own: the newest files are the ones the reader just asked about, and anything left out can
 * be switched back on in the session rail. It also offers to send the failed message again
 * without its own files, and to continue in a copy of the conversation that has none. All leave
 * the original untouched: a retry is a new version of the message beside the old one, and the
 * copy is a new conversation.
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
  const { ask, getMessages } = useOptionalMessagesOperations();
  const getAddedConvo = useGetAddedConvo();
  const { navigateToConvo } = useNavigateToConvo();
  const { showToast } = useToastContext();
  const reasoningStore = useStore();
  /** The failed turn, staged in the copy's composer so it can be sent again as it was. */
  const failedTurnRef = useRef<TMessage | undefined>(undefined);

  /**
   * Hands the failed turn to the copy's composer the way a message is put back for editing: its
   * text through the in-memory handoff the composer drains on mount (never the draft store, which
   * the Save Drafts preference may switch off), and its quotes, manual skills and reasoning
   * override through their compose-time atoms. Only its files stay behind.
   */
  const stageFailedTurn = useRecoilCallback(
    ({ set }) =>
      (forkedId: string, turn: TMessage): boolean => {
        const hasText = turn.text.trim() !== '';
        if (hasText) {
          set(store.pendingComposerTextByConvoId(forkedId), turn.text);
        }
        if ((turn.quotes?.length ?? 0) > 0) {
          reasoningStore.set(pendingQuotesByConvoId(forkedId), turn.quotes ?? []);
        }
        if ((turn.manualSkills?.length ?? 0) > 0) {
          reasoningStore.set(pendingManualSkillsByConvoId(forkedId), turn.manualSkills ?? []);
        }
        if (turn.reasoningOverride != null) {
          reasoningStore.set(
            pendingReasoningOverrideFamily(getReasoningStateKey(forkedId, 0)),
            turn.reasoningOverride,
          );
        }
        return hasText;
      },
    [reasoningStore],
  );

  const forkConvo = useForkConvoMutation({
    onSuccess: (data) => {
      /** A server that predates `excludeFiles` ignores it and returns an ordinary copy, which
       *  would fail the same way; say so rather than announce a recovery that did not happen. */
      if (data.messages.some((message) => messageCarriesFiles(message))) {
        showToast({
          message: localize('com_ui_branch_without_files_unsupported'),
          status: 'error',
        });
        return;
      }
      const turn = failedTurnRef.current;
      const forkedId = data.conversation.conversationId;
      const staged = turn != null && forkedId != null && stageFailedTurn(forkedId, turn);
      navigateToConvo(data.conversation);
      showToast({
        message: localize(
          staged ? 'com_ui_branch_without_files_draft' : 'com_ui_branch_without_files_done',
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

  const exclusion = useFileExclusionMutation();
  const { parent, canRetry, branchTargetId, olderCarryFiles } = recovery;
  const busy = isSubmitting || forkConvo.isLoading || exclusion.isLoading;
  const countLimit = isCountLimitError(text);
  /** A count limit is about the turn's own files, which leaving older ones out does not change. */
  const mayDropOlder =
    olderCarryFiles && !countLimit && isSubmittableMessage(parent.text, parent.files?.length ?? 0);
  /** What is already left out, so a turn that failed again after it is not offered it again. */
  const { data: excluded } = useFileExclusionQuery(conversationId, { enabled: mayDropOlder });
  const leftOut = excluded?.excludedFiles;
  const olderIncluded = (): string[] => {
    const left = new Set(leftOut ?? []);
    return collectOlderFileIds(getMessages(), parent).filter((fileId) => !left.has(fileId));
  };
  const canDropOlder =
    mayDropOlder && (leftOut == null || leftOut.length === 0 || olderIncluded().length > 0);

  const retryWithoutOlderFiles = () => {
    const fileIds = olderIncluded();
    if (fileIds.length === 0) {
      return;
    }
    exclusion.mutate(
      { conversationId, fileIds, excluded: true },
      {
        onSuccess: () => {
          ask(
            { text: parent.text, parentMessageId: parent.parentMessageId, conversationId },
            {
              overrideFiles: parent.files ?? [],
              overrideManualSkills: parent.manualSkills,
              overrideQuotes: parent.quotes,
              overrideReasoning: parent.reasoningOverride ?? null,
              addedConvo: getAddedConvo() || undefined,
            },
          );
        },
        onError: () => {
          showToast({
            message: localize('com_ui_retry_without_older_files_error'),
            status: 'error',
          });
        },
      },
    );
  };

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
    failedTurnRef.current = parent;
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
        {countLimit && <>{localize('com_error_attachments_count_cause')} </>}
        {!countLimit && isAttachmentError(text) && <>{localize('com_error_attachments_cause')} </>}
        {canDropOlder && localize('com_error_attachments_older_info')}
        {!canDropOlder && localize(getExplanationKey(recovery))}
      </p>
      {canDropOlder && (
        <p className="text-text-secondary">{localize(getExplanationKey(recovery))}</p>
      )}
      <ErrorActions>
        {canDropOlder && (
          <ErrorAction onClick={retryWithoutOlderFiles} disabled={busy}>
            {localize('com_ui_retry_without_older_files')}
          </ErrorAction>
        )}
        {canRetry && (
          <ErrorAction
            onClick={retryWithoutFiles}
            disabled={busy}
            variant={canDropOlder ? 'outline' : undefined}
          >
            {localize('com_ui_retry_without_files')}
          </ErrorAction>
        )}
        {branchTargetId != null && (
          <ErrorAction
            onClick={branchWithoutFiles}
            disabled={busy}
            variant={canRetry || canDropOlder ? 'outline' : undefined}
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

  /** An assistants thread keeps its own copy of every attachment upstream, so neither a retry
   *  nor a local copy leaves them behind; those endpoints offer no fork for the same reason. */
  if (
    chat == null ||
    readOnly ||
    conversation?.subagentThread != null ||
    isAssistantsEndpoint(conversation?.endpoint) ||
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
