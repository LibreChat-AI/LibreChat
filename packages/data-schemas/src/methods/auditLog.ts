import { createHash } from 'node:crypto';
import type { FilterQuery, Model } from 'mongoose';
import type {
  AdminAuditLogEntry,
  AuditChainVerification,
  AuditContext,
  AuditLogFilters,
  AuditLogPage,
  AuditMetadata,
  IAuditLog,
  PurgeAuditLogOptions,
  PurgeAuditLogResult,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
  VerifyAuditChainOptions,
} from '~/types';
import type { IndexBuildOptions } from '~/utils/retry';
import { GENESIS_HASH, PLATFORM_CHAIN_KEY } from '~/schema/auditLog';
import { createIndexesWithRetry } from '~/utils/retry';
import { AUDIT_ACTION_CATEGORY } from '~/types/admin';
import logger from '~/config/winston';

const DEFAULT_LIMIT = 100;
export const MAX_AUDIT_LOG_LIMIT = 500;
/**
 * Upper bound on rows emitted by the CSV export stream. At 100k rows per tenant
 * per export request, a careless admin script (or a hostile auditor) can keep a
 * cursor and a Node worker busy without saturating either; beyond that, exports
 * should be sliced by `from`/`to`.
 */
export const MAX_AUDIT_EXPORT_ROWS = 100_000;
/**
 * Upper bound on rows verified in a single HTTP-triggered integrity check. Full
 * offline jobs can pass a larger value explicitly when needed.
 */
export const MAX_AUDIT_VERIFY_ROWS = 100_000;
/** Record-format version stamped on every new entry. */
export const AUDIT_SCHEMA_VERSION = 1;
const MAX_SEARCH_LENGTH = 200;
/**
 * Retries when concurrent appends race for the same `seq`. Generous because a
 * lost append on the default fail-open path means a silently missing audit row;
 * with jittered backoff this resolves contention well beyond any realistic burst
 * of parallel admin writes.
 */
const MAX_APPEND_RETRIES = 12;
/** Base unit (ms) for jittered backoff between duplicate-key retries. */
const APPEND_BACKOFF_MS = 5;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AuditLogMethods {
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<IAuditLog | null>;
  listAuditLogPage: (
    tenantId: string | undefined,
    filters: AuditLogFilters,
  ) => Promise<AuditLogPage>;
  findAuditLogEntry: (
    tenantId: string | undefined,
    id: string,
  ) => Promise<AdminAuditLogEntry | null>;
  streamAuditLogEntries: (
    tenantId: string | undefined,
    filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
    onEntry: (entry: AdminAuditLogEntry) => void | Promise<void>,
    options?: { isCancelled?: () => boolean; maxRows?: number },
  ) => Promise<{ count: number; truncated: boolean }>;
  verifyAuditChain: (
    tenantId: string | undefined,
    options?: VerifyAuditChainOptions,
  ) => Promise<AuditChainVerification>;
  purgeAuditLogEntries: (
    tenantId: string | undefined,
    options: PurgeAuditLogOptions,
  ) => Promise<PurgeAuditLogResult>;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function regexFilter(value: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(value), $options: 'i' };
}

function oneOrIn<T>(values: T[]): T | { $in: T[] } {
  return values.length === 1 ? values[0] : { $in: values };
}

