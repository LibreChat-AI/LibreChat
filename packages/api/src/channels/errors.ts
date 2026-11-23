export class ChannelExecutionError extends Error {
  constructor(
    readonly code:
      | 'execution_not_prepared'
      | 'execution_identity_changed'
      | 'dispatch_outcome_unknown'
      | 'generation_missing'
      | 'generation_replaced'
      | 'stop_unconfirmed',
  ) {
    super(code);
    this.name = 'ChannelExecutionError';
  }
}
