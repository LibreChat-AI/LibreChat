import { Counter, Gauge, Histogram } from 'prom-client';
import type { ChannelRunView } from 'librechat-data-provider';
import type { Registry } from 'prom-client';
import type { DiscordDiscoverySource, DiscordHealth, DiscordHealthEntry } from './health';
import type { DiscordRateObservation, DiscordRateRejection } from './rates';
import type { DiscordGatewayOwner } from './gateway';
import type { WorkerProvider } from '../provider';
import { discordHealthConcerns, discordHealthLevels } from './health';

/**
 * Closed label vocabularies. A runtime value outside its list is recorded as `other`, so no
 * caller can create a series, and none carries an identifier, content, error text or raw route.
 */
export const discordIngressOutcomes = [
  'ping',
  'accepted',
  'conflict',
  'capacity',
  'bad_signature',
  'bad_payload',
  'bad_context',
  'unsupported',
  'too_large',
  'at_capacity',
  'deadline',
  'unavailable',
  'not_found',
] as const;
export const discordRestRoutes = [
  'message_create',
  'message_edit',
  'message_delete',
  'channel_read',
  'permissions_read',
  'thread_read',
  'member_read',
  'guild_read',
  'gateway_bot',
  'interaction_reply',
  'other',
] as const;
export const discordRestStatuses = [
  '2xx',
  '401',
  '403',
  '404',
  '429',
  '4xx',
  '5xx',
  'network',
  'other',
] as const;
export const discordRateRejections = [
  'queue_full',
  'queue_timeout',
  'capacity',
] as const satisfies readonly DiscordRateRejection[];
export const discordDeliveryKinds = ['progress', 'answer', 'trace', 'cleanup'] as const;
export const discordDeliveryOutcomes = [
  'confirmed',
  'retryable',
  'permanent',
  'uncertain',
] as const;
export const discordRunPhases = ['started', 'delivered', 'failed', 'cancelled'] as const;
export const discordTurnOutcomes = ['idle', 'worked', 'held'] as const;
export const discordRecoveryEvents = [
  'channel_storage_transactions_required',
  'channel_service_authentication_failed',
  'channel_service_authority_unavailable',
  'channel_binding_unavailable',
  'channel_state_requires_reconciliation',
  'channel_service_rate_limited',
  'channel_service_unavailable',
  'channel_operation_timed_out',
  'channel_run_held_for_recovery',
  'discord_write_rejected',
  'discord_write_deferred',
  'discord_write_outcome_unconfirmed',
  'other',
] as const;
export const discordSessionEvents = [
  'ready',
  'resumed',
  'closed_transient',
  'closed_fatal',
  'gap',
  'error',
] as const;
export const discordStopReasons = [
  'shutdown',
  'lost',
  'credentials',
  'configuration',
  'identity',
  'startup',
  'checkpoint',
  'failed',
  'backpressure',
  'dispatch',
] as const;

export type DiscordIngressOutcome = (typeof discordIngressOutcomes)[number];
export type DiscordRestRoute = (typeof discordRestRoutes)[number];
export type DiscordRestStatus = (typeof discordRestStatuses)[number];
export type DiscordDeliveryKind = (typeof discordDeliveryKinds)[number];
export type DiscordDeliveryOutcome = (typeof discordDeliveryOutcomes)[number];
export type DiscordRunPhase = (typeof discordRunPhases)[number];
export type DiscordTurnOutcome = (typeof discordTurnOutcomes)[number];
export type DiscordSessionEvent = (typeof discordSessionEvents)[number];
export type DiscordStopReason = (typeof discordStopReasons)[number];

/** Facts that belong to the process, not to one owned application. */
export type DiscordObservation =
  | { type: 'ingress'; outcome: DiscordIngressOutcome }
  | { type: 'ack'; durationMs: number }
  | { type: 'discovery'; source: DiscordDiscoverySource; ok: boolean }
  | { type: 'task'; ok: boolean }
  | { type: 'turn'; outcome: DiscordTurnOutcome }
  /** `recoveryEvent()` returns an open string, so the adapter closes it. */
  | { type: 'recovery'; event: string }
  | { type: 'delivery'; kind: DiscordDeliveryKind; outcome: DiscordDeliveryOutcome }
  | { type: 'run'; phase: DiscordRunPhase };

