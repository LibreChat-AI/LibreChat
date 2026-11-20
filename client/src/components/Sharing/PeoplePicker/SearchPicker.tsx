import * as React from 'react';
import { Search } from 'lucide-react';
import debounce from 'lodash/debounce';
import * as Ariakit from '@ariakit/react';
import { Input, Spinner, Skeleton, useNestedPopoverStyle } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type SearchPickerProps<TOption extends { key: string }> = {
  options: TOption[];
  renderOptions: (option: TOption) => React.ReactElement;
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (pickedOption: TOption) => void;
  placeholder?: string;
  inputClassName?: string;
  inputRef?: React.RefObject<HTMLInputElement>;
  label?: string;
  labelClassName?: string;
  resetValueOnHide?: boolean;
  isSmallScreen?: boolean;
  isLoading?: boolean;
  minQueryLengthForNoResults?: number;
};

export function SearchPicker<TOption extends { key: string; value: string }>({
  options,
  renderOptions,
  onPick,
  onQueryChange,
  query,
  label,
  labelClassName,
  isSmallScreen = false,
  placeholder,
  inputClassName,
  inputRef: providedInputRef,
  resetValueOnHide = false,
  isLoading = false,
  minQueryLengthForNoResults = 2,
}: SearchPickerProps<TOption>) {
  const localize = useLocalize();
  const [open, setOpen] = React.useState(false);
  const fallbackInputRef = React.useRef<HTMLInputElement>(null);
  const inputRef = providedInputRef ?? fallbackInputRef;
  const [localQuery, setLocalQuery] = React.useState(query);
  const popoverStyle = useNestedPopoverStyle();
  const hasContent =
    isLoading || options.length > 0 || localQuery.trim().length >= minQueryLengthForNoResults;
  const combobox = Ariakit.useComboboxStore({
    open: open && hasContent,
    setOpen,
    virtualFocus: true,
    resetValueOnHide,
  });

  React.useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  const debouncedOnQueryChange = React.useMemo(
    () =>
      debounce((value: string) => {
        onQueryChange(value);
      }, 500),
    [onQueryChange],
  );

  React.useEffect(() => {
    return () => {
      debouncedOnQueryChange.cancel();
    };
  }, [debouncedOnQueryChange]);

  const onPickHandler = (option: TOption) => {
    debouncedOnQueryChange.cancel();
    setLocalQuery('');
    onQueryChange('');
    onPick(option);
    inputRef.current?.focus();
    combobox.hide();
  };

  return (
    <Ariakit.ComboboxProvider store={combobox}>
      <Ariakit.ComboboxLabel
        className={cn('text-text-primary mb-2 block font-medium', labelClassName)}
      >
        {label}
      </Ariakit.ComboboxLabel>
      <>
        <div
          className={cn(
            'text-text-primary relative flex h-10 items-center gap-2',
            isSmallScreen === true ? 'mb-2 h-14 rounded-2xl' : '',
          )}
        >
          {isLoading ? (
            <Spinner className="absolute inset-s-3 h-4 w-4" />
          ) : (
            <Search className="text-text-secondary absolute inset-s-3 h-4 w-4" aria-hidden="true" />
          )}
          <Ariakit.Combobox
            render={<Input />}
            ref={inputRef}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && combobox.getState().open) {
                e.preventDefault();
                e.stopPropagation();
                setLocalQuery('');
                onQueryChange('');
                debouncedOnQueryChange.cancel();
                combobox.hide();
              }
            }}
            store={combobox}
            setValueOnClick={false}
            setValueOnChange={false}
            onChange={(e) => {
              const value = e.target.value;
              setLocalQuery(value);
              setOpen(true);
              debouncedOnQueryChange(value);
            }}
            value={localQuery}
            placeholder={placeholder || localize('com_ui_select_options')}
            className={cn('h-10 w-full ps-10 text-sm leading-tight', inputClassName)}
          />
        </div>
      </>
      <Ariakit.ComboboxPopover
        portal
        fixed
        gutter={8}
        sameWidth
        store={combobox}
        unmountOnHide
        autoFocusOnShow={false}
        modal={false}
        autoFocusOnHide={false}
        // Shared modal depth determines portal stacking and pointer interaction.
        style={popoverStyle}
        data-variant="field"
        className="popover-ui pointer-events-auto z-50"
      >
        {(() => {
          if (isLoading) {
            return (
              <div className="space-y-2 p-2">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-3 px-3 py-2">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div className="flex-1 space-y-1">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            );
          }

          if (options.length > 0) {
            return options.map((o) => (
              <Ariakit.ComboboxItem
                key={o.key}
                focusOnHover
                value={o.value}
                selectValueOnClick={false}
                onClick={() => onPickHandler(o)}
                className={cn(
                  'flex w-full cursor-pointer items-center px-3 text-sm',
                  'text-text-primary hover:bg-surface-tertiary',
                  'data-[active-item]:bg-surface-tertiary',
                )}
                render={renderOptions(o)}
              ></Ariakit.ComboboxItem>
            ));
          }

          if (localQuery.trim().length >= minQueryLengthForNoResults) {
            return (
              <div
                className={cn(
                  'flex items-center justify-center px-4 py-8 text-center',
                  'text-text-secondary text-sm',
                )}
              >
                <div className="flex flex-col items-center gap-2">
                  <Search className="text-text-tertiary h-8 w-8 opacity-50" />
                  <div className="font-medium">{localize('com_ui_no_results_found')}</div>
                  <div className="text-text-tertiary text-xs">
                    {localize('com_ui_try_adjusting_search')}
                  </div>
                </div>
              </div>
            );
          }

          return null;
        })()}
      </Ariakit.ComboboxPopover>
    </Ariakit.ComboboxProvider>
  );
}
