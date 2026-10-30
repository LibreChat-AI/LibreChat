import { randomUUID } from 'node:crypto';
import { channelConfigSchema } from 'librechat-data-provider';
import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
import type { AgentChannelMethods, ChannelRunStorage } from '@librechat/data-schemas';
import type { ChannelConfig } from 'librechat-data-provider';
import type { ChannelRunDependencies } from './runs';
import { createIdleRecoveryLoop } from '~/agents/recovery';
import { hasChannelRunAuthority } from './runs';

export interface ChannelCleanupDependencies {
  storage: ChannelRunStorage;
  channels: Pick<
    AgentChannelMethods,
    'getAgentChannelMetadata' | 'listDeletingAgentChannels' | 'deleteAgentChannel'
  >;
  resolvePrincipal: ChannelRunDependencies['resolvePrincipal'];
  retireForAuthorityLoss: ChannelRunDependencies['retireForAuthorityLoss'];
  isCredentialCurrent: (
    run: Parameters<ChannelRunDependencies['retireForAuthorityLoss']>[0],
  ) => Promise<boolean>;
  deleteApiKey: (id: string, userId: string) => Promise<boolean>;
  getConfig: () => Promise<ChannelConfig | undefined>;
  onError: (error: unknown) => void;
  now?: () => number;
}

/** Private recovery survives disabled features and missing gateway/channel rows.
 * Only metadata crosses system context; cleanup cannot enqueue or deliver. */
export function createChannelCleanupRuntime(deps: ChannelCleanupDependencies) {
  const owner = `channel-cleanup-${randomUUID()}`;
  const now = deps.now ?? Date.now;
  let worker: ReturnType<typeof createIdleRecoveryLoop> | undefined;
  let initialization: Promise<void> | undefined;
  let stopped = false;
  let runCursor: string | undefined;
  let channelCursor: string | undefined;
  return {
    initialize(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (initialization) return initialization;
      initialization = (async () => {
        const initial = channelConfigSchema.parse((await deps.getConfig()) ?? {});
        if (stopped) return;
        worker = createIdleRecoveryLoop({
          ...initial.cleanup,
          onError: deps.onError,
          scan: async () => {
            if (stopped) return true;
            const config = channelConfigSchema.parse((await deps.getConfig()) ?? {});
            const pageSize = Math.min(config.cleanup.batchSize, config.maxMetadataPageSize);
            const [runs, deleting] = await runAsSystem(() =>
              Promise.all([
                deps.storage.listPendingMetadata(runCursor, pageSize),
                deps.channels.listDeletingAgentChannels(channelCursor, pageSize),
              ]),
            );
            runCursor = runs.next;
            channelCursor = deleting.next;
            let idle = !runs.next && !deleting.next;
            for (const target of runs.runs) {
              if (stopped) break;
              await tenantStorage.run(
                { tenantId: target.tenantId === '_' ? undefined : target.tenantId },
                async () => {
                  try {
                    const run = await deps.storage.read(
                      target.tenantId,
                      target.channelId,
                      target.runId,
                    );
                    if (!run) return;
                    const channel = await deps.channels.getAgentChannelMetadata(target.channelId);
                    if (
                      config.enabled &&
                      channel &&
                      (await hasChannelRunAuthority(channel, run, deps.resolvePrincipal)) &&
                      (await deps.isCredentialCurrent(run))
                    )
                      return;
                    const claimed = await deps.storage.claimAuthorityLost(
                      run,
                      owner,
                      now(),
                      config.leaseMs,
                    );
                    if (!claimed) return;
                    idle = false;
                    if ((await deps.retireForAuthorityLoss(claimed)) !== 'stopped') return;
                    await deps.storage.finishAuthorityLost(
                      claimed.tenantId,
                      {
                        runId: claimed.runId,
                        owner,
                        epoch: claimed.leaseEpoch,
                      },
                      now(),
                    );
                  } catch (error) {
                    idle = false;
                    deps.onError(error);
                  }
                },
              );
            }
            for (const target of deleting.channels) {
              if (stopped) break;
              await tenantStorage.run({ tenantId: target.tenantId || undefined }, async () => {
                try {
                  const channel = await deps.channels.getAgentChannelMetadata(target.channelId);
                  if (channel?.status !== 'deleting') return;
                  if (channel.apiKeyId)
                    await deps.deleteApiKey(channel.apiKeyId, channel.createdBy);
                  const result = await deps.channels.deleteAgentChannel(
                    channel.channelId,
                    channel.createdBy,
                  );
                  if (result.status !== 'not_found') idle = false;
                } catch (error) {
                  idle = false;
                  deps.onError(error);
                }
              });
            }
            return idle;
          },
        });
        await worker.start();
        if (stopped) await worker.stop();
      })();
      return initialization;
    },
    wake(): void {
      worker?.wake();
    },
    async stop(): Promise<void> {
      stopped = true;
      try {
        await initialization;
      } catch {
        /* Failed initialization has no running worker. */
      }
      await worker?.stop();
    },
  };
}
