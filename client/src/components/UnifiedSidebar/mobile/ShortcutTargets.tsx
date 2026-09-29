import { memo } from 'react';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel } from '~/Providers';

/**
 * The panel keyboard shortcuts locate a panel by its rail button
 * (`[data-testid="nav-panel-*"]`), read `aria-pressed`, and click it. The rail
 * does not exist on mobile, so those shortcuts would silently no-op on a
 * narrow window or a tablet with a keyboard.
 *
 * These hidden buttons keep that contract intact without reviving the rail.
 * Routing the shortcuts through `useActivePanel` instead would mean hoisting
 * `ActivePanelProvider` above `SidebarChatProvider`, which exists specifically
 * to keep panel changes from re-running `useChatHelpers`.
 *
 * Only available links render, so a shortcut for a panel this endpoint does not
 * offer still correctly does nothing.
 */
function ShortcutTargets({
  links,
  onLeaveInsights,
  routeActiveId,
}: {
  links: NavLink[];
  onLeaveInsights?: () => void;
  routeActiveId?: string;
}) {
  const { active, setActive } = useActivePanel();
  const activeId = routeActiveId ?? resolveActivePanel(active, links);

  return (
    <>
      {links.map((link) => (
        <button
          key={link.id}
          type="button"
          hidden
          tabIndex={-1}
          data-testid={`nav-panel-${link.id}`}
          aria-pressed={link.id === activeId}
          disabled={link.disabled}
          onClick={() => {
            if (link.onClick) {
              link.onClick();
              return;
            }
            setActive(link.id);
            if (routeActiveId) {
              onLeaveInsights?.();
            }
          }}
        />
      ))}
    </>
  );
}

export default memo(ShortcutTargets);