function idToString(id: string | { toString(): string }): string {
  return typeof id === 'string' ? id : id.toString();
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Distinguishes tenant chains from the platform chain so a tenant whose id is
 * literally the platform sentinel cannot share the platform's audit chain. */
const TENANT_CHAIN_PREFIX = 'tenant:';

/** Tenant scope → chain key. Blank/whitespace tenant is the platform chain;
 * tenant ids are namespaced so they can never collide with `PLATFORM_CHAIN_KEY`. */
export function auditChainKey(tenantId?: string): string {
  return typeof tenantId === 'string' && tenantId.trim().length > 0
    ? `${TENANT_CHAIN_PREFIX}${tenantId}`
    : PLATFORM_CHAIN_KEY;
}

function normalizeTenantId(tenantId?: string): string | undefined {
  return typeof tenantId === 'string' && tenantId.trim().length > 0 ? tenantId : undefined;
}

/** Drop undefined values; collapse an empty map to `undefined` so the field is
 * omitted entirely (and hashes identically on read-back). */
function normalizeMetadata(metadata?: AuditMetadata): AuditMetadata | undefined {
  if (!metadata) return undefined;
  const out: AuditMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeContext(context?: AuditContext): AuditContext | undefined {
  if (!context) return undefined;
  const out: AuditContext = {};
  if (context.requestId) out.requestId = context.requestId;
  if (context.ip) out.ip = context.ip;
  if (context.userAgent) out.userAgent = context.userAgent;
  if (context.sessionId) out.sessionId = context.sessionId;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Deterministic JSON: object keys sorted recursively so two semantically equal
 * entries always serialize to the same string. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/** Fields covered by the per-entry hash. Mirrors the stored shape so write-time
 * and verify-time recomputation agree exactly. */
interface HashableEntry {
  schemaVersion: number;
  category: IAuditLog['category'];
  action: IAuditLog['action'];
  outcome: IAuditLog['outcome'];
  severity: IAuditLog['severity'];
  actor: IAuditLog['actor'];
  target: IAuditLog['target'];
  metadata?: AuditMetadata;
  context?: AuditContext;
  tenantId?: string;
  chainKey: string;
  seq: number;
  prevHash: string;
  createdAt: Date;
}

function computeEntryHash(entry: HashableEntry): string {
  const canonical = {
    v: entry.schemaVersion,
    category: entry.category,
    action: entry.action,
    outcome: entry.outcome,
    severity: entry.severity,
    actor: {
      type: entry.actor.type,
      id: entry.actor.id ?? null,
      name: entry.actor.name,
    },
    target: {
      type: entry.target.type,
      id: entry.target.id ?? null,
      name: entry.target.name ?? null,
    },
    metadata: entry.metadata ?? null,
    context: entry.context
      ? {
          requestId: entry.context.requestId ?? null,
          ip: entry.context.ip ?? null,
          userAgent: entry.context.userAgent ?? null,
          sessionId: entry.context.sessionId ?? null,
        }
      : null,
    tenantId: entry.tenantId ?? null,
    chainKey: entry.chainKey,
    seq: entry.seq,
    prevHash: entry.prevHash,
    createdAt: entry.createdAt.toISOString(),
  };
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function toWire(doc: IAuditLog): AdminAuditLogEntry {
  const entry: AdminAuditLogEntry = {
    id: doc._id.toString(),
    schemaVersion: doc.schemaVersion,
    category: doc.category,
    action: doc.action,
    outcome: doc.outcome,
    severity: doc.severity,
    actor: {
      type: doc.actor.type,
      name: doc.actor.name,
      ...(doc.actor.id != null ? { id: doc.actor.id } : {}),
    },
    target: {
      type: doc.target.type,
      ...(doc.target.id != null ? { id: doc.target.id } : {}),
      ...(doc.target.name != null ? { name: doc.target.name } : {}),
    },
    integrity: { seq: doc.seq, hash: doc.hash, prevHash: doc.prevHash },
    timestamp: doc.createdAt.toISOString(),
  };
  if (doc.metadata != null) entry.metadata = doc.metadata;
  const context = normalizeContext(doc.context);
  if (context) entry.context = context;
  if (doc.tenantId != null) entry.tenantId = doc.tenantId;
  return entry;
}

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_AUDIT_LOG_LIMIT);
}

/**
 * Builds the Mongo `find` filter for audit-log queries. Chain scoping is always
 * applied first and uses the compound `{ chainKey, ... }` indexes. The substring
 * regex filters (`actor.name`, `target.name`, `metadata.capability`, `search`)
 * are case-insensitive and cannot use a B-tree index: within the chain slice
 * they degrade to a partition scan. The primary listing combines `chainKey` with
 * `seq`/`createdAt` pagination, so the scan stays bounded by the date window.
 */
function buildFilter(chainKey: string, filters: AuditLogFilters): FilterQuery<IAuditLog> {
  const query: FilterQuery<IAuditLog> = { chainKey };

  if (filters.category && filters.category.length > 0) {
    query.category = oneOrIn(filters.category);
  }
  if (filters.action && filters.action.length > 0) {
    query.action = oneOrIn(filters.action);
  }
  if (filters.outcome && filters.outcome.length > 0) {
    query.outcome = oneOrIn(filters.outcome);
  }
  if (filters.severity && filters.severity.length > 0) {
    query.severity = oneOrIn(filters.severity);
  }
  if (filters.actorType) {
    query['actor.type'] = filters.actorType;
  }
  if (filters.actorQuery) {
    query['actor.name'] = regexFilter(filters.actorQuery);
  }
  if (filters.targetType) {
    query['target.type'] = filters.targetType;
  }
  if (filters.targetQuery) {
    query['target.name'] = regexFilter(filters.targetQuery);
  }
  if (filters.capability) {
    query['metadata.capability'] = regexFilter(filters.capability);
  }
  if (filters.from || filters.to) {
    const createdAt: { $gte?: Date; $lte?: Date } = {};
    if (filters.from) createdAt.$gte = filters.from;
    if (filters.to) createdAt.$lte = filters.to;
    query.createdAt = createdAt;
  }
  if (filters.search && filters.search.length > 0) {
    const safe = regexFilter(filters.search.slice(0, MAX_SEARCH_LENGTH));
    query.$or = [
      { 'actor.name': safe },
      { 'target.name': safe },
      { action: safe },
      { 'metadata.capability': safe },
    ];
  }

  return query;
}

/** Longest wait on the request path for a peer's index build before an append fails open. */
const AUDIT_INDEX_BUILD_DEADLINE_MS = 10_000;

export interface AuditLogMethodOptions {
  /** Overrides for the append index build; tests shorten its polling and deadline. */
  indexBuild?: IndexBuildOptions;
}

export function createAuditLogMethods(
  mongoose: typeof import('mongoose'),
  options: AuditLogMethodOptions = {},
): AuditLogMethods {
  function model(): Model<IAuditLog> {
    return mongoose.models.AuditLog as Model<IAuditLog>;
  }

  /**
   * The read-then-create append only serializes concurrent writers when the
   * unique `{ chainKey, seq }` index exists. With `MONGO_AUTO_INDEX=false`, or
   * during the startup window before a background build finishes, two writers
   * could insert the same `seq` with no duplicate-key error and silently fork
   * the chain. Build the indexes once before the first append so serialization
   * never depends on a background build — letting Mongoose's own background
   * build settle first, so the two never overlap on a single-build engine. The
   * wait for a peer's build is bounded, because this runs on the request path:
   * past the deadline the append fails open below instead of holding the
   * request. Memoized; reset on failure so a later write retries.
   */
  let indexPromise: Promise<unknown> | null = null;
  function ensureIndexes(): Promise<unknown> {
    if (!indexPromise) {
      indexPromise = createIndexesWithRetry(model(), {
        peerBuildDeadlineMs: AUDIT_INDEX_BUILD_DEADLINE_MS,
        ...options.indexBuild,
      }).catch((err) => {
        indexPromise = null;
        throw err;
      });
    }
    return indexPromise;
  }

  async function recordAuditEntry(
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ): Promise<IAuditLog | null> {
    const AuditLog = model();
    const tenantId = normalizeTenantId(input.tenantId);
    const chainKey = auditChainKey(input.tenantId);
    const category = input.category ?? AUDIT_ACTION_CATEGORY[input.action];
    const outcome = input.outcome ?? 'success';
    const severity =
      input.severity ?? (outcome === 'failure' || outcome === 'denied' ? 'warning' : 'info');
    const actor = {
      type: input.actor.type,
      name: input.actor.name,
      ...(input.actor.id != null ? { id: idToString(input.actor.id) } : {}),
    };
    const target = {
      type: input.target.type,
      ...(input.target.id != null ? { id: idToString(input.target.id) } : {}),
      ...(input.target.name != null ? { name: input.target.name } : {}),
    };
    const metadata = normalizeMetadata(input.metadata);
    const context = normalizeContext(input.context);

    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      try {
        /** Guarantee the unique seq index exists before serializing on it. */
        await ensureIndexes();
        const last = await AuditLog.findOne({ chainKey })
          .sort({ seq: -1 })
          .select('seq hash')
          .lean<{ seq: number; hash: string }>();
        const prevSeq = last?.seq ?? 0;
        const prevHash = last?.hash ?? GENESIS_HASH;
        const seq = prevSeq + 1;
        const createdAt = new Date();
        const hash = computeEntryHash({
          schemaVersion: AUDIT_SCHEMA_VERSION,
          category,
          action: input.action,
          outcome,
          severity,
          actor,
          target,
          metadata,
          context,
          tenantId,
          chainKey,
          seq,
          prevHash,
          createdAt,
        });
        const doc = await AuditLog.create({
          schemaVersion: AUDIT_SCHEMA_VERSION,
          category,
          action: input.action,
          outcome,
          severity,
          actor,
          target,
          ...(metadata !== undefined && { metadata }),
          ...(context !== undefined && { context }),
          ...(tenantId !== undefined && { tenantId }),
          chainKey,
          seq,
          prevHash,
          hash,
          createdAt,
        });
        return doc;
      } catch (err) {
        if (isDuplicateKeyError(err) && attempt < MAX_APPEND_RETRIES - 1) {
          /** Jittered backoff de-correlates racing writers before they recompute
           * the tail `seq`, so the next attempt is very unlikely to collide. */
          await sleep(Math.floor(Math.random() * APPEND_BACKOFF_MS * (attempt + 1)));
          continue;
        }
        /**
         * Fail-open by default: a failed write must never block the privileged
         * operation, so it returns null and leaves a structured forensic trail.
         * Callers that require a durable record pass `failClosed` to surface the
         * failure instead.
         */
        logger.error('[auditLog] failed to record audit entry', {
          action: input.action,
          category,
          outcome,
          chainKey,
          tenantId,
          actorId: actor.id ?? null,
          actorType: actor.type,
          targetType: target.type,
          targetId: target.id ?? null,
          err,
        });
        if (options?.failClosed) {
          throw err instanceof Error ? err : new Error('Failed to record audit entry');
        }
        return null;
      }
    }
    return null;
  }

  async function listAuditLogPage(
    tenantId: string | undefined,
    filters: AuditLogFilters,
  ): Promise<AuditLogPage> {
    const AuditLog = model();
    const chainKey = auditChainKey(tenantId);
    const limit = clampLimit(filters.limit);
    const base = buildFilter(chainKey, filters);

    const cursorSeq =
      typeof filters.cursor === 'number' && Number.isFinite(filters.cursor)
        ? filters.cursor
        : undefined;
    const paged: FilterQuery<IAuditLog> =
      cursorSeq !== undefined ? { ...base, seq: { $lt: cursorSeq } } : base;
    const offset =
      cursorSeq === undefined && filters.offset && filters.offset > 0
        ? Math.floor(filters.offset)
        : 0;

    let pageQuery = AuditLog.find(paged)
      .sort({ seq: -1 })
      .limit(limit + 1);
    if (offset > 0) pageQuery = pageQuery.skip(offset);

    const [rowsPlusOne, total] = await Promise.all([
      pageQuery.lean<IAuditLog[]>(),
      AuditLog.countDocuments(base),
    ]);

    const hasMore = rowsPlusOne.length > limit;
    const rows = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
    const nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1].seq : null;

    return { entries: rows.map(toWire), total, nextCursor };
  }

  async function findAuditLogEntry(
    tenantId: string | undefined,
    id: string,
  ): Promise<AdminAuditLogEntry | null> {
    if (!OBJECT_ID_RE.test(id)) return null;
    const AuditLog = model();
    const query: FilterQuery<IAuditLog> = { _id: id, chainKey: auditChainKey(tenantId) };
    const doc = await AuditLog.findOne(query).lean<IAuditLog>();
    return doc ? toWire(doc) : null;
  }

  async function streamAuditLogEntries(
    tenantId: string | undefined,
    filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
    onEntry: (entry: AdminAuditLogEntry) => void | Promise<void>,
    options?: { isCancelled?: () => boolean; maxRows?: number },
  ): Promise<{ count: number; truncated: boolean }> {
    const AuditLog = model();
    const query = buildFilter(auditChainKey(tenantId), filters);
    const cursor = AuditLog.find(query)
      .sort({ seq: -1 })
      .lean<IAuditLog[]>()
      .cursor({ batchSize: 500 });

    const isCancelled = options?.isCancelled;
    const maxRows = options?.maxRows;
    let count = 0;
    let truncated = false;
    try {
      for await (const doc of cursor) {
        if (isCancelled?.()) {
          await cursor.close();
          break;
        }
        if (maxRows != null && count >= maxRows) {
          /** The cap fired only because at least one more row exists beyond it,
           * so this is a genuine truncation — an exact-cap match exhausts the
           * cursor naturally and never reaches here. */
          truncated = true;
          await cursor.close();
          break;
        }
        await onEntry(toWire(doc));
        count++;
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
    return { count, truncated };
  }

  async function verifyAuditChain(
    tenantId: string | undefined,
    options?: VerifyAuditChainOptions,
  ): Promise<AuditChainVerification> {
    const AuditLog = model();
    const chainKey = auditChainKey(tenantId);
    const cursor = AuditLog.find({ chainKey })
      .sort({ seq: 1 })
      .lean<IAuditLog[]>()
      .cursor({ batchSize: 500 });

    const trustedCheckpoint = options?.trustedCheckpoint;
    const isCancelled = options?.isCancelled;
    const maxRows = options?.maxRows;
    let prevHash = GENESIS_HASH;
    let expectedSeq: number | null = null;
    let firstSeq: number | null = null;
    let lastSeq = 0;
    let checked = 0;

    try {
      for await (const doc of cursor) {
        if (isCancelled?.()) {
          await cursor.close();
          return {
            ok: false,
            chainKey,
            checked,
            reason: 'verification cancelled',
            range: firstSeq !== null ? { firstSeq, lastSeq } : undefined,
          };
        }
        if (maxRows != null && checked >= maxRows) {
          await cursor.close();
          return {
            ok: false,
            chainKey,
            checked,
            brokenAt: doc.seq,
            reason: `verification row limit exceeded (${maxRows})`,
            range:
              firstSeq !== null ? { firstSeq, lastSeq } : { firstSeq: doc.seq, lastSeq: doc.seq },
          };
        }
        if (firstSeq === null) {
          firstSeq = doc.seq;
          expectedSeq = doc.seq;
          /**
           * A non-genesis start (firstSeq > 1) means a prefix is gone. Only a
           * matching trusted checkpoint proves it was an authorized retention
           * purge; otherwise this is an attacker deleting the oldest rows, so we
           * must NOT silently trust the first row's prevHash.
           */
          if (doc.seq === 1) {
            prevHash = GENESIS_HASH;
          } else if (
            trustedCheckpoint &&
            trustedCheckpoint.throughSeq === doc.seq - 1 &&
            trustedCheckpoint.prevHash === doc.prevHash
          ) {
            prevHash = doc.prevHash;
          } else {
            await cursor.close();
            return {
              ok: false,
              chainKey,
              checked,
              brokenAt: doc.seq,
              reason: trustedCheckpoint
                ? 'checkpoint mismatch: purged prefix does not match the trusted checkpoint'
                : `non-genesis start at seq ${doc.seq}: prefix purged or deleted (supply a trusted checkpoint to verify)`,
              range: { firstSeq, lastSeq: doc.seq },
            };
          }
        }
        if (doc.seq !== expectedSeq) {
          return {
            ok: false,
            chainKey,
            checked,
            brokenAt: expectedSeq ?? doc.seq,
            reason: `sequence gap: expected ${expectedSeq}, found ${doc.seq}`,
            range: { firstSeq, lastSeq },
          };
        }
        if (doc.prevHash !== prevHash) {
          return {
            ok: false,
            chainKey,
            checked,
            brokenAt: doc.seq,
            reason: 'broken hash link',
            range: { firstSeq, lastSeq },
          };
        }
        if (computeEntryHash(doc) !== doc.hash) {
          return {
            ok: false,
            chainKey,
            checked,
            brokenAt: doc.seq,
            reason: 'hash mismatch',
            range: { firstSeq, lastSeq },
          };
        }
        prevHash = doc.hash;
        lastSeq = doc.seq;
        expectedSeq = doc.seq + 1;
        checked++;
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }

    return {
      ok: true,
      chainKey,
      checked,
      range: firstSeq !== null ? { firstSeq, lastSeq } : undefined,
    };
  }

  async function purgeAuditLogEntries(
    tenantId: string | undefined,
    options: PurgeAuditLogOptions,
  ): Promise<PurgeAuditLogResult> {
    if (!options.confirm) return { deletedCount: 0 };
    if (!(options.before instanceof Date) || Number.isNaN(options.before.getTime())) {
      throw new Error('purgeAuditLogEntries: `before` must be a valid Date');
    }
    const AuditLog = model();
    const chainKey = auditChainKey(tenantId);

    /**
     * Translate the date intent into a contiguous `seq` boundary before deleting.
     * `createdAt` is app-generated, so under multi-instance clock skew a later
     * `seq` can carry an earlier timestamp; a raw date delete could then remove
     * an interior row and permanently break verification. Instead, find the
     * earliest entry that must be retained (the first by `seq` whose `createdAt`
     * is on/after `before`) and delete only the strictly-lower `seq` prefix. This
     * never deletes past a retained entry, so the remaining chain stays
     * contiguous even with skew (it may retain a few old rows, which is safe).
     */
    const firstRetained = await AuditLog.findOne({ chainKey, createdAt: { $gte: options.before } })
      .sort({ seq: 1 })
      .select('seq')
      .lean<{ seq: number }>();

    const deleteFilter: FilterQuery<IAuditLog> = firstRetained
      ? { chainKey, seq: { $lt: firstRetained.seq } }
      : { chainKey };

    /**
     * Retention purge is the one privileged path that removes audit rows. It
     * intentionally uses the raw driver to bypass the append-only Mongoose hooks
     * (the model blocks every delete). Tenant isolation is applied via `chainKey`.
     */
    // eslint-disable-next-line no-restricted-syntax -- privileged retention purge; append-only hooks block deleteMany, tenant scoped via chainKey
    const result = await AuditLog.collection.deleteMany(deleteFilter);
    const deletedCount = result.deletedCount ?? 0;

    logger.warn('[auditLog] retention purge executed', {
      chainKey,
      before: options.before.toISOString(),
      deletedCount,
    });

    /**
     * Only a purge that actually removed rows may mint a trust boundary. A no-op
     * purge returning a checkpoint for the current first entry would let a caller
     * legitimize a prefix this purge never authorized (e.g. one an attacker
     * deleted), so `verifyAuditChain` could be tricked into accepting it.
     */
    if (deletedCount === 0) {
      return { deletedCount: 0 };
    }

    const newFirst = await AuditLog.findOne({ chainKey })
      .sort({ seq: 1 })
      .select('seq prevHash')
      .lean<{ seq: number; prevHash: string }>();

    return {
      deletedCount,
      /** Boundary for `verifyAuditChain`: the new earliest entry resumes the
       * chain at `seq`, so the purged prefix ran through `seq - 1` and its last
       * hash is this entry's `prevHash`. Callers persist this to later prove the
       * purge was authorized. */
      checkpoint: newFirst
        ? { throughSeq: newFirst.seq - 1, prevHash: newFirst.prevHash }
        : undefined,
    };
  }

  return {
    recordAuditEntry,
    listAuditLogPage,
    findAuditLogEntry,
    streamAuditLogEntries,
    verifyAuditChain,
    purgeAuditLogEntries,
  };
}
