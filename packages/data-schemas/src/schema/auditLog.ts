import { Schema } from 'mongoose';
import type { IAuditLog } from '~/types';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  AUDIT_SEVERITIES,
} from '~/types/admin';

/** Sentinel `chainKey` for platform-level (non-tenant) audit entries. */
export const PLATFORM_CHAIN_KEY = '__platform__';

/** Genesis link: the `prevHash` of the first entry in any chain. */
export const GENESIS_HASH: string = '0'.repeat(64);

const actorSchema = new Schema(
  {
    type: { type: String, enum: [...AUDIT_ACTOR_TYPES], required: true, immutable: true },
    id: { type: String, required: false, immutable: true },
    name: { type: String, required: true, immutable: true },
  },
  { _id: false },
);

const targetSchema = new Schema(
  {
    type: { type: String, required: true, immutable: true },
    id: { type: String, required: false, immutable: true },
    name: { type: String, required: false, immutable: true },
  },
  { _id: false },
);

const contextSchema = new Schema(
  {
    requestId: { type: String, required: false, immutable: true },
    ip: { type: String, required: false, immutable: true },
    userAgent: { type: String, required: false, immutable: true },
    sessionId: { type: String, required: false, immutable: true },
  },
  { _id: false },
);

/**
 * Append-only by schema contract: every field is `immutable`, every
 * update-style operation is short-circuited in the pre-hooks below, and there
 * is no `updatedAt` — a mutable timestamp would imply mutation is allowed.
 * `createdAt` is set explicitly by the writer (not by `timestamps`) so it is
 * covered by the per-entry hash. Tamper-evidence beyond these app-layer guards
 * comes from the hash chain (`prevHash`/`hash`/`seq`) maintained in
 * `~/methods/auditLog`.
 */
const auditLogSchema: Schema<IAuditLog> = new Schema<IAuditLog>({
  schemaVersion: { type: Number, required: true, immutable: true },
  category: {
    type: String,
    enum: [...AUDIT_CATEGORIES],
    required: true,
    immutable: true,
  },
  action: {
    type: String,
    enum: [...AUDIT_ACTIONS],
    required: true,
    immutable: true,
  },
  outcome: {
    type: String,
    enum: [...AUDIT_OUTCOMES],
    required: true,
    immutable: true,
  },
  severity: {
    type: String,
    enum: [...AUDIT_SEVERITIES],
    required: true,
    immutable: true,
  },
  actor: { type: actorSchema, required: true, immutable: true },
  target: { type: targetSchema, required: true, immutable: true },
  /** Event-specific payload (e.g. `{ capability }` for grants). Open by design;
   * never store raw prompts, secrets, or full tool outputs here. */
  metadata: { type: Schema.Types.Mixed, required: false, immutable: true },
  context: { type: contextSchema, required: false, immutable: true },
  /**
   * Platform-level entries MUST omit this field entirely — never set it to null.
   * Tenant-scoped queries derive `chainKey` from `tenantId`; absence here maps
   * to the platform chain.
   */
  tenantId: {
    type: String,
    required: false,
    immutable: true,
    validate: {
      validator: (v: unknown) => typeof v === 'string' && v.trim().length > 0,
      message:
        'tenantId must be a non-empty string or omitted entirely — never null, empty, or a non-string value',
    },
  },
  chainKey: { type: String, required: true, immutable: true },
  seq: { type: Number, required: true, immutable: true },
  prevHash: { type: String, required: true, immutable: true },
  hash: { type: String, required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true },
});

const APPEND_ONLY_MESSAGE = 'AuditLog is append-only — updates and deletes are forbidden';

/** Block every query-level update path. */
auditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne'],
  function (next) {
    next(new Error(APPEND_ONLY_MESSAGE));
  },
);

/** Block every query-level delete path. */
auditLogSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function (next) {
  next(new Error(APPEND_ONLY_MESSAGE));
});

/**
 * Mongoose registers `deleteOne` / `updateOne` pre-hooks as query middleware
 * by default, leaving `Document.prototype.deleteOne()` and
 * `Document.prototype.updateOne()` as escape hatches: a caller holding a loaded
 * doc could invoke either on the instance and bypass the query-level hooks.
 * The explicit `{ document: true, query: false }` registrations close both.
 */
auditLogSchema.pre('deleteOne', { document: true, query: false }, function (next) {
  next(new Error(APPEND_ONLY_MESSAGE));
});
auditLogSchema.pre('updateOne', { document: true, query: false }, function (next) {
  next(new Error(APPEND_ONLY_MESSAGE));
});

/** Document-level `save` is allowed for new docs only; a second save mutates. */
auditLogSchema.pre('save', function (next) {
  if (!this.isNew) {
    next(new Error(APPEND_ONLY_MESSAGE));
    return;
  }
  next();
});

/**
 * `Model.bulkWrite()` dispatches update/delete operations through the raw driver
 * and skips the query/document middleware above. Block it wholesale: audit rows
 * are only ever written via `recordAuditEntry` (`Model.create`), and a bulk
 * insert would also break the sequential hash chain, so there is no legitimate
 * bulkWrite path. The privileged retention purge uses `Model.collection` and is
 * unaffected by this hook.
 */
auditLogSchema.pre('bulkWrite', function (next) {
  next(new Error(APPEND_ONLY_MESSAGE));
});

/**
 * `Model.insertMany()` is another bulk path that skips the document `save`
 * hook, so it could insert rows with attacker-chosen `seq`/`prevHash`/`hash`
 * and poison the chain. Entries are only ever written one-at-a-time via
 * `recordAuditEntry` (`Model.create`), so block bulk inserts outright.
 */
auditLogSchema.pre('insertMany', function (next) {
  next(new Error(APPEND_ONLY_MESSAGE));
});

/**
 * Unique per-chain sequence. This is both the keyset-pagination key and the
 * integrity backstop: concurrent appends race to claim the next `seq`, one wins,
 * and the losers retry — so the chain can never fork.
 */
auditLogSchema.index({ chainKey: 1, seq: 1 }, { unique: true });

/** Primary listing: newest-first within a chain, bounded by a date window. */
auditLogSchema.index({ chainKey: 1, createdAt: -1, seq: -1 });

/** Faceted reads. */
auditLogSchema.index({ chainKey: 1, category: 1, createdAt: -1 });
auditLogSchema.index({ chainKey: 1, 'target.type': 1, 'target.id': 1, createdAt: -1 });

export default auditLogSchema;
