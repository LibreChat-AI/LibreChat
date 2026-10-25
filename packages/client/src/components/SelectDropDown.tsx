import React from 'react';
import { JSX } from 'react/jsx-runtime';
import {
  Label,
  Listbox,
  Transition,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react';
import type { Option, OptionWithIcon, DropdownValueSetter } from '~/common';
import { cn, disabledFillClasses } from '~/utils';
import { useMultiSearch } from './MultiSearch';
import { CheckMark } from '~/svgs';

type SelectDropDownProps = {
  id?: string;
  title?: string;
  disabled?: boolean;
  value: string | null | Option | OptionWithIcon;
  setValue: DropdownValueSetter | ((value: string) => void);
  tabIndex?: number;
  availableValues?: string[] | Option[] | OptionWithIcon[];
  emptyTitle?: boolean;
  showAbove?: boolean;
  showLabel?: boolean;
  iconSide?: IconSide;
  optionIconSide?: IconSide;
  renderOption?: () => React.ReactNode;
  containerClassName?: string;
  currentValueClass?: string;
  optionsListClass?: string;
  optionsClass?: string;
  subContainerClassName?: string;
  className?: string;
  placeholder?: string;
  searchClassName?: string;
  searchPlaceholder?: string;
  showOptionIcon?: boolean;
};

/** `left` and `right` are physical edges in every direction; `start` and `end` follow the
 *  reading direction, so they mirror in RTL. */
type IconSide = 'left' | 'right' | 'start' | 'end';

const checkMarkSide: Record<IconSide, string> = {
  left: 'left-0 pl-2',
  right: 'right-0 pr-3',
  start: 'inset-s-0 ps-2',
  end: 'inset-e-0 pe-3',
};

/** Room for a check mark that sits before the label. */
const labelCheckGap: Record<IconSide, string> = { left: 'ml-4', right: '', start: 'ms-4', end: '' };

const trailingOptionIcon: Record<IconSide, string> = {
  left: '',
  right: 'absolute right-0 pr-2',
  start: '',
  end: 'absolute inset-e-0 pe-2',
};

function getOptionText(option: string | Option | OptionWithIcon): string {
  if (typeof option === 'string') {
    return option;
  }
  if ('label' in option) {
    return option.label ?? '';
  }
  if ('value' in option) {
    return (option.value ?? '') + '';
  }
  return '';
}

function SelectDropDown({
  title: _title,
  value,
  disabled,
  setValue,
  availableValues,
  showAbove = false,
  showLabel = true,
  emptyTitle = false,
  iconSide = 'end',
  optionIconSide = 'start',
  placeholder,
  containerClassName,
  optionsListClass,
  optionsClass,
  currentValueClass,
  subContainerClassName,
  className,
  renderOption,
  searchClassName,
  searchPlaceholder,
  showOptionIcon = false,
}: SelectDropDownProps): JSX.Element {
  const transitionProps = { className: 'top-full mt-3' };
  if (showAbove) {
    transitionProps.className = 'bottom-full mb-3';
  }

  let title = _title;
  if (emptyTitle) {
    title = '';
  }

  const values = availableValues ?? [];

  // Enable searchable select if enough items are provided.
  const [filteredValues, searchRender] = useMultiSearch<string[] | Option[]>({
    availableOptions: values,
    placeholder: searchPlaceholder,
    getTextKeyOverride: (option) => getOptionText(option).toUpperCase(),
    className: searchClassName,
    disabled,
  });
  const hasSearchRender = searchRender != null;
  const options = hasSearchRender ? filteredValues : values;
  const renderIcon = showOptionIcon && value != null && (value as OptionWithIcon).icon != null;
  /** The wide padding keeps the label clear of a trailing check mark, on the same axis as it. */
  const optionPadding = iconSide === 'left' || iconSide === 'right' ? 'pr-9 pl-3' : 'ps-3 pe-9';

  return (
    <div className={cn('flex items-center justify-center gap-2', containerClassName ?? '')}>
      <div className={cn('relative w-full', subContainerClassName ?? '')}>
        <Listbox value={value} onChange={setValue} disabled={disabled}>
          {({ open }) => (
            <>
              <ListboxButton
                data-testid="select-dropdown-button"
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') {
                    return;
                  }
                  event.preventDefault();
                  if (!open) {
                    event.currentTarget.dispatchEvent(
                      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
                    );
                  }
                }}
                className={cn(
                  'border-border-control bg-surface-secondary focus-visible:ring-focus-control disabled:bg-surface-secondary relative flex w-full cursor-default flex-col rounded-md border py-2 ps-3 pe-10 text-start focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden sm:text-sm',
                  disabledFillClasses,
                  className ?? '',
                )}
              >
                {showLabel && (
                  <Label
                    className="text-text-secondary block text-xs"
                    id="headlessui-listbox-label-:r1:"
                    data-headlessui-state=""
                  >
                    {title}
                  </Label>
                )}
                <span className="inline-flex w-full truncate">
                  <span
                    className={cn(
                      'text-text-primary flex h-6 items-center gap-1 truncate text-sm',
                      !showLabel ? 'text-xs' : '',
                      currentValueClass ?? '',
                    )}
                  >
                    {!showLabel && !emptyTitle && (
                      <span className="text-text-secondary text-xs">{title}:</span>
                    )}
                    {renderIcon && trailingOptionIcon[optionIconSide] === '' && (
                      <span className="icon-md flex items-center">
                        {(value as OptionWithIcon).icon}
                      </span>
                    )}
                    {renderIcon && (
                      <span className="icon-md absolute inset-e-0 me-8 flex items-center">
                        {(value as OptionWithIcon).icon}
                      </span>
                    )}
                    {(() => {
                      if (!value) {
                        return <span className="text-text-secondary">{placeholder}</span>;
                      }
                      if (typeof value !== 'string') {
                        return value.label ?? '';
                      }
                      return value;
                    })()}
                  </span>
                </span>
                <span className="pointer-events-none absolute inset-y-0 inset-e-0 flex items-center pe-2">
                  <svg
                    stroke="currentColor"
                    fill="none"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-text-tertiary h-4 w-4"
                    height="1em"
                    width="1em"
                    xmlns="http://www.w3.org/2000/svg"
                    style={showAbove ? { transform: 'scaleY(-1)' } : {}}
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </span>
              </ListboxButton>
              <Transition
                show={open}
                as="div"
                leave="transition ease-in duration-100"
                leaveFrom="opacity-100"
                leaveTo="opacity-0"
                {...transitionProps}
              >
                <ListboxOptions
                  className={cn(
                    'border-border-light bg-surface-secondary absolute z-10 mt-2 max-h-60 w-full overflow-auto rounded-sm border text-xs md:w-[100%]',
                    optionsListClass ?? '',
                  )}
                >
                  {renderOption && (
                    <ListboxOption
                      key={'listbox-render-option'}
                      value={null}
                      className={cn(
                        'group text-text-primary hover:bg-surface-hover relative flex h-[2.625rem] cursor-pointer items-center overflow-hidden select-none',
                        optionPadding,
                        optionsClass ?? '',
                      )}
                    >
                      {renderOption() as React.JSX.Element}
                    </ListboxOption>
                  )}
                  {searchRender as React.JSX.Element}
                  {options.map((option: string | Option, i: number) => {
                    if (!option) {
                      return null;
                    }
                    const currentLabel =
                      typeof option === 'string' ? option : (option.label ?? option.value ?? '');
                    const currentValue = typeof option === 'string' ? option : (option.value ?? '');
                    const currentIcon =
                      typeof option === 'string'
                        ? null
                        : ((option.icon as React.ReactNode) ?? null);
                    let activeValue: string | number | null | Option = value;
                    if (typeof activeValue !== 'string') {
                      activeValue = activeValue?.value ?? '';
                    }
                    return (
                      <ListboxOption
                        key={i}
                        value={option}
                        className={({ active }) =>
                          cn(
                            'group text-text-primary hover:bg-surface-hover relative flex h-[2.625rem] cursor-pointer items-center overflow-hidden select-none',
                            optionPadding,
                            active ? 'bg-surface-active text-text-primary' : '',
                            optionsClass ?? '',
                          )
                        }
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          <span
                            className={cn(
                              'text-text-primary flex h-6 items-center gap-1',
                              option === value ? 'font-semibold' : '',
                              labelCheckGap[iconSide],
                            )}
                          >
                            {currentIcon != null && (
                              <span className={cn('me-1', trailingOptionIcon[optionIconSide])}>
                                {currentIcon}
                              </span>
                            )}
                            {currentLabel}
                          </span>
                          {value != null && currentValue === activeValue && (
                            <span
                              className={cn(
                                'text-text-primary absolute inset-y-0 flex items-center',
                                checkMarkSide[iconSide],
                              )}
                            >
                              <CheckMark />
                            </span>
                          )}
                        </span>
                      </ListboxOption>
                    );
                  })}
                </ListboxOptions>
              </Transition>
            </>
          )}
        </Listbox>
      </div>
    </div>
  );
}

export default SelectDropDown;
