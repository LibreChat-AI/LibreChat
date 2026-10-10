import { useRef } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import type { RefObject } from 'react';
import ArchivedChatsTable from './ArchivedChatsTable';
import { useLocalize } from '~/hooks';

export function ArchivedChatsModal({
  open,
  onOpenChange,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | HTMLDivElement | null>;
}) {
  const localize = useLocalize();
  const contentRef = useRef<HTMLDivElement>(null);

  /** The virtualized table has no stable focusable on mount, so Radix's default
   *  autofocus lands on a row that the virtualizer tears out, dropping focus to
   *  the page's top focus guard; anchor focus to the dialog content instead.
   *  The container is only a landing spot for focus, never a tab stop, so it
   *  draws no focus ring of its own; the first Tab reveals one on a real control. */
  const handleOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    contentRef.current?.focus();
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogContent
        focusOutline="hidden"
        ref={contentRef}
        tabIndex={-1}
        onOpenAutoFocus={handleOpenAutoFocus}
        className="w-11/12 max-w-3xl shadow-2xl"
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_nav_archived_chats')}</OGDialogTitle>
        </OGDialogHeader>
        <ArchivedChatsTable />
      </OGDialogContent>
    </OGDialog>
  );
}
