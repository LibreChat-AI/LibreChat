import React, { useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { Constants, MutationKeys, dataService } from 'librechat-data-provider';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  OGDialogClose,
  OGDialogTrigger,
  useToastContext,
  OGDialogTemplate,
} from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import useGetConversation from '~/hooks/Conversations/useGetConversation';
import { useArchiveAllConversationsMutation } from '~/data-provider';
import { isTemporaryConversation } from '~/utils';
import useNewChat from '~/hooks/Chat/useNewChat';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

type SubmittedConversation = Pick<
  TConversation,
  'conversationId' | 'isArchived' | 'isTemporary' | 'expiredAt'
>;

const isSubmittedChatStillActive = (
  submittedConversation: SubmittedConversation | null,
  currentConversation: TConversation | null,
): submittedConversation is SubmittedConversation & { conversationId: string } =>
  submittedConversation != null &&
  submittedConversation.conversationId != null &&
  submittedConversation.conversationId !== Constants.NEW_CONVO &&
  submittedConversation.isArchived !== true &&
  !isTemporaryConversation(submittedConversation) &&
  currentConversation?.conversationId === submittedConversation.conversationId &&
  currentConversation?.isArchived !== true &&
  !isTemporaryConversation(currentConversation);

export const ArchiveAllChats = () => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const submittedConversationRef = useRef<SubmittedConversation | null>(null);
  const getConversation = useGetConversation();
  const { startNewChat } = useNewChat();
  const { showToast } = useToastContext();
  const pendingArchives = useIsMutating({
    mutationKey: [MutationKeys.archiveAllConversations],
  });

  const archiveAllMutation = useArchiveAllConversationsMutation({
    onSuccess: () => {
      const submittedConversation = submittedConversationRef.current;
      const currentConversation = getConversation();
      submittedConversationRef.current = null;
      if (isSubmittedChatStillActive(submittedConversation, currentConversation)) {
        startNewChat();
      }
      showToast({
        message: localize('com_ui_archive_all_success'),
        severity: NotificationSeverity.SUCCESS,
        showIcon: true,
      });
    },
    onError: async () => {
      const submittedConversation = submittedConversationRef.current;
      const currentConversation = getConversation();
      submittedConversationRef.current = null;
      showToast({
        message: localize('com_ui_archive_all_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
      if (!isSubmittedChatStillActive(submittedConversation, currentConversation)) {
        return;
      }
      try {
        const persistedConversation = await dataService.getConversationById(
          submittedConversation.conversationId,
        );
        if (
          persistedConversation.isArchived === true &&
          isSubmittedChatStillActive(submittedConversation, getConversation())
        ) {
          startNewChat();
        }
      } catch {
        // Leave Recoil alone when we cannot confirm this chat was archived.
      }
    },
  });

  const archiveAllChats = () => {
    const conversation = getConversation();
    submittedConversationRef.current = conversation?.conversationId
      ? {
          conversationId: conversation.conversationId,
          isArchived: conversation.isArchived,
          isTemporary: conversation.isTemporary,
          expiredAt: conversation.expiredAt,
        }
      : null;
    archiveAllMutation.mutate();
  };

  const isArchivePending = archiveAllMutation.isLoading || pendingArchives > 0;

  return (
    <div className="flex items-center justify-between">
      <Label id="archive-all-chats-label">{localize('com_nav_archive_all_chats')}</Label>
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button
            aria-labelledby="archive-all-chats-label"
            variant="outline"
            disabled={isArchivePending}
            onClick={() => setOpen(true)}
          >
            {localize('com_ui_archive')}
          </Button>
        </OGDialogTrigger>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_nav_confirm_archive_all')}
          className="max-w-[28.125rem]"
          main={
            <Label className="break-words">{localize('com_nav_archive_all_confirm_message')}</Label>
          }
          selection={
            <OGDialogClose asChild>
              <Button
                aria-label={localize('com_ui_archive')}
                aria-busy={isArchivePending}
                disabled={isArchivePending}
                variant="submit"
                className="border-none font-normal max-sm:order-first max-sm:w-full sm:order-none"
                onClick={archiveAllChats}
              >
                {isArchivePending ? <Spinner /> : localize('com_ui_archive')}
              </Button>
            </OGDialogClose>
          }
        />
      </OGDialog>
    </div>
  );
};
