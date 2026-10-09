import { memo, startTransition, useId, type MemoExoticComponent } from 'react';
import { Search } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';
import type { DataTableSearchProps } from './DataTable.types';
import { useLocalize } from '~/hooks';
import { Input } from '../Input';
import { cn } from '~/utils';

export const DataTableSearch: MemoExoticComponent<
  ({ value, onChange, placeholder, className, disabled }: DataTableSearchProps) => JSX.Element
> = memo(
  ({
    value,
    onChange,
    placeholder,
    className,
    disabled = false,
  }: DataTableSearchProps): JSX.Element => {
    const localize = useLocalize();
    const searchId = useId();
    const descriptionId = `${searchId}-description`;

    return (
      <div className="relative flex-1">
        <label htmlFor={searchId} className="sr-only">
          {localize('com_ui_search_table')}
        </label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-tertiary"
          aria-hidden="true"
        />
        <Input
          id={searchId}
          value={value}
          onChange={(e) => {
            startTransition(() => onChange(e.target.value));
          }}
          disabled={disabled}
          aria-label={localize('com_ui_search_table')}
          aria-describedby={descriptionId}
          placeholder={placeholder || localize('com_ui_search')}
          className={cn(
            'h-11 rounded-none border-0 bg-transparent pl-9 text-sm placeholder:text-text-tertiary focus-visible:ring-inset',
            className,
          )}
        />
        <span id={descriptionId} className="sr-only">
          {localize('com_ui_search_table_description')}
        </span>
      </div>
    );
  },
);

DataTableSearch.displayName = 'DataTableSearch';
