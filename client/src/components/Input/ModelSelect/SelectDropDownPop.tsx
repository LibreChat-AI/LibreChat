import React, { useState } from 'react';
import { useMultiSearch } from '@librechat/client';
import { Root, Trigger, Content, Portal } from '@radix-ui/react-popover';
import type { Option } from '~/common';
import MenuItem from '~/components/Chat/Menus/UI/MenuItem';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type SelectDropDownProps = {
  id?: string;
  title?: string;
  value: string | null | Option;
  disabled?: boolean;
  setValue: (value: string) => void;
  availableValues: string[] | Option[];
  emptyTitle?: boolean;
  showAbove?: boolean;
  showLabel?: boolean;
  iconSide?: 'left' | 'right';
  renderOption?: () => React.ReactNode;
  footer?: React.ReactNode;
};

function SelectDropDownPop({
  title: _title,
  value,
  availableValues,
  setValue,
  showAbove = false,
  showLabel = true,
  emptyTitle = false,
  footer,
}: SelectDropDownProps) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const transitionProps = { className: 'top-full mt-3' };
  if (showAbove) {
    transitionProps.className = 'bottom-full mb-3';
  }

  let title = _title;

  if (emptyTitle) {
    title = '';
  } else if (!title) {
    title = localize('com_ui_model');
  }

  // Detemine if we should to convert this component into a searchable select.  If we have enough elements, a search
  // input will appear near the top of the menu, allowing correct filtering of different model menu items. This will
  // reset once the component is unmounted (as per a normal search)
  const [filteredValues, searchRender] = useMultiSearch<string[] | Option[]>({
    availableOptions: availableValues,
  });
  const hasSearchRender = Boolean(searchRender);
  const options = hasSearchRender ? filteredValues : availableValues;

  const handleSelect = (selectedValue: string) => {
    setValue(selectedValue);
    setOpen(false);
  };

  return (
    <Root open={open} onOpenChange={setOpen}>
      <div className={'flex items-center justify-center gap-2'}>
        <div className={'relative w-full'}>
          <Trigger asChild>
            <button
              data-testid="select-dropdown-button"
              className={cn(
                'border-border-light bg-surface-secondary relative flex cursor-pointer flex-col rounded-lg border py-2 pr-10 pl-3 text-left focus:ring-0 focus:ring-offset-0 sm:text-sm',
                'hover:bg-surface-hover data-[state=open]:bg-surface-hover',
                'max-w-[215px] min-w-[200px] sm:max-w-full sm:min-w-full',
              )}
              aria-label={localize('com_ui_select_var', { 0: title })}
              aria-haspopup="false"
            >
              {' '}
              {showLabel && <label className="text-text-secondary block text-xs">{title}</label>}
              <span className="inline-flex w-full">
                <span
                  className={cn(
                    'text-text-primary flex h-6 items-center gap-1 text-sm',
                    !showLabel ? 'text-xs' : '',
                    'min-w-[75px] font-normal',
                  )}
                >
                  {typeof value !== 'string' && value ? (value.label ?? '') : (value ?? '')}
                </span>
              </span>
              <span className="absolute inset-y-0 right-0 flex items-center pr-2">
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
            </button>
          </Trigger>
          <Portal>
            <Content
              side="bottom"
              align="start"
              className={cn(
                'border-border-light bg-surface-secondary z-50 mt-2 mr-3 max-h-[52vh] w-full max-w-[85vw] overflow-hidden overflow-y-auto rounded-lg border shadow-lg sm:max-w-full lg:max-h-[52vh]',
                hasSearchRender && 'relative',
              )}
            >
              {searchRender}
              {options.map((option) => {
                if (typeof option === 'string') {
                  return (
                    <MenuItem
                      key={option}
                      title={option}
                      value={option}
                      selected={!!(value && value === option)}
                      onClick={() => handleSelect(option)}
                    />
                  );
                }
                return (
                  <MenuItem
                    key={option.value}
                    title={option.label}
                    description={option.description}
                    value={option.value}
                    icon={option.icon}
                    selected={!!(value && value === option.value)}
                    onClick={() => handleSelect(option.value)}
                  />
                );
              })}
              {footer}
            </Content>
          </Portal>
        </div>
      </div>
    </Root>
  );
}

export default SelectDropDownPop;
