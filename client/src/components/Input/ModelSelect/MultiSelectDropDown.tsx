import React, { useState, useRef } from 'react';
import { Wrench, ArrowRight } from 'lucide-react';
import { CheckMark, useOnClickOutside, useMultiSearch } from '@librechat/client';
import {
  Listbox,
  ListboxButton,
  Label,
  ListboxOptions,
  ListboxOption,
  Transition,
} from '@headlessui/react';
import type { TPlugin } from 'librechat-data-provider';
import { cn } from '~/utils/';

export type TMultiSelectDropDownProps = {
  title?: string;
  value: Array<{ icon?: string; name?: string; isButton?: boolean }>;
  disabled?: boolean;
  setSelected: (option: string) => void;
  availableValues: TPlugin[];
  showAbove?: boolean;
  showLabel?: boolean;
  containerClassName?: string;
  optionsClassName?: string;
  labelClassName?: string;
  isSelected: (value: string) => boolean;
  className?: string;
  searchPlaceholder?: string;
  optionValueKey?: string;
};

function MultiSelectDropDown({
  title = 'Plugins',
  value,
  disabled,
  setSelected,
  availableValues,
  showAbove = false,
  showLabel = true,
  containerClassName,
  optionsClassName = '',
  labelClassName = '',
  isSelected,
  className,
  searchPlaceholder,
  optionValueKey = 'value',
}: TMultiSelectDropDownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  const excludeIds = ['select-plugin', 'plugins-label', 'selected-plugins'];
  useOnClickOutside(menuRef, () => setIsOpen(false), excludeIds);

  const handleSelect: (value: string) => void = (option) => {
    setSelected(option);
    setIsOpen(true);
  };

  // input will appear near the top of the menu, allowing correct filtering of different model menu items. This will
  // reset once the component is unmounted (as per a normal search)
  const [filteredValues, searchRender] = useMultiSearch<TPlugin[]>({
    availableOptions: availableValues,
    placeholder: searchPlaceholder,
    getTextKeyOverride: (option) => (option.name || '').toUpperCase(),
  });

  const hasSearchRender = Boolean(searchRender);
  const options = hasSearchRender ? filteredValues : availableValues;

  const transitionProps = { className: 'top-full mt-3' };
  if (showAbove) {
    transitionProps.className = 'bottom-full mb-3';
  }
  const openProps = { open: isOpen };
  return (
    <div className={cn('flex items-center justify-center gap-2', containerClassName ?? '')}>
      <div className="relative w-full">
        {/* the function typing is correct but there's still an issue here */}
        {/* @ts-ignore */}
        <Listbox value={value} onChange={handleSelect} disabled={disabled}>
          {() => (
            <>
              <ListboxButton
                className={cn(
                  'border-border-light bg-surface-secondary relative flex w-full cursor-default flex-col rounded-md border py-2 pr-10 pl-3 text-left focus:ring-0 focus:ring-offset-0 focus:outline-hidden sm:text-sm',
                  className ?? '',
                )}
                id={excludeIds[0]}
                onClick={() => setIsOpen((prev) => !prev)}
                {...openProps}
              >
                {' '}
                {showLabel && (
                  <Label
                    className={cn('text-text-secondary block text-xs', labelClassName)}
                    id={excludeIds[1]}
                    data-headlessui-state=""
                  >
                    {title}
                  </Label>
                )}
                <span className="inline-flex w-full truncate" id={excludeIds[2]}>
                  <span
                    className={cn(
                      'text-text-primary flex h-6 items-center gap-1 truncate text-sm',
                      !showLabel ? 'text-xs' : '',
                    )}
                  >
                    {!showLabel && title.length > 0 && (
                      <span className="text-text-secondary text-xs">{title}:</span>
                    )}
                    <span className="flex h-6 items-center gap-1 truncate">
                      <div className="flex gap-1">
                        {value.map((v, i) => (
                          <div
                            key={i}
                            className="relative"
                            style={{ width: '16px', height: '16px' }}
                          >
                            {v.icon ? (
                              <img
                                src={v.icon}
                                alt={`${v} logo`}
                                className="bg-surface-fixed h-full w-full rounded-sm"
                              />
                            ) : (
                              <Wrench className="bg-surface-fixed h-full w-full rounded-sm" />
                            )}
                            <div className="ring-border-light absolute inset-0 rounded-sm ring-1 ring-inset" />
                          </div>
                        ))}
                      </div>
                    </span>
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
                show={isOpen}
                as={React.Fragment}
                leave="transition ease-in duration-150"
                leaveFrom="opacity-100"
                leaveTo="opacity-0"
                {...transitionProps}
              >
                <ListboxOptions
                  ref={menuRef}
                  className={cn(
                    'bg-surface-secondary ring-border-light absolute z-50 mt-2 max-h-60 w-full overflow-auto rounded text-base text-xs ring-1 focus:outline-hidden md:w-[100%] dark:last:border-0',
                    optionsClassName,
                  )}
                >
                  {searchRender}
                  {options.map((option, i: number) => {
                    if (!option) {
                      return null;
                    }
                    const selected = isSelected(option[optionValueKey]);
                    return (
                      <ListboxOption
                        key={i}
                        value={option[optionValueKey]}
                        className="group border-border-light text-text-primary hover:bg-surface-hover relative flex h-[42px] cursor-pointer items-center overflow-hidden border-b pr-9 pl-3 select-none last:border-0"
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          {!option.isButton && (
                            <span className="h-6 w-6 shrink-0">
                              <div className="relative" style={{ width: '100%', height: '100%' }}>
                                {option.icon ? (
                                  <img
                                    src={option.icon}
                                    alt={`${option.name} logo`}
                                    className="bg-surface-fixed h-full w-full rounded-sm"
                                  />
                                ) : (
                                  <Wrench className="bg-surface-fixed h-full w-full rounded-sm" />
                                )}
                                <div className="ring-border-light absolute inset-0 rounded-sm ring-1 ring-inset"></div>
                              </div>
                            </span>
                          )}
                          <span
                            className={cn(
                              'text-text-primary flex h-6 items-center gap-1',
                              selected ? 'font-semibold' : '',
                            )}
                          >
                            {option.name}
                          </span>
                          {option.isButton && (
                            <span className="text-text-primary absolute inset-y-0 right-0 flex items-center pr-3">
                              <ArrowRight />
                            </span>
                          )}
                          {selected && !option.isButton && (
                            <span className="text-text-primary absolute inset-y-0 right-0 flex items-center pr-3">
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

export default MultiSelectDropDown;
