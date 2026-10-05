import * as Tabs from '@radix-ui/react-tabs';
import { Search, X, ChevronRight } from 'lucide-react';
import type { SettingsContextValue, SettingsTab } from './types';
import { useLocalize } from '~/hooks';
import { TABS } from './types';
import { cn } from '~/utils';

interface SidebarProps {
  ctx: SettingsContextValue;
  query: string;
  onQueryChange: (q: string) => void;
  onSelectTab: (tab: SettingsTab) => void;
  showChevron?: boolean;
  hideTabs?: boolean;
  /** Stacked above the content pane rather than beside it. */
  stacked?: boolean;
}

export default function Sidebar({
  ctx,
  query,
  onQueryChange,
  onSelectTab,
  showChevron = false,
  hideTabs = false,
  stacked = false,
}: SidebarProps) {
  const localize = useLocalize();
  const tabs = TABS.filter((t) => !t.show || t.show(ctx));

  return (
    <div
      className={cn(
        'flex min-h-0 w-full flex-col gap-3 overflow-hidden',
        !stacked && 'w-[14.375rem]',
        stacked && !hideTabs && 'flex-1',
      )}
    >
      <div className="relative shrink-0">
        <Search
          className="text-text-tertiary pointer-events-none absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              onQueryChange('');
            }
          }}
          placeholder={localize('com_ui_settings_search_placeholder')}
          aria-label={localize('com_ui_settings_search_placeholder')}
          className="bg-surface-secondary text-text-primary w-full rounded-lg py-2 pr-8 pl-8 text-sm focus-visible:outline-hidden"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label={localize('com_ui_clear_search')}
            className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {!hideTabs && (
        <Tabs.List
          aria-label={localize('com_nav_settings')}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
        >
          {tabs.map((tab) => (
            <Tabs.Trigger
              key={tab.id}
              value={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={cn(
                'text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary rounded-theme-control flex shrink-0 items-center justify-between gap-2 px-3 py-2.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset md:py-2',
                'data-[state=active]:bg-surface-tertiary data-[state=active]:text-text-primary',
              )}
            >
              <span className="flex min-w-0 items-center gap-2 [&>svg]:shrink-0">
                {tab.icon}
                <span className="min-w-0 text-left break-words">{localize(tab.labelKey)}</span>
              </span>
              {showChevron && (
                <ChevronRight className="text-text-tertiary h-4 w-4 shrink-0" aria-hidden="true" />
              )}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      )}
    </div>
  );
}
