import { useState, useRef, useCallback } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogTrigger,
  OGDialogTemplate,
  TooltipAnchor,
  useToastContext,
} from '@librechat/client';
import type { TConversationTag } from 'librechat-data-provider';
import { useDeleteConversationTagMutation } from '~/data-provider';
import { BookmarkEditDialog } from '~/components/Bookmarks';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

interface BookmarkCardActionsProps {
  bookmark: TConversationTag;
}

export default function BookmarkCardActions({ bookmark }: BookmarkCardActionsProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);

  const deleteBookmarkMutation = useDeleteConversationTagMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_bookmarks_delete_success'),
      });
      setDeleteOpen(false);
    },
    onError: () => {
      showToast({
        message: localize('com_ui_bookmarks_delete_error'),
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const confirmDelete = useCallback(async () => {
    await deleteBookmarkMutation.mutateAsync(bookmark.tag);
  }, [bookmark.tag, deleteBookmarkMutation]);

  return (
    <div className="flex items-center gap-1">
      {/* Edit button */}
      <BookmarkEditDialog
        context="BookmarkCardActions"
        bookmark={bookmark}
        open={editOpen}
        setOpen={setEditOpen}
        triggerRef={editTriggerRef}
      >
        <OGDialogTrigger asChild>
          <TooltipAnchor
            description={localize('com_ui_edit')}
            side="top"
            render={
              <Button
                ref={editTriggerRef}
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={localize('com_ui_bookmarks_edit')}
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </OGDialogTrigger>
      </BookmarkEditDialog>

      {/* Delete button */}
      <OGDialog open={deleteOpen} onOpenChange={setDeleteOpen} triggerRef={deleteTriggerRef}>
        <OGDialogTrigger asChild>
          <TooltipAnchor
            description={localize('com_ui_delete')}
            side="top"
            render={
              <Button
                ref={deleteTriggerRef}
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={localize('com_ui_bookmarks_delete')}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </OGDialogTrigger>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_bookmarks_delete')}
          className="max-w-[450px]"
          main={
            <p className="text-left text-sm text-text-secondary">
              {localize('com_ui_bookmark_delete_confirm')} <strong>{bookmark.tag}</strong>
            </p>
          }
          selection={{
            selectHandler: confirmDelete,
            selectClasses:
              'bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover',
            selectText: localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </div>
  );
}
