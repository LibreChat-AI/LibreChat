import { useState, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { Spinner } from '@librechat/client';
import { useParams } from 'react-router-dom';
import type { TSkillListResponse } from 'librechat-data-provider';
import { useLocalize, useDebounce, useNavScrolling } from '~/hooks';
import SkillListSkeleton from '../lists/SkillListSkeleton';
import { useSkillsInfiniteQuery } from '~/data-provider';
import SkillListPanel from '../lists/SkillList';
import { PanelContent } from '~/components/ui';
import FilterSkills from './FilterSkills';
import { cn } from '~/utils';
import store from '~/store';

interface SkillsSidePanelProps {
  className?: string;
}

/**
 * Skills sidebar panel.
 * Header: filter input + create menu, matching the other side panels.
 */

export default function SkillsSidePanel({ className }: SkillsSidePanelProps) {
  const localize = useLocalize();
  const { skillId: activeSkillId } = useParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [sectionOpen, setSectionOpen] = useState(true);
  const debouncedSearch = useDebounce(searchTerm, 250);

  const listQuery = useSkillsInfiniteQuery({ search: debouncedSearch || undefined, limit: 20 });

  const pages = useMemo(() => listQuery.data?.pages ?? [], [listQuery.data]);
  const skills = useMemo(() => pages.flatMap((page) => page.skills), [pages]);

  const lastPage = pages[pages.length - 1];
  const nextCursor = lastPage?.has_more === true ? lastPage.after : null;

  /** A collapsed sidebar keeps this panel mounted, so stop draining pages into it */
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);

  const { containerRef } = useNavScrolling<TSkillListResponse>({
    nextCursor,
    isFetchingNext: listQuery.isFetchingNextPage,
    fetchNextPage: listQuery.fetchNextPage,
    enabled: sidebarExpanded && sectionOpen,
  });

  return (
    <div
      className={cn(
        'border-border-light flex h-full w-full flex-col overflow-hidden border-r pt-2',
        className,
      )}
    >
      <FilterSkills searchTerm={searchTerm} onSearchChange={(e) => setSearchTerm(e.target.value)} />

      {/* Only the list scrolls */}
      <PanelContent
        ref={containerRef}
        isLoading={listQuery.isLoading}
        skeleton={<SkillListSkeleton />}
        className="px-3 pb-3"
      >
        <SkillListPanel
          skills={skills}
          activeSkillId={activeSkillId}
          sectionOpen={sectionOpen}
          onSectionOpenChange={setSectionOpen}
        />
        {/* Appending the next page, so the loaded rows stay put */}
        {listQuery.isFetchingNextPage && (
          <div className="flex shrink-0 justify-center py-2">
            <Spinner className="size-4" />
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {localize('com_ui_loading')}
            </span>
          </div>
        )}
      </PanelContent>
    </div>
  );
}
