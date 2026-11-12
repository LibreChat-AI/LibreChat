import { EModelEndpoint } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel } from '~/Providers';
import { cn } from '~/utils';

export default function Nav({ links }: { links: NavLink[] }) {
  const { active } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);
  return (
    <div
      className={cn(
        'text-text-primary flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto',
        /* The builder grows and shrinks as sections open; reserving the scrollbar's band keeps the
           column from losing its width in one step the moment the scrollbar appears. */
        effectiveActive === EModelEndpoint.agents && 'scrollbar-gutter-stable',
      )}
    >
      {links.map((link) =>
        link.id === effectiveActive && link.Component ? <link.Component key={link.id} /> : null,
      )}
    </div>
  );
}
