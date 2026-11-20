import { setTimeout as delay } from 'node:timers/promises';
import type { DiscordChannelConfig, DiscordInboxResolution } from 'librechat-data-provider';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DiscordApplicationObserver, DiscordObserver, DiscordTelemetry } from './observe';
import type { DiscordGatewayOwner, DiscordGatewayDependencies } from './gateway';
import type { DiscordHealthSnapshot } from './health';
import type { SharedGatewayConfig } from '../config';
import type { DiscordRetryState } from './recovery';
import type { WorkerProvider } from '../provider';
import type { Logger } from '../types';
import { observeDiscordProvider, safeDiscordObserver, noopDiscordTelemetry } from './observe';
import { DiscordReplyClient, deliverDiscordReply } from './reply';
import { DiscordGatewayControlClient } from './ownership';
import { DiscordCredentialReporter } from './credentials';
import { ChannelWorker, recoveryEvent } from '../worker';
import { createDiscordWorkerProvider } from './worker';
import { withDiscordApplicationLease } from './lease';
import { createDiscordGatewayDriver } from './socket';
import { DiscordRuntimeClient } from './discovery';
import { dispatchDiscordEvent } from './dispatch';
import { DiscordRateCoordinator } from './rates';
import { DiscordControlClient } from './control';
import { runDiscordApplications } from './pool';
import { discordRetryDelay } from './recovery';
import { runDiscordSession } from './session';
import { createDiscordWebhook } from './http';
import { ChannelClient } from '../client';
import { DiscordClient } from './client';

interface OwnedApplication {
  owner: DiscordGatewayOwner;
  signal: AbortSignal;
  rates: DiscordRateCoordinator;
  observe: DiscordApplicationObserver;
  tasks: Set<Promise<void>>;
}
/** Optional telemetry and the private health read it feeds. Without it the app reports nothing. */
export interface DiscordObservability {
  telemetry: DiscordTelemetry;
  health: { snapshot(): DiscordHealthSnapshot };
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
  private readonly telemetry: DiscordTelemetry;
  private readonly observe: DiscordObserver;

  constructor(
    private readonly config: SharedGatewayConfig,
    private readonly policy: DiscordChannelConfig,
    private readonly log: Logger,
    private readonly transport: typeof fetch = fetch,
    private readonly createDriver?: DiscordGatewayDependencies['createDriver'],
    private readonly observability?: DiscordObservability,
  ) {
    this.telemetry = observability?.telemetry ?? noopDiscordTelemetry;
    this.observe = safeDiscordObserver(this.telemetry.observe);
    this.control = new DiscordControlClient(config, transport);
    this.runtime = new DiscordRuntimeClient(config, transport);
    this.ownership = new DiscordGatewayControlClient(config, transport);
    this.ingress = createDiscordWebhook({
      policy,
      capacity: policy.gateway.ingressConcurrency,
      ready: () => this.ready && this.ownersHealthy && this.workersHealthy,
      security: (id, signal) => this.control.security(id, signal),
      submit: (input, signal) => this.control.submit(input, signal),
      submitDm: (input, signal) => this.control.submitDm(input, signal),
      select: (input, signal) => this.control.select(input, signal),
      observe: this.observe,
      log,
    });
  }

