import type { DiscordGatewayOwner } from './gateway';

export const discordHealthConcerns = ['workers', 'credentials', 'permissions', 'native'] as const;
export const discordHealthLevels = [
  'disabled',
  'unknown',
  'healthy',
  'degraded',
  'failing',
] as const;
export const discordQuarantineReasons = ['credentials', 'configuration', 'identity'] as const;

export type DiscordHealthConcern = (typeof discordHealthConcerns)[number];
export type DiscordHealthLevel = (typeof discordHealthLevels)[number];
export type DiscordQuarantineReason = (typeof discordQuarantineReasons)[number];
export type DiscordDiscoverySource = 'applications' | 'channels';
export type DiscordLevelCounts = Record<DiscordHealthLevel, number>;
export type DiscordQuarantineSummary = Readonly<Record<DiscordQuarantineReason, number>>;

export interface DiscordHealthPolicy {
  /** Continuous signals (discovery, Gateway heartbeat) older than this no longer count as live. */
  staleAfterMs: number;
  /** Event driven observations (credentials, permissions) older than this decay to unknown. */
  observationTtlMs: number;
}
export const DEFAULT_DISCORD_HEALTH_POLICY: Readonly<DiscordHealthPolicy> = {
  staleAfterMs: 120_000,
  observationTtlMs: 3_600_000,
};

export interface DiscordHealthOptions extends Partial<DiscordHealthPolicy> {
  now?: () => number;
  /** Applications held out of restart after a fatal stop. Their teardown removed ownership, so
   * the owner of that state supplies a count per reason at read time. It must not count an
   * application that is still owned, or the per concern totals exceed the application count. */
  quarantine?: () => DiscordQuarantineSummary;
}

/** Aggregates only: no application, guild, channel, user or run identifiers. */
export interface DiscordHealthSnapshot {
  /** Applications whose lease this replica holds. */
  applications: number;
  /** Applications held out after a fatal stop. They are not owned. */
  quarantined: number;
  workers: DiscordHealthLevel;
  /** Each of these sums to `applications + quarantined`. */
  credentials: DiscordLevelCounts;
  permissions: DiscordLevelCounts;
  native: DiscordLevelCounts;
}

/** Inputs for one owned application. Once its state is removed, a handle changes nothing the registry reports. */
export interface DiscordHealthEntry {
  credential(result: 'ok' | 'rejected'): void;
  /** Bot side outcomes only. An actor losing access is per user and never belongs here. */
  permission(result: 'ok' | 'denied'): void;
  native(signal: 'up' | 'ack' | 'closed' | 'gap', shardId: number): void;
  /** A stop that only a new revision or the end of a quarantine can recover from. */
  fatal(): void;
}

interface Observation {
  at: number;
  ok: boolean;
}
interface Shard {
  /** Last READY or RESUMED. Absent until the shard first connects. */
  upAt?: number;
  /** A non-fatal close since the last READY or RESUMED. */
  closed: boolean;
  ackAt?: number;
  gapAt?: number;
}
interface Tracked {
  ownerId: string;
  revision: string;
  /** Expected shard count. Zero means the Gateway is disabled for this application. */
  shards: number;
  credential?: Observation;
  permissions: Observation[];
  sessions: Map<number, Shard>;
  fatal: boolean;
}
interface Source {
  firstAt?: number;
  okAt?: number;
  last?: 'ok' | 'failed';
}

const permissionWindow = 3;
const taskWindow = 8;
type Live = Exclude<DiscordHealthLevel, 'disabled'>;
const severity: Record<Live, number> = { healthy: 0, unknown: 1, degraded: 2, failing: 3 };
const worst = (left: Live, right: Live): Live => (severity[right] > severity[left] ? right : left);
/** A clock that stepped backwards must not make an old observation look newer than now. */
const age = (now: number, at: number): number => Math.max(0, now - at);
const emptyCounts = (): DiscordLevelCounts => ({
  disabled: 0,
  unknown: 0,
  healthy: 0,
  degraded: 0,
  failing: 0,
});

