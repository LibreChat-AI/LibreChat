import { LayoutGrid } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { LocalizeFunction } from '~/common';
import { CustomMenuItem as MenuItem } from '../CustomMenu';
import { cn } from '~/utils';

const marketplaceSearchAliases = ['agent marketplace', 'marketplace'];

export function marketplaceSearchMatches(searchValue: string, localize: LocalizeFunction): boolean {
  const searchTerm = searchValue.trim().toLowerCase();
  if (!searchTerm) {
    return true;
  }

  return [
    localize('com_agents_marketplace'),
    localize('com_ui_marketplace'),
    ...marketplaceSearchAliases,
  ].some((label) => label.toLowerCase().includes(searchTerm));
}

export default function MarketplaceItem({
  className,
  label,
  posInSet,
  setSize,
}: {
  className?: string;
  label: string;
  /** Set when the sibling model list is virtualized; see `VirtualizedModelList`. */
  posInSet?: number;
  setSize?: number;
}) {
  const navigate = useNavigate();

  return (
    <MenuItem
      onClick={() => navigate('/agents')}
      aria-label={label}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      data-testid="model-selector-marketplace-item"
      className={cn(
        'flex w-full cursor-pointer items-center justify-between rounded-lg px-2 text-sm',
        className,
      )}
    >
      <div className="flex w-full min-w-0 items-center gap-2 px-1 py-1">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center">
          <LayoutGrid className="h-5 w-5 text-text-primary" aria-hidden="true" />
        </div>
        <span className="truncate text-left">{label}</span>
      </div>
    </MenuItem>
  );
}
