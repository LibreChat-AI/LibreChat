import type { Connection } from 'mongoose';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/**
 * Driver-level completeness probe for tenant isolation.
 *
 * Tenant scoping is enforced by the storage engine's own binding — Mongoose
 * middleware today. That leaves one question no amount of reading the binding
 * can answer: does it cover *every* path, including the ones nobody enumerated?
 *
 * This probe answers it from below, by observing the commands that actually
 * reach the wire. The check does not depend on the binding being correct, which
 * is the whole point of putting it here.
 *
 * It asks one narrow, decidable question: **did the binding's own contribution
 * arrive, for the tenant that was active when the command was issued?** It does
 * not try to decide tenant-safety for arbitrary filter algebra — that problem is
 * unbounded, and every operator left open is a way for a regression to look
 * scoped. The binding emits `{ tenantId: <active> }` at the top level of a
 * filter, or unshifts `{ $match: { tenantId: <active> } }` onto a pipeline, so
 * that is exactly what is checked. Anything else is reported unscoped.
 *
 * Requires the connection to have been opened with `monitorCommands: true`.
 */

/** One command observed reaching the database. */
export interface TenantCommandRecord {
  readonly commandName: string;
  readonly collection: string;
  /** The tenant active when the command was issued, if any. */
  readonly tenantId?: string;
  /** True when the command provably restricts itself to that tenant. */
  readonly scoped: boolean;
  /** The predicates as sent, for test failure output. */
  readonly predicate: string;
}

export interface TenantProbe {
  /**
   * Runs `fn` and returns every observed command against a watched collection.
   * Not re-entrant: one recording at a time per probe.
   */
  record(fn: () => Promise<unknown>): Promise<readonly TenantCommandRecord[]>;
  /** Detaches the listener. */
  close(): void;
}

type CommandDocument = Record<string, unknown>;

/**
 * Predicate locations per command, as the wire protocol names them.
 * `list` marks commands whose payload is an array of sub-operations.
 */
const PREDICATE_PATHS: ReadonlyMap<string, { readonly key: string; readonly list?: string }> =
  new Map([
    ['find', { key: 'filter' }],
    ['count', { key: 'query' }],
    ['distinct', { key: 'query' }],
    ['findAndModify', { key: 'query' }],
    ['update', { key: 'q', list: 'updates' }],
    ['delete', { key: 'q', list: 'deletes' }],
    ['insert', { key: '', list: 'documents' }],
  ]);

/**
 * Commands that touch a collection but carry no tenant-bearing data. Anything
 * outside this list and `PREDICATE_PATHS` is reported unscoped rather than
 * dropped, so a command shape the probe does not understand fails closed
 * instead of passing unseen.
 *
 * `drop` is deliberately absent: unlike index inspection, dropping a collection
 * destroys every tenant's rows, and a leak detector must never be silent about
 * that.
 */
const UNJUDGED_COMMANDS: ReadonlySet<string> = new Set([
  'createIndexes',
  'listIndexes',
  'dropIndexes',
  'listCollections',
  'collMod',
  'create',
]);

/**
 * `JSON.stringify` throws on BSON values it does not know, and this runs inside
 * the driver's synchronous event handler — a throw would escape into the
 * database operation itself. Diagnostics must never do that.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));
  } catch {
    return '(unserializable predicate)';
  }
}

/** Stages that rewrite another collection from inside the aggregate command. */
const COLLECTION_WRITING_STAGES = ['$out', '$merge'] as const;

/**
 * Whether a filter carries the binding's own contribution: `tenantId` equal to
 * the active tenant, at the top level, as a plain equality.
 */
function pinsTenant(filter: unknown, tenantId: string): boolean {
  if (filter == null || typeof filter !== 'object' || Array.isArray(filter)) {
    return false;
  }
  return (filter as CommandDocument).tenantId === tenantId;
}

