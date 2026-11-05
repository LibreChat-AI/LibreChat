import type { AppConfig } from '@librechat/data-schemas';

/** Budgets for outbound calls made inside a request, used when `timeouts` omits a key. */
export const DEFAULT_OUTBOUND_TIMEOUTS_MS = {
  ragMs: 30_000,
  ocrMs: 300_000,
  actionsMs: 300_000,
  moderationMs: 10_000,
  imageFetchMs: 30_000,
  toolsMs: 60_000,
  speechMs: 300_000,
  imageGenerationMs: 300_000,
} as const;

/**
 * Budget for calls made where no app config is in scope (startup, the config loader, auth
 * refresh, email delivery), so `timeouts` cannot reach them.
 */
export const SERVICE_REQUEST_TIMEOUT_MS = 10_000;

export type OutboundTimeout = keyof typeof DEFAULT_OUTBOUND_TIMEOUTS_MS;

/** The `librechat.yaml` `timeouts` value for `key`, else its default. */
export function getOutboundTimeoutMs(
  appConfig: Pick<AppConfig, 'timeouts'> | null | undefined,
  key: OutboundTimeout,
): number {
  return appConfig?.timeouts?.[key] ?? DEFAULT_OUTBOUND_TIMEOUTS_MS[key];
}

/** What an operator sees when a budget runs out: the key to raise and its current value. */
export function outboundTimeoutMessage(key: OutboundTimeout, timeoutMs: number): string {
  return `Exceeded timeouts.${key} (${timeoutMs} ms); raise it in librechat.yaml if this upstream is legitimately slow`;
}

/**
 * Axios options bounding one request by `timeoutMs`, both as socket idle time (`timeout`) and as
 * wall-clock time (the abort signal), since a response that keeps trickling bytes never goes idle.
 * `AbortSignal.timeout` holds its timer weakly, so a finished request leaves nothing scheduled.
 * Either way the failure carries `outboundTimeoutMessage`, and the deadline also follows `signal`.
 */
export function outboundRequestBudget(
  timeoutMs: number,
  key: OutboundTimeout,
  signal?: AbortSignal,
): { timeout: number; timeoutErrorMessage: string; signal: AbortSignal } {
  const deadline = AbortSignal.timeout(timeoutMs);
  return {
    timeout: timeoutMs,
    timeoutErrorMessage: outboundTimeoutMessage(key, timeoutMs),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  };
}

/**
 * The budget overrun behind `error`, if it was one: an idle timeout, which axios reports with
 * the budget message, or a passed deadline, which cancels with a `TimeoutError` reason.
 */
export function getOutboundTimeout(error: unknown): Error | undefined {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  const { config } = error as {
    config?: { timeoutErrorMessage?: unknown; signal?: { reason?: unknown } };
  };
  const budgetMessage = config?.timeoutErrorMessage;
  if (typeof budgetMessage !== 'string' || !budgetMessage.startsWith('Exceeded timeouts.')) {
    return undefined;
  }
  if ((error as { message?: unknown }).message === budgetMessage) {
    return error as Error;
  }
  const reason = config?.signal?.reason as { name?: unknown } | undefined;
  if (reason?.name === 'TimeoutError') {
    return Object.assign(new Error(budgetMessage), { name: 'OutboundTimeoutError' });
  }
  return undefined;
}

/** Budget for one call a built-in tool makes to its API, per `timeouts.toolsMs`. */
export function toolRequestBudget(
  timeouts?: AppConfig['timeouts'],
  signal?: AbortSignal,
): ReturnType<typeof outboundRequestBudget> {
  return outboundRequestBudget(getOutboundTimeoutMs({ timeouts }, 'toolsMs'), 'toolsMs', signal);
}

/**
 * Budget factory for speech providers, per `timeouts.speechMs`. Each call starts a fresh
 * deadline, so every provider request gets the full budget while `signal` (a client
 * disconnect) stays shared across them.
 */
export function createSpeechBudget(
  appConfig: Pick<AppConfig, 'timeouts'> | null | undefined,
  signal?: AbortSignal,
): () => ReturnType<typeof outboundRequestBudget> {
  const timeoutMs = getOutboundTimeoutMs(appConfig, 'speechMs');
  return () => outboundRequestBudget(timeoutMs, 'speechMs', signal);
}

/** Budget for one request under the configured (or default) `key` timeout. */
export function configuredRequestBudget(
  appConfig: Pick<AppConfig, 'timeouts'> | null | undefined,
  key: OutboundTimeout,
  signal?: AbortSignal,
): ReturnType<typeof outboundRequestBudget> {
  return outboundRequestBudget(getOutboundTimeoutMs(appConfig, key), key, signal);
}

/** Fixed budget for startup and auth requests made before app config exists. */
export function serviceRequestBudget(): { timeout: number; signal: AbortSignal } {
  return {
    timeout: SERVICE_REQUEST_TIMEOUT_MS,
    signal: AbortSignal.timeout(SERVICE_REQUEST_TIMEOUT_MS),
  };
}
