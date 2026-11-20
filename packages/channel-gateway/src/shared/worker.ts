import { setTimeout as delay } from 'node:timers/promises';
import type { SharedGatewayConfig } from '../config';
import type { Logger } from '../types';
import { ChannelWorker, recoveryEvent } from '../worker';
import { resolveGatewayConfig } from '../config';
import { WorkspaceClient } from './client';
import { ChannelClient } from '../client';
import { SlackClient } from '../slack';

/** Fixed-size turns over durable discovery; no resident process or queue per installation. */
export async function runSharedWorkers(
  config: SharedGatewayConfig,
  client: WorkspaceClient,
  log: Logger,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<void> {
  const slack = new SlackClient(config, log);
  while (!signal.aborted) {
    let wait = 1000;
    try {
      const settings = await client.bootstrap(signal);
      wait = settings.workers.pollIntervalMs;
      const rows = await client.discover(settings.workers.discoveryBatchSize, signal);
      let cursor = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(settings.workers.workerConcurrency, rows.length) },
          async () => {
            while (!signal.aborted && cursor < rows.length) {
              const row = rows[cursor++];
              const scoped = resolveGatewayConfig(
                { ...config, CHANNEL_TENANT_ID: row.tenantId, CHANNEL_ID: row.channelId },
                settings.gateway,
              );
              try {
                await new ChannelWorker(
                  scoped,
                  new ChannelClient(scoped, transport),
                  slack,
                  log,
                ).tick(signal);
              } catch (error) {
                if (!signal.aborted) log.warn(recoveryEvent(error));
              }
            }
          },
        ),
      );
    } catch (error) {
      if (!signal.aborted) log.warn(recoveryEvent(error));
    }
    await delay(wait, undefined, { signal }).catch(() => {});
  }
}
