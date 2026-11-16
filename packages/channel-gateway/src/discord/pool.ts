import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import type { DiscordChannelConfig } from 'librechat-data-provider';
import type { DiscordGatewayOwner } from './gateway';
import type { Logger } from '../types';
import { DiscordGatewayFailure } from './recovery';

interface RecoveryState {
  revision: string;
  fatalFailures: number;
  transientFailures: number;
  until: number;
  seenRound: number;
}

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
    policy: Pick<DiscordChannelConfig['gateway'], 'maxApplications' | 'pollIntervalMs'> &
      Partial<Pick<DiscordChannelConfig['gateway'], 'recovery'>>;
    now?: () => number;
    random?: () => number;
    log: Logger;
  },
  signal: AbortSignal,
): Promise<void> {
  const policy = discordChannelConfigSchema.parse({ gateway: deps.policy }).gateway;
  const active = new Map<string, RunningApplication>();
  const recovery = new Map<string, RecoveryState>();
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
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
          let state = recovery.get(application.applicationId);
          if (state?.revision === application.applicationRevision) state.seenRound = round;
          const previous = active.get(application.applicationId);
          if (previous?.revision === application.applicationRevision) continue;
          if (previous) {
            previous.controller.abort();
            await previous.task;
          }
          if (state?.revision !== application.applicationRevision) {
            recovery.delete(application.applicationId);
            state = undefined;
          }
          if (state && state.until > now()) continue;
          if (
            active.size >= policy.maxApplications ||
            (!state && recovery.size >= policy.recovery.maxTrackedApplications)
          ) {
            capacity = true;
            continue;
          }
          const tracked = state ?? {
            revision: application.applicationRevision,
            fatalFailures: 0,
            transientFailures: 0,
            until: 0,
            seenRound: round,
          };
          recovery.set(application.applicationId, tracked);
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
            .then(() => {
              if (recovery.get(application.applicationId) === tracked)
                recovery.delete(application.applicationId);
            })
            .catch((error: unknown) => {
              if (signal.aborted || controller.signal.aborted) {
                if (recovery.get(application.applicationId) === tracked)
                  recovery.delete(application.applicationId);
                return;
              }
              const failure = error instanceof DiscordGatewayFailure ? error : undefined;
              if (failure && failure.healthyForMs >= policy.recovery.resetAfterMs) {
                tracked.fatalFailures = 0;
                tracked.transientFailures = 0;
              }
              const fatal = failure?.fatal === true;
              const count = fatal
                ? (tracked.fatalFailures = Math.min(31, tracked.fatalFailures + 1))
                : (tracked.transientFailures = Math.min(31, tracked.transientFailures + 1));
              const base = fatal ? policy.recovery.fatalRetryMinMs : policy.pollIntervalMs;
              const cap = fatal ? policy.recovery.fatalRetryMaxMs : policy.recovery.retryMaxMs;
              const wait = Math.min(cap, base * 2 ** (count - 1));
              const sample = random();
              const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 1;
              tracked.until =
                now() + (fatal ? wait : Math.max(1, Math.round(wait * (0.5 + jitter / 2))));
              deps.log.warn(
                fatal
                  ? 'discord_application_quarantined'
                  : 'discord_application_runtime_unavailable',
              );
            })
            .finally(() => {
              if (active.get(application.applicationId) === running)
                active.delete(application.applicationId);
            });
        }
        // Only a completed discovery scan can evict absent applications. Failed pages are not proof.
        if (cursor === undefined)
          for (const [id, state] of recovery)
            if (state.seenRound !== round && !active.has(id)) recovery.delete(id);
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
    recovery.clear();
  }
}
