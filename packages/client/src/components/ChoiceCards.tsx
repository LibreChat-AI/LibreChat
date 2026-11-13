import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cn, disabledWithinFillClasses } from '~/utils';
import './ChoiceCards.css';

/** `choice-badge` carries the pick animation in `ChoiceCards.css`. */
const badgeClasses =
  'choice-badge bg-text-primary text-surface-primary relative flex size-5 items-center justify-center rounded-full';

export interface ChoiceCardOption {
  value: string;
  label: string;
  /** What choosing this does, kept inside the card so a choice and its explanation are one thing. */
  description?: string;
  /** Drawn in a small tile at the card's top edge. */
  icon: ReactNode;
}

export interface ChoiceCardsProps {
  options: ChoiceCardOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  'aria-labelledby'?: string;
  'aria-label'?: string;
}

/**
 * A small set of exclusive choices drawn as cards: an icon tile, the choice's name and a line on
 * what it means, with a radio mark that fills when the card is chosen. Native radios underneath,
 * so the arrow keys, the single tab stop and the screen reader's group semantics come from the
 * browser.
 */
export function ChoiceCards({
  options,
  value,
  onChange,
  disabled = false,
  className,
  'aria-labelledby': ariaLabelledBy,
  'aria-label': ariaLabel,
}: ChoiceCardsProps): ReactElement {
  const id = useId();

  return (
    <div
      role="radiogroup"
      aria-labelledby={ariaLabelledBy}
      aria-label={ariaLabel}
      className={cn('grid auto-cols-fr grid-flow-col gap-3', className)}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const labelId = `${id}-${option.value}-label`;
        const descriptionId = `${id}-${option.value}-description`;
        return (
          <label
            key={option.value}
            className={cn(
              'relative flex cursor-pointer flex-col gap-3 rounded-2xl border p-4 transition-colors duration-150 motion-reduce:transition-none',
              'has-[:focus-visible]:ring-focus-control has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2',
              checked
                ? 'border-text-primary bg-surface-secondary'
                : 'hover:bg-surface-hover border-border-medium',
              disabledWithinFillClasses,
              'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
            )}
          >
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={checked}
              disabled={disabled}
              aria-labelledby={labelId}
              aria-describedby={option.description ? descriptionId : undefined}
              onChange={() => {
                if (!disabled) onChange(option.value);
              }}
              className="sr-only"
            />
            <span className="flex items-start justify-between" aria-hidden="true">
              <span
                className={cn(
                  'flex size-9 items-center justify-center rounded-lg',
                  checked
                    ? 'bg-surface-tertiary text-text-primary'
                    : 'bg-surface-secondary text-text-secondary',
                )}
              >
                {option.icon}
              </span>
              {checked && (
                <span className={badgeClasses}>
                  <svg
                    viewBox="0 0 24 24"
                    className="size-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
              )}
            </span>
            <span className="flex flex-col gap-1">
              <span id={labelId} className="text-text-primary text-sm font-medium">
                {option.label}
              </span>
              {option.description && (
                <span id={descriptionId} className="text-text-secondary text-xs leading-snug">
                  {option.description}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
