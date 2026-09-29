import React, { useRef } from 'react';
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
  iconSide?: 'left' | 'right';
  optionIconSide?: 'left' | 'right';
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
  iconSide = 'right',
  optionIconSide = 'left',
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

  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className={cn('flex items-center justify-center gap-2', containerClassName ?? '')}>
      <div className={cn('relative w-full', subContainerClassName ?? '')}>
        <Listbox value={value} onChange={setValue} disabled={disabled}>
          {({ open }) => (
            <>
              <ListboxButton
                ref={buttonRef}
                data-testid="select-dropdown-button"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!open && buttonRef.current) {
                      buttonRef.current.click();
                    }
                  }
                }}
                className={cn(
                  'border-border-control bg-surface-secondary focus-visible:ring-focus-control disabled:bg-surface-secondary relative flex w-full cursor-default flex-col rounded-md border py-2 pr-10 pl-3 text-left focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden sm:text-sm',
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
                    {renderIcon && optionIconSide !== 'right' && (
                      <span className="icon-md flex items-center">
                        {(value as OptionWithIcon).icon}
                      </span>
                    )}
                    {renderIcon && (
                      <span className="icon-md absolute right-0 mr-8 flex items-center">
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
                <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
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
                    'border-border-light bg-surface-secondary absolute z-10 mt-2 max-h-60 w-full overflow-auto rounded border text-xs md:w-[100%]',
                    optionsListClass ?? '',
                  )}
                >
                  {renderOption && (
                    <ListboxOption
                      key={'listbox-render-option'}
                      value={null}
                      className={cn(
                        'group text-text-primary hover:bg-surface-hover relative flex h-[42px] cursor-pointer items-center overflow-hidden pr-9 pl-3 select-none',
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
                            'group text-text-primary hover:bg-surface-hover relative flex h-[42px] cursor-pointer items-center overflow-hidden pr-9 pl-3 select-none',
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
                              iconSide === 'left' ? 'ml-4' : '',
                            )}
                          >
                            {currentIcon != null && (
                              <span
                                className={cn(
                                  'mr-1',
                                  optionIconSide === 'right' ? 'absolute right-0 pr-2' : '',
                                )}
                              >
                                {currentIcon}
                              </span>
                            )}
                            {currentLabel}
                          </span>
                          {value != null && currentValue === activeValue && (
                            <span
                              className={cn(
                                'text-text-primary absolute inset-y-0 flex items-center',
                                iconSide === 'left' ? 'left-0 pl-2' : 'right-0 pr-3',
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
