export type DiscordGatewayStopReason =
  | 'shutdown'
  | 'lost'
  | 'credentials'
  | 'identity'
  | 'checkpoint'
  | 'configuration'
  | 'failed'
  | 'backpressure'
  | 'dispatch';

/** Safe terminal classification; provider payloads and credentials never cross this boundary. */
export class DiscordGatewayFailure extends Error {
  readonly fatal: boolean;
  constructor(
    readonly reason: Exclude<DiscordGatewayStopReason, 'shutdown' | 'lost'>,
    readonly healthyForMs = 0,
  ) {
    super('Discord Gateway connection unavailable');
    this.fatal = ['credentials', 'configuration', 'identity'].includes(reason);
  }
}
