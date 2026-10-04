import { memo, useCallback, lazy, Suspense } from 'react';
import { SquarePen } from 'lucide-react';
import { Skeleton, Sidebar, Button, Chip, TooltipAnchor } from '@librechat/client';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import AgentMarketplaceButton from '~/components/Nav/AgentMarketplaceButton';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import useNewChat from '~/hooks/Chat/useNewChat';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const AccountSettings = lazy(() => import('~/components/Nav/AccountSettings'));

const NewChatButton = memo(function NewChatButton({
  setActive,
  switchToHistory,
}: {
  setActive: (id: string) => void;
  switchToHistory: boolean;
}) {
  const localize = useLocalize();
  const tooltipDescription = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');

  const handlePanelSwitch = useCallback(() => {
    if (switchToHistory) {
      setActive(DEFAULT_PANEL);
    }
  }, [switchToHistory, setActive]);

  const { handleNewChatClick } = useNewChat({ onNewChat: handlePanelSwitch });

  return (
    <TooltipAnchor
      side="right"
      description={tooltipDescription}
      render={
        <a
          href="/c/new"
          data-testid="new-chat-button"
          aria-label={localize('com_ui_new_chat')}
          aria-keyshortcuts={ariaKey}
          className="hover:bg-surface-hover flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
          onClick={handleNewChatClick}
        >
          <SquarePen className="text-text-primary h-5 w-5" />
        </a>
      }
    />
  );
});

const NavIconButton = memo(function NavIconButton({
  link,
  isActive,
  expanded,
  setActive,
  onExpand,
  onCollapse,
  onNavigate,
  onLeaveRoute,
}: {
  link: NavLink;
  isActive: boolean;
  expanded: boolean;
  setActive: (id: string) => void;
  onExpand?: () => void;
  onCollapse?: () => void;
  onNavigate?: () => void;
  onLeaveRoute?: () => void;
}) {
  const localize = useLocalize();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (link.onClick) {
        if (link.Component && isActive) {
          if (expanded) onCollapse?.();
          else onExpand?.();
          return;
        }
        link.onClick(e);
        onNavigate?.();
        return;
      }
      if (isActive && expanded) {
        onCollapse?.();
        return;
      }
      if (!isActive) {
        setActive(link.id);
      }
      if (!expanded) {
        onExpand?.();
      } else {
        onLeaveRoute?.();
      }
    },
    [link, isActive, setActive, expanded, onExpand, onCollapse, onNavigate, onLeaveRoute],
  );

  return (
    <TooltipAnchor
      description={
        link.activity ? `${localize(link.title)}: ${link.activity.label}` : localize(link.title)
      }
      side="right"
      render={
        <Button
          size="icon"
          variant="ghost"
          aria-label={
            link.activity ? `${localize(link.title)}: ${link.activity.label}` : localize(link.title)
          }
          aria-pressed={isActive}
          disabled={link.disabled}
          data-testid={`nav-panel-${link.id}`}
          className={cn(
            'relative h-9 w-9 rounded-lg',
            isActive ? 'bg-surface-active-alt text-text-primary' : 'text-text-secondary',
          )}
          onClick={handleClick}
        >
          <link.icon className="h-5 w-5" aria-hidden="true" />
          {link.activity && (
            <Chip size="xs" tone="info" className="absolute -top-1 -right-1" aria-hidden="true">
              {link.activity.count}
            </Chip>
          )}
        </Button>
      }
    />
  );
});

function ExpandedPanel({
  links,
  routeActiveId,
  expanded = true,
  onCollapse,
  onExpand,
  onNavigate,
  onLeaveRoute,
  switchToHistory,
}: {
  links: NavLink[];
  routeActiveId?: string;
  expanded?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
  onNavigate?: () => void;
  onLeaveRoute?: () => void;
  switchToHistory: boolean;
}) {
  const localize = useLocalize();
  const { active, setActive } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);
  const isRoutePanel = routeActiveId !== undefined;
  const expandOtherPanel = useCallback(() => {
    if (routeActiveId) onLeaveRoute?.();
    onExpand?.();
  }, [routeActiveId, onLeaveRoute, onExpand]);

  const toggleLabel = expanded ? 'com_nav_close_sidebar' : 'com_nav_open_sidebar';
  const toggleClick = expanded ? onCollapse : onExpand;
  const toggleSidebarHint = useShortcutHint('toggleSidebar', localize(toggleLabel));
  const toggleSidebarAriaKey = useShortcutAriaKey('toggleSidebar');

  return (
    <div className="border-border-light bg-surface-primary-alt flex h-full shrink-0 flex-col gap-2 border-r px-2 py-2">
      <TooltipAnchor
        side="right"
        description={toggleSidebarHint}
        render={
          <Button
            id={expanded ? CLOSE_SIDEBAR_ID : undefined}
            data-testid={expanded ? 'close-sidebar-button' : 'open-sidebar-button'}
            size="icon"
            variant="ghost"
            aria-label={localize(toggleLabel)}
            aria-expanded={expanded}
            aria-keyshortcuts={toggleSidebarAriaKey}
            className="h-9 w-9 rounded-lg"
            onClick={toggleClick}
          >
            <Sidebar aria-hidden="true" className="text-text-primary h-5 w-5" />
          </Button>
        }
      />
      <NewChatButton setActive={setActive} switchToHistory={switchToHistory} />
      <AgentMarketplaceButton />
      <div className="border-border-light mx-2 border-b" />
      <div className="flex flex-col gap-1 overflow-y-auto">
        {links.map((link) => (
          <NavIconButton
            key={link.id}
            link={link}
            isActive={
              link.id === routeActiveId ? true : !isRoutePanel && link.id === effectiveActive
            }
            expanded={expanded ?? true}
            setActive={setActive}
            onExpand={link.id === routeActiveId ? onExpand : expandOtherPanel}
            onCollapse={onCollapse}
            onNavigate={onNavigate}
            onLeaveRoute={isRoutePanel ? onLeaveRoute : undefined}
          />
        ))}
      </div>

      <div className="mt-auto">
        <Suspense fallback={<Skeleton className="h-9 w-9 rounded-lg" />}>
          <AccountSettings collapsed />
        </Suspense>
      </div>
    </div>
  );
}

export default memo(ExpandedPanel);