/** Facts that belong to one owned application. They update its metrics and its health together. */
export type DiscordApplicationObservation =
  | DiscordRateObservation
  /** A bot only inspection. Actor denials are per user and are never reported here. */
  | { type: 'permission'; outcome: 'ok' | 'denied' }
  | { type: 'session'; event: 'error' }
  | { type: 'session'; event: Exclude<DiscordSessionEvent, 'error'>; shardId: number }
  | { type: 'heartbeat'; shardId: number; latencyMs: number }
  | { type: 'stop'; reason: DiscordStopReason };

export type DiscordObserver = (observation: DiscordObservation) => void;
export type DiscordApplicationObserver = (observation: DiscordApplicationObservation) => void;

export interface DiscordApplicationScope {
  observe: DiscordApplicationObserver;
  /** Ends this application's health state. Later observations still count metrics only. */
  release(): void;
}
export interface DiscordTelemetry {
  observe: DiscordObserver;
  /** `shards` is the Gateway shard count, or zero when the Gateway is disabled. */
  application(owner: DiscordGatewayOwner, options: { shards: number }): DiscordApplicationScope;
}

export const noopDiscordTelemetry: DiscordTelemetry = {
  observe: () => undefined,
  application: () => ({ observe: () => undefined, release: () => undefined }),
};

/** Telemetry must never change what it observes, so a throwing sink is ignored. */
export function safeDiscordObserver<T>(
  observer?: (observation: T) => void,
): (observation: T) => void {
  return (observation) => {
    try {
      observer?.(observation);
    } catch {
      // An optional metrics sink cannot fail a request, a lease or a delivery.
    }
  };
}

const label = <T extends string>(allowed: readonly T[], value: unknown): T | 'other' =>
  allowed.find((candidate) => candidate === value) ?? 'other';
const validDuration = (milliseconds: number): boolean =>
  Number.isFinite(milliseconds) && milliseconds >= 0;

/** Exact templates built by `DiscordClient`, `DiscordReplyClient`, thread inspection and the SDK REST. */
const restRoutes = new Map<string, DiscordRestRoute>([
  ['POST /channels/:id/messages', 'message_create'],
  ['PATCH /channels/:id/messages/:id', 'message_edit'],
  ['DELETE /channels/:id/messages/:id', 'message_delete'],
  ['GET /channels/:id', 'channel_read'],
  ['GET /channels/:id/permissions/member/:id', 'permissions_read'],
  ['GET /channels/:id/thread-members/:id', 'thread_read'],
  ['GET /guilds/:id/members/:id', 'member_read'],
  ['GET /guilds/:id', 'guild_read'],
  ['GET /gateway/bot', 'gateway_bot'],
  ['PATCH /webhooks/:id/:token/messages/@original', 'interaction_reply'],
]);
/** Everything except `interaction_reply`, which is authorized by the interaction token. */
const botRoutes: ReadonlySet<DiscordRestRoute> = new Set([
  'message_create',
  'message_edit',
  'message_delete',
  'channel_read',
  'permissions_read',
  'thread_read',
  'member_read',
  'guild_read',
  'gateway_bot',
]);
const writeRoutes: ReadonlySet<DiscordRestRoute> = new Set(['message_create', 'message_edit']);

export function discordRestRoute(route: string): DiscordRestRoute {
  return restRoutes.get(route) ?? 'other';
}

export function discordRestStatus(status: number | undefined): DiscordRestStatus {
  if (status === undefined) return 'network';
  if (!Number.isInteger(status) || status < 200 || status > 599) return 'other';
  if (status < 300) return '2xx';
  if (status === 401) return '401';
  if (status === 403) return '403';
  if (status === 404) return '404';
  if (status === 429) return '429';
  if (status < 400) return 'other';
  return status < 500 ? '4xx' : '5xx';
}

const prefix = 'channel_gateway_discord_';

/**
 * Builds the Prometheus adapter on the caller's registry, never a global one. Each observation
 * updates metrics and health in the same call, so the two cannot disagree.
 */