function credentialLevel(tracked: Tracked, now: number, ttl: number): Live {
  const latest = tracked.credential;
  if (!latest || age(now, latest.at) > ttl) return 'unknown';
  return latest.ok ? 'healthy' : 'failing';
}

/** Three denied outcomes in a row fail; fewer than three denials cannot prove more than degraded. */
function permissionLevel(tracked: Tracked, now: number, ttl: number): Live {
  const recent = tracked.permissions.filter((outcome) => age(now, outcome.at) <= ttl);
  if (!recent.length) return 'unknown';
  const denied = recent.filter((outcome) => !outcome.ok).length;
  if (!denied) return 'healthy';
  return denied === permissionWindow ? 'failing' : 'degraded';
}

function shardLevel(shard: Shard, now: number, stale: number): Live {
  if (shard.closed) return 'degraded';
  if (shard.upAt === undefined) return 'unknown';
  if (age(now, Math.max(shard.upAt, shard.ackAt ?? shard.upAt)) > stale) return 'degraded';
  return shard.gapAt !== undefined && age(now, shard.gapAt) <= stale ? 'degraded' : 'healthy';
}

function nativeLevel(tracked: Tracked, now: number, stale: number): DiscordHealthLevel {
  if (!tracked.shards) return 'disabled';
  if (tracked.fatal) return 'failing';
  let level: Live = tracked.sessions.size < tracked.shards ? 'unknown' : 'healthy';
  for (const shard of tracked.sessions.values())
    level = worst(level, shardLevel(shard, now, stale));
  return level;
}

/** Time since the last success decides, so a loop that stops reporting cannot stay healthy. */
function discoveryLevel(source: Source, now: number, stale: number): Live {
  if (source.firstAt === undefined) return 'unknown';
  const elapsed = age(now, source.okAt ?? source.firstAt);
  if (source.last === 'ok' && elapsed <= stale) return 'healthy';
  return elapsed < stale ? 'degraded' : 'failing';
}

/**
 * Truthful private health for one gateway replica. Every level is computed from timestamps when
 * it is read, so silence decays instead of leaving a stale `healthy`. Nothing here probes
 * Discord, and readiness and liveness keep their existing meaning.
 */
export class DiscordHealth {
  private readonly policy: Readonly<DiscordHealthPolicy>;
  private readonly now: () => number;
  private readonly quarantine?: () => DiscordQuarantineSummary;
  private readonly tracked = new Map<string, Tracked>();
  private readonly sources: Record<DiscordDiscoverySource, Source> = {
    applications: {},
    channels: {},
  };
  private readonly tasks: Observation[] = [];

