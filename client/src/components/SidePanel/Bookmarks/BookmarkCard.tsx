import React, { useRef } from 'react';
import { GripVertical } from 'lucide-react';
import { useDrag, useDrop } from 'react-dnd';
import { useToastContext } from '@librechat/client';
import type { TConversationTag } from 'librechat-data-provider';
import { useConversationTagMutation } from '~/data-provider';
import BookmarkCardActions from './BookmarkCardActions';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface BookmarkCardProps {
  bookmark: TConversationTag;
  position: number;
  moveRow: (dragIndex: number, hoverIndex: number) => void;
}

interface DragItem {
  index: number;
  id: string;
  type: string;
}

export default function BookmarkCard({ bookmark, position, moveRow }: BookmarkCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const mutation = useConversationTagMutation({
    context: 'BookmarkCard',
    tag: bookmark.tag,
  });

  const handleDrop = (item: DragItem) => {
    mutation.mutate(
      { ...bookmark, position: item.index },
      {
        onSuccess: () => {
          showToast({
            message: localize('com_ui_bookmarks_update_success'),
            severity: NotificationSeverity.SUCCESS,
          });
        },
        onError: () => {
          showToast({
            message: localize('com_ui_bookmarks_update_error'),
            severity: NotificationSeverity.ERROR,
          });
        },
      },
    );
  };

  const [, drop] = useDrop({
    accept: 'bookmark',
    drop: handleDrop,
    hover(item: DragItem) {
      if (!ref.current || item.index === position) {
        return;
      }
      moveRow(item.index, position);
      item.index = position;
    },
  });

  const [{ isDragging }, drag] = useDrag({
    type: 'bookmark',
    item: { index: position },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  drag(drop(ref));

  return (
    <div
      ref={ref}
      className={cn(
        'group flex cursor-move items-center gap-2 rounded-lg px-3 py-2.5',
        'hover:bg-surface-active-alt bg-transparent',
        isDragging && 'opacity-50',
      )}
    >
      {/* Drag handle */}
      <GripVertical className="text-text-tertiary size-4 shrink-0" aria-hidden="true" />

      {/* Tag name */}
      <span className="text-text-primary min-w-0 flex-1 truncate text-sm font-medium">
        {bookmark.tag}
      </span>

      {/* Actions */}
      <BookmarkCardActions bookmark={bookmark} />
    </div>
  );
}
