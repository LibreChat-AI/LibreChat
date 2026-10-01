import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { Root, Trigger, Content } from '@radix-ui/react-popover';
import type { KeyboardEvent, ReactNode } from 'react';
import { fieldControl } from './Field';
import { cn } from '~/utils';

const HOURS_24 = Array.from({ length: 24 }, (_, value) => value);
const HOURS_12 = Array.from({ length: 12 }, (_, index) => (index === 0 ? 12 : index));
const MINUTES = Array.from({ length: 60 }, (_, value) => value);

const pad = (value: number): string => String(value).padStart(2, '0');

const formatTime = (
  hour: number,
  minute: number,
  locale: string | undefined,
  hour12: boolean,
): string =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12 }).format(
    new Date(2000, 0, 1, hour, minute),
  );

export interface TimeColumnProps {
  label: string;
  values: number[];
  selected: number;
  format: (value: number) => string;
  onSelect: (value: number) => void;
}

/**
 * One scrolling column of the picker. Radio semantics rather than a listbox of
 * buttons: the options are mutually exclusive values, and a roving tabindex keeps
 * the column a single tab stop that arrow keys move within, which is what a
 * keyboard user expects from a set of 60 minutes.
 */
export function TimeColumn({
  label,
  values,
  selected,
  format,
  onSelect,
}: TimeColumnProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  /** The value to centre on, frozen at mount. Centering runs once per open, not on
   *  every re-render: re-centering as the user clicks down a column would yank the
   *  row they just aimed at back to the middle. */
  const initialSelected = useRef(selected);

  /**
   * Opening on 9:00 must not strand the user at 00:00 in a 60-row list. In a layout
   * effect rather than a ref callback because React attaches descendant refs BEFORE
   * the parent's: from the button's callback `listRef` is still null on the mount
   * that matters, so the scroll never happened. Scrolled by hand rather than with
   * `scrollIntoView`, which also scrolls every scrollable ancestor and would shove
   * the surrounding dialog around the page.
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    const node = list?.querySelector<HTMLButtonElement>(
      `[data-value="${initialSelected.current}"]`,
    );
    if (list == null || node == null) {
      return;
    }
    list.scrollTop = node.offsetTop - (list.clientHeight - node.clientHeight) / 2;
  }, []);

  const focusValue = (value: number) => {
    const node = listRef.current?.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
    node?.focus();
    // Optional call: scrolling is an enhancement, and not every environment
    // rendering this (jsdom, older embedded webviews) implements it.
    node?.scrollIntoView?.({ block: 'nearest' });
  };

  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: values.length - 1,
    };
    const target = moves[event.key];
    if (target == null) {
      return;
    }
    event.preventDefault();
    // Wraps, so holding ArrowUp from midnight reaches 23:00 without a dead end.
    const next = values[(target + values.length) % values.length];
    onSelect(next);
    focusValue(next);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="text-text-secondary px-1 pb-1 text-xs font-medium">{label}</span>
      <div
        ref={listRef}
        role="radiogroup"
        aria-label={label}
        // `relative` so the selected row's `offsetTop` is measured against this
        // column and not whatever positioned ancestor the popover happens to have.
        className="border-border-light relative max-h-52 overflow-y-auto rounded-lg border p-1"
      >
        {values.map((value, index) => {
          const isSelected = value === selected;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              data-value={value}
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                'w-full rounded-md px-2 py-1 text-center text-sm tabular-nums transition-colors',
                isSelected
                  ? 'bg-surface-active text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-surface-hover',
              )}
            >
              {format(value)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface PickerShellProps {
  id?: string;
  labelledBy?: string;
  className?: string;
  display: string;
  contentClassName: string;
  children: ReactNode;
}

/**
 * The trigger and popover surface both pickers share: a `fieldControl` button that
 * reads as an Input beside one, and the same enter/exit motion as the other Radix
 * primitives. Held in one place so a theme or interaction fix lands on both.
 */
function PickerShell({
  id,
  labelledBy,
  className,
  display,
  contentClassName,
  children,
}: PickerShellProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const valueId = `${useId()}value`;

  return (
    <Root open={open} onOpenChange={setOpen}>
      <Trigger asChild>
        <button
          id={id}
          type="button"
          // The value is part of the NAME, not just visible text: `aria-labelledby`
          // replaces a button's child text, so pointing it at the field label alone
          // announced "Time" and left a screen reader user unable to tell what time
          // was selected without opening the columns and reading them.
          aria-labelledby={labelledBy == null ? valueId : `${labelledBy} ${valueId}`}
          className={cn(
            fieldControl,
            'text-text-primary items-center justify-between gap-2',
            'hover:bg-surface-hover data-[state=open]:bg-surface-hover',
            className,
          )}
        >
          <span id={valueId} className="tabular-nums">
            {display}
          </span>
          <Clock className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
        </button>
      </Trigger>
      {/* Deliberately NOT portaled. A Radix dialog sets `pointer-events: none` on
          the body while open, so a popover portaled out of it renders correctly but
          receives no clicks or wheel events, and its focus trap puts the content out
          of tab order too. Rendering in place keeps the columns usable, so a dialog
          hosting one needs `overflow-visible` to avoid clipping it. */}
      <Content
        side="bottom"
        align="start"
        sideOffset={6}
        className={cn(
          'border-border-light bg-surface-secondary z-[999] rounded-xl border p-2 shadow-lg outline-hidden',
          // Same enter/exit motion as the shared Radix primitives (Combobox,
          // Select, DropdownMenu): fade + zoom from the trigger edge, with Radix's
          // own transform origin so the zoom grows out of wherever it was placed.
          'origin-(--radix-popover-content-transform-origin)',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
          'motion-reduce:animate-none',
          contentClassName,
        )}
      >
        {children}
      </Content>
    </Root>
  );
}

export interface TimePickerLabels {
  hour: string;
  minute: string;
  meridiem: string;
  am: string;
  pm: string;
}

export interface TimePickerProps {
  hour: number;
  minute: number;
  onChange: (next: { hour: number; minute: number }) => void;
  /** Column headings and the meridiem option names. Passed in rather than looked
   *  up here so this primitive carries no translation keys of its own. */
  labels: TimePickerLabels;
  id?: string;
  labelledBy?: string;
  className?: string;
  locale?: string;
  /** Required rather than guessed from `locale`. The host app resolves its "Clock
   *  format" setting once and passes the answer down; deriving a second answer here
   *  would let the picker and the summary beside it disagree about the same time. */
  hour12: boolean;
}

/**
 * Hour, minute and (where the locale uses one) meridiem columns behind a single
 * trigger. Replaces `<input type="time">`, whose rendering the browser owns and
 * which cannot be brought in line with the rest of the form.
 */
export default function TimePicker({
  hour,
  minute,
  onChange,
  labels,
  id,
  labelledBy,
  className,
  locale,
  hour12,
}: TimePickerProps): JSX.Element {
  const isPm = hour >= 12;

  const displayHour = hour12 ? HOURS_12[hour % 12] : hour;
  const setHour = (value: number) => {
    if (!hour12) {
      onChange({ hour: value, minute });
      return;
    }
    const base = value % 12;
    onChange({ hour: isPm ? base + 12 : base, minute });
  };

  return (
    <PickerShell
      id={id}
      labelledBy={labelledBy}
      className={className}
      display={formatTime(hour, minute, locale, hour12)}
      contentClassName="w-64"
    >
      <div className="flex gap-2">
        <TimeColumn
          label={labels.hour}
          values={hour12 ? HOURS_12 : HOURS_24}
          selected={displayHour}
          format={hour12 ? String : pad}
          onSelect={setHour}
        />
        <TimeColumn
          label={labels.minute}
          values={MINUTES}
          selected={minute}
          format={pad}
          onSelect={(value) => onChange({ hour, minute: value })}
        />
        {hour12 && (
          <TimeColumn
            label={labels.meridiem}
            values={[0, 1]}
            selected={isPm ? 1 : 0}
            format={(value) => (value === 1 ? labels.pm : labels.am)}
            onSelect={(value) => {
              const base = hour % 12;
              onChange({ hour: value === 1 ? base + 12 : base, minute });
            }}
          />
        )}
      </div>
    </PickerShell>
  );
}

export interface MinutePickerProps {
  minute: number;
  onChange: (minute: number) => void;
  label: string;
  id?: string;
  labelledBy?: string;
  className?: string;
}

/**
 * A single minutes column behind the same trigger, so an hour-less cadence reads
 * as the same picker with its other columns dropped rather than a different widget.
 */
export function MinutePicker({
  minute,
  onChange,
  label,
  id,
  labelledBy,
  className,
}: MinutePickerProps): JSX.Element {
  return (
    <PickerShell
      id={id}
      labelledBy={labelledBy}
      className={className}
      display={pad(minute)}
      contentClassName="w-36"
    >
      <TimeColumn
        label={label}
        values={MINUTES}
        selected={minute}
        format={pad}
        onSelect={onChange}
      />
    </PickerShell>
  );
}
