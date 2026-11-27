import { BookmarkContext } from '~/Providers/BookmarkContext';
import { useConversationTagsQuery } from '~/data-provider';
import BookmarkTable from './BookmarkTable';

const BookmarkPanel = () => {
  const { data, isLoading } = useConversationTagsQuery();

  return (
    <div className="flex h-full w-full flex-col overflow-hidden pt-2">
      <BookmarkContext.Provider value={{ bookmarks: data || [] }}>
        <BookmarkTable isLoading={isLoading} />
      </BookmarkContext.Provider>
    </div>
  );
};
export default BookmarkPanel;
