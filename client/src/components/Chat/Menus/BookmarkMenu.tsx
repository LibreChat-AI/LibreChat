import { useState, useId } from 'react';
import { useRecoilValue } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { BookmarkFilledIcon, BookmarkIcon } from '@radix-ui/react-icons';
import { DropdownPopup, TooltipAnchor, Spinner } from '@librechat/client';
import type { FC } from 'react';
import { BookmarkContext } from '~/Providers/BookmarkContext';
import useBookmarkItems from '~/hooks/Chat/useBookmarkItems';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const BookmarkMenu: FC = () => {
  const localize = useLocalize();
  const menuId = useId();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const conversationId = useRecoilValue(store.conversationByIndex(0))?.conversationId ?? '';
  const { show, items, bookmarks, hasBookmarks, isLoading, triggerAriaLabel, dialog } =
    useBookmarkItems();

  if (!show) {
    return null;
  }

  const renderButtonContent = () => {
    if (isLoading) {
      return <Spinner aria-label="Spinner" />;
    }
    if (hasBookmarks) {
      return <BookmarkFilledIcon className="icon-md" aria-hidden="true" />;
    }
    return <BookmarkIcon className="icon-md" aria-hidden="true" />;
  };

  return (
    <BookmarkContext.Provider value={{ bookmarks }}>
      <DropdownPopup
        portal={true}
        menuId={menuId}
        focusLoop={true}
        isOpen={isMenuOpen}
        unmountOnHide={true}
        setIsOpen={setIsMenuOpen}
        keyPrefix={`${conversationId}-bookmark-`}
        trigger={
          <TooltipAnchor
            description={localize('com_ui_bookmarks_add')}
            render={
              <Ariakit.MenuButton
                id="bookmark-menu-button"
                aria-label={triggerAriaLabel}
                aria-pressed={hasBookmarks}
                className={cn(
                  'border-border-light bg-presentation hover:bg-surface-hover flex size-9 shrink-0 items-center justify-center gap-2 rounded-xl border text-sm transition-colors duration-200',
                  isMenuOpen ? 'bg-surface-hover' : '',
                )}
                data-testid="bookmark-menu"
              >
                {renderButtonContent()}
              </Ariakit.MenuButton>
            }
          />
        }
        items={items}
      />
      {dialog}
    </BookmarkContext.Provider>
  );
};

export default BookmarkMenu;