  http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const health = this.observability?.health;
    if (health && request.method === 'GET' && request.url?.split('?')[0] === '/healthz/detail') {
      this.detail(response, health);
      return Promise.resolve();
    }
    return this.ingress.http(request, response);
  }

  /**
   * Private aggregate health, served beside /metrics and never routed publicly. It names no
   * application, channel, user or credential, and it never changes readiness: `status` only
   * repeats what /readyz answers.
   */
  private detail(response: ServerResponse, health: DiscordObservability['health']): void {
    const { applications, quarantined, workers, credentials, permissions, native } =
      health.snapshot();
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      JSON.stringify({
        status: this.ready && this.ownersHealthy && this.workersHealthy ? 'ready' : 'not_ready',
        process: {
          level: this.ready ? 'healthy' : 'degraded',
          uptimeSeconds: Math.floor(process.uptime()),
        },
        workers: { level: workers },
        applications,
        quarantined,
        credentials,
        permissions,
        native,
      }),
    );
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
        // The health entry lives exactly as long as this lease: released with it, replaced by a new owner.
        const scope = this.scope(owner);
        const credentials = new DiscordCredentialReporter({
          owner,
          intervalMs: this.policy.health.observationTtlMs,
          retryMs: this.policy.health.observationRetryMs,
          write: (authority, state, sequence) =>
            this.ownership.observeCredentials(authority, state, sequence),
        });
        const metrics = safeDiscordObserver(scope.observe);
        const observe: DiscordApplicationObserver = (observation) => {
          credentials.observe(observation);
          metrics(observation);
        };
        const context: OwnedApplication = {
          owner,
          signal: ownedSignal,
          rates: new DiscordRateCoordinator(this.policy.rateLimits, observe),
          observe,
          tasks: new Set(),
        };
        this.active.set(owner.applicationId, context);
        try {
          if (this.policy.gateway.enabled) await this.sessions(context, ownedSignal);
          else await untilAbort(ownedSignal);
        } finally {
          this.active.delete(owner.applicationId);
          try {
            await Promise.allSettled([...context.tasks]);
          } finally {
            try {
              await credentials.close();
            } finally {
              scope.release();
            }
          }
        }
      },
      signal,
    );
  }

  private scope(owner: DiscordGatewayOwner): ReturnType<DiscordTelemetry['application']> {
    const shards = this.policy.gateway.enabled ? this.policy.gateway.shardCount : 0;
    try {
      const scope = this.telemetry.application(owner, { shards });
      return {
        observe: scope.observe,
        release: () => {
          try {
            scope.release();
          } catch {
            // Telemetry cannot fail the lease teardown that releases it.
          }
        },
      };
    } catch {
      return noopDiscordTelemetry.application(owner, { shards });
    }
  }

  /**
   * A failed session only delays the next session. The lease and the REST workers (replies, inbox
   * claims and delivery) stay with the application, so a Gateway that cannot connect never stops
   * signed slash commands from being answered. A new revision is a new owner and starts at once.
   */
  private async sessions(context: OwnedApplication, signal: AbortSignal): Promise<void> {
    const { owner } = context;
    const retry: DiscordRetryState = { fatalFailures: 0, transientFailures: 0 };
    while (!signal.aborted) {
      try {
        await runDiscordSession(
          {
            owner,
            policy: this.policy,
            ownership: this.ownership,
            createDriver:
              this.createDriver ??
              ((options) => createDiscordGatewayDriver(options, this.transport, context.rates)),
            log: this.log,
            observe: context.observe,
            dispatch: (application, event, dispatchSignal) =>
              dispatchDiscordEvent(
                {
                  owner,
                  application,
                  policy: this.policy,
                  rates: context.rates,
                  runtime: this.runtime,
                  gateway: this.ownership,
                  transport: this.transport,
                  observe: context.observe,
                },
                event,
                dispatchSignal,
              ),
          },
          signal,
        );
        return;
      } catch (error) {
        if (signal.aborted) return;
        const { fatal, waitMs } = discordRetryDelay(retry, error, this.policy.gateway);
        this.log.warn(
          fatal ? 'discord_application_quarantined' : 'discord_application_runtime_unavailable',
        );
        await delay(waitMs, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  private async task(
    context: OwnedApplication,
    work: () => Promise<void>,
    recover: (error: unknown) => string = (error) => recoveryEvent(error),
  ): Promise<void> {
    if (context.signal.aborted) return;
    const task = work().then(
      () => this.observe({ type: 'task', ok: true }),
      (error: unknown) => {
        // An abort ends the work on purpose, so it is neither a failure nor a recovery.
        if (context.signal.aborted) return;
        this.log.warn('discord_application_work_unavailable');
        this.observe({ type: 'task', ok: false });
        let event = 'other';
        try {
          event = recover(error);
        } catch {
          // An unclassifiable failure is still counted, as other.
        }
        this.observe({ type: 'recovery', event });
      },
    );
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
        this.observe({ type: 'discovery', source: 'channels', ok: true });
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
                  inspect: async (job, inspectionSignal) => {
                    const application = await this.ownership.bootstrap(
                      context.owner,
                      inspectionSignal,
                    );
                    if (!application) return null;
                    const current = new DiscordClient(
                      {
                        botToken: application.botToken,
                        timeoutMs: this.policy.requestTimeoutMs,
                        maxResponseBytes: this.policy.maxResponseBytes,
                        observe: context.observe,
                      },
                      this.transport,
                      context.rates,
                    );
                    let source: DiscordInboxResolution['source'] =
                      await current.inspectGuildTextActorSource(
                        {
                          applicationId: context.owner.applicationId,
                          botUserId: application.botUserId,
                          guildId: job.inspection.guildId,
                          channelId: job.inspection.externalChannelId,
                          authorId: job.inspection.externalUserId,
                        },
                        inspectionSignal,
                      );
                    if (!source && job.inspection.scope !== 'dm')
                      source = await current.inspectGuildThreadSource(
                        {
                          applicationId: context.owner.applicationId,
                          botUserId: application.botUserId,
                          guildId: job.inspection.guildId,
                          threadChannelId: job.inspection.externalChannelId,
                          authorId: job.inspection.externalUserId,
                        },
                        inspectionSignal,
                      );
                    return this.control.resolve(
                      { fence: job.fence, owner: context.owner, source },
                      inspectionSignal,
                    );
                  },
                },
                context.signal,
              );
            }),
          );
        }
        for (const row of page.channels) {
          const context = this.active.get(row.applicationId);
          if (!context || context.owner.applicationRevision !== row.applicationRevision) continue;
          tasks.push(() => {
            let classify: WorkerProvider['recoveryEvent'] | undefined;
            return this.task(
              context,
              async () => {
                const config = {
                  ...this.config,
                  CHANNEL_TENANT_ID: row.tenantId,
                  CHANNEL_ID: row.channelId,
                };
                const provider = observeDiscordProvider(
                  createDiscordWorkerProvider({
                    owner: context.owner,
                    rates: context.rates,
                    createClient: (bundle, rates) =>
                      new DiscordClient(
                        {
                          botToken: bundle.credentials.botToken,
                          timeoutMs: bundle.discord.requestTimeoutMs,
                          maxResponseBytes: bundle.discord.maxResponseBytes,
                          observe: context.observe,
                        },
                        this.transport,
                        rates,
                      ),
                  }),
                  this.observe,
                );
                classify = (failure) => provider.recoveryEvent(failure);
                try {
                  const worked = await new ChannelWorker(
                    config,
                    new ChannelClient(config, this.transport, {
                      type: 'discord',
                      applicationRevision: row.applicationRevision,
                    }),
                    provider,
                    this.log,
                  ).tick(context.signal);
                  this.observe({ type: 'turn', outcome: worked ? 'worked' : 'idle' });
                } catch (error) {
                  if (!context.signal.aborted) this.observe({ type: 'turn', outcome: 'held' });
                  throw error;
                }
              },
              (error) => recoveryEvent(error, classify),
            );
          });
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
        if (!signal.aborted) {
          this.log.warn('discord_worker_discovery_unavailable');
          this.observe({ type: 'discovery', source: 'channels', ok: false });
        }
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
              this.observe({ type: 'discovery', source: 'applications', ok: true });
              return page;
            } catch (error) {
              this.ownersHealthy = false;
              this.reportReadiness();
              if (!discoverySignal.aborted)
                this.observe({ type: 'discovery', source: 'applications', ok: false });
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
