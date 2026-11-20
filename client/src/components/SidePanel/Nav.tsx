import { Suspense } from 'react';
import { Spinner } from '@librechat/client';
import { EModelEndpoint } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Panels load on first open; on a slow link the fetch would otherwise leave the panel blank. */
function PanelLoading() {
  const localize = useLocalize();
  return (
    <div role="status" className="text-text-secondary flex flex-1 items-center justify-center py-8">
      <Spinner size={20} />
      <span className="sr-only">{localize('com_ui_loading')}</span>
    </div>
  );
}

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
      <Suspense fallback={<PanelLoading />}>
        {links.map((link) =>
          link.id === effectiveActive && link.Component ? <link.Component key={link.id} /> : null,
        )}
      </Suspense>
    </div>
  );
}
