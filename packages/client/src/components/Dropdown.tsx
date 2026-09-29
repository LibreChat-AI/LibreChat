import React, { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { matchSorter } from 'match-sorter';
import * as Select from '@ariakit/react/select';
import * as Combobox from '@ariakit/react/combobox';
import type { Option } from '~/common';
import { cn, disabledFillClasses } from '~/utils';
import { fieldControl } from './Field';
import './Dropdown.css';

interface DropdownProps {
  value?: string;
  label?: string;
  onChange: (value: string) => void;
  options: (string | Option | { divider: true })[];
  /** Applied to the positioning wrapper */
  className?: string;
  /** Applied to the trigger button */
  triggerClassName?: string;
  /** Applied to the popover */
  sizeClasses?: string;
  testId?: string;
  icon?: React.ReactNode;
  iconOnly?: boolean;
  renderValue?: (option: Option) => React.ReactNode;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  portal?: boolean;
  /** `field` matches the `Input` primitive so this can sit in a form row. */
  variant?: 'default' | 'field';
  /** Renders the popover into this element instead of document.body */
  portalElement?: ((element: HTMLElement) => HTMLElement | null) | HTMLElement | null;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchEmptyText?: string;
}

const isDivider = (item: string | Option | { divider: true }): item is { divider: true } =>
  typeof item === 'object' && 'divider' in item;

const isOption = (item: string | Option | { divider: true }): item is Option =>
  typeof item === 'object' && 'value' in item && 'label' in item;

const normalizeOption = (item: string | Option): Option =>
  typeof item === 'string' ? { value: item, label: item } : item;

const Dropdown: React.FC<DropdownProps> = ({
  value: selectedValue,
  label = '',
  onChange,
  options,
  className = '',
  triggerClassName,
  sizeClasses,
  testId = 'dropdown-menu',
  icon,
  iconOnly = false,
  renderValue,
  ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  portal = true,
  variant = 'default',
  portalElement,
  disabled = false,
  searchable = false,
  searchPlaceholder,
  searchEmptyText,
}) => {
  const valueId = `${useId()}value`;
  const [searchValue, setSearchValue] = useState('');

  const handleChange = (value: string) => {
    onChange(value);
  };

  const comboboxStore = Combobox.useComboboxStore({
    resetValueOnHide: true,
    value: searchValue,
    setValue: setSearchValue,
  });

  const selectProps = Select.useSelectStore({
    combobox: searchable ? comboboxStore : undefined,
    value: selectedValue,
    setValue: handleChange,
  });

  const getOptionObject = (val: string | undefined): Option | undefined => {
    if (val == null || val === '') {
      return undefined;
    }
    return options
      .filter((o) => !isDivider(o))
      .map((o) => normalizeOption(o as string | Option))
      .find((o) => o.value === val);
  };

  const getOptionLabel = (currentValue: string | undefined) => {
    if (currentValue == null || currentValue === '') {
      return '';
    }
    const option = getOptionObject(currentValue);
    return option ? option.label : currentValue;
  };

  const matches = useMemo(() => {
    if (!searchable) {
      return [];
    }
    const optionItems = options
      .filter((o) => !isDivider(o))
      .map((o) => normalizeOption(o as string | Option));
    return matchSorter(optionItems, searchValue, {
      keys: ['label', 'value'],
      baseSort: (a, b) => (a.index < b.index ? -1 : 1),
    });
  }, [searchable, options, searchValue]);

  const renderOptionContent = (option: Option) => (
    <div className="flex w-full items-center gap-2">
      {option.icon != null && <span>{option.icon as React.ReactNode}</span>}
      <span className="block truncate">{option.label}</span>
      {selectedValue === option.value && (
        <span className="ml-auto pl-2">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="icon-md block group-hover:hidden"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12ZM16.0755 7.93219C16.5272 8.25003 16.6356 8.87383 16.3178 9.32549L11.5678 16.0755C11.3931 16.3237 11.1152 16.4792 10.8123 16.4981C10.5093 16.517 10.2142 16.3973 10.0101 16.1727L7.51006 13.4227C7.13855 13.014 7.16867 12.3816 7.57733 12.0101C7.98598 11.6386 8.61843 11.6687 8.98994 12.0773L10.6504 13.9039L14.6822 8.17451C15 7.72284 15.6238 7.61436 16.0755 7.93219Z"
              fill="currentColor"
            />
          </svg>
        </span>
      )}
    </div>
  );

  return (
    <div className={cn('relative', variant === 'field' && 'w-full', className)}>
      <Select.Select
        store={selectProps}
        disabled={disabled}
        className={cn(
          'border-border-control text-text-primary hover:bg-surface-hover hover:text-text-primary relative inline-flex items-center justify-between rounded-xl border bg-transparent py-2 text-sm transition-all duration-200 ease-in-out',
          'disabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
          disabledFillClasses,
          /** Horizontal padding would squeeze the icon, which flex-shrinks to fit */
          iconOnly ? 'size-10 justify-center px-0' : 'w-fit gap-2 px-3',
          variant === 'field' && fieldControl,
          triggerClassName,
        )}
        data-testid={testId}
        aria-label={ariaLabel}
        // `aria-labelledby` REPLACES the trigger's child text, and that text is the
        // selected option: pointing it at the field label alone announced "Clock
        // Format" with no way to hear which format is selected. Naming the value span
        // alongside the caller's label keeps both. Not in `iconOnly` mode, where the
        // span does not render and the id would dangle.
        aria-labelledby={
          ariaLabelledBy == null || iconOnly ? ariaLabelledBy : `${ariaLabelledBy} ${valueId}`
        }
      >
        <div className={cn('flex items-center gap-2', iconOnly ? 'shrink-0' : 'w-full')}>
          {icon}
          {!iconOnly && (
            <span id={valueId} className="block truncate">
              {label}
              {(() => {
                const matchedOption = getOptionObject(selectedValue);
                if (matchedOption && renderValue) {
                  return renderValue(matchedOption);
                }
                return getOptionLabel(selectedValue);
              })()}
            </span>
          )}
        </div>
        {!iconOnly && <Select.SelectArrow />}
      </Select.Select>
      <Select.SelectPopover
        portal={portal}
        portalElement={portalElement}
        store={selectProps}
        className={cn(
          // `className` sizes the TRIGGER only (applied above on Select.Select).
          // Forwarding it here too meant a caller's trigger height (e.g. `h-10`)
          // became the popover's height as well, clipping every option below the
          // first out of view. `sizeClasses` is the popover's own sizing prop; the
          // shared `.popover-ui` class already caps height to the viewport via
          // `--popover-available-height` and scrolls, so nothing else is needed here.
          'popover-ui z-40 text-sm',
          '[pointer-events:auto]', // Override body's pointer-events:none when in modal
          sizeClasses,
        )}
      >
        {searchable ? (
          <>
            <div className="sticky -top-2 z-10 -mx-2 -mt-2 mb-1 bg-inherit px-2 pt-2 pb-1.5">
              <div className="relative">
                <Search
                  className="text-text-tertiary pointer-events-none absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Combobox.Combobox
                  store={comboboxStore}
                  autoSelect
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="border-border-control text-text-primary placeholder:text-text-secondary w-full rounded-lg border bg-inherit py-1.5 pr-2 pl-8 text-sm focus:outline-hidden"
                />
              </div>
            </div>
            <Combobox.ComboboxList
              store={comboboxStore}
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              className="flex flex-col"
            >
              {matches.map((option) => (
                <Combobox.ComboboxItem
                  key={`option-${String(option.value)}`}
                  value={String(option.value)}
                  className="select-item"
                  render={
                    <Select.SelectItem value={String(option.value)} data-theme={option.value} />
                  }
                >
                  {renderOptionContent(option)}
                </Combobox.ComboboxItem>
              ))}
            </Combobox.ComboboxList>
            {matches.length === 0 && (
              <div className="text-text-secondary px-2 py-6 text-center text-sm" aria-hidden="true">
                {searchEmptyText}
              </div>
            )}
            <div role="status" aria-live="polite" className="sr-only">
              {matches.length === 0 ? searchEmptyText : ''}
            </div>
          </>
        ) : (
          options.map((item, index) => {
            if (isDivider(item)) {
              return <div key={`divider-${index}`} className="border-border-heavy my-1 border-t" />;
            }

            const option = normalizeOption(item);
            if (!isOption(option)) {
              return null;
            }

            return (
              <Select.SelectItem
                key={`option-${index}`}
                value={String(option.value)}
                className="select-item"
                data-theme={option.value}
              >
                {renderOptionContent(option)}
              </Select.SelectItem>
            );
          })
        )}
      </Select.SelectPopover>
    </div>
  );
};

export default Dropdown;
