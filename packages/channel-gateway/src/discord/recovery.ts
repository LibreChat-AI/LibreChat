import type { DiscordChannelConfig } from 'librechat-data-provider';

export type DiscordGatewayStopReason =
  | 'shutdown'
  | 'lost'
  | 'credentials'
  | 'identity'
  | 'checkpoint'
  | 'configuration'
  | 'startup'
  | 'failed'
  | 'backpressure'
  | 'dispatch';

/**
 * Safe terminal classification; provider payloads and credentials never cross this boundary.
 * `fatal` selects the longer retry ladder, for a fault that repeating will not fix (a rejected
 * token, a configuration or identity fault) or that can spend IDENTIFY budget on every attempt
 * (`startup`: a session that did not reach READY in time, or was refused an IDENTIFY). The delay
 * itself always comes from policy, never from the failure.
 */
export class DiscordGatewayFailure extends Error {
  readonly fatal: boolean;
  constructor(
    readonly reason: Exclude<DiscordGatewayStopReason, 'shutdown' | 'lost'>,
    readonly healthyForMs = 0,
  ) {
    super('Discord Gateway connection unavailable');
    this.fatal = ['credentials', 'configuration', 'identity', 'startup'].includes(reason);
  }
}

export type DiscordIdentifyRefusalReason = 'exhausted' | 'invalid' | 'retry';

/**
 * An IDENTIFY the owner refused to let the SDK send: the session budget is spent or unreadable, or
 * the shard has not answered its previous IDENTIFY. A budget that could not be read at all is not
 * a refusal but an ordinary failure. The reason is a closed set and carries no detail.
 */
export class DiscordIdentifyRefusal extends Error {
  constructor(readonly reason: DiscordIdentifyRefusalReason) {
    super('Discord Gateway identify refused');
  }
}

/** Failures counted against one owner. Fatal and transient failures never share a counter. */
export interface DiscordRetryState {
  fatalFailures: number;
  transientFailures: number;
}

/**
 * Advances the exponential retry ladder for one failure and returns how long the next attempt
 * waits. A fatal delay starts at `fatalRetryMinMs` and is exact; a transient delay starts at the
 * poll interval and takes equal jitter. A failure that followed a verified session of at least
 * `resetAfterMs` starts both ladders again.
 */
export function discordRetryDelay(
  state: DiscordRetryState,
  error: unknown,
  policy: Pick<DiscordChannelConfig['gateway'], 'pollIntervalMs' | 'recovery'>,
  random: () => number = Math.random,
): { fatal: boolean; waitMs: number } {
  const { recovery } = policy;
  const failure = error instanceof DiscordGatewayFailure ? error : undefined;
  if (failure && failure.healthyForMs >= recovery.resetAfterMs) {
    state.fatalFailures = 0;
    state.transientFailures = 0;
  }
  const fatal = failure?.fatal === true;
  const count = fatal
    ? (state.fatalFailures = Math.min(31, state.fatalFailures + 1))
    : (state.transientFailures = Math.min(31, state.transientFailures + 1));
  const base = fatal ? recovery.fatalRetryMinMs : policy.pollIntervalMs;
  const cap = fatal ? recovery.fatalRetryMaxMs : recovery.retryMaxMs;
  const wait = Math.min(cap, base * 2 ** (count - 1));
  const sample = random();
  const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 1;
  return { fatal, waitMs: fatal ? wait : Math.max(1, Math.round(wait * (0.5 + jitter / 2))) };
}
