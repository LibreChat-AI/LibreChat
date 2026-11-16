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
  /** Reuse the configured observation lifetime to bound repeated writes and outage retries. */
  intervalMs: number;
  now?: () => number;
}

/** One lease owns one reporter. No timer, credentials, event payloads or unbounded queue. */
export class DiscordCredentialReporter {
  private readonly owner: DiscordGatewayOwner;
  private readonly now: () => number;
  private pending?: DiscordCredentialState;
  private attempt?: { state: DiscordCredentialState; at: number };
  private sequence = 0;
  private running?: Promise<void>;
  private closed = false;

  constructor(private readonly options: CredentialReporterOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0)
      throw new TypeError('Invalid Discord credential reporting interval');
    this.owner = { ...options.owner };
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
      if (
        this.attempt?.state === state &&
        Math.max(0, at - this.attempt.at) < this.options.intervalMs
      )
        continue;
      this.attempt = { state, at };
      try {
        if (!(await this.options.write(this.owner, state, (this.sequence += 1)))) {
          this.closed = true;
          this.pending = undefined;
        }
      } catch {
        // Keep the previous recorded evidence. A later observation can retry after the interval;
        // neither an outage nor its error text is evidence that the bot credential is invalid.
      }
    }
  }
}