/** The exact atomic-claim predicate emitted by persisted document saves. */
function pinsTenantOrLegacy(filter: unknown, tenantId: string): boolean {
  if (filter == null || typeof filter !== 'object' || Array.isArray(filter)) {
    return false;
  }
  const condition = (filter as CommandDocument).tenantId;
  if (condition == null || typeof condition !== 'object' || Array.isArray(condition)) {
    return false;
  }
  const keys = Object.keys(condition);
  const values = (condition as CommandDocument).$in;
  return (
    keys.length === 1 &&
    keys[0] === '$in' &&
    Array.isArray(values) &&
    values.length === 3 &&
    values[0] === tenantId &&
    values[1] === null &&
    values[2] === ''
  );
}

/** A `$lookup` reads its foreign collection inside the outer command. */
function lookupTargetsTenant(lookup: unknown, tenantId: string): boolean {
  if (lookup == null || typeof lookup !== 'object') {
    return false;
  }
  return pipelineTargetsTenant((lookup as CommandDocument).pipeline, tenantId);
}

/**
 * A pipeline is scoped when its *first* stage is the tenant `$match` the
 * binding unshifts, it writes to no other collection, and every joined read
 * scopes itself.
 *
 * Position is the whole point: `[{ $limit: 1 }, { $match: { tenantId } }]`
 * mentions the tenant but lets another tenant's row take the limited slot, and
 * a `$group` before the match has already combined every tenant's data.
 */
function pipelineTargetsTenant(pipeline: unknown, tenantId: string): boolean {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return false;
  }

  for (const stage of pipeline) {
    if (stage == null || typeof stage !== 'object') {
      continue;
    }
    const record = stage as CommandDocument;
    for (const name of COLLECTION_WRITING_STAGES) {
      if (name in record) {
        return false;
      }
    }
    if ('$lookup' in record && !lookupTargetsTenant(record.$lookup, tenantId)) {
      return false;
    }
  }

  const first = pipeline[0];
  if (first == null || typeof first !== 'object') {
    return false;
  }
  return pinsTenant((first as CommandDocument).$match, tenantId);
}

/** Every predicate a command carries, so a partially-scoped batch still fails. */
function predicatesOf(command: CommandDocument, commandName: string): unknown[] {
  const path = PREDICATE_PATHS.get(commandName);
  if (!path) {
    return [];
  }
  if (!path.list) {
    return [command[path.key]];
  }
  const operations = command[path.list];
  if (!Array.isArray(operations)) {
    return [];
  }
  return path.key ? operations.map((operation) => operation?.[path.key]) : operations;
}

/** A command reduced to the operation the probe should actually judge. */
interface ResolvedCommand {
  readonly command: CommandDocument;
  readonly commandName: string;
  readonly collection: string;
}

/**
 * Resolves the operation a wire command represents, unwrapping `explain` —
 * whose payload is the nested command rather than a collection name, and which
 * would otherwise be dropped even though `executionStats` reveals cross-tenant
 * cardinality.
 */
function resolveCommand(
  command: CommandDocument,
  commandName: string,
): ResolvedCommand | undefined {
  if (commandName === 'explain') {
    const inner = command.explain;
    if (inner == null || typeof inner !== 'object') {
      return undefined;
    }
    const innerCommand = inner as CommandDocument;
    const [innerName] = Object.keys(innerCommand);
    return innerName ? resolveCommand(innerCommand, innerName) : undefined;
  }

  // `getMore` carries the cursor id under its own name and the collection separately.
  const value = commandName === 'getMore' ? command.collection : command[commandName];
  if (typeof value !== 'string') {
    return undefined;
  }
  return { command, commandName, collection: value };
}

/** The predicates a command carries, for test failure output. */
function describePredicates(command: CommandDocument, commandName: string): string {
  if (commandName === 'aggregate') {
    return safeStringify(command.pipeline);
  }
  if (commandName === 'getMore') {
    return '(cursor continuation — no predicate)';
  }
  return safeStringify(predicatesOf(command, commandName));
}