export function createDiscordTelemetry(options: {
  registry: Registry;
  health: DiscordHealth;
}): DiscordTelemetry {
  const { registry, health } = options;
  const registers = [registry];
  const ingress = new Counter({
    name: `${prefix}ingress_total`,
    help: 'Discord signed ingress requests by bounded outcome',
    labelNames: ['outcome'] as const,
    registers,
  });
  const ack = new Histogram({
    name: `${prefix}ack_seconds`,
    help: 'Time from a matched Discord ingress route to its single response write',
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3],
    registers,
  });
  const rest = new Counter({
    name: `${prefix}rest_total`,
    help: 'Discord REST requests by route group and status class',
    labelNames: ['route', 'status'] as const,
    registers,
  });
  const rejected = new Counter({
    name: `${prefix}rest_queue_rejected_total`,
    help: 'Discord REST requests the local rate queue refused to start',
    labelNames: ['reason'] as const,
    registers,
  });
  const delivery = new Counter({
    name: `${prefix}delivery_total`,
    help: 'Discord delivery attempts by kind and provider classified outcome',
    labelNames: ['kind', 'outcome'] as const,
    registers,
  });
  const runs = new Counter({
    name: `${prefix}run_total`,
    help: 'Discord run lifecycle transitions seen by the worker',
    labelNames: ['phase'] as const,
    registers,
  });
  const turns = new Counter({
    name: `${prefix}turn_total`,
    help: 'Discord channel worker turns by outcome',
    labelNames: ['outcome'] as const,
    registers,
  });
  const recoveries = new Counter({
    name: `${prefix}recovery_total`,
    help: 'Discord work recoveries by bounded event',
    labelNames: ['event'] as const,
    registers,
  });
  const sessions = new Counter({
    name: `${prefix}gateway_session_total`,
    help: 'Discord Gateway session events',
    labelNames: ['event'] as const,
    registers,
  });
  const stops = new Counter({
    name: `${prefix}gateway_stop_total`,
    help: 'Discord Gateway stops by reason',
    labelNames: ['reason'] as const,
    registers,
  });
  const heartbeats = new Histogram({
    name: `${prefix}heartbeat_seconds`,
    help: 'Discord Gateway heartbeat acknowledgement latency',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers,
  });
  const read = () => {
    try {
      return health.snapshot();
    } catch {
      return undefined;
    }
  };
  new Gauge({
    name: `${prefix}health`,
    help: 'Applications per Discord health concern and level; workers is one process entity',
    labelNames: ['concern', 'level'] as const,
    registers,
    collect() {
      const snapshot = read();
      if (!snapshot) return;
      for (const concern of discordHealthConcerns)
        for (const level of discordHealthLevels)
          this.set(
            { concern, level },
            concern === 'workers' ? Number(snapshot.workers === level) : snapshot[concern][level],
          );
    },
  });
  new Gauge({
    name: `${prefix}applications_owned`,
    help: 'Discord applications whose lease this replica holds',
    registers,
    collect() {
      const snapshot = read();
      if (snapshot) this.set(snapshot.applications);
    },
  });
  new Gauge({
    name: `${prefix}applications_quarantined`,
    help: 'Discord applications held out of restart after a fatal Gateway stop',
    registers,
    collect() {
      const snapshot = read();
      if (snapshot) this.set(snapshot.quarantined);
    },
  });

  const observe = safeDiscordObserver<DiscordObservation>((observation) => {
    switch (observation.type) {
      case 'ingress':
        ingress.inc({ outcome: label(discordIngressOutcomes, observation.outcome) });
        return;
      case 'ack':
        if (validDuration(observation.durationMs)) ack.observe(observation.durationMs / 1000);
        return;
      case 'discovery':
        health.discovery(observation.source, observation.ok);
        return;
      case 'task':
        health.task(observation.ok);
        return;
      case 'turn':
        turns.inc({ outcome: label(discordTurnOutcomes, observation.outcome) });
        return;
      case 'recovery':
        recoveries.inc({ event: label(discordRecoveryEvents, observation.event) });
        return;
      case 'delivery':
        delivery.inc({
          kind: label(discordDeliveryKinds, observation.kind),
          outcome: label(discordDeliveryOutcomes, observation.outcome),
        });
        return;
      case 'run':
        runs.inc({ phase: label(discordRunPhases, observation.phase) });
        return;
    }
  });

  return {
    observe,
    application(owner, { shards }) {
      let entry: DiscordHealthEntry | undefined;
      try {
        entry = health.entry(owner, { shards });
      } catch {
        // Without a health entry the application still counts metrics.
      }
      let released = false;
      const observeApplication = (observation: DiscordApplicationObservation): void => {
        switch (observation.type) {
          case 'rest': {
            const route = discordRestRoute(observation.route);
            const status = discordRestStatus(observation.status);
            rest.inc({ route, status });
            if (!entry || !botRoutes.has(route)) return;
            // Only a 2xx or a 401 says anything about the bot token. A 5xx, a 429 or a missing
            // response proves nothing, and a 403 or 404 on a member or thread read is per user.
            if (status === '2xx') entry.credential('ok');
            else if (status === '401') entry.credential('rejected');
            if (!writeRoutes.has(route)) return;
            // 404 is what Discord answers for a message or channel a user deleted, so only a
            // 403 on a bot write is a bot side permission denial.
            if (status === '2xx') entry.permission('ok');
            else if (status === '403') entry.permission('denied');
            return;
          }
          case 'rejected':
            rejected.inc({ reason: label(discordRateRejections, observation.reason) });
            return;
          case 'permission':
            if (observation.outcome === 'ok') entry?.permission('ok');
            else if (observation.outcome === 'denied') entry?.permission('denied');
            return;
          case 'session': {
            sessions.inc({ event: label(discordSessionEvents, observation.event) });
            if (!entry || observation.event === 'error') return;
            const { shardId } = observation;
            if (observation.event === 'ready' || observation.event === 'resumed') {
              entry.native('up', shardId);
              entry.credential('ok');
            } else if (observation.event === 'closed_transient') entry.native('closed', shardId);
            else if (observation.event === 'closed_fatal') entry.fatal();
            else if (observation.event === 'gap') entry.native('gap', shardId);
            return;
          }
          case 'heartbeat':
            if (validDuration(observation.latencyMs))
              heartbeats.observe(observation.latencyMs / 1000);
            entry?.native('ack', observation.shardId);
            return;
          case 'stop':
            stops.inc({ reason: label(discordStopReasons, observation.reason) });
            if (observation.reason === 'credentials') entry?.credential('rejected');
            if (
              observation.reason === 'credentials' ||
              observation.reason === 'configuration' ||
              observation.reason === 'identity' ||
              observation.reason === 'startup'
            )
              entry?.fatal();
            // The owner outlives a failed session, so its shards stay down until the next one is READY.
            else if (observation.reason !== 'shutdown' && observation.reason !== 'lost')
              for (let shardId = 0; shardId < shards; shardId++) entry?.native('closed', shardId);
            return;
        }
      };
      return {
        observe: safeDiscordObserver(observeApplication),
        release: () => {
          if (released) return;
          released = true;
          try {
            health.remove(owner);
          } catch {
            // A failed removal must not fail the lease teardown that calls it.
          }
        },
      };
    },
  };
}

