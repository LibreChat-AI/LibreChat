import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel } from '~/Providers';

export default function Nav({ links, activeId }: { links: NavLink[]; activeId?: string }) {
  const { active } = useActivePanel();
  const effectiveActive = resolveActivePanel(activeId ?? active, links);
  return (
    <div className="text-text-primary flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto">
      {links.map((link) =>
        link.id === effectiveActive && link.Component ? <link.Component key={link.id} /> : null,
      )}
    </div>
  );
}
