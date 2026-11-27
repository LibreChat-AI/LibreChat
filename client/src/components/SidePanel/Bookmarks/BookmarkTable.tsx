import React, { useCallback, useEffect, useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, FilterInput, OGDialogTrigger, TooltipAnchor } from '@librechat/client';
import type { ConversationTagsResponse, TConversationTag } from 'librechat-data-provider';
import { BookmarkContext, useBookmarkContext } from '~/Providers/BookmarkContext';
import { BookmarkEditDialog } from '~/components/Bookmarks';
import { PanelContent, PanelHeader } from '~/components/ui';
import BookmarkCardSkeleton from './BookmarkCardSkeleton';
import BookmarkList from './BookmarkList';
import { useLocalize } from '~/hooks';

const removeDuplicates = (bookmarks: TConversationTag[]) => {
  const seen = new Set();
  return bookmarks.filter((bookmark) => {
    const duplicate = seen.has(bookmark._id);
    seen.add(bookmark._id);
    return !duplicate;
  });
};

const BookmarkTable = ({ isLoading = false }: { isLoading?: boolean }) => {
  const localize = useLocalize();
  const headingId = useId();
  const [rows, setRows] = useState<ConversationTagsResponse>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const { bookmarks = [] } = useBookmarkContext();

  useEffect(() => {
    const _bookmarks = removeDuplicates(bookmarks).sort((a, b) => a.position - b.position);
    setRows(_bookmarks);
  }, [bookmarks]);

  const moveRow = useCallback((dragIndex: number, hoverIndex: number) => {
    setRows((prevTags: TConversationTag[]) => {
      const updatedRows = [...prevTags];
      const [movedRow] = updatedRows.splice(dragIndex, 1);
      updatedRows.splice(hoverIndex, 0, movedRow);
      return updatedRows.map((row, index) => ({ ...row, position: index }));
    });
  }, []);

  const filteredRows = rows.filter(
    (row) => row.tag && row.tag.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <BookmarkContext.Provider value={{ bookmarks }}>
      <div role="region" aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col">
        {/* Sticky header: title, create, filter */}
        <PanelHeader
          title={localize('com_ui_bookmarks')}
          titleId={headingId}
          action={
            <BookmarkEditDialog context="BookmarkTable" open={createOpen} setOpen={setCreateOpen}>
              <OGDialogTrigger asChild>
                <TooltipAnchor
                  description={localize('com_ui_bookmarks_new')}
                  side="bottom"
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={localize('com_ui_bookmarks_new')}
                      onClick={() => setCreateOpen(true)}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  }
                />
              </OGDialogTrigger>
            </BookmarkEditDialog>
          }
          search={
            <FilterInput
              inputId="bookmarks-filter"
              label={localize('com_ui_bookmarks_filter')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          }
        />

        {/* Only the list scrolls */}
        <PanelContent
          isLoading={isLoading}
          skeleton={<BookmarkCardSkeleton />}
          className="px-3 pb-3"
        >
          <BookmarkList
            bookmarks={filteredRows}
            moveRow={moveRow}
            isFiltered={searchQuery.length > 0}
          />
        </PanelContent>
      </div>
    </BookmarkContext.Provider>
  );
};

export default BookmarkTable;