  constructor(options: DiscordHealthOptions = {}) {
    const policy = {
      staleAfterMs: options.staleAfterMs ?? DEFAULT_DISCORD_HEALTH_POLICY.staleAfterMs,
      observationTtlMs: options.observationTtlMs ?? DEFAULT_DISCORD_HEALTH_POLICY.observationTtlMs,
    };
    if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value <= 0))
      throw new TypeError('Invalid Discord health policy');
    this.policy = policy;
    this.now = options.now ?? Date.now;
    this.quarantine = options.quarantine;
  }

  /**
   * State lives exactly as long as one lease. A new owner or a new revision replaces what was
   * there, and nothing is inherited, so a rotated credential starts again at unknown.
   */
  entry(owner: DiscordGatewayOwner, options: { shards: number }): DiscordHealthEntry {
    const { applicationId, applicationRevision, ownerId } = owner;
    if (
      ![applicationId, applicationRevision, ownerId].every(
        (value) => typeof value === 'string' && value,
      ) ||
      !Number.isSafeInteger(options.shards) ||
      options.shards < 0
    )
      throw new TypeError('Invalid Discord health owner');
    let record = this.tracked.get(applicationId);
    if (record?.ownerId !== ownerId || record.revision !== applicationRevision) {
      record = {
        ownerId,
        revision: applicationRevision,
        shards: options.shards,
        permissions: [],
        sessions: new Map(),
        fatal: false,
      };
      this.tracked.set(applicationId, record);
    }
    const current = record;
    return {
      credential: (result) => {
        current.credential = { at: this.now(), ok: result === 'ok' };
      },
      permission: (result) => {
        current.permissions.push({ at: this.now(), ok: result === 'ok' });
        if (current.permissions.length > permissionWindow) current.permissions.shift();
      },
      native: (signal, shardId) => this.signal(current, signal, shardId),
      fatal: () => {
        current.fatal = true;
      },
    };
  }

  /** A late release from a previous owner cannot remove the state of the owner that replaced it. */
  remove(owner: Pick<DiscordGatewayOwner, 'applicationId' | 'ownerId'>): void {
    if (this.tracked.get(owner.applicationId)?.ownerId === owner.ownerId)
      this.tracked.delete(owner.applicationId);
  }

  discovery(source: DiscordDiscoverySource, ok: boolean): void {
    const state = this.sources[source];
    const at = this.now();
    state.firstAt ??= at;
    state.last = ok ? 'ok' : 'failed';
    if (ok) state.okAt = at;
  }

  /** One unit of worker or reply delivery work. A recent window made only of failures degrades. */
  task(ok: boolean): void {
    this.tasks.push({ at: this.now(), ok });
    if (this.tasks.length > taskWindow) this.tasks.shift();
  }

  snapshot(): DiscordHealthSnapshot {
    const now = this.now();
    const { staleAfterMs, observationTtlMs } = this.policy;
    const credentials = emptyCounts();
    const permissions = emptyCounts();
    const native = emptyCounts();
    for (const record of this.tracked.values()) {
      credentials[credentialLevel(record, now, observationTtlMs)]++;
      permissions[permissionLevel(record, now, observationTtlMs)]++;
      native[nativeLevel(record, now, staleAfterMs)]++;
    }
    const held = this.held();
    const quarantined = held.credentials + held.configuration + held.identity;
    credentials.failing += held.credentials;
    credentials.unknown += held.configuration + held.identity;
    permissions.unknown += quarantined;
    native.failing += quarantined;
    return {
      applications: this.tracked.size,
      quarantined,
      workers: this.workers(now),
      credentials,
      permissions,
      native,
    };
  }

  private workers(now: number): DiscordHealthLevel {
    const { staleAfterMs } = this.policy;
    let level = worst(
      discoveryLevel(this.sources.applications, now, staleAfterMs),
      discoveryLevel(this.sources.channels, now, staleAfterMs),
    );
    const recent = this.tasks.filter((task) => age(now, task.at) <= staleAfterMs);
    if (level === 'healthy' && recent.length && recent.every((task) => !task.ok))
      level = 'degraded';
    return level;
  }

  private signal(tracked: Tracked, signal: 'up' | 'ack' | 'closed' | 'gap', shardId: number): void {
    if (!Number.isSafeInteger(shardId) || shardId < 0 || shardId >= tracked.shards) return;
    let shard = tracked.sessions.get(shardId);
    if (!shard) {
      shard = { closed: false };
      tracked.sessions.set(shardId, shard);
    }
    const at = this.now();
    if (signal === 'up') {
      shard.upAt = at;
      shard.closed = false;
    } else if (signal === 'ack') shard.ackAt = at;
    else if (signal === 'gap') shard.gapAt = at;
    else shard.closed = true;
  }

  private held(): DiscordQuarantineSummary {
    const summary = { credentials: 0, configuration: 0, identity: 0 };
    try {
      const supplied = this.quarantine?.();
      for (const reason of discordQuarantineReasons) {
        const count = supplied?.[reason];
        if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
          summary[reason] = count;
      }
    } catch {
      // A faulty supplier must not turn a scrape into an error.
    }
    return summary;
  }
}
