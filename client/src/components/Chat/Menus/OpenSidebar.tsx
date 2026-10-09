import { TooltipAnchor, Button, Sidebar } from '@librechat/client';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { useLocalize } from '~/hooks';

export const CLOSE_SIDEBAR_ID = 'close-sidebar-button';
export const OPEN_SIDEBAR_ID = 'open-sidebar-button';

/**
 * `testId` exists because the sidebar rail publishes `open-sidebar-button` for its own
 * collapsed toggle. Any caller that can stay mounted alongside the rail must claim a
 * distinct id, or `getByTestId` resolves to two elements.
 */
export default function OpenSidebar({
  className,
  testId = OPEN_SIDEBAR_ID,
}: {
  className?: string;
  testId?: string;
}) {
  const localize = useLocalize();
  const { setSidebarOpen } = useSidebarToggle();
  const tooltipDescription = useShortcutHint('toggleSidebar', localize('com_nav_open_sidebar'));
  const ariaKey = useShortcutAriaKey('toggleSidebar');

  const handleClick = () => {
    const mode = setSidebarOpen(true);
    if (mode === 'none') {
      /** Desktop only: the expanded panel claims `CLOSE_SIDEBAR_ID` and has
       * no commit-driven handoff of its own. The mobile drawer focuses its
       * toggle from the commit itself — a second timer there would steal
       * focus back from a keyboard user who has already tabbed onward. */
      setTimeout(() => {
        document.getElementById(CLOSE_SIDEBAR_ID)?.focus();
      }, 250);
    }
  };

  return (
    <TooltipAnchor
      description={tooltipDescription}
      render={
        <Button
          id={OPEN_SIDEBAR_ID}
          size="icon"
          variant="header-action"
          data-testid={testId}
          aria-label={localize('com_nav_open_sidebar')}
          aria-expanded={false}
          aria-controls="chat-history-nav"
          aria-keyshortcuts={ariaKey}
          className={className}
          onClick={handleClick}
        >
          <Sidebar className="icon-md" aria-hidden="true" />
        </Button>
      }
    />
  );
}
