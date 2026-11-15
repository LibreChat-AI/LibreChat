import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordChannelConfig } from 'librechat-data-provider';
import type { DiscordGatewayOwner } from './gateway';
import type { Logger } from '../types';

type Application = Pick<DiscordGatewayOwner, 'applicationId' | 'applicationRevision'>;
interface RunningApplication {
  revision: string;
  controller: AbortController;
  task: Promise<void>;
}

/** Bounded resident ownership, including applications with no active channel jobs.
 * Losing contenders finish promptly so subsequent discovery pages can use the available slots. */
export async function runDiscordApplications(
  deps: {
    discover: (
      cursor: string | undefined,
      signal: AbortSignal,
    ) => Promise<{ applications: Application[]; next?: string }>;
    start: (owner: DiscordGatewayOwner, signal: AbortSignal) => Promise<void>;
    policy: Pick<DiscordChannelConfig['gateway'], 'maxApplications' | 'pollIntervalMs'>;
    log: Logger;
  },
  signal: AbortSignal,
): Promise<void> {
  const policy = discordChannelConfigSchema.parse({ gateway: deps.policy }).gateway;
  const active = new Map<string, RunningApplication>();
  let cursor: string | undefined;
  let capacityReported = false;
  let round = -1;
  try {
    while (!signal.aborted) {
      try {
        if (cursor === undefined) round++;
        const page = await deps.discover(cursor, signal);
        signal.throwIfAborted();
        if (page.next !== undefined && page.next === cursor)
          throw new Error('Discord discovery cursor did not advance');
        cursor = page.next;
        let capacity = false;
        // Rotate each complete scan so a busy first candidate cannot starve later applications.
        for (let index = 0; index < page.applications.length; index++) {
          const application = page.applications[(index + round) % page.applications.length];
          if (signal.aborted) break;
          const previous = active.get(application.applicationId);
          if (previous?.revision === application.applicationRevision) continue;
          if (previous) {
            previous.controller.abort();
            await previous.task;
          }
          if (active.size >= policy.maxApplications) {
            capacity = true;
            continue;
          }
          const controller = new AbortController();
          const owner = {
            applicationId: application.applicationId,
            applicationRevision: application.applicationRevision,
            ownerId: randomBytes(16).toString('hex'),
          };
          const running: RunningApplication = {
            revision: application.applicationRevision,
            controller,
            task: Promise.resolve(),
          };
          active.set(application.applicationId, running);
          running.task = Promise.resolve()
            .then(() => deps.start(owner, AbortSignal.any([controller.signal, signal])))
            .catch(() => {
              if (!signal.aborted && !controller.signal.aborted)
                deps.log.warn('discord_application_runtime_unavailable');
            })
            .finally(() => {
              if (active.get(application.applicationId) === running)
                active.delete(application.applicationId);
            });
        }
        if (capacity && !capacityReported) deps.log.warn('discord_application_capacity_exhausted');
        capacityReported = capacity;
      } catch {
        if (!signal.aborted) deps.log.warn('discord_application_discovery_unavailable');
      }
      await delay(policy.pollIntervalMs, undefined, { signal }).catch(() => {});
    }
  } finally {
    for (const running of active.values()) running.controller.abort();
    await Promise.allSettled([...active.values()].map((running) => running.task));
  }
}
