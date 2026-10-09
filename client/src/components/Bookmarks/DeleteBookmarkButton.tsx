import { useCallback, useState } from 'react';
import {
  Button,
  TrashIcon,
  Label,
  OGDialog,
  OGDialogTrigger,
  TooltipAnchor,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import type { FC } from 'react';
import { useDeleteConversationTagMutation } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

const DeleteBookmarkButton: FC<{
  bookmark: string;
  tabIndex?: number;
  onFocus?: () => void;
  onBlur?: () => void;
}> = ({ bookmark, tabIndex = 0, onFocus, onBlur }) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [open, setOpen] = useState(false);

  const deleteBookmarkMutation = useDeleteConversationTagMutation({
    onSuccess: () => {
      showToast({
        message: localize('com_ui_bookmarks_delete_success'),
      });
    },
    onError: () => {
      showToast({
        message: localize('com_ui_bookmarks_delete_error'),
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const confirmDelete = useCallback(async () => {
    await deleteBookmarkMutation.mutateAsync(bookmark);
  }, [bookmark, deleteBookmarkMutation]);

  return (
    <>
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <TooltipAnchor
            description={localize('com_ui_delete')}
            render={
              <Button
                variant="ghost"
                aria-label={localize('com_ui_bookmarks_delete')}
                tabIndex={tabIndex}
                onFocus={onFocus}
                onBlur={onBlur}
                onClick={() => setOpen(!open)}
                className="h-8 w-8 p-0"
              >
                <TrashIcon />
              </Button>
            }
          />
        </OGDialogTrigger>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_bookmarks_delete')}
          className="w-11/12 max-w-lg"
          main={
            <Label className="text-left text-sm font-medium">
              {localize('com_ui_bookmark_delete_confirm')} {bookmark}
            </Label>
          }
          selection={{
            selectHandler: confirmDelete,
            selectClasses:
              'bg-surface-destructive hover:bg-surface-destructive-hover text-text-on-status',
            selectText: localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </>
  );
};

export default DeleteBookmarkButton;
