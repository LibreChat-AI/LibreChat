export type DiscordWriteOutcome = 'permanent' | 'retryable' | 'unknown';
export class DiscordWriteError extends Error {
  constructor(
    readonly outcome: DiscordWriteOutcome,
    readonly retryAfterMs = 0,
    readonly status?: number,
  ) {
    super('Discord operation was not confirmed');
  }
}
