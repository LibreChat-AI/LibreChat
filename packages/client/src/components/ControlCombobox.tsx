import { useMemo, useState, useRef, memo, useEffect, MemoExoticComponent } from 'react';
import * as Ariakit from '@ariakit/react';
import { matchSorter } from 'match-sorter';
import { Search, ChevronDown } from 'lucide-react';
import { SelectRenderer } from '@ariakit/react-components/select/select-renderer';
import type { OptionWithIcon } from '~/common';
import { usePopoverZIndex } from './OriginalDialog';
import useRemScale from '~/hooks/useRemScale';
import { fieldControl } from './Field';
import './AnimatePopover.css';
import { JSX } from 'react/jsx-runtime';
import { cn, pxToRem } from '~/utils';

interface ControlComboboxProps {
  selectedValue: string;
  displayValue?: string;
  items: OptionWithIcon[];
  setValue: (value: string) => void;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
  ariaLabel: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  searchPlaceholder?: string;
  selectPlaceholder?: string;
  isCollapsed: boolean;
  SelectIcon?: React.ReactNode;
  containerClassName?: string;
  iconClassName?: string;
  showCarat?: boolean;
  className?: string;
  disabled?: boolean;
  iconSide?: 'left' | 'right';
  selectId?: string;
  placement?: Ariakit.SelectStoreProps['placement'];
  popoverClassName?: string;
  matchTriggerWidth?: boolean;
  /** Caps the entire popover, search field included, at this pixel height;
   * the option list becomes the scrolling region. Unset keeps the default
   * fixed 300px list height. */
  popoverMaxHeight?: number;
  /** Renders at most this many options while the search field is empty.
   * Typing lifts the cap so search reaches every option. */
  unsearchedLimit?: number;
  /** `field` matches the `Input` primitive so this can sit in a form row. */
  variant?: 'default' | 'field';
  gutter?: number;
  /**
   * Radix dialogs trap focus, so a portaled popover rendered outside the dialog
   * cannot receive typing in its search field. Pass `false` from inside a dialog
   * to keep the list in the dialog, and give that dialog `overflow-visible` so
   * the popover is not clipped.
   */
  portal?: boolean;
  /** Keep portaled options inside a modal without clipping its scroll region. */
  portalElement?: Ariakit.SelectPopoverProps['portalElement'];
  /** Told when the popover opens and closes, for hosts that must behave
   *  differently while it is up — e.g. a focus-trapped panel whose own Escape
   *  handler must not fire while an open popover owns the key. */
  onOpenChange?: (open: boolean) => void;
}

const ROW_HEIGHT = 36;

