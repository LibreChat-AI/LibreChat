import { setTimeout as delay } from 'node:timers/promises';
import type { DiscordChannelConfig } from 'librechat-data-provider';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DiscordGatewayOwner } from './gateway';
import type { SharedGatewayConfig } from '../config';
import type { Logger } from '../types';
import { DiscordReplyClient, deliverDiscordReply } from './reply';
import { DiscordGatewayControlClient } from './ownership';
import { createDiscordWorkerProvider } from './worker';
import { withDiscordApplicationLease } from './lease';
import { DiscordRuntimeClient } from './discovery';
import { DiscordRateCoordinator } from './rates';
import { DiscordControlClient } from './control';
import { runDiscordApplications } from './pool';
import { createDiscordWebhook } from './http';
import { ChannelWorker } from '../worker';
import { ChannelClient } from '../client';
import { DiscordClient } from './client';

interface OwnedApplication {
  owner: DiscordGatewayOwner;
  signal: AbortSignal;
  rates: DiscordRateCoordinator;
  tasks: Set<Promise<void>>;
}
const untilAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

/** Shared signed ingress plus one globally bounded worker pool over application-owned REST clients. */
export class DiscordGatewayApp {
  ready = false;
  private ownersHealthy = false;
  private workersHealthy = false;
  private readinessReported = false;
  private readonly active = new Map<string, OwnedApplication>();
  private readonly control: DiscordControlClient;
  private readonly runtime: DiscordRuntimeClient;
  private readonly ownership: DiscordGatewayControlClient;
  private readonly ingress: ReturnType<typeof createDiscordWebhook>;

  constructor(
    private readonly config: SharedGatewayConfig,
    private readonly policy: DiscordChannelConfig,
    private readonly log: Logger,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.control = new DiscordControlClient(config, transport);
    this.runtime = new DiscordRuntimeClient(config, transport);
    this.ownership = new DiscordGatewayControlClient(config, transport);
    this.ingress = createDiscordWebhook({
      policy,
      capacity: policy.gateway.ingressConcurrency,
      ready: () => this.ready && this.ownersHealthy && this.workersHealthy,
      security: (id, signal) => this.control.security(id, signal),
      submit: (input, signal) => this.control.submit(input, signal),
      log,
    });
  }

  http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    return this.ingress.http(request, response);
  }

  private reportReadiness(): void {
    const ready = this.ready && this.ownersHealthy && this.workersHealthy;
    if (ready && !this.readinessReported) this.log.info('discord_gateway_ready');
    this.readinessReported = ready;
  }

  private async own(owner: DiscordGatewayOwner, signal: AbortSignal): Promise<void> {
    await withDiscordApplicationLease(
      {
        owner,
        leaseMs: this.policy.gateway.ownershipLeaseMs,
        ownership: this.ownership,
        log: this.log,
      },
      async (ownedSignal) => {
        const context: OwnedApplication = {
          owner,
          signal: ownedSignal,
          rates: new DiscordRateCoordinator(this.policy.rateLimits),
          tasks: new Set(),
        };
        this.active.set(owner.applicationId, context);
        try {
          await untilAbort(ownedSignal);
        } finally {
          this.active.delete(owner.applicationId);
          await Promise.allSettled([...context.tasks]);
        }
      },
      signal,
    );
  }

  private async task(context: OwnedApplication, work: () => Promise<void>): Promise<void> {
    if (context.signal.aborted) return;
    const task = work().catch(() => {
      if (!context.signal.aborted) this.log.warn('discord_application_work_unavailable');
    });
    context.tasks.add(task);
    try {
      await task;
    } finally {
      context.tasks.delete(task);
    }
  }

  private async workers(signal: AbortSignal): Promise<void> {
    let cursor: string | undefined;
    while (!signal.aborted) {
      try {
        const page = await this.runtime.channels(cursor, signal);
        signal.throwIfAborted();
        if (page.next !== undefined && page.next === cursor)
          throw new Error('Discord channel cursor did not advance');
        cursor = page.next;
        this.workersHealthy = true;
        this.reportReadiness();
        const tasks: (() => Promise<void>)[] = [];
        for (const context of this.active.values()) {
          tasks.push(() =>
            this.task(context, async () => {
              await deliverDiscordReply(
                {
                  applicationId: context.owner.applicationId,
                  owner: context.owner.ownerId,
                  control: this.control,
                  reply: new DiscordReplyClient(
                    {
                      timeoutMs: this.policy.requestTimeoutMs,
                      maxResponseBytes: this.policy.maxResponseBytes,
                    },
                    this.transport,
                    context.rates,
                  ),
                  retryDelayMs: this.policy.inbox.retryDelayMs,
                },
                context.signal,
              );
            }),
          );
        }
        for (const row of page.channels) {
          const context = this.active.get(row.applicationId);
          if (!context || context.owner.applicationRevision !== row.applicationRevision) continue;
          tasks.push(() =>
            this.task(context, async () => {
              const config = {
                ...this.config,
                CHANNEL_TENANT_ID: row.tenantId,
                CHANNEL_ID: row.channelId,
              };
              const provider = createDiscordWorkerProvider({
                rates: context.rates,
                createClient: (bundle, rates) =>
                  new DiscordClient(
                    {
                      botToken: bundle.credentials.botToken,
                      timeoutMs: bundle.discord.requestTimeoutMs,
                      maxResponseBytes: bundle.discord.maxResponseBytes,
                    },
                    this.transport,
                    rates,
                  ),
              });
              await new ChannelWorker(
                config,
                new ChannelClient(config, this.transport, {
                  type: 'discord',
                  applicationRevision: row.applicationRevision,
                }),
                provider,
                this.log,
              ).tick(context.signal);
            }),
          );
        }
        let next = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(this.policy.gateway.workerConcurrency, tasks.length) },
            async () => {
              while (!signal.aborted && next < tasks.length) await tasks[next++]();
            },
          ),
        );
      } catch {
        this.workersHealthy = false;
        this.reportReadiness();
        if (!signal.aborted) this.log.warn('discord_worker_discovery_unavailable');
      }
      await delay(this.policy.gateway.pollIntervalMs, undefined, { signal }).catch(() => {});
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    const tasks = [
      runDiscordApplications(
        {
          policy: this.policy.gateway,
          log: this.log,
          discover: async (cursor, discoverySignal) => {
            try {
              const page = await this.runtime.applications(cursor, discoverySignal);
              this.ownersHealthy = true;
              this.reportReadiness();
              return page;
            } catch (error) {
              this.ownersHealthy = false;
              this.reportReadiness();
              throw error;
            }
          },
          start: (owner, ownedSignal) => this.own(owner, ownedSignal),
        },
        combined,
      ),
      this.workers(combined),
    ];
    try {
      await Promise.all(tasks);
    } finally {
      this.ready = false;
      controller.abort();
      await Promise.allSettled(tasks);
    }
  }
}