/**
 * Whether a collation applies, checking the batched operations as well as the
 * envelope: `update` and `delete` carry collation inside each `updates[]` /
 * `deletes[]` entry, where a command-level check never sees it.
 */
function carriesCollation(command: CommandDocument, commandName: string): boolean {
  if ('collation' in command) {
    return true;
  }
  const path = PREDICATE_PATHS.get(commandName);
  if (path?.list == null) {
    return false;
  }
  const operations = command[path.list];
  if (!Array.isArray(operations)) {
    return false;
  }
  return operations.some(
    (operation) => operation != null && typeof operation === 'object' && 'collation' in operation,
  );
}

/** Whether this command is one the probe can judge at all. */
function carriesPredicate(command: CommandDocument, commandName: string): boolean {
  if (UNJUDGED_COMMANDS.has(commandName)) {
    return false;
  }
  if (commandName === 'aggregate') {
    return Array.isArray(command.pipeline);
  }
  if (!PREDICATE_PATHS.has(commandName)) {
    return true;
  }
  return predicatesOf(command, commandName).length > 0;
}

/**
 * Whether every predicate this command carries targets `tenantId`.
 * Only called for commands `carriesPredicate` has already accepted.
 */
function isScoped(command: CommandDocument, commandName: string, tenantId: string): boolean {
  // A collation can broaden equality — under a case-insensitive one,
  // `tenantId: 'tenant-a'` also matches `TENANT-A` — so literal equality no
  // longer proves isolation and the command cannot be called scoped.
  if (carriesCollation(command, commandName)) {
    return false;
  }
  if (commandName === 'aggregate') {
    return pipelineTargetsTenant(command.pipeline, tenantId);
  }
  // A cursor continuation carries no predicate, and the scope it was opened
  // under is not visible here, so it fails closed rather than passing unseen.
  if (commandName === 'getMore') {
    return false;
  }
  if (!PREDICATE_PATHS.has(commandName)) {
    return false;
  }
  return predicatesOf(command, commandName).every(
    (predicate) =>
      pinsTenant(predicate, tenantId) ||
      (commandName === 'update' && pinsTenantOrLegacy(predicate, tenantId)),
  );
}

export function attachTenantProbe(
  connection: Connection,
  collections: Iterable<string>,
): TenantProbe {
  const watched = new Set(collections);
  const databaseName = connection.db?.databaseName;
  let recording: TenantCommandRecord[] | null = null;

  const onCommandStarted = (event: {
    commandName: string;
    command: CommandDocument;
    databaseName?: string;
  }): void => {
    if (recording == null) {
      return;
    }
    // A shared MongoClient emits for every database it serves, and collection
    // names are only unique within one.
    if (event.databaseName != null && event.databaseName !== databaseName) {
      return;
    }

    const resolved = resolveCommand(event.command, event.commandName);
    if (resolved == null || !watched.has(resolved.collection)) {
      return;
    }

    const { command, commandName, collection } = resolved;
    if (!carriesPredicate(command, commandName)) {
      return;
    }

    // Async context reaches this handler, so each command is judged against the
    // tenant that was actually active when it was issued.
    const tenantId = getTenantId();
    const predicate = describePredicates(command, commandName);

    if (tenantId == null || tenantId === SYSTEM_TENANT_ID) {
      recording.push({ commandName, collection, scoped: false, predicate });
      return;
    }

    recording.push({
      commandName,
      collection,
      tenantId,
      scoped: isScoped(command, commandName, tenantId),
      predicate,
    });
  };

  connection.getClient().on('commandStarted', onCommandStarted);

  return {
    async record(fn) {
      const captured: TenantCommandRecord[] = [];
      recording = captured;
      try {
        await fn();
      } finally {
        recording = null;
      }
      return captured;
    },
    close() {
      connection.getClient().off('commandStarted', onCommandStarted);
    },
  };
}

/** Convenience for assertions: the commands that reached the wire unscoped. */
export function unscoped(records: readonly TenantCommandRecord[]): readonly TenantCommandRecord[] {
  return records.filter((record) => !record.scoped);
}