function ControlCombobox({
  selectedValue,
  displayValue,
  items,
  setValue,
  onBlur,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  searchPlaceholder,
  selectPlaceholder,
  containerClassName,
  isCollapsed,
  SelectIcon,
  showCarat,
  className,
  disabled,
  iconClassName,
  iconSide = 'left',
  selectId,
  placement,
  popoverClassName,
  matchTriggerWidth = true,
  popoverMaxHeight,
  unsearchedLimit,
  variant = 'default',
  gutter = 4,
  portal = true,
  portalElement,
  onOpenChange,
}: ControlComboboxProps): JSX.Element {
  const [searchValue, setSearchValue] = useState('');
  const remScale = useRemScale();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [buttonWidth, setButtonWidth] = useState<number | null>(null);
  const popoverWidth = isCollapsed ? '18.75rem' : (buttonWidth ?? '18.75rem');
  const popoverZIndex = usePopoverZIndex();

  const getItem = (option: OptionWithIcon) => ({
    id: `item-${option.value}`,
    value: option.value as string | undefined,
    label: option.label,
    icon: option.icon,
  });

  const combobox = Ariakit.useComboboxStore({
    defaultItems: items.map(getItem),
    resetValueOnHide: true,
    value: searchValue,
    setValue: setSearchValue,
  });

  const select = Ariakit.useSelectStore({
    combobox,
    defaultItems: items.map(getItem),
    value: selectedValue,
    setValue,
    setOpen: onOpenChange,
    placement,
  });

  const selectOpen = select.useState('open');
  useEffect(() => {
    // The select owns the popover; hiding it does not hide the combobox store.
    if (!selectOpen) {
      setSearchValue('');
    }
  }, [selectOpen]);

  const matches = useMemo(() => {
    const filteredItems = matchSorter(items, searchValue, {
      keys: ['value', 'label'],
      baseSort: (a, b) => (a.index < b.index ? -1 : 1),
    });
    const mapped = filteredItems.map(getItem);
    if (unsearchedLimit != null && searchValue.trim() === '') {
      const capped = mapped.slice(0, unsearchedLimit);
      /** The open list keeps offering the current selection: an option that
       * ranks past the cut takes the last slot instead of vanishing until the
       * user knows to search for it. */
      if (selectedValue != null && !capped.some((item) => item.value === selectedValue)) {
        const selected = mapped.find((item) => item.value === selectedValue);
        if (selected != null) {
          capped[capped.length - 1] = selected;
        }
      }
      return capped;
    }
    return mapped;
  }, [searchValue, items, unsearchedLimit, selectedValue]);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || isCollapsed) {
      return;
    }

    setButtonWidth(button.offsetWidth);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const width = entry.borderBoxSize?.[0]?.inlineSize ?? button.offsetWidth;
      if (width > 0) {
        setButtonWidth(width);
      }
    });

    observer.observe(button);
    return () => observer.disconnect();
  }, [isCollapsed]);

  const selectIconClassName = cn(
    'flex h-5 w-5 items-center justify-center overflow-hidden rounded-full',
    iconClassName,
  );
  const optionIconClassName = cn(
    'mr-2 flex h-5 w-5 items-center justify-center overflow-hidden rounded-full',
    iconClassName,
  );

  return (
    <div
      className={cn(
        'flex w-full items-center justify-center px-1',
        variant === 'field' && 'px-0',
        containerClassName,
      )}
    >
      <Ariakit.SelectLabel store={select} className="sr-only">
        {ariaLabel}
      </Ariakit.SelectLabel>
      <Ariakit.Select
        ref={buttonRef}
        store={select}
        id={selectId}
        disabled={disabled}
        onBlur={onBlur}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={ariaDescribedBy}
        className={cn(
          'bg-surface-secondary flex items-center justify-center gap-2 rounded-full',
          'text-text-primary hover:bg-surface-tertiary',
          'border-border-control border',
          isCollapsed ? 'h-9 w-9' : 'h-9 w-full rounded-xl px-3 py-2 text-sm',
          variant === 'field' && cn(fieldControl, 'hover:bg-surface-hover justify-start'),
          className,
        )}
      >
        {SelectIcon != null && iconSide === 'left' && (
          <div className={selectIconClassName}>{SelectIcon}</div>
        )}
        {!isCollapsed && (
          <>
            <span
              className="grow truncate text-left"
              title={(displayValue != null ? displayValue : selectedValue) || undefined}
            >
              {displayValue != null
                ? displayValue || selectPlaceholder
                : selectedValue || selectPlaceholder}
            </span>
            {SelectIcon != null && iconSide === 'right' && (
              <div className={selectIconClassName}>{SelectIcon}</div>
            )}
            {showCarat && <ChevronDown className="text-text-secondary h-4 w-4" />}
          </>
        )}
      </Ariakit.Select>
      <Ariakit.SelectPopover
        store={select}
        gutter={gutter}
        portal={portal}
        portalElement={portalElement}
        className={cn(
          'border-border-light bg-surface-secondary overflow-hidden rounded-xl border shadow-lg',
          popoverMaxHeight != null && 'flex flex-col',
          popoverClassName ?? 'animate-popover',
        )}
        style={{
          zIndex: popoverZIndex,
          /** `--popover-available-height` is the space Ariakit measured for this
           * placement, so a short viewport shrinks the cap instead of pushing
           * lower options offscreen; the fallback keeps the cap when the
           * variable is absent. */
          /** The preferred width is expressed in rem, so it grows with the UI scale
           *  past narrow viewports. Cap it here rather than in each caller: a
           *  min-width outranks a max-width, so the minimum has to carry the cap. */
          maxWidth: '90vw',
          maxHeight:
            popoverMaxHeight != null
              ? `min(${pxToRem(popoverMaxHeight)}, var(--popover-available-height, ${pxToRem(popoverMaxHeight)}))`
              : undefined,
          width: matchTriggerWidth ? popoverWidth : undefined,
          minWidth: matchTriggerWidth ? undefined : 'min(16rem, 90vw)',
        }}
      >
        <div className="shrink-0 py-1.5">
          <div className="relative">
            <Search className="text-text-primary absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Ariakit.Combobox
              store={combobox}
              autoSelect
              placeholder={searchPlaceholder}
              className="bg-surface-secondary text-text-primary w-full rounded-md py-2 pr-3 pl-9 text-sm focus:outline-hidden"
            />
          </div>
        </div>
        <div
          className={cn(
            popoverMaxHeight != null
              ? 'min-h-0 flex-1 overflow-auto'
              : 'max-h-[18.75rem] overflow-auto',
          )}
        >
          <Ariakit.ComboboxList store={combobox}>
            <SelectRenderer
              store={select}
              items={matches}
              itemSize={ROW_HEIGHT * remScale}
              overscan={5}
            >
              {({ value, icon, label, ...item }) => (
                <Ariakit.ComboboxItem
                  key={item.id}
                  {...item}
                  className={cn(
                    'flex w-full cursor-pointer items-center px-3 text-sm',
                    'text-text-primary hover:bg-surface-tertiary',
                    'data-[active-item]:bg-surface-tertiary',
                  )}
                  render={<Ariakit.SelectItem value={value} />}
                >
                  {icon != null && iconSide === 'left' && (
                    <div className={optionIconClassName}>{icon}</div>
                  )}
                  <span className="grow truncate text-left">{label}</span>
                  {icon != null && iconSide === 'right' && (
                    <div className={optionIconClassName}>{icon}</div>
                  )}
                </Ariakit.ComboboxItem>
              )}
            </SelectRenderer>
          </Ariakit.ComboboxList>
        </div>
      </Ariakit.SelectPopover>
    </div>
  );
}

const ControlComboboxMemo: MemoExoticComponent<typeof ControlCombobox> = memo(ControlCombobox);
export default ControlComboboxMemo;