/** Delivery and run outcomes come from the provider's own classification, so no worker edit is needed. */
export function observeDiscordProvider(
  provider: WorkerProvider,
  observer: DiscordObserver,
): WorkerProvider {
  const observe = safeDiscordObserver(observer);
  const attempt = async <T>(kind: DiscordDeliveryKind, write: () => Promise<T>): Promise<T> => {
    try {
      const result = await write();
      observe({ type: 'delivery', kind, outcome: 'confirmed' });
      return result;
    } catch (error) {
      observe({ type: 'delivery', kind, outcome: deliveryOutcome(provider, error) });
      throw error;
    }
  };
  return {
    ...provider,
    writeProgress: (run, bundle, signal) =>
      attempt('progress', () => provider.writeProgress(run, bundle, signal)),
    deleteProgress: (run, bundle, signal) =>
      attempt('cleanup', () => provider.deleteProgress(run, bundle, signal)),
    preparePart(part, renderer, bundle) {
      const write = provider.preparePart(part, renderer, bundle);
      const kind = part.traceUrl === undefined ? 'answer' : 'trace';
      return (run, signal) => attempt(kind, () => write(run, signal));
    },
    async lifecycle(run, bundle, phase, signal) {
      const next = runPhase(run, phase);
      if (next) observe({ type: 'run', phase: next });
      await provider.lifecycle?.(run, bundle, phase, signal);
    },
  };
}

function deliveryOutcome(provider: WorkerProvider, error: unknown): DiscordDeliveryOutcome {
  try {
    const { outcome } = provider.classifyError(error);
    return outcome === 'unknown' ? 'uncertain' : outcome;
  } catch {
    return 'uncertain';
  }
}

/**
 * The worker calls `started` on every claim, and a run that yielded keeps its `executing` state,
 * so only a claim of a still `queued` run is a start. The worker reports a cancelled run as
 * `failed`, so the committed state tells the two apart.
 */
function runPhase(
  run: Pick<ChannelRunView, 'state'>,
  phase: 'started' | 'completed' | 'failed',
): DiscordRunPhase | undefined {
  if (phase === 'started') return run.state === 'queued' ? 'started' : undefined;
  if (phase === 'completed') return 'delivered';
  return run.state === 'cancelled' ? 'cancelled' : 'failed';
}
