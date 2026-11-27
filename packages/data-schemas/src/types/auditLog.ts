import type { Document, Types } from 'mongoose';
import type {
  AdminAuditLogEntry,
  AuditAction,
  AuditActor,
  AuditActorType,
  AuditCategory,
  AuditContext,
  AuditIntegrity,
  AuditMetadata,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
} from './admin';

/**
 * AuditLog is an append-only, hash-chained compliance record. Enforcement lives
 * in `~/schema/auditLog` (immutable fields, pre-update/delete/save hooks) and in
 * `~/methods/auditLog` (per-chain hash linking + a unique `{ chainKey, seq }`
 * index that serializes concurrent appends). `createdAt` is set explicitly by
 * the writer so it is covered by the entry hash.
 */
export type AuditLog = {
  /** Record-format version, so future migrations can interpret older rows. */
  schemaVersion: number;
  category: AuditCategory;
  action: AuditAction;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  actor: AuditActor;
  target: AuditTarget;
  metadata?: AuditMetadata;
  context?: AuditContext;
  /** Absent = platform-level entry; present = tenant-scoped entry. */
  tenantId?: string;
  /**
   * Always present; equals `tenantId` or the platform sentinel. The hash chain
   * and keyset pagination are scoped to this key, and `{ chainKey, seq }` is the
   * unique index that serializes appends.
   */
  chainKey: string;
  /** Monotonic per-chain sequence number (1-based). */
  seq: number;
  /** Hash of the previous entry in the chain; genesis links to the zero hash. */
  prevHash: string;
  /** SHA-256 over this entry's canonical content (including `seq` and `prevHash`). */
  hash: string;
  createdAt: Date;
};

export type IAuditLog = AuditLog &
  Document & {
    _id: Types.ObjectId;
  };

/** Actor as accepted by writers; `id` may be an ObjectId for convenience. */
export interface AuditActorInput {
  type: AuditActorType;
  id?: string | Types.ObjectId;
  name: string;
}

/** Target as accepted by writers; `id` may be an ObjectId for convenience. */
export interface AuditTargetInput {
  type: string;
  id?: string | Types.ObjectId;
  name?: string;
}

export interface RecordAuditEntryInput {
  action: AuditAction;
  /** Derived from `action` when omitted. */
  category?: AuditCategory;
  /** Defaults to `'success'`. */
  outcome?: AuditOutcome;
  /** Defaults to `'warning'` for `failure`/`denied`, else `'info'`. */
  severity?: AuditSeverity;
  actor: AuditActorInput;
  target: AuditTargetInput;
  metadata?: AuditMetadata;
  context?: AuditContext;
  tenantId?: string;
}

/** Options that shape a single audit write. */
export interface RecordAuditEntryOptions {
  /**
   * When true, a failed write throws instead of resolving to `null`. Callers
   * that must not proceed without a durable audit record opt in here; the
   * default is fail-open so audit emission never blocks a privileged operation.
   */
  failClosed?: boolean;
}

export interface AuditLogFilters {
  search?: string;
  category?: AuditCategory[];
  action?: AuditAction[];
  outcome?: AuditOutcome[];
  severity?: AuditSeverity[];
  /** Exact match on `actor.type`. */
  actorType?: AuditActorType;
  /** Case-insensitive substring match against the denormalized `actor.name`. */
  actorQuery?: string;
  /** Exact match on `target.type`. */
  targetType?: string;
  /** Case-insensitive substring match against the denormalized `target.name`. */
  targetQuery?: string;
  /** Case-insensitive substring match against `metadata.capability`. */
  capability?: string;
  from?: Date;
  to?: Date;
  /** Offset pagination (legacy / random-access). Prefer `cursor`. */
  offset?: number;
  limit?: number;
  /**
   * Keyset cursor: the `seq` of the last entry from the previous page. Results
   * are newest-first, so the next page is `seq < cursor`. Stable under
   * concurrent appends, unlike `offset`.
   */
  cursor?: number;
}

export interface AuditLogPage {
  entries: AdminAuditLogEntry[];
  total: number;
  /** Pass as `cursor` to fetch the next page; `null` when the page is the last. */
  nextCursor: number | null;
}

/** Outcome of verifying a chain's tamper-evidence. */
export interface AuditChainVerification {
  ok: boolean;
  chainKey: string;
  /** Number of entries inspected. */
  checked: number;
  /** First `seq` where the chain broke (gap, broken link, or hash mismatch). */
  brokenAt?: number;
  reason?: string;
  /** Earliest/latest `seq` present. `firstSeq > 1` indicates a purged prefix. */
  range?: { firstSeq: number; lastSeq: number };
}

export interface PurgeAuditLogOptions {
  /** Delete entries strictly older than this instant (a contiguous prefix). */
  before: Date;
  /** Required safety latch; the purge is a no-op unless explicitly confirmed. */
  confirm: boolean;
}

/** A trusted boundary marker proving a prefix was purged by an authorized
 * retention run rather than deleted by an attacker. Persisted by the caller
 * (e.g. alongside retention-job records) and passed back to `verifyAuditChain`. */
export interface AuditCheckpoint {
  /** Highest `seq` that was purged; the chain resumes at `throughSeq + 1`. */
  throughSeq: number;
  /** Hash of the last purged entry === `prevHash` of the new earliest entry. */
  prevHash: string;
}

export interface PurgeAuditLogResult {
  deletedCount: number;
  /** The boundary the verifier must be given to accept the now-shorter chain.
   * Absent when the chain is now empty or nothing was purged. */
  checkpoint?: AuditCheckpoint;
}

export interface VerifyAuditChainOptions {
  /** Stop verification early when the caller has gone away. */
  isCancelled?: () => boolean;
  /** Maximum rows to inspect before returning a bounded, non-OK result. */
  maxRows?: number;
  /** When the chain no longer starts at `seq: 1` (a prefix was purged), the
   * verifier requires this boundary to distinguish an authorized retention purge
   * from an attacker deleting the oldest rows. Without it, a non-genesis start
   * fails verification rather than being silently trusted. */
  trustedCheckpoint?: AuditCheckpoint;
}

/** Re-exported so consumers can import the entry shape and its supporting types
 * from one module. */
export type {
  AdminAuditLogEntry,
  AuditAction,
  AuditActor,
  AuditActorType,
  AuditCategory,
  AuditContext,
  AuditIntegrity,
  AuditMetadata,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
};
