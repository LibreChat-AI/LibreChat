import { BookmarkContext } from '~/Providers/BookmarkContext';
import { useConversationTagsQuery } from '~/data-provider';
import BookmarkTable from './BookmarkTable';

const BookmarkPanel = () => {
  const { data, isLoading, isError, refetch } = useConversationTagsQuery();

  return (
    <div className="flex h-full w-full flex-col overflow-hidden pt-2">
      <BookmarkContext.Provider value={{ bookmarks: data || [] }}>
        <BookmarkTable isLoading={isLoading} isError={isError} onRetry={() => refetch()} />
      </BookmarkContext.Provider>
    </div>
  );
};
export default BookmarkPanel;
