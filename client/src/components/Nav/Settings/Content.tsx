import { useMemo } from 'react';
import type { SettingsContextValue, SettingsTab, SettingEntry } from './types';
import { filterSettings } from './search';
import { useLocalize } from '~/hooks';
import { registry } from './registry';
import Section from './Section';
import { TABS } from './types';

interface ContentProps {
  activeTab: SettingsTab;
  query: string;
  ctx: SettingsContextValue;
}

function visible(entry: SettingEntry, ctx: SettingsContextValue): boolean {
  return !entry.show || entry.show(ctx);
}

export default function Content({ activeTab, query, ctx }: ContentProps) {
  const localize = useLocalize();
  const tab = TABS.find((t) => t.id === activeTab)!;

  const results = useMemo(
    () => (query.trim() ? filterSettings(registry, query, ctx, localize) : null),
    [query, ctx, localize],
  );

  if (results !== null) {
    return (
      <div aria-label={localize('com_ui_settings_results_aria')} aria-live="polite">
        {results.length === 0 ? (
          <p className="text-text-secondary p-2 text-sm">
            {localize('com_ui_settings_no_results')}
          </p>
        ) : (
          <div className="text-text-primary overflow-hidden rounded-xl text-sm">
            {results.map(({ entry, label }) => {
              const Cmp = entry.Component;
              const tabMeta = TABS.find((t) => t.id === entry.tab)!;
              const sectionMeta = tabMeta.sections.find((s) => s.id === entry.section);
              return (
                <div key={entry.id} className="px-4 py-3">
                  <div className="text-text-tertiary mb-1.5 text-xs">
                    {localize(tabMeta.labelKey)} ›{' '}
                    {sectionMeta ? localize(sectionMeta.labelKey) : label}
                  </div>
                  <Cmp />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {tab.sections.map((section) => {
        const entries = registry.filter(
          (e) => e.tab === activeTab && e.section === section.id && visible(e, ctx),
        );
        if (entries.length === 0) {
          return null;
        }
        return (
          <Section
            key={section.id}
            heading={localize(section.labelKey)}
            icon={section.icon}
            danger={section.danger}
          >
            {entries.map((e) => {
              const Cmp = e.Component;
              return (
                <div key={e.id} className="px-4 py-3">
                  <Cmp />
                </div>
              );
            })}
          </Section>
        );
      })}
    </div>
  );
}
