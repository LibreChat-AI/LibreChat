import * as React from 'react';
import { Search } from 'lucide-react';
import debounce from 'lodash/debounce';
import * as Ariakit from '@ariakit/react';
import { Input, Spinner, Skeleton } from '@librechat/client';
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
  resetValueOnHide = false,
  isLoading = false,
  minQueryLengthForNoResults = 2,
}: SearchPickerProps<TOption>) {
  const localize = useLocalize();
  const [_open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [localQuery, setLocalQuery] = React.useState(query);
  const combobox = Ariakit.useComboboxStore({
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
    setLocalQuery('');
    onQueryChange('');
    onPick(option);
    setOpen(false);
    if (inputRef.current) {
      inputRef.current.focus();
    }
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
            <Spinner className="absolute left-3 h-4 w-4" />
          ) : (
            <Search className="text-text-secondary absolute left-3 h-4 w-4" aria-hidden="true" />
          )}
          <Ariakit.Combobox
            render={<Input />}
            ref={inputRef}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && combobox.getState().open) {
                e.preventDefault();
                e.stopPropagation();
                setLocalQuery('');
                onQueryChange('');
                debouncedOnQueryChange.cancel();
                setOpen(false);
              }
            }}
            store={combobox}
            setValueOnClick={false}
            setValueOnChange={false}
            onChange={(e) => {
              const value = e.target.value;
              setLocalQuery(value);
              debouncedOnQueryChange(value);
            }}
            value={localQuery}
            // autoSelect
            placeholder={placeholder || localize('com_ui_select_options')}
            className={cn('h-10 w-full pl-10 text-sm leading-tight', inputClassName)}
          />
        </div>
      </>
      <Ariakit.ComboboxPopover
        portal={false} //todo fix focus when set to true
        gutter={8}
        sameWidth
        open={
          isLoading ||
          options.length > 0 ||
          (localQuery.trim().length >= minQueryLengthForNoResults && !isLoading)
        }
        store={combobox}
        unmountOnHide
        autoFocusOnShow={false}
        modal={false}
        className={cn(
          'animate-popover border-border-light bg-surface-secondary z-[9999] max-w-[calc(100vw-1rem)] min-w-[min(16rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border shadow-lg',
          '[pointer-events:auto]', // Override body's pointer-events:none when in modal
        )}
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
                // hideOnClick
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
