import { memo, lazy, Suspense, useEffect, useRef } from 'react';
import { Button, Sidebar, Skeleton } from '@librechat/client';
import type { NavLink } from '~/common';
import AgentMarketplaceButton from '~/components/Nav/AgentMarketplaceButton';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import { useShortcutAriaKey } from '~/hooks/useKeyboardShortcuts';
import { useLocalize } from '~/hooks';
import Switcher from './Switcher';

const AccountSettings = lazy(() => import('~/components/Nav/AccountSettings'));

/**
 * At full width there is nothing beside the drawer left to tap, so this close
 * button is the primary dismissal. It mirrors the chat header's `OpenSidebar`
 * toggle — same icon, same look, same far-left slot — so opening the drawer
 * reads as the one persistent control flipping state, not a new X appearing
 * elsewhere. It keeps `CLOSE_SIDEBAR_ID` because `OpenSidebar` focuses that id
 * shortly after opening.
 */
function Header({
  links,
  expanded,
  onClose,
  onLeaveInsights,
  routeActiveId,
}: {
  links: NavLink[];
  expanded: boolean;
  onClose: () => void;
  onLeaveInsights?: () => void;
  routeActiveId?: string;
}) {
  const localize = useLocalize();
  const toggleSidebarAriaKey = useShortcutAriaKey('toggleSidebar');
  const closeRef = useRef<HTMLButtonElement>(null);

  /** Opening makes the chat pane inert, so keyboard/AT focus must move into
   * the drawer. The commit itself drives the handoff — every opener (button,
   * swipe, shortcut) lands here, and a wall-clock timer would race the
   * deferred state flip and silently miss whenever the flip outlasted it. */
  useEffect(() => {
    if (expanded) {
      closeRef.current?.focus();
    }
  }, [expanded]);

  return (
    <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-border-light px-2">
      <Button
        ref={closeRef}
        /**
         * The drawer stays mounted while closed so it can slide, and a
         * translated element still counts as visible. Only claim the close
         * identity while open, or callers that probe for it act on a control
         * sitting off-viewport.
         */
        id={expanded ? CLOSE_SIDEBAR_ID : undefined}
        data-testid={expanded ? 'close-sidebar-button' : undefined}
        size="icon"
        variant="header-action"
        aria-label={localize('com_nav_close_sidebar')}
        aria-expanded={expanded}
        aria-controls="chat-history-nav"
        /** The only close control while open, so its binding must be discoverable here. */
        aria-keyshortcuts={toggleSidebarAriaKey}
        tabIndex={expanded ? 0 : -1}
        className="flex-shrink-0"
        onClick={onClose}
      >
        <Sidebar className="icon-md" aria-hidden="true" />
      </Button>
      <Switcher
        links={links}
        onLeaveInsights={onLeaveInsights}
        onNavigate={onClose}
        routeActiveId={routeActiveId}
      />
      <AgentMarketplaceButton side="bottom" onNavigate={onClose} />
      <Suspense fallback={<Skeleton className="size-9 rounded-lg" />}>
        <AccountSettings collapsed />
      </Suspense>
    </div>
  );
}

export default memo(Header);
