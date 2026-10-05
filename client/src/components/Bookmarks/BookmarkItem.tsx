import { useState } from 'react';
import { Spinner } from '@librechat/client';
import { MenuItem } from '@headlessui/react';
import { BookmarkFilledIcon, BookmarkIcon } from '@radix-ui/react-icons';
import type { FC } from 'react';

type MenuItemProps = {
  tag: string | React.ReactNode;
  selected: boolean;
  count?: number;
  handleSubmit: (tag?: string) => void;
  icon?: React.ReactNode;
};

const BookmarkItem: FC<MenuItemProps> = ({ tag, selected, handleSubmit, icon, ...rest }) => {
  const [isLoading, setIsLoading] = useState(false);
  const clickHandler = async () => {
    if (tag === 'New Bookmark') {
      handleSubmit();
      return;
    }

    setIsLoading(true);
    handleSubmit(tag as string);
    setIsLoading(false);
  };

  const breakWordStyle: React.CSSProperties = {
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
  };

  const renderIcon = () => {
    if (icon != null) {
      return icon;
    }

    if (isLoading) {
      return <Spinner className="size-4" />;
    }

    if (selected) {
      return <BookmarkFilledIcon aria-hidden="true" className="size-4" />;
    }

    return <BookmarkIcon aria-hidden="true" className="size-4" />;
  };

  return (
    <MenuItem
      aria-label={tag as string}
      className="group text-text-primary data-[focus]:bg-surface-hover data-[focus-visible]:ring-text-primary flex w-full gap-2 rounded-lg p-2.5 text-sm transition-colors duration-200 focus:outline-hidden data-[focus-visible]:ring-2"
      {...rest}
      as="button"
      onClick={clickHandler}
    >
      <div className="flex grow items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {renderIcon()}
          <div style={breakWordStyle}>{tag}</div>
        </div>
      </div>
    </MenuItem>
  );
};

export default BookmarkItem;
