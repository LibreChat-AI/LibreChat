import { useEffect, useState } from 'react';
import { ViolationTypes } from 'librechat-data-provider';
import type { ErrorRendererProps } from './parts';
import {
  ErrorBody,
  readNumber,
  readString,
  formatNumber,
  formatDuration,
  useWindowLabel,
  formatTimestamp,
} from './parts';
import { useLocalize } from '~/hooks';

type RetryTargetInput = {
  type: string | undefined;
  resetAt?: number;
  retryAfterSeconds?: number;
  createdAt?: string | Date;
  windowInMinutes?: number;
};

function getCreatedAtMs(createdAt?: string | Date): number | undefined {
  if (createdAt == null) {
    return undefined;
  }
  const timestamp = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * The moment the limiter's window reopens. A reset already in the past still resolves, and reads as
 * "you can send another message now". A future one is bounded by the limiter's own window, which is
 * as far ahead as a reset can lie, rather than by a fixed horizon an operator's window may exceed.
 * The window is measured from the row's own timestamp when it has one, the clock the target is
 * counted in, so a device clock that disagrees with the server's cannot push a valid reset out of
 * range.
 */
function resolveRetryTarget({
  type,
  resetAt,
  retryAfterSeconds,
  createdAt,
  windowInMinutes,
}: RetryTargetInput): number | undefined {
  if (type !== ViolationTypes.MESSAGE_LIMIT) {
    return undefined;
  }

  /**
   * `retryAfterSeconds` is relative, so counted from the row's own timestamp it holds up against a
   * device clock that disagrees with the server's: a row received live is stamped by this device
   * as it arrives, and a restored row by the server that also stamped `resetAt`. The absolute
   * `resetAt` is the fallback for a row missing either.
   */
  const rowTime = getCreatedAtMs(createdAt);
  const target =
    retryAfterSeconds != null && rowTime != null ? rowTime + retryAfterSeconds * 1000 : resetAt;
  if (target == null || !Number.isFinite(target)) {
    return undefined;
  }

  const violatedAt = rowTime ?? Date.now();
  if (windowInMinutes != null && target > violatedAt + windowInMinutes * 60 * 1000) {
    return undefined;
  }
  return target;
}

/** Keeps a rate-limit countdown local to the rendered error row. */
function useRetryCountdown(target?: number): number | undefined {
  const [remaining, setRemaining] = useState<number | undefined>(() =>
    target == null ? undefined : Math.max(0, target - Date.now()),
  );

  useEffect(() => {
    if (target == null) {
      setRemaining(undefined);
      return;
    }

    const tick = () => {
      const next = target - Date.now();
      setRemaining(Math.max(0, next));
      return next;
    };

    if (tick() <= 0) {
      return;
    }

    const timer = setInterval(() => {
      if (tick() <= 0) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [target]);

  if (target == null) {
    return undefined;
  }
  return remaining ?? Math.max(0, target - Date.now());
}

export default function LimitError({ json, message }: ErrorRendererProps) {
  const localize = useLocalize();
  const type = readString(json, 'type');
  const createdAt = message?.createdAt as string | Date | undefined;
  const max = readNumber(json, 'max');
  const limit = readNumber(json, 'limit');
  const windowInMinutes = readNumber(json, 'windowInMinutes');
  const windowLabel = useWindowLabel(windowInMinutes);
  const resetAt = readNumber(json, 'resetAt');
  const retryAfterSeconds = readNumber(json, 'retryAfterSeconds');
  const retryTarget = resolveRetryTarget({
    type,
    resetAt,
    retryAfterSeconds,
    createdAt,
    windowInMinutes,
  });
  const remaining = useRetryCountdown(retryTarget);

  let headline: string;
  switch (type) {
    case ViolationTypes.MESSAGE_LIMIT:
      if (windowLabel == null) {
        headline = localize('com_error_limit_reached');
      } else if (max === 1) {
        headline = localize('com_error_message_limit_one', { 0: windowLabel });
      } else if (max != null) {
        headline = localize('com_error_message_limit', {
          0: formatNumber(max),
          1: windowLabel,
        });
      } else {
        headline = localize('com_error_limit_reached');
      }
      break;
    case ViolationTypes.CONCURRENT:
      headline =
        limit != null && limit > 1
          ? localize('com_error_concurrent', { 0: formatNumber(limit) })
          : localize('com_error_concurrent_one');
      break;
    case ViolationTypes.FILE_UPLOAD_LIMIT:
      headline =
        max != null && windowLabel != null
          ? localize('com_error_file_upload_limit', {
              0: formatNumber(max),
              1: windowLabel,
            })
          : localize('com_error_limit_reached');
      break;
    case ViolationTypes.TTS_LIMIT:
      headline =
        max != null && windowLabel != null
          ? localize('com_error_tts_limit', { 0: formatNumber(max), 1: windowLabel })
          : localize('com_error_limit_reached');
      break;
    case ViolationTypes.STT_LIMIT:
      headline =
        max != null && windowLabel != null
          ? localize('com_error_stt_limit', { 0: formatNumber(max), 1: windowLabel })
          : localize('com_error_limit_reached');
      break;
    default:
      headline = localize('com_error_limit_reached');
  }

  /**
   * The error box is an assertive live region, so a line that changes every second would be
   * announced every second. The ticking countdown is hidden from assistive technology, which reads
   * the moment the window reopens instead; that sentence changes once, when sending is allowed again.
   */
  return (
    <ErrorBody>
      <p>{headline}</p>
      {retryTarget != null && remaining != null && (
        <p className="text-text-secondary">
          {remaining > 0 ? (
            <>
              <span aria-hidden="true">
                {localize('com_error_retry_countdown', { 0: formatDuration(remaining) })}
              </span>
              <span className="sr-only">
                {localize('com_error_retry_at', { 0: formatTimestamp(retryTarget) })}
              </span>
            </>
          ) : (
            localize('com_error_retry_available')
          )}
        </p>
      )}
    </ErrorBody>
  );
}
