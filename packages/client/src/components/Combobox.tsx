import { startTransition } from 'react';
import { JSX } from 'react/jsx-runtime';
import { Search as SearchIcon } from 'lucide-react';
import * as RadixSelect from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxProvider,
  ComboboxCancel,
} from '@ariakit/react';
import type { OptionWithIcon } from '~/common';
import { SelectTrigger, SelectValue, SelectScrollDownButton } from './Select';
import { useNestedPopoverStyle } from './OriginalDialog';
import { useCombobox } from '~/hooks';
import { cn } from '~/utils';

export default function ComboboxComponent({
  selectedValue,
  displayValue,
  items,
  setValue,
  ariaLabel,
  searchPlaceholder,
  selectPlaceholder,
  isCollapsed,
  SelectIcon,
}: {
  ariaLabel: string;
  displayValue?: string;
  selectedValue: string;
  searchPlaceholder?: string;
  selectPlaceholder?: string;
  items: OptionWithIcon[] | string[];
  setValue: (value: string) => void;
  isCollapsed: boolean;
  SelectIcon?: React.ReactNode;
}): JSX.Element {
  const options: OptionWithIcon[] = (items ?? []).map((option: string | OptionWithIcon) => {
    if (typeof option === 'string') {
      return { label: option, value: option };
    }
    return option;
  });

  const { open, setOpen, setSearchValue, matches } = useCombobox({
    value: selectedValue,
    options,
  });
  const nestedStyle = useNestedPopoverStyle();

  return (
    <RadixSelect.Root
      value={selectedValue}
      onValueChange={setValue}
      open={open}
      /** Hacky fix for radix-ui Android issue: https://github.com/radix-ui/primitives/issues/1658  */
      onOpenChange={() => {
        if (open === true) {
          setOpen(false);
          return;
        }
        setTimeout(() => {
          setOpen(!open);
        }, 75);
      }}
    >
      <ComboboxProvider
        open={open}
        setOpen={setOpen}
        resetValueOnHide
        includesBaseElement={false}
        setValue={(value) => {
          startTransition(() => {
            setSearchValue(value);
          });
        }}
      >
        <SelectTrigger
          aria-label={ariaLabel}
          className={cn(
            'flex items-center gap-2 [&>span]:line-clamp-1 [&>span]:flex [&>span]:w-full [&>span]:items-center [&>span]:gap-1 [&>span]:truncate [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
            isCollapsed
              ? 'flex h-9 w-9 shrink-0 items-center justify-center p-0 [&>span]:w-auto [&>svg]:hidden'
              : '',
            'bg-surface-secondary text-text-primary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-text-primary',
          )}
        >
          <SelectValue placeholder={selectPlaceholder}>
            <div className="assistant-item flex items-center justify-center overflow-hidden rounded-full">
              {SelectIcon ? SelectIcon : <ChevronDownIcon />}
            </div>
            <span
              className={cn('ml-2', isCollapsed ? 'hidden' : '')}
              style={{ userSelect: 'none' }}
            >
              {selectedValue
                ? (displayValue ?? selectedValue)
                : selectPlaceholder && selectPlaceholder}
            </span>
          </SelectValue>
        </SelectTrigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            role="dialog"
            aria-label={ariaLabel + 's'}
            position="popper"
            style={nestedStyle}
            className={cn(
              'relative z-40 max-h-[52vh] min-w-[8rem] overflow-hidden rounded-md border border-border-light bg-surface-secondary text-text-primary shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
              'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
              'bg-surface-secondary',
            )}
          >
            <RadixSelect.Viewport className="mb-5 h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]">
              <div className="group sticky left-0 top-0 z-10 flex h-12 items-center gap-2 bg-surface-secondary px-3 py-2 text-text-primary duration-300">
                <SearchIcon className="h-4 w-4 text-text-secondary transition-colors duration-300 group-focus-within:text-text-primary group-hover:text-text-primary" />
                <Combobox
                  autoSelect
                  placeholder={searchPlaceholder}
                  className="flex-1 rounded-md border-none bg-transparent px-2.5 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-border-medium"
                  // Ariakit's Combobox manually triggers a blur event on virtually
                  // blurred items, making them work as if they had actual DOM
                  // focus. These blur events might happen after the corresponding
                  // focus events in the capture phase, leading Radix Select to
                  // close the popover. This happens because Radix Select relies on
                  // the order of these captured events to discern if the focus was
                  // outside the element. Since we don't have access to the
                  // onInteractOutside prop in the Radix SelectContent component to
                  // stop this behavior, we can turn off Ariakit's behavior here.
                  onBlurCapture={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                />
                <ComboboxCancel
                  hideWhenEmpty={true}
                  className="relative flex h-5 w-5 items-center justify-end text-text-secondary transition-colors duration-300 group-focus-within:text-text-primary group-hover:text-text-primary"
                />
              </div>
              <ComboboxList className="overflow-y-auto p-1 py-2">
                {matches.map(({ label, value, icon }) => (
                  <RadixSelect.Item key={value} value={`${value ?? ''}`} asChild>
                    <ComboboxItem
                      className={cn(
                        'relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-surface-hover focus:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                        'rounded-lg hover:bg-surface-hover',
                      )}
                      /** Hacky fix for radix-ui Android issue: https://github.com/radix-ui/primitives/issues/1658  */
                      onTouchEnd={() => {
                        setValue(`${value ?? ''}`);
                        setOpen(false);
                      }}
                    >
                      <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                        <RadixSelect.ItemIndicator>
                          <CheckIcon className="h-4 w-4" />
                        </RadixSelect.ItemIndicator>
                      </span>
                      <RadixSelect.ItemText>
                        <div className="flex items-center justify-center gap-3 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:text-text-primary">
                          <div className="assistant-item overflow-hidden rounded-full">
                            {icon && icon}
                          </div>
                          {label}
                        </div>
                      </RadixSelect.ItemText>
                    </ComboboxItem>
                  </RadixSelect.Item>
                ))}
              </ComboboxList>
            </RadixSelect.Viewport>
            <SelectScrollDownButton className="absolute bottom-0 left-0 right-0" />
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </ComboboxProvider>
    </RadixSelect.Root>
  );
}
