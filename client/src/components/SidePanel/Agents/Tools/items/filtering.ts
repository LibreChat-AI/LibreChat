import type { AgentItem, ItemFilter } from './types';
import { itemKey } from './selectors';

/**
 * Extra, non-serializable inputs the view filter needs. Kept out of
 * `ItemFilter` (which models the persisted filter UI state) so live query data
 * — like the set of favorited ids — can be threaded in by callers.
 */
export interface FilterContext {
  /**
   * Compound `kind:id` keys (the `itemKey` format) of the user's favorited
   * items; required for the `favorites` view. Compound keys prevent an item
   * of one kind from matching a favorite of another kind with the same id.
   */
  favoritedIds?: Set<string>;
}

function getCategory(item: AgentItem): string | undefined {
  if (item.kind === 'skill') {
    return item.skill.category;
  }
  return undefined;
}

function matchesSearch(item: AgentItem, search: string): boolean {
  if (!search) return true;
  const term = search.toLowerCase();
  return item.name.toLowerCase().includes(term) || item.description.toLowerCase().includes(term);
}

function matchesKind(item: AgentItem, kind: ItemFilter['kind']): boolean {
  if (!kind || kind === 'all') return true;
  return item.kind === kind;
}

function matchesCategory(item: AgentItem, category: ItemFilter['category']): boolean {
  if (!category || category === 'all') return true;
  return getCategory(item) === category;
}

export function matchesView(
  item: AgentItem,
  view: ItemFilter['view'],
  context: FilterContext,
): boolean {
  switch (view) {
    case 'mine':
      return item.ownedByUser === true;
    case 'favorites':
      return context.favoritedIds?.has(itemKey(item)) === true;
    default:
      return true;
  }
}

export function applyFilter(
  items: AgentItem[],
  filter: ItemFilter,
  context: FilterContext = {},
): AgentItem[] {
  return items.filter(
    (item) =>
      matchesSearch(item, filter.search ?? '') &&
      matchesKind(item, filter.kind) &&
      matchesCategory(item, filter.category) &&
      matchesView(item, filter.view, context),
  );
}
