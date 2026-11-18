import { useState, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { ShieldAlert } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { TSkillListResponse } from 'librechat-data-provider';
import { useDebounce, useNavScrolling, useHasAccess, useLocalize } from '~/hooks';
import CollectionError from '~/components/ui/CollectionError';
import { PanelContent, ListLoading } from '~/components/ui';
import SkillListSkeleton from '../lists/SkillListSkeleton';
import { useSkillsInfiniteQuery } from '~/data-provider';
import SkillListPanel from '../lists/SkillList';
import FilterSkills from './FilterSkills';
import { cn } from '~/utils';
import store from '~/store';

/** A first page that fills a tall panel, so opening it does not immediately fetch a second one to fill the gap. */
const PAGE_SIZE = 50;

interface SkillsSidePanelProps {
  className?: string;
  visible?: boolean;
}

/**
 * Skills sidebar panel.
 * Header: filter input + create menu, matching the other side panels.
 */

export default function SkillsSidePanel({ className, visible }: SkillsSidePanelProps) {
  const localize = useLocalize();
  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const { skillId: activeSkillId } = useParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [sectionOpen, setSectionOpen] = useState(true);
  const debouncedSearch = useDebounce(searchTerm, 250);

  const listQuery = useSkillsInfiniteQuery(
    { search: debouncedSearch || undefined, limit: PAGE_SIZE },
    { enabled: hasAccess },
  );

  const pages = useMemo(() => listQuery.data?.pages ?? [], [listQuery.data]);
  const skills = useMemo(() => pages.flatMap((page) => page.skills), [pages]);

  const lastPage = pages[pages.length - 1];
  const nextCursor = lastPage?.has_more === true ? lastPage.after : null;

  /** A collapsed sidebar keeps this panel mounted, so stop draining pages into it */
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const panelVisible = visible ?? sidebarExpanded;

  const { containerRef } = useNavScrolling<TSkillListResponse>({
    nextCursor,
    isFetchingNext: listQuery.isFetchingNextPage,
    fetchNextPage: listQuery.fetchNextPage,
    enabled: hasAccess && panelVisible && sectionOpen && !listQuery.isError,
  });

  if (!hasAccess) {
    return <EmptyState icon={ShieldAlert} title={localize('com_ui_feature_no_access')} />;
  }

  return (
    <div
      className={cn(
        'border-border-light flex h-full w-full flex-col overflow-hidden border-e pt-2',
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
        {(!listQuery.isError || skills.length > 0) && (
          <SkillListPanel
            skills={skills}
            activeSkillId={activeSkillId}
            sectionOpen={sectionOpen}
            onSectionOpenChange={setSectionOpen}
            isFiltered={debouncedSearch.trim().length > 0}
          />
        )}
        {listQuery.isError && <CollectionError onRetry={() => listQuery.refetch()} />}
        {/* Appending the next page, so the loaded rows stay put */}
        {listQuery.isFetchingNextPage && <ListLoading />}
      </PanelContent>
    </div>
  );
}
