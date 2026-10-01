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
import { rowActionSlotClasses } from '~/utils';
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
    <div className={rowActionSlotClasses({ open: editOpen || deleteOpen })}>
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
                type="button"
                variant="row-action-reveal"
                size="icon-xs"
                data-open={editOpen || undefined}
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
                type="button"
                variant="row-action-reveal"
                size="icon-xs"
                data-open={deleteOpen || undefined}
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
            <p className="text-text-secondary text-left text-sm">
              {localize('com_ui_bookmark_delete_confirm')}{' '}
              {/* The name is the user's and can be one unbroken run of characters. It
                  breaks anywhere rather than wrapping on spaces it does not have,
                  which is also what stops it setting the dialog's width. The sentence
                  around it still breaks on its own words. */}
              <strong className="break-all">{bookmark.tag}</strong>
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
