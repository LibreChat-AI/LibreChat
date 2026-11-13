import { memo, useCallback } from 'react';
import { useAtom } from 'jotai';
import type { Ref } from 'react';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import { consoleRailExpandedAtom } from './state';
import Console from './Console';

function Navigation({
  links,
  panelExpanded,
  onExpand,
  onCollapse,
  onLeavePage,
  routeActiveId,
  panelToggleRef,
  switchToHistory,
  appTitle,
  onSelect,
}: {
  links: NavLink[];
  panelExpanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onLeavePage: () => void;
  routeActiveId?: string;
  panelToggleRef?: Ref<HTMLButtonElement>;
  switchToHistory: boolean;
  appTitle: string;
  onSelect?: (id: string) => void;
}) {
  const [railExpanded, setRailExpanded] = useAtom(consoleRailExpandedAtom);
  const { active, setActive } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);

  const toggleRail = useCallback(() => setRailExpanded((value) => !value), [setRailExpanded]);
  const selectPanel = useCallback(
    (id: string) => {
      const link = links.find((entry) => entry.id === id);
      if (!link || link.disabled) {
        return;
      }
      if (link.onClick) {
        link.onClick();
        return;
      }
      if (!routeActiveId && id === effectiveActive && panelExpanded) {
        onCollapse();
        return;
      }
      setActive(id);
      if (routeActiveId) {
        onLeavePage();
      }
      if (!panelExpanded) {
        onExpand();
      }
    },
    [
      links,
      routeActiveId,
      effectiveActive,
      panelExpanded,
      setActive,
      onCollapse,
      onLeavePage,
      onExpand,
    ],
  );
  const handleNewChat = useCallback(() => {
    if (switchToHistory) {
      setActive(DEFAULT_PANEL);
    }
  }, [switchToHistory, setActive]);

  return (
    <Console
      links={links}
      railExpanded={railExpanded}
      onToggleRail={toggleRail}
      activeId={routeActiveId ?? effectiveActive}
      onSelect={onSelect ?? selectPanel}
      panelExpanded={panelExpanded}
      onTogglePanel={routeActiveId ? undefined : panelExpanded ? onCollapse : onExpand}
      panelToggleRef={panelToggleRef}
      onNewChat={handleNewChat}
      appTitle={appTitle}
    />
  );
}

export default memo(Navigation);
