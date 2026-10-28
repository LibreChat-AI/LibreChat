import { useId } from 'react';
import { JSX } from 'react/jsx-runtime';
import { RotateCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import useAutoRetry from '~/hooks/useAutoRetry';
import { LoadingDots } from './LoadingDots';
import { Button } from './Button';
import { cn } from '~/utils';

export interface RetryableErrorLabels {
  /** Idle action, e.g. "Try Again". */
  retry: string;
  /** In-flight action and the announced status, e.g. "Retrying". */
  retrying: string;
  /** Called each tick, e.g. `(seconds) => localize(key, { seconds })`. */
  countdown: (seconds: number) => string;
  /** Omit to hide the reload escape hatch once the automatic attempts run out. */
  reload?: string;
}

export interface RetryableErrorProps {
  /** One heading and at most one line: an error state is read, not studied. */
  title: string;
  detail?: string;
  /** Decorative, rendered inside the circular surface at a fixed size. */
  icon?: LucideIcon;
  /** `neutral` for outcomes that are not faults, such as an empty result. */
  tone?: 'error' | 'neutral';
  labels: RetryableErrorLabels;
  /** Omit to render the message without any action. */
  onRetry?: () => void;
  /** True while the caller's request is in flight. */
  isRetrying?: boolean;
  /** False for failures a repeated request cannot fix; disables the backoff. */
  autoRetry?: boolean;
  /** Backoff steps in milliseconds; see `useAutoRetry` for the default. */
  retryDelaysMs?: readonly number[];
  /** Replaces the default full-height centring. */
  className?: string;
}

/**
 * A centred failure state that recovers on its own: bounded automatic retries
 * with a visible countdown, an immediate attempt when connectivity or focus
 * returns, and a reload once the attempts are spent.
 *
 * Copy and classification stay with the caller — this owns the layout, the
 * waiting affordances and the announcement, so every feature that can fail a
 * fetch reports it the same way.
 */
export function RetryableError({
  title,
  detail,
  icon: Icon,
  tone = 'error',
  labels,
  onRetry,
  isRetrying = false,
  autoRetry = true,
  retryDelaysMs,
  className,
}: RetryableErrorProps): JSX.Element {
  const detailId = `${useId()}-detail`;
  const { countdown, isExhausted, retryManually } = useAutoRetry({
    enabled: autoRetry && !!onRetry,
    isRetrying,
    onRetry,
    delaysMs: retryDelaysMs,
  });
  const isWaiting = isRetrying || countdown != null;

  return (
    <div
      className={cn(
        'flex h-full min-h-full w-full flex-col items-center justify-center gap-5 px-4 py-10 text-center',
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3" role="alert" aria-atomic="true">
        {Icon != null && (
          <span
            className={cn(
              'flex size-11 items-center justify-center rounded-full',
              tone === 'error'
                ? 'bg-status-error-subtle text-status-error'
                : 'bg-surface-tertiary text-text-secondary',
            )}
          >
            <Icon className="size-5" aria-hidden={true} />
          </span>
        )}

        <div className="max-w-sm">
          <h3 className="text-text-primary text-base font-semibold">{title}</h3>
          {detail != null && detail !== '' && (
            <p className="text-text-secondary mt-1 text-sm leading-6" id={detailId}>
              {detail}
            </p>
          )}
        </div>
      </div>

      {onRetry && (
        <div className="flex flex-col items-center gap-2">
          <Button
            onClick={() => {
              if (!isRetrying) {
                retryManually();
              }
            }}
            size="sm"
            aria-disabled={isRetrying || undefined}
            aria-busy={isRetrying}
            className={cn('min-w-[8rem]', isRetrying && 'opacity-50')}
            aria-describedby={detail ? detailId : undefined}
          >
            {isRetrying ? (
              <>
                {labels.retrying}
                <LoadingDots />
              </>
            ) : (
              <>
                <RotateCw className="size-4" aria-hidden={true} />
                {labels.retry}
              </>
            )}
          </Button>

          {isExhausted && !isRetrying && labels.reload != null && (
            <Button variant="link" size="sm" onClick={() => window.location.reload()}>
              {labels.reload}
            </Button>
          )}

          {/* Ticks every second, so it stays out of the alert's announcement. */}
          {countdown != null && (
            <p
              className="text-text-tertiary mt-1.5 flex items-center gap-1.5 text-xs"
              aria-hidden="true"
            >
              {labels.countdown(countdown)}
              <LoadingDots />
            </p>
          )}
        </div>
      )}

      {/* Polite, and outside the assertive region, so progress never interrupts. */}
      <span className="sr-only" role="status" aria-live="polite">
        {isWaiting ? labels.retrying : ''}
      </span>
    </div>
  );
}

export default RetryableError;
