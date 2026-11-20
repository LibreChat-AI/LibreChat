import type { ChannelRunSnapshot } from 'librechat-data-provider';
import type { ChannelRunRecord } from '@librechat/data-schemas';
import type { createChannelResponseProjection, createChannelResponseRetirement } from './responses';
import { ChannelExecutionError } from './errors';

export { ChannelExecutionError } from './errors';

export interface ChannelExecutionDependencies {
  responseProjection: ReturnType<typeof createChannelResponseProjection>;
  responseRetirement: ReturnType<typeof createChannelResponseRetirement>;
}

/** Execution and cancellation belong to Responses; Channels only projects delivery state. */
export function createChannelExecutionAdapter(deps: ChannelExecutionDependencies) {
  return {
    async retireForAuthorityLoss(run: ChannelRunRecord): Promise<'stopped' | 'pending'> {
      if (!run.cancellationRequested || run.errorCode !== 'channel_authority_changed')
        throw new ChannelExecutionError('execution_identity_changed');
      if (!run.execution) return 'stopped';
      const execution = run.execution;
      // A credential permits Response admission even before its ID has been bound.
      // Only an unprovisioned run can be retired without consulting Responses.
      if (
        !execution.apiKeyId &&
        !execution.responseId &&
        execution.generationCreatedAt == null &&
        execution.deliveryKey == null &&
        execution.enqueueAttemptedAt == null
      )
        return 'stopped';
      if (execution.protocol !== 'responses')
        throw new ChannelExecutionError('execution_identity_changed');
      return deps.responseRetirement(run);
    },
    async advance(
      run: ChannelRunRecord,
    ): Promise<{ snapshot: ChannelRunSnapshot; generationCreatedAt?: number }> {
      if (run.execution?.protocol !== 'responses' || !run.execution.responseId)
        throw new ChannelExecutionError('execution_not_prepared');
      return deps.responseProjection(run);
    },
  };
}
