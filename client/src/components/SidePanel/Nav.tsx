import { EModelEndpoint } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import {
  FeatureSlot,
  FeatureVisibility,
  useFeaturePresentation,
} from '~/components/FeaturePresentation/Context';
import { getPageForNavId } from '~/components/FeaturePresentation/registry';
import { useActivePanel, resolveActivePanel } from '~/Providers';
import { cn } from '~/utils';

export default function Nav({ links, visible = true }: { links: NavLink[]; visible?: boolean }) {
  const { active } = useActivePanel();
  const presentation = useFeaturePresentation();
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
      <FeatureVisibility.Provider value={visible}>
        {links.map((link) => {
          if (link.id !== effectiveActive || !link.Component) {
            return null;
          }
          const page = getPageForNavId(link.id);
          return page && presentation?.canOpenPage(page) ? (
            <FeatureSlot key={link.id} page={page} view="panel" visible={visible} />
          ) : (
            <link.Component key={link.id} />
          );
        })}
      </FeatureVisibility.Provider>
    </div>
  );
}
