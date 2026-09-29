import { useState, useId } from 'react';
import * as Ariakit from '@ariakit/react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { DropdownPopup, TooltipAnchor, Button } from '@librechat/client';
import { BookmarkFilledIcon, BookmarkIcon } from '@radix-ui/react-icons';
import { Ellipsis, PlusCircle, HatGlasses, Check, ChartNoAxesGantt } from 'lucide-react';
import type { TStartupConfig } from 'librechat-data-provider';
import type { TraceControl } from '~/components/Chat/Trace';
import type * as t from '~/common';
import { BookmarkContext } from '~/Providers/BookmarkContext';
import useBookmarkItems from '~/hooks/Chat/useBookmarkItems';
import useTemporaryChat from '~/hooks/Chat/useTemporaryChat';
import useExportShare from '~/hooks/Chat/useExportShare';
import useMultiConvo from '~/hooks/Chat/useMultiConvo';
import { useHasAccess, useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Mobile overflow menu. Collapses the header's secondary actions behind a
 * single control so the bar holds four targets instead of seven. Each action's
 * behaviour and visibility rule comes from the hook that also drives its
 * desktop button, so the two surfaces cannot drift apart.
 */
export default function HeaderMenu({
  startupConfig,
  trace,
  className,
}: {
  startupConfig?: TStartupConfig;
  /** Owned by the header, which also renders the desktop trace button from it. */
  trace?: TraceControl;
  className?: string;
}) {
  const localize = useLocalize();
  const menuId = useId();
  const [isOpen, setIsOpen] = useState(false);

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });
  const hasAccessToMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });
  const hasAccessToTemporaryChat = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });

  const multiConvo = useMultiConvo();
  const temporary = useTemporaryChat();
  const bookmarks = useBookmarkItems({ enabled: hasAccessToBookmarks === true });
  const exportShare = useExportShare({
    isSharedButtonEnabled: startupConfig?.sharedLinksEnabled ?? false,
  });

  const showBookmarks = hasAccessToBookmarks === true && bookmarks.show;
  const showCompare = hasAccessToMultiConvo === true && multiConvo.show;
  const showTemporary = hasAccessToTemporaryChat === true && temporary.show;

  const items: t.MenuItemProps[] = [];

  /** `separate` marks an entry as *being* a divider, so it needs its own slot. */
  const pushGroup = (...group: t.MenuItemProps[]) => {
    if (items.length > 0) {
      items.push({ separate: true });
    }
    items.push(...group);
  };

  if (showBookmarks) {
    items.push({
      id: 'header-bookmarks',
      label: localize('com_ui_bookmarks'),
      icon: bookmarks.hasBookmarks ? (
        <BookmarkFilledIcon className="size-4 text-text-secondary" />
      ) : (
        <BookmarkIcon className="size-4 text-text-secondary" />
      ),
      subItems: bookmarks.items,
    });
  }

  if (showCompare) {
    items.push({
      id: 'header-compare',
      label: localize('com_ui_add_multi_conversation'),
      icon: <PlusCircle className="size-4 text-text-secondary" />,
      onClick: multiConvo.addConversation,
    });
  }

  if (trace?.show === true) {
    pushGroup({
      id: 'header-trace',
      label: localize('com_ui_trace_view'),
      icon: <ChartNoAxesGantt className="size-4 text-text-secondary" />,
      onClick: trace.open,
    });
  }

  if (exportShare.show) {
    pushGroup(...exportShare.items);
  }

  if (showTemporary) {
    pushGroup({
      id: 'header-temporary',
      label: localize('com_ui_temporary'),
      ariaChecked: temporary.isTemporary,
      className: temporary.isTemporary ? 'bg-surface-active' : undefined,
      icon: temporary.isTemporary ? (
        <Check className="size-4 text-text-primary" />
      ) : (
        <HatGlasses className="size-4 text-text-secondary" />
      ),
      onClick: temporary.toggle,
    });
  }

  if (items.length === 0) {
    return null;
  }

  /** Mirrors the desktop share button, which surfaces an active link in its tooltip. */
  const triggerDescription = exportShare.hasSharedLink
    ? localize('com_ui_export_share_link_active')
    : localize('com_ui_more_options');

  return (
    <BookmarkContext.Provider value={{ bookmarks: bookmarks.bookmarks }}>
      <DropdownPopup
        portal={true}
        menuId={menuId}
        focusLoop={true}
        unmountOnHide={true}
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        items={items}
        trigger={
          <TooltipAnchor
            description={triggerDescription}
            render={
              <Ariakit.MenuButton
                id="header-menu-button"
                data-testid="header-overflow-menu"
                aria-label={triggerDescription}
                aria-expanded={isOpen}
                render={
                  <Button
                    size="icon"
                    variant="outline"
                    className={cn(
                      'relative size-9 flex-shrink-0 rounded-xl bg-presentation hover:bg-surface-active-alt',
                      className,
                    )}
                  />
                }
              >
                <Ellipsis className="icon-md" aria-hidden="true" />
                {exportShare.hasSharedLink && (
                  <span
                    className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-status-info ring-2 ring-presentation"
                    data-testid="header-menu-shared-link-indicator"
                    aria-hidden="true"
                  />
                )}
              </Ariakit.MenuButton>
            }
          />
        }
      />
      {showBookmarks && bookmarks.dialog}
      {exportShare.dialogs}
    </BookmarkContext.Provider>
  );
}
