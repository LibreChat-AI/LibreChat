import { channelConfigSchema, ContentTypes } from 'librechat-data-provider';
import type { AppConfig, ChannelRunRecord, StoredResponseRecord } from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { responseTenantId } from '~/agents/responses/scope';

export interface ChannelPreviewDependencies {
  jobs: Pick<GenerationJobManagerClass, 'getResumeState'>;
  getConfig: (run: ChannelRunRecord) => Promise<AppConfig>;
}

/** Called only after the canonical Responses reader has authorized the execution. */
export function createChannelResponsePreview(deps: ChannelPreviewDependencies) {
  return async (
    run: ChannelRunRecord,
    record: StoredResponseRecord,
  ): Promise<string | undefined> => {
    if (
      run.admission.actor.provider !== 'discord' ||
      run.cancellationRequested ||
      record.cancellationRequestedAt != null ||
      record.status !== 'in_progress' ||
      record.generationCreatedAt == null
    )
      return undefined;
    const config = channelConfigSchema.parse(
      (await deps.getConfig(run)).endpoints?.agents?.channels ?? {},
    );
    if (!config.enabled || !config.discord?.enabled || config.discord.streaming.mode !== 'partial')
      return undefined;
    const state = await deps.jobs.getResumeState(record.responseId, record.generationCreatedAt, {
      durableOnly: true,
      readIf: (job) =>
        job.status === 'running' &&
        job.createdAt === record.generationCreatedAt &&
        job.userId === record.userId &&
        responseTenantId(job.tenantId) === responseTenantId(record.tenantId) &&
        job.agent_id === record.agentId &&
        job.endpoint === 'responses' &&
        job.responseMessageId === record.responseId &&
        job.conversationId === record.conversationId &&
        job.terminalPersistencePending !== true,
    });
    if (
      !state ||
      state.conversationId !== record.conversationId ||
      state.responseMessageId !== record.responseId
    )
      return undefined;
    let preview = '';
    for (const part of state.aggregatedContent ?? []) {
      if (part.type !== ContentTypes.TEXT || typeof part.text !== 'string') continue;
      for (const point of part.text) {
        if (preview.length + point.length > config.discord.streaming.maxPreviewChars)
          return preview;
        preview += point;
      }
    }
    return preview || undefined;
  };
}
