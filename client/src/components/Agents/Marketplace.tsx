import React, { useEffect, useMemo, useRef } from 'react';
import { useMediaQuery } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useSearchParams, useParams, useNavigate } from 'react-router-dom';
import type t from 'librechat-data-provider';
import { useGetEndpointsQuery, useGetAgentCategoriesQuery } from '~/data-provider';
import SortDropdown, { SORT_OPTIONS, DEFAULT_SORT_OPTION } from './SortDropdown';
import { useDocumentTitle, useHasAccess, useLocalize } from '~/hooks';
import MarketplaceAdminSettings from './MarketplaceAdminSettings';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { SidePanelGroup } from '~/components/SidePanel';
import MineFilterToggle from './MineFilterToggle';
import CategoryTabs from './CategoryTabs';
import SearchBar from './SearchBar';
import AgentGrid from './AgentGrid';

interface AgentMarketplaceProps {
  className?: string;
}

const AgentMarketplace: React.FC<AgentMarketplaceProps> = ({ className = '' }) => {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { category } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchQuery = searchParams.get('q') || '';
  const sort = useMemo<t.AgentSortOption>(() => {
    const value = searchParams.get('sort');
    return SORT_OPTIONS.some((option) => option.value === value)
      ? (value as t.AgentSortOption)
      : DEFAULT_SORT_OPTION;
  }, [searchParams]);
  const mine: 0 | 1 = searchParams.get('mine') === '1' ? 1 : 0;

  useDocumentTitle(`${localize('com_agents_marketplace')} | LibreChat`);
  useGetEndpointsQuery();
  const categoriesQuery = useGetAgentCategoriesQuery({
    staleTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
  const hasPromotedCategory = categoriesQuery.data?.some((item) => item.value === 'promoted');
  /* Turning the filter on from Top Picks navigates to `/agents/all`, because an authored
     agent is rarely promoted. A restored or shared `/agents?mine=1` carries no path
     category, so defaulting it to `promoted` would answer the same intent with the empty
     promoted-and-mine intersection instead of the caller's agents. */
  const defaultCategory = hasPromotedCategory && mine !== 1 ? 'promoted' : 'all';
  const activeCategory = category || defaultCategory;

  const handleTabChange = (value: string) => {
    if (value === activeCategory) {
      return;
    }
    const params = new URLSearchParams(searchParams);
    /* Top Picks is a curated set, so the filter that sent the user to `/agents/all` when
       they turned it on is released when they choose Top Picks again. Carrying it here
       would resolve straight back to All below and make the tab unselectable. */
    if (value === 'promoted') {
      params.delete('mine');
    }
    navigate({
      pathname: value === 'promoted' ? '/agents' : `/agents/${encodeURIComponent(value)}`,
      search: params.toString(),
    });
  };

  const handleSearch = (query: string) => {
    const params = new URLSearchParams(searchParams);
    if (query.trim()) {
      params.set('q', query.trim());
    } else {
      params.delete('q');
    }
    setSearchParams(params);
  };

  const handleSortChange = (value: t.AgentSortOption) => {
    const params = new URLSearchParams(searchParams);
    if (value === DEFAULT_SORT_OPTION) {
      params.delete('sort');
    } else {
      params.set('sort', value);
    }
    setSearchParams(params);
  };

  const handleMineChange = (checked: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (checked) {
      params.set('mine', '1');
    } else {
      params.delete('mine');
    }
    if (checked && activeCategory === 'promoted') {
      navigate({ pathname: '/agents/all', search: params.toString() });
      return;
    }
    /* Dropping the filter on a path that carries no category would hand the view back to
       Top Picks, which is not what turning a filter off means. Name the category the user
       was already looking at instead. */
    if (!checked && category == null && activeCategory === 'all') {
      navigate({ pathname: '/agents/all', search: params.toString() });
      return;
    }
    setSearchParams(params);
  };

  const hasAccessToMarketplace = useHasAccess({
    permissionType: PermissionTypes.MARKETPLACE,
    permission: Permissions.USE,
  });
  useEffect(() => {
    if (hasAccessToMarketplace) {
      return;
    }
    const timeoutId = setTimeout(() => navigate('/c/new'), 1000);
    return () => clearTimeout(timeoutId);
  }, [hasAccessToMarketplace, navigate]);

  if (!hasAccessToMarketplace) {
    return null;
  }

  return (
    <div
      className={`bg-surface-primary-alt relative flex w-full grow overflow-hidden ${className}`}
    >
      <SidePanelGroup>
        <main
          className="flex h-full min-w-0 flex-col overflow-hidden"
          aria-labelledby="marketplace-heading"
        >
          {/* The compact header has no room for a visible title, but a landmark label is
              not reachable by heading navigation: without this the document's outline
              would start at an agent card. */}
          <h1 id="marketplace-heading" className="sr-only">
            {localize('com_agents_marketplace')}
          </h1>
          <div className="border-border-light shrink-0 border-b">
            <div className="flex items-center gap-2 p-3">
              {isSmallScreen && <OpenSidebar className="size-9 shrink-0 rounded-lg" />}
              <SearchBar value={searchQuery} onSearch={handleSearch} className="min-w-0 flex-1" />
              <MarketplaceAdminSettings />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-3">
              <div className="min-w-0 flex-1 basis-full lg:basis-0">
                <CategoryTabs
                  categories={categoriesQuery.data || []}
                  activeTab={activeCategory}
                  isLoading={categoriesQuery.isLoading}
                  onChange={handleTabChange}
                />
              </div>
              <div className="ms-auto flex shrink-0 items-center gap-1.5">
                <MineFilterToggle checked={mine === 1} onCheckedChange={handleMineChange} />
                <SortDropdown value={sort} onChange={handleSortChange} />
              </div>
            </div>
          </div>
          <div
            ref={scrollContainerRef}
            className="min-h-0 flex-1 scrollbar-gutter-stable overflow-x-hidden overflow-y-auto p-3"
          >
            {/* Deliberately unkeyed: the grid's own `scopeKey` already carries the category,
                so it replaces the results itself and hands focus back when the scope
                changes. Remounting it on the category instead would destroy an open detail
                dialog and its return target, and the replacement grid starts with an empty
                `previousScopeKeyRef`, so it reads that render as a first mount and leaves
                focus on the document. */}
            <AgentGrid
              category={activeCategory}
              searchQuery={searchQuery}
              scrollElementRef={scrollContainerRef}
              sort={sort}
              mine={mine}
            />
          </div>
        </main>
      </SidePanelGroup>
    </div>
  );
};

export default AgentMarketplace;
