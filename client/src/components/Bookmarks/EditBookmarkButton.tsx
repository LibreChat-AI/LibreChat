import { useState } from 'react';
import { TooltipAnchor, OGDialogTrigger, EditIcon, Button } from '@librechat/client';
import type { TConversationTag } from 'librechat-data-provider';
import type { FC } from 'react';
import BookmarkEditDialog from './BookmarkEditDialog';
import { useLocalize } from '~/hooks';

const EditBookmarkButton: FC<{
  bookmark: TConversationTag;
  tabIndex?: number;
  onFocus?: () => void;
  onBlur?: () => void;
}> = ({ bookmark, tabIndex = 0, onFocus, onBlur }) => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);

  return (
    <BookmarkEditDialog
      context="EditBookmarkButton"
      bookmark={bookmark}
      open={open}
      setOpen={setOpen}
    >
      <OGDialogTrigger asChild>
        <TooltipAnchor
          description={localize('com_ui_edit')}
          render={
            <Button
              variant="ghost"
              aria-label={localize('com_ui_bookmarks_edit')}
              tabIndex={tabIndex}
              onFocus={onFocus}
              onBlur={onBlur}
              onClick={() => setOpen(!open)}
              size="icon-sm"
            >
              <EditIcon />
            </Button>
          }
        />
      </OGDialogTrigger>
    </BookmarkEditDialog>
  );
};

export default EditBookmarkButton;
