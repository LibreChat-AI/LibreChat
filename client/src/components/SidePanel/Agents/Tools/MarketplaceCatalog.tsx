import { Search } from 'lucide-react';
import { Skeleton } from '@librechat/client';
import type { AgentItem, ItemFilter, ItemStatus } from './items/types';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { itemKey } from './items/selectors';
import { useLocalize } from '~/hooks';
import ToolCard from './ToolCard';

type View = NonNullable<ItemFilter['view']>;

interface MarketplaceCatalogProps {
  items: AgentItem[];
  selectedIds: Set<string>;
  onToggle: (item: AgentItem) => void;
  onConfigure?: (item: AgentItem) => void;
  view?: View;
  isLoadingSkills?: boolean;
  skillsInView?: boolean;
  /** Compound `kind:id` keys of the user's favorited items. */
  favoriteKeys?: Set<string>;
  onToggleFavorite?: (item: AgentItem) => void;
  /** Overrides the default per-view empty message (e.g. "No skills found"). */
  emptyKey?: TranslationKeys;
  /** Accessible label for the grid; defaults to the marketplace label. */
  ariaLabel?: string;
  /** Live state per item, such as an MCP server's connection. */
  statusFor?: (item: AgentItem) => ItemStatus | undefined;
}

const SKELETON_COUNT = 3;

const EMPTY_COPY_KEYS: Record<View, TranslationKeys> = {
  marketplace: 'com_ui_tools_search_no_results',
  mine: 'com_ui_tools_view_mine_empty',
  favorites: 'com_ui_tools_view_favorites_empty',
};

function ToolCardSkeleton() {
  return (
    <div className="border-border-light flex h-32 w-full flex-col gap-2 rounded-2xl border p-4">
      <div className="flex w-full items-start gap-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

export default function MarketplaceCatalog({
  items,
  selectedIds,
  onToggle,
  onConfigure,
  view = 'marketplace',
  isLoadingSkills = false,
  skillsInView = false,
  favoriteKeys,
  onToggleFavorite,
  emptyKey,
  ariaLabel,
  statusFor,
}: MarketplaceCatalogProps) {
  const localize = useLocalize();
  const showSkeletons = isLoadingSkills && skillsInView;

  if (items.length === 0 && !showSkeletons) {
    return (
      <div role="status" className="flex flex-col items-center justify-center py-16 text-center">
        <Search className="text-text-tertiary size-8 opacity-40" aria-hidden="true" />
        <p className="text-text-secondary mt-3 text-sm">
          {localize(emptyKey ?? EMPTY_COPY_KEYS[view])}
        </p>
      </div>
    );
  }

  return (
    <ul
      className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
      aria-label={ariaLabel ?? localize('com_ui_tools_marketplace')}
      aria-busy={showSkeletons}
    >
      {items.map((item) => (
        <li key={itemKey(item)}>
          <ToolCard
            item={item}
            selected={selectedIds.has(itemKey(item))}
            onToggle={onToggle}
            onConfigure={onConfigure}
            isFavorited={favoriteKeys?.has(itemKey(item)) ?? false}
            onToggleFavorite={onToggleFavorite}
            status={statusFor?.(item)}
          />
        </li>
      ))}
      {showSkeletons &&
        Array.from({ length: SKELETON_COUNT }, (_, index) => (
          <li key={`skeleton:${index}`} aria-hidden="true">
            <ToolCardSkeleton />
          </li>
        ))}
    </ul>
  );
}
