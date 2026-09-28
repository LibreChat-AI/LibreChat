import React, { useState, useRef, useLayoutEffect, useCallback, memo } from 'react';
import { useLocalize } from '~/hooks';

/** Matches the `inset-y-1` the single-row indicator uses. */
const INDICATOR_INSET = 4;

interface Option {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

interface RadioProps {
  options: Option[];
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  fullWidth?: boolean;
  /** Lets the segments flow onto a second row instead of overflowing their
   *  container. A `whitespace-nowrap` label plus `px-4` gives every segment a hard
   *  minimum width, so five of them (translated labels are longer still) push past a
   *  dialog's width on a phone and the choices past the edge become unreachable.
   *  The moving indicator follows across rows; the single-row default is untouched. */
  wrap?: boolean;
  'aria-labelledby'?: string;
}

const Radio: React.NamedExoticComponent<RadioProps> = memo(function Radio({
  options,
  value,
  onChange,
  disabled = false,
  className = '',
  buttonClassName = '',
  fullWidth = false,
  wrap = false,
  'aria-labelledby': ariaLabelledBy,
}: RadioProps) {
  const localize = useLocalize();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [isMounted, setIsMounted] = useState(false);
  const [currentValue, setCurrentValue] = useState<string>(value ?? '');
  const [backgroundStyle, setBackgroundStyle] = useState<React.CSSProperties>({});

  const handleChange = (newValue: string) => {
    setCurrentValue(newValue);
    onChange?.(newValue);
  };

  /** A radiogroup is a single tab stop: the roving `tabIndex` puts focus on the
   *  checked segment and the arrows move the selection, per WAI-ARIA. Without
   *  this every segment was its own tab stop and keyboard users could focus a
   *  segment but never reach the others' selection behavior. */
  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (disabled || options.length < 2) {
      return;
    }
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: options.length - 1,
    };
    const target = moves[event.key];
    if (target == null) {
      return;
    }
    event.preventDefault();
    // Wraps, so holding ArrowRight from the last segment returns to the first.
    const next = (target + options.length) % options.length;
    const nextValue = options[next].value;
    // Focus follows the key unconditionally; the selection only changes when it
    // actually moves. Home on the first segment and End on the last land where
    // they started, and firing `onChange` there would dirty a form for a
    // selection that never changed.
    buttonRefs.current[next]?.focus();
    if (nextValue === currentValue) {
      return;
    }
    handleChange(nextValue);
  };

  const updateBackgroundStyle = useCallback(() => {
    const selectedIndex = options.findIndex((opt) => opt.value === currentValue);
    const selectedButton = buttonRefs.current[selectedIndex];
    if (selectedIndex < 0 || !selectedButton) {
      return;
    }
    // offsetWidth/offsetLeft are layout metrics: unlike getBoundingClientRect they
    // are not distorted by the dialog's open transform (scale), and they resolve to
    // whole pixels, so the indicator matches its segment and keeps crisp borders.
    if (!wrap) {
      setBackgroundStyle({
        width: `${selectedButton.offsetWidth}px`,
        transform: `translateX(${selectedButton.offsetLeft}px)`,
      });
      return;
    }
    // Wrapped, the indicator also has to move vertically, so it carries its own
    // height rather than stretching between the container's insets, and it has to
    // reproduce what `inset-y-1` produces for a row that still fits.
    //
    // That geometry depends on the container's own vertical padding, because the
    // insets resolve against its padding box: a group styled `px-1` gets a pill
    // inset inside its segment, while one styled `p-1` gets a pill that covers the
    // segment exactly. The first row's `offsetTop` is that padding, so measuring it
    // keeps both cases identical when a group turns `wrap` on; assuming zero shrank
    // a padded group's pill by 8px and left it floating inside the segment.
    const rowInset = buttonRefs.current[0]?.offsetTop ?? 0;
    setBackgroundStyle({
      width: `${selectedButton.offsetWidth}px`,
      height: `${selectedButton.offsetHeight + rowInset * 2 - INDICATOR_INSET * 2}px`,
      transform: `translate(${selectedButton.offsetLeft}px, ${
        selectedButton.offsetTop - rowInset + INDICATOR_INSET
      }px)`,
    });
  }, [currentValue, options, wrap]);

  // Measure before paint and re-measure on any later layout change (the dialog's
  // open animation settling, a window resize). A fixed timeout previously raced
  // the dialog transition and left the indicator mis-sized.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    updateBackgroundStyle();
    setIsMounted(true);
    const observer = new ResizeObserver(() => updateBackgroundStyle());
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateBackgroundStyle]);

  useLayoutEffect(() => {
    if (value !== undefined) {
      setCurrentValue(value);
    }
  }, [value]);

  if (options.length === 0) {
    return (
      <div
        className="relative inline-flex items-center rounded-lg bg-surface-tertiary p-1 opacity-50"
        role="radiogroup"
        aria-labelledby={ariaLabelledBy}
      >
        <span className="px-4 py-2 text-xs text-text-secondary">
          {localize('com_ui_no_options')}
        </span>
      </div>
    );
  }

  const selectedIndex = options.findIndex((opt) => opt.value === currentValue);

  return (
    <div
      ref={containerRef}
      className={`relative ${fullWidth ? 'flex' : 'inline-flex'} ${
        wrap ? 'flex-wrap' : ''
      } items-center rounded-lg bg-surface-tertiary px-1 ${className}`}
      role="radiogroup"
      aria-labelledby={ariaLabelledBy}
    >
      {selectedIndex >= 0 && isMounted && (
        <div
          className={`pointer-events-none absolute left-0 rounded-md border border-border-light bg-surface-primary shadow-sm transition-all duration-300 ease-out ${
            wrap ? 'top-0' : 'inset-y-1'
          }`}
          style={backgroundStyle}
        />
      )}
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(el) => {
            buttonRefs.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-checked={currentValue === option.value}
          tabIndex={selectedIndex === index || (selectedIndex < 0 && index === 0) ? 0 : -1}
          onClick={() => handleChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          disabled={disabled}
          className={`relative z-10 flex h-[34px] items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary ${
            currentValue === option.value ? 'text-text-primary' : 'text-text-secondary'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${fullWidth ? 'flex-1' : ''} ${buttonClassName}`}
        >
          {option.icon && (
            <span className="flex-shrink-0" aria-hidden="true">
              {option.icon}
            </span>
          )}
          <span className="whitespace-nowrap">{option.label}</span>
        </button>
      ))}
    </div>
  );
});

export default Radio;
