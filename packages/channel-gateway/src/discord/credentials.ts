import type { DiscordCredentialState, DiscordGatewayOwner } from 'librechat-data-provider';
import type { DiscordApplicationObservation } from './observe';
import { discordCredentialObservation } from './observe';

interface CredentialReporterOptions {
  owner: DiscordGatewayOwner;
  /** `sequence` counts this reporter's attempts; the server ignores a write that is not newer. */
  write(
    owner: DiscordGatewayOwner,
    state: DiscordCredentialState,
    sequence: number,
  ): Promise<boolean>;
  /** Reuse the configured observation lifetime to bound repeated writes of identical evidence. */
  intervalMs: number;
  /** Wait before a write that failed is repeated, with or without new evidence. Capped by `intervalMs`. */
  retryMs: number;
  now?: () => number;
}

/**
 * One lease owns one reporter: at most one write in flight, one pending state and one retry timer.
 * No credentials, event payloads or unbounded queue.
 */
export class DiscordCredentialReporter {
  private readonly owner: DiscordGatewayOwner;
  private readonly now: () => number;
  private readonly retryMs: number;
  private pending?: DiscordCredentialState;
  private attempt?: { state: DiscordCredentialState; at: number; failed: boolean };
  private sequence = 0;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly options: CredentialReporterOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0)
      throw new TypeError('Invalid Discord credential reporting interval');
    if (!Number.isSafeInteger(options.retryMs) || options.retryMs <= 0)
      throw new TypeError('Invalid Discord credential retry delay');
    this.owner = { ...options.owner };
    this.retryMs = Math.min(options.retryMs, options.intervalMs);
    this.now = options.now ?? Date.now;
  }

  observe(observation: DiscordApplicationObservation): void {
    if (this.closed) return;
    const state = discordCredentialObservation(observation);
    if (!state) return;
    this.pending = state;
    this.start();
  }

  /** Flush already observed evidence before releasing the lease; ignore later callbacks. */
  async close(): Promise<void> {
    this.closed = true;
    this.disarm();
    while (this.running) await this.running;
  }

  private start(): void {
    if (this.running || !this.pending) return;
    this.running = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.running = undefined;
        this.start();
      });
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const state = this.pending;
      this.pending = undefined;
      const at = this.now();
      const last = this.attempt;
      const window = last?.failed ? this.retryMs : this.options.intervalMs;
      if (last?.state === state && Math.max(0, at - last.at) < window) continue;
      this.disarm();
      const attempt = { state, at, failed: false };
      this.attempt = attempt;
      try {
        if (!(await this.options.write(this.owner, state, (this.sequence += 1)))) {
          this.closed = true;
          this.pending = undefined;
        }
      } catch {
        // Keep the previous recorded evidence. Neither an outage nor its error text is evidence
        // that the bot credential is invalid, so the failed attempt is repeated by the timer.
        attempt.failed = true;
      }
    }
    this.arm();
  }

  /** The timer repeats only the latest attempt and only while it is the one that failed. */
  private arm(): void {
    if (this.closed || this.timer || !this.attempt?.failed) return;
    this.timer = setTimeout(() => this.retry(), this.retryMs);
    this.timer.unref();
  }

  private disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private retry(): void {
    this.timer = undefined;
    const failed = this.attempt;
    if (this.closed || this.running || !failed?.failed) return;
    // The repeat is not coalesced against the failure it repeats.
    this.attempt = undefined;
    this.pending = failed.state;
    this.start();
  }
}
