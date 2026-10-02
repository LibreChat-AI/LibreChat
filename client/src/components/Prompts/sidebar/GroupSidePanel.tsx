import { useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { Button, Sidebar, Spinner, TooltipAnchor } from '@librechat/client';
import type { PromptGroupListResponse } from 'librechat-data-provider';
import { useLocalize, useNavScrolling, activateCatalog } from '~/hooks';
import PromptGroupSkeleton from '../lists/PromptGroupSkeleton';
import { usePromptGroupsContext } from '~/Providers';
import { PanelContent } from '~/components/ui';
import List from '../lists/List';
import { cn } from '~/utils';
import store from '~/store';

export default function GroupSidePanel({
  children,
  footer,
  className = '',
  closePanelRef,
  onClose,
  isChatRoute: isChatRouteProp,
}: {
  children?: React.ReactNode;
  /** Rendered below the list, outside the scroll area, so it stays visible */
  footer?: React.ReactNode;
  className?: string;
  closePanelRef?: React.RefObject<HTMLButtonElement>;
  onClose?: () => void;
  isChatRoute?: boolean;
}) {
  const location = useLocation();
  const localize = useLocalize();
  const isChatRoute = isChatRouteProp ?? location.pathname?.startsWith('/c/') ?? false;

  const context = usePromptGroupsContext();

  /** A collapsed sidebar keeps this panel mounted, so stop draining pages into it */
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  /** Mirrors UnifiedSidebar's panelExpanded: the insights route collapses the
   * panel while the atom stays true, so visibility is atom AND route */
  const panelVisible = sidebarExpanded && !location.pathname.startsWith('/insights');

  /** The panel stays mounted while hidden, so only a visible panel releases
   * its catalog ahead of the background warmup schedule */
  useEffect(() => {
    if (panelVisible) {
      activateCatalog('prompts');
    }
  }, [panelVisible]);

  const { containerRef } = useNavScrolling<PromptGroupListResponse>({
    nextCursor: context?.nextCursor,
    isFetchingNext: context?.isFetchingNextPage ?? false,
    fetchNextPage: context?.fetchNextPage,
    enabled: sidebarExpanded,
  });

  if (!context) {
    return null;
  }
  const { promptGroups, groupsQuery, isFetchingNextPage } = context;

  return (
    <div id="prompts-panel" className={cn('flex h-full w-full flex-col', className)}>
      {onClose && (
        <div className="flex items-center justify-end px-2 py-[2px] md:py-2">
          <TooltipAnchor
            description={localize('com_nav_close_sidebar')}
            render={
              <Button
                ref={closePanelRef}
                size="icon"
                variant="outline"
                data-testid="close-prompts-panel-button"
                aria-label={localize('com_nav_close_sidebar')}
                aria-expanded={true}
                className="hover:bg-surface-hover rounded-full border-none bg-transparent p-2 md:rounded-xl"
                onClick={onClose}
              >
                <Sidebar />
              </Button>
            }
          />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Sticky header: it brings its own padding via PanelHeader */}
        <div className="text-text-primary shrink-0">{children}</div>
        <PanelContent
          ref={containerRef}
          isLoading={!!groupsQuery.isLoading}
          skeleton={<PromptGroupSkeleton />}
          className="text-text-primary flex scrollbar-gutter-stable flex-col gap-2 overflow-x-hidden pr-1 pb-3 pl-3"
        >
          <List groups={promptGroups} isChatRoute={isChatRoute} />
          {/* Appending the next page, so the loaded rows stay put */}
          {isFetchingNextPage && (
            <div className="flex shrink-0 justify-center py-2">
              <Spinner className="size-4" />
              <span className="sr-only" aria-live="polite" aria-atomic="true">
                {localize('com_ui_loading')}
              </span>
            </div>
          )}
        </PanelContent>
      </div>
      {footer}
    </div>
  );
}
