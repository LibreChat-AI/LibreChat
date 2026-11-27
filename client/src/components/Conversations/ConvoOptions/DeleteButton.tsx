import React, { useCallback } from 'react';
import { Trans } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Spinner,
  OGDialog,
  OGDialogClose,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  useToastContext,
} from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import useOpenConversationId from '~/hooks/Conversations/useOpenConversationId';
import { useDeleteConversationMutation } from '~/data-provider';
import { useLocalize, useNewConvo } from '~/hooks';
import { NotificationSeverity } from '~/common';

type DeleteButtonProps = {
  conversationId: string;
  retainView: () => void;
  title: string;
  showDeleteDialog?: boolean;
  setShowDeleteDialog?: (value: boolean) => void;
  triggerRef?: React.RefObject<HTMLButtonElement>;
  setMenuOpen?: (open: boolean) => void;
  /** Read when the delete settles, for callers whose dialog can close before it does. */
  getCurrentConversationId?: () => string | undefined;
};

export function DeleteConversationDialog({
  setShowDeleteDialog,
  conversationId,
  getCurrentConversationId,
  setMenuOpen,
  retainView,
  title,
}: {
  setMenuOpen?: (open: boolean) => void;
  setShowDeleteDialog: (value: boolean) => void;
  conversationId: string;
  getCurrentConversationId?: () => string | undefined;
  retainView: () => void;
  title: string;
}) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { newConversation } = useNewConvo();
  const getOpenConversationId = useOpenConversationId();

  const deleteMutation = useDeleteConversationMutation({
    onSuccess: () => {
      setShowDeleteDialog(false);
      /** Only the chat on screen is replaced; an unsent one is never the chat deleted. */
      const openConvoId = (getCurrentConversationId ?? getOpenConversationId)();
      if (openConvoId === conversationId) {
        newConversation();
        navigate('/c/new', { replace: true });
      }
      setMenuOpen?.(false);
      retainView();
      showToast({
        message: localize('com_ui_convo_delete_success'),
        severity: NotificationSeverity.SUCCESS,
        showIcon: true,
      });
    },
    onError: () => {
      showToast({
        message: localize('com_ui_convo_delete_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    },
  });

  const confirmDelete = useCallback(() => {
    const messages = queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]);
    const thread_id = messages?.[messages.length - 1]?.thread_id;
    const endpoint = messages?.[messages.length - 1]?.endpoint;

    deleteMutation.mutate({ conversationId, thread_id, endpoint, source: 'button' });
  }, [conversationId, deleteMutation, queryClient]);

  return (
    <OGDialogContent
      id="delete-conversation-dialog"
      className="w-11/12 max-w-md"
      showCloseButton={false}
      aria-describedby="delete-conversation-description"
    >
      <OGDialogHeader>
        <OGDialogTitle>{localize('com_ui_delete_conversation')}</OGDialogTitle>
      </OGDialogHeader>
      <div id="delete-conversation-description" className="w-full truncate">
        <Trans
          i18nKey="com_ui_delete_confirm_strong"
          values={{ title }}
          components={{ strong: <strong /> }}
        />
      </div>
      <div className="flex justify-end gap-4 pt-4">
        <OGDialogClose asChild>
          <Button variant="outline">{localize('com_ui_cancel')}</Button>
        </OGDialogClose>
        <Button variant="destructive" onClick={confirmDelete} disabled={deleteMutation.isLoading}>
          {deleteMutation.isLoading ? <Spinner /> : localize('com_ui_delete')}
        </Button>
      </div>
    </OGDialogContent>
  );
}

export default function DeleteButton({
  conversationId,
  getCurrentConversationId,
  retainView,
  title,
  setMenuOpen,
  showDeleteDialog,
  setShowDeleteDialog,
  triggerRef,
}: DeleteButtonProps) {
  if (showDeleteDialog === undefined || setShowDeleteDialog === undefined) {
    return null;
  }

  if (!conversationId) {
    return null;
  }

  return (
    <OGDialog open={showDeleteDialog!} onOpenChange={setShowDeleteDialog!} triggerRef={triggerRef}>
      <DeleteConversationDialog
        setShowDeleteDialog={setShowDeleteDialog}
        conversationId={conversationId}
        getCurrentConversationId={getCurrentConversationId}
        setMenuOpen={setMenuOpen}
        retainView={retainView}
        title={title}
      />
    </OGDialog>
  );
}
