import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn, Button, useLocalize } from '@librechat/client';
import type { ReactNode } from 'react';
import type { ErrorPayload, ErrorSource } from '../../core/errors';
import useExpandCollapse from '../parts/useExpandCollapse';
import { formatNumber } from '../../core/errors';

export type ErrorRendererProps = {
  /** The payload parsed out of the message text. */
  json: ErrorPayload;
  /** The message text as persisted, including any prefix around the payload. */
  text: string;
  /** The row this error belongs to; absent only where no row supplies an `ErrorSource`. */
  message?: ErrorSource;
};

/** The fallback renderer also runs when there is no payload at all. */
export type UnclassifiedErrorProps = Omit<ErrorRendererProps, 'json'> & { json?: ErrorPayload };

/** Stacks an error's sentences, details and actions without inheriting prose spacing. */
export function ErrorBody({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-col gap-2">{children}</div>;
}

/**
 * Secondary information a reader only wants after the headline: a provider's own message, a token
 * budget, a generation breakdown. Collapsed by default and rendered as text rather than through
 * `CodeBlock`, which frames a detail in a code bar and a dark slab that reads as output.
 *
 * Motion is `.part-expand`, the same `grid-template-rows` tween the tool rows and reasoning in
 * the transcript use, so a detail inside an error box opens on the curve the rest of the message
 * content already moves on, with its reduced-motion rule; `useExpandCollapse` makes the collapsed
 * body `inert`.
 *
 * The body stays mounted while collapsed. That is what makes the card resize rather than jump: a
 * collapsed row still contributes its width to the box's intrinsic size, so the box only ever
 * changes height, and it changes it on the tween instead of in one step. The gap to the trigger
 * lives inside the animated element for the same reason — as a margin outside it, it would appear
 * in a single step once the height reached zero.
 */
export function ErrorDetails({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { ref: panelRef } = useExpandCollapse(open);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((expanded) => !expanded)}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-text-secondary hover:text-text-primary focus-visible:ring-text-primary flex items-center gap-1 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
      >
        {label}
        <ChevronRight
          className={cn(
            'size-3.5 transition-transform duration-300 ease-out motion-reduce:transition-none',
            open ? 'rotate-90' : 'rtl:-scale-x-100',
          )}
          aria-hidden="true"
        />
      </button>
      <div id={panelId} className="part-expand" data-expanded={open} aria-hidden={!open}>
        <div ref={panelRef} className="overflow-hidden">
          <div className="text-text-secondary mt-1 text-xs break-words whitespace-pre-wrap">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Past a sentence's worth of text, or across lines, a detail is a body to open rather than read. */
const INLINE_DETAIL_LENGTH = 240;

/**
 * A headline plus the failure's own words, the way every provider-produced error reads: what is
 * known first, the reported text second. A single sentence stays in place, where a reader gets it
 * without acting; a body of text collapses under `label` unless `inline` says the detail is the
 * instruction the reader needs, as a gateway's explanation of a spent budget is.
 */
export function ErrorWithDetail({
  headline,
  detail,
  label,
  inline = false,
}: {
  headline: string;
  detail?: string;
  label: string;
  inline?: boolean;
}): ReactNode {
  if (detail == null) {
    return <>{headline}</>;
  }

  return (
    <ErrorBody>
      <div>{headline}</div>
      {inline || (detail.length <= INLINE_DETAIL_LENGTH && !/[\r\n]/.test(detail)) ? (
        <div className="text-text-secondary break-words whitespace-pre-wrap">{detail}</div>
      ) : (
        <ErrorDetails label={label}>{detail}</ErrorDetails>
      )}
    </ErrorBody>
  );
}

export function ErrorActions({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** The one thing a reader can do about the failure, next to the sentence explaining it. */
export function ErrorAction({
  onClick,
  children,
  variant,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  /** A second action next to the primary one reads as the alternative, not a peer. */
  variant?: 'outline';
  disabled?: boolean;
}): ReactNode {
  return (
    /** One step tighter than the button default (8px) so the control reads as nested inside the
     *  error card's 12px corner rather than echoing it. */
    <Button
      type="button"
      size="sm"
      shape="nested"
      variant={variant}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

/** "minute" or "45 minutes", for limit copy that ends in "per …". */
export function useWindowLabel(windowInMinutes?: number): string | undefined {
  const localize = useLocalize();
  if (windowInMinutes == null) {
    return undefined;
  }
  return windowInMinutes === 1
    ? localize('com_error_window_minute')
    : localize('com_error_window_minutes', { 0: formatNumber(windowInMinutes) });
}
