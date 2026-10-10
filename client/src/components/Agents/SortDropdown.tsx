import { useId } from 'react';
import { Dropdown } from '@librechat/client';
import { ArrowDownWideNarrow } from 'lucide-react';
import type t from 'librechat-data-provider';
import { useLocalize, TranslationKeys } from '~/hooks';

/**
 * Sort options offered by the marketplace, in the order they appear in the dropdown.
 * Also the allowlist `Marketplace.tsx` validates the `?sort=` URL param against, so an
 * option missing here is unreachable even by direct link. Keep in sync with
 * `AgentSortOption` in `packages/data-provider/src/types/assistants.ts` (the shared type)
 * and with the server-side allowlist in `api/server/controllers/agents/v1.js`.
 */
export const SORT_OPTIONS: Array<{ value: t.AgentSortOption; labelKey: TranslationKeys }> = [
  { value: 'newest', labelKey: 'com_agents_sort_newest' },
  { value: 'oldest', labelKey: 'com_agents_sort_oldest' },
  { value: 'popular', labelKey: 'com_agents_sort_popular' },
  { value: 'author', labelKey: 'com_agents_sort_author' },
];

export const DEFAULT_SORT_OPTION: t.AgentSortOption = 'newest';

interface SortDropdownProps {
  value: t.AgentSortOption;
  onChange: (value: t.AgentSortOption) => void;
}

/**
 * Sort control for the agent marketplace.
 */
const SortDropdown: React.FC<SortDropdownProps> = ({ value, onChange }) => {
  const localize = useLocalize();
  const options = SORT_OPTIONS.map((option) => ({
    value: option.value,
    label: localize(option.labelKey),
  }));
  const labelId = useId();

  return (
    <span className="flex shrink-0 items-center">
      <span id={labelId} className="sr-only">
        {localize('com_agents_sort_label')}
      </span>
      <Dropdown
        value={value}
        onChange={(v) => onChange(v as t.AgentSortOption)}
        options={options}
        sizeClasses="w-40"
        icon={<ArrowDownWideNarrow className="size-3.5 shrink-0" aria-hidden="true" />}
        shape="default"
        variant="compact"
        triggerClassName="w-40"
        testId="agent-sort-dropdown"
        aria-labelledby={labelId}
      />
    </span>
  );
};

export default SortDropdown;
