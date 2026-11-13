import { memo, Suspense } from 'react';
import { ChevronsLeft, SquarePen } from 'lucide-react';
import { Button, Sidebar, Skeleton, TooltipAnchor } from '@librechat/client';
import type { Ref } from 'react';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import AgentMarketplaceButton from '~/components/Nav/AgentMarketplaceButton';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import useNewChat from '~/hooks/Conversations/useNewChat';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const AccountSettings = lazyWithRecovery(() => import('~/components/Nav/AccountSettings'));

export const CONSOLE_PANEL_ID = 'console-sidebar-panel';

export interface ConsoleProps {
  links: NavLink[];
  railExpanded: boolean;
  onToggleRail: () => void;
  activeId?: string;
  onSelect?: (id: string) => void;
  panelExpanded: boolean;
  /** Omit on full-page destinations without a secondary panel. */
  onTogglePanel?: () => void;
  /** Panel toggle, or the active full-page destination, for focus restoration. */
  panelToggleRef?: Ref<HTMLButtonElement>;
  onNewChat: () => void;
  appTitle: string;
}

const NewChat = memo(function NewChat({
  railExpanded,
  onNewChat,
}: Pick<ConsoleProps, 'railExpanded' | 'onNewChat'>) {
  const localize = useLocalize();
  const hint = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');
  const { handleNewChatClick } = useNewChat({ onNewChat });

  return (
    <TooltipAnchor
      side="right"
      description={hint}
      render={
        <Button
          asChild
          variant="nav"
          size={railExpanded ? 'sm' : 'icon'}
          className={cn('w-full shrink-0', railExpanded && 'justify-start')}
        >
          <a
            href="/c/new"
            data-testid="new-chat-button"
            aria-label={localize('com_ui_new_chat')}
            aria-keyshortcuts={ariaKey}
            onClick={handleNewChatClick}
          >
            <SquarePen className="size-5 shrink-0" aria-hidden="true" />
            {railExpanded && <span className="truncate">{localize('com_ui_new_chat')}</span>}
          </a>
        </Button>
      }
    />
  );
});

/** The host owns page selection and panel visibility; this rail only displays their state. */
function Console({
  links,
  railExpanded,
  onToggleRail,
  activeId,
  onSelect,
  panelExpanded,
  onTogglePanel,
  panelToggleRef,
  onNewChat,
  appTitle,
}: ConsoleProps) {
  const localize = useLocalize();
  const railLabel = localize(
    railExpanded ? 'com_nav_collapse_navigation' : 'com_nav_expand_navigation',
  );
  const panelLabel = localize(panelExpanded ? 'com_nav_close_sidebar' : 'com_nav_open_sidebar');
  const panelHint = useShortcutHint('toggleSidebar', panelLabel);
  const panelKey = useShortcutAriaKey('toggleSidebar');
  const rowClass = cn('w-full shrink-0', railExpanded && 'justify-start');

  return (
    <nav
      aria-label={localize('com_nav_navigation')}
      data-testid="console-navigation"
      className={cn(
        'border-border-light bg-surface-sidebar text-text-primary flex h-full min-h-0 shrink-0 flex-col gap-2 border-e py-2',
        railExpanded ? 'w-48 px-2' : 'w-12 px-1',
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-center gap-2 px-1">
        <img
          src="assets/logo.svg"
          alt={railExpanded ? '' : appTitle}
          className="size-6 shrink-0 object-contain"
        />
        {railExpanded && <span className="min-w-0 flex-1 truncate font-semibold">{appTitle}</span>}
      </div>
      <TooltipAnchor
        side="right"
        description={railLabel}
        render={
          <Button
            variant="nav"
            size={railExpanded ? 'sm' : 'icon'}
            className={rowClass}
            aria-label={railLabel}
            aria-expanded={railExpanded}
            data-testid="console-rail-toggle"
            onClick={() => onToggleRail()}
          >
            <ChevronsLeft
              aria-hidden="true"
              className={cn('size-5 shrink-0 rtl:-scale-x-100', !railExpanded && 'rotate-180')}
            />
            {railExpanded && <span className="truncate">{railLabel}</span>}
          </Button>
        }
      />
      <NewChat railExpanded={railExpanded} onNewChat={onNewChat} />
      <AgentMarketplaceButton layout={railExpanded ? 'row' : 'icon'} />
      <div className="border-border-inset mx-1 border-b" />
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {links.map((link) => (
          <TooltipAnchor
            key={link.id}
            side="right"
            description={localize(link.title)}
            render={
              <Button
                ref={!onTogglePanel && activeId === link.id ? panelToggleRef : undefined}
                variant="nav"
                size={railExpanded ? 'sm' : 'icon'}
                className={rowClass}
                aria-label={localize(link.title)}
                aria-pressed={activeId === link.id}
                disabled={link.disabled}
                data-testid={`nav-panel-${link.id}`}
                onClick={(event) => {
                  if (link.disabled) {
                    return;
                  }
                  if (onSelect) {
                    onSelect(link.id);
                    return;
                  }
                  link.onClick?.(event);
                }}
              >
                <link.icon className="size-5 shrink-0" aria-hidden="true" />
                {railExpanded && <span className="truncate">{localize(link.title)}</span>}
              </Button>
            }
          />
        ))}
      </div>
      {onTogglePanel && (
        <TooltipAnchor
          side="right"
          description={panelHint}
          render={
            <Button
              ref={panelToggleRef}
              id={panelExpanded ? CLOSE_SIDEBAR_ID : undefined}
              data-testid={panelExpanded ? 'close-sidebar-button' : 'open-sidebar-button'}
              variant="nav"
              size={railExpanded ? 'sm' : 'icon'}
              className={rowClass}
              aria-label={panelLabel}
              aria-expanded={panelExpanded}
              aria-controls={CONSOLE_PANEL_ID}
              aria-keyshortcuts={panelKey}
              onClick={() => onTogglePanel()}
            >
              <Sidebar className="size-5 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
              {railExpanded && <span className="truncate">{panelLabel}</span>}
            </Button>
          }
        />
      )}
      <div className="shrink-0">
        <Suspense fallback={<Skeleton className="h-9 w-full rounded-lg" />}>
          <AccountSettings collapsed={!railExpanded} />
        </Suspense>
      </div>
    </nav>
  );
}

export default memo(Console);
