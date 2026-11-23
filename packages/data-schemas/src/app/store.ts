import { PrincipalType } from 'librechat-data-provider';
import type { PrincipalModel, TCustomConfig } from 'librechat-data-provider';
import type { ConfigLocation, ConfigPathSegments } from './paths';
import type { ConfigOverrideState } from './mutations';
import {
  setConfigFields,
  unsetConfigPaths,
  toConfigOverrideState,
  tombstoneConfigPaths,
  replaceConfigOverrides,
  isConfigOverrideStateEmpty,
} from './mutations';
import {
  isBaseConfigPrincipal,
  sortByConfigPrecedence,
  getDefaultConfigPriority,
} from './precedence';
import { parseFieldPath, parseConfigPath, ConfigPathError } from './paths';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { getSafeErrorFields } from '~/utils/errors';
import logger from '~/config/winston';

/**
 * The portable admin-config store contract.
 *
 * Override documents are plain JSON: record keys may contain `.` or start with `$`, and no
 * engine-specific operator appears in the override semantics. An engine stores and returns
 * documents verbatim (any key encoding is the engine's own business), and every write is a
 * whole-document compare-and-swap against a revision. Mutations are pure transforms
 * (`./mutations`) applied between a read and that write, so a second engine (PostgreSQL/JSONB)
 * implements five operations and inherits the rest.
 *
 * Every engine also scopes documents to the caller's tenant as `~/tenant/conformance` requires,
 * and keeps role documents (whose ids every tenant reuses) and every `listActive` read to one
 * tenant partition (`tenantPartition`), so a merge never mixes tenants. Only a `list` that asks
 * for `acrossTenants` reads every partition the caller's scope can see, for reports that name
 * each document's tenant. The operations inherit the partition from these five: a role's
 * priority change or move (`setPriority`, `movePrincipal`) reads and writes only the caller's
 * partition, on both sides of a move.
 *
 * `./conformance` is the suite an engine must pass.
 */

/** Precondition meaning "the principal must not have a document yet" (create-only). */
export const ABSENT_CONFIG_REVISION = 'absent';

/** How many times a write without a client precondition re-reads and retries on a conflict. */
export const CONFIG_WRITE_ATTEMPTS = 3;

/** The longest pause before the first retry; it doubles for each later one. */
const CONFIG_RETRY_BASE_DELAY_MS = 20;

/** The longest pause before any retry. */
const CONFIG_RETRY_MAX_DELAY_MS = 200;

/** `<document id>:<configVersion>`, or {@link ABSENT_CONFIG_REVISION}. */
export type ConfigRevision = string;

const REVISION_PATTERN = /^([A-Za-z0-9_-]{1,64}):(0|[1-9]\d{0,14})$/;

export interface ConfigPrincipal {
  principalType: PrincipalType;
  principalId: string;
}

/** A principal's override document as every engine returns it. */
export interface ConfigRecord {
  /** The engine's identity for the document; changes when a document is deleted and recreated. */
  _id: string;
  principalType: PrincipalType;
  principalId: string;
  principalModel: PrincipalModel;
  priority: number;
  overrides: Partial<TCustomConfig>;
  tombstones: string[];
  isActive: boolean;
  /** Incremented by every write; `0` for a legacy document that never had it. */
  configVersion: number;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Everything a write sets. Identity, version, tenant and timestamps belong to the engine. */
export type ConfigDraft = Pick<
  ConfigRecord,
  'principalModel' | 'priority' | 'overrides' | 'tombstones' | 'isActive'
>;

/** The parts of a document that name its principal and its tombstones. */
export type ConfigTombstones = Pick<
  ConfigRecord,
  'principalType' | 'principalId' | 'tenantId' | 'tombstones'
>;

/**
 * Which documents a `list` returns: only active or inactive ones, and with `acrossTenants`, the
 * role documents of every tenant partition the caller's scope can read instead of one partition's.
 */
export interface ConfigListFilter {
  isActive?: boolean;
  acrossTenants?: boolean;
}

export interface ConfigStore {
  /** The principal's document, active or not, or `null` when it has none. */
  read(principal: ConfigPrincipal): Promise<ConfigRecord | null>;
  /** Every document the filter selects, in {@link compareConfigRecords} order. */
  list(filter?: ConfigListFilter): Promise<ConfigRecord[]>;
  /** The active documents of exactly these principals, in {@link compareConfigRecords} order. */
  listActive(principals: readonly ConfigPrincipal[]): Promise<ConfigRecord[]>;
  /**
   * Writes the whole document when the stored one is at `expected` (or, for
   * {@link ABSENT_CONFIG_REVISION}, when none exists), incrementing `configVersion`. Any other
   * state throws {@link ConfigRevisionConflictError} and changes nothing.
   *
   * A create that committed returns the document it created even when the engine's first
   * acknowledgement of it was lost: the engine chooses the new identity before it writes and
   * settles a lost acknowledgement by looking that identity up. Any other error means the
   * create did not commit, or that the engine could not tell; a caller then never removes a
   * document it finds, since it cannot confirm the document is its own.
   */
  write(
    principal: ConfigPrincipal,
    draft: ConfigDraft,
    expected: ConfigRevision,
  ): Promise<ConfigRecord>;
  /**
   * Deletes the principal's document and returns it, or returns `null` when there is none. With
   * `expected`, deletes only a document at that revision and throws
   * {@link ConfigRevisionConflictError} for any other state.
   */
  remove(principal: ConfigPrincipal, expected?: ConfigRevision): Promise<ConfigRecord | null>;
  /**
   * Re-inserts a deleted document as it was (identity and version included) only when the
   * principal has none, so a document written since is never replaced. Returns whether it did.
   */
  restore(snapshot: ConfigRecord): Promise<boolean>;
}

/**
 * The stored document is not at the revision a write was conditioned on. `currentRevision` is
 * the revision found (`null` when there is no document), when the failing step knew it.
 */
export class ConfigRevisionConflictError extends Error {
  readonly code = 'CONFIG_VERSION_CONFLICT';
  readonly currentRevision: ConfigRevision | null | undefined;

  constructor(currentRevision?: ConfigRevision | null) {
    super('Config was modified by another request');
    this.name = 'ConfigRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export function isConfigRevisionConflict(error: unknown): error is ConfigRevisionConflictError {
  return (
    error instanceof ConfigRevisionConflictError ||
    (error instanceof Error && (error as { code?: unknown }).code === 'CONFIG_VERSION_CONFLICT')
  );
}

/**
 * Why a document move was refused before anything changed: the target principal already has
 * a document, or either side is the tenant-wide Base principal, which never moves.
 */
export type ConfigMoveRefusal = 'CONFIG_PRINCIPAL_EXISTS' | 'CONFIG_PRINCIPAL_RESERVED';

const CONFIG_MOVE_REFUSALS: ReadonlySet<unknown> = new Set<ConfigMoveRefusal>([
  'CONFIG_PRINCIPAL_EXISTS',
  'CONFIG_PRINCIPAL_RESERVED',
]);

/** `movePrincipal` refused the move and changed nothing; `code` says why. */
export class ConfigMoveRefusedError extends Error {
  readonly code: ConfigMoveRefusal;

  constructor(code: ConfigMoveRefusal) {
    super(
      code === 'CONFIG_PRINCIPAL_EXISTS'
        ? 'The target principal already has a config document'
        : 'The base config document cannot be moved or replaced',
    );
    this.name = 'ConfigMoveRefusedError';
    this.code = code;
  }
}

/** Whether `error` is a refused move, optionally for one specific reason. */
export function isConfigMoveRefused(
  error: unknown,
  code?: ConfigMoveRefusal,
): error is ConfigMoveRefusedError {
  if (!(error instanceof Error)) {
    return false;
  }
  const actual = (error as { code?: unknown }).code;
  return CONFIG_MOVE_REFUSALS.has(actual) && (code === undefined || actual === code);
}

export function getConfigRevision(record: {
  _id: { toString(): string };
  configVersion?: number | null;
}): ConfigRevision {
  return `${record._id.toString()}:${record.configVersion ?? 0}`;
}

/** The revision a write must be conditioned on to replace `record` (or to create it). */
export function getExpectedRevision(record: ConfigRecord | null): ConfigRevision {
  return record ? getConfigRevision(record) : ABSENT_CONFIG_REVISION;
}

/** Splits a document revision into identity and version; `null` for anything else. */
export function parseConfigRevision(
  revision: ConfigRevision,
): { id: string; configVersion: number } | null {
  const match = REVISION_PATTERN.exec(revision);
  return match ? { id: match[1], configVersion: Number(match[2]) } : null;
}

/** Whether a client-supplied precondition is well formed: `absent` or a document revision. */
export function isConfigRevision(value: unknown): value is ConfigRevision {
  return (
    typeof value === 'string' &&
    (value === ABSENT_CONFIG_REVISION || parseConfigRevision(value) != null)
  );
}

/**
 * Store order: ascending priority, then the engine identity, so equal priorities never shuffle.
 * It is what an engine can sort by natively; the operations re-sort into merge order
 * (`compareConfigPrecedence`), which also puts Base first and ranks principal types.
 */
export function compareConfigRecords(
  left: Pick<ConfigRecord, '_id' | 'priority'>,
  right: Pick<ConfigRecord, '_id' | 'priority'>,
): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  if (left._id === right._id) {
    return 0;
  }
  return left._id < right._id ? -1 : 1;
}

/**
 * The pause in milliseconds before retry `attempt` (1-based) of a write that lost a race: a random
 * point in the upper half of a ceiling that doubles per retry (20, 40, 80 ms, up to 200), so
 * writers that lost the same race re-read at different times instead of colliding again.
 */
export function getConfigRetryDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(
    CONFIG_RETRY_MAX_DELAY_MS,
    CONFIG_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function pauseBeforeRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, getConfigRetryDelay(attempt)));
}

/** What one attempt of {@link runConfigMutation} decided: write `draft`, or stop with `result`. */
export type ConfigMutationPlan<T> = { draft: ConfigDraft; result?: T } | { draft: null; result: T };

export type ConfigMutationOutcome<T> =
  | { written: true; record: ConfigRecord; previous: ConfigRecord | null; result?: T }
  | { written: false; current: ConfigRecord | null; result: T };

export interface ConfigMutationIO {
  read(): Promise<ConfigRecord | null>;
  write(draft: ConfigDraft, expected: ConfigRevision): Promise<ConfigRecord>;
}

/**
 * Read, plan, compare-and-swap. `plan` sees the document as stored and returns the whole next
 * draft (or a reason to stop), so validation and secret preservation always run against what
 * the write replaces.
 *
 * With `expectedRevision` the write happens only on that revision: a mismatch at read or at
 * write throws {@link ConfigRevisionConflictError}. Without it, a concurrent write is absorbed
 * by pausing ({@link getConfigRetryDelay}), re-reading and re-planning, up to `attempts` times,
 * and only then throws.
 */
export async function runConfigMutation<T = never>(
  io: ConfigMutationIO,
  plan: (current: ConfigRecord | null) => ConfigMutationPlan<T> | Promise<ConfigMutationPlan<T>>,
  options: { expectedRevision?: ConfigRevision; attempts?: number } = {},
): Promise<ConfigMutationOutcome<T>> {
  const { expectedRevision } = options;
  const attempts = expectedRevision ? 1 : Math.max(1, options.attempts ?? CONFIG_WRITE_ATTEMPTS);
  for (let attempt = 1; ; attempt++) {
    const current = await io.read();
    const currentRevision = current ? getConfigRevision(current) : null;
    if (expectedRevision && expectedRevision !== (currentRevision ?? ABSENT_CONFIG_REVISION)) {
      throw new ConfigRevisionConflictError(currentRevision);
    }
    const next = await plan(current);
    if (next.draft == null) {
      return { written: false, current, result: next.result as T };
    }
    try {
      const record = await io.write(next.draft, getExpectedRevision(current));
      return { written: true, record, previous: current, result: next.result };
    } catch (error) {
      if (!isConfigRevisionConflict(error) || attempt >= attempts) {
        throw error;
      }
    }
    await pauseBeforeRetry(attempt);
  }
}

/** Options every principal-scoped write accepts. */
export interface ConfigWriteOptions {
  /** Write only when the stored document is at this revision (`absent`: only when none exists). */
  expectedRevision?: ConfigRevision;
}

export interface ConfigLifecycleOptions extends ConfigWriteOptions {
  /**
   * Act only on a document that holds nothing (see `isConfigOverrideStateEmpty`); otherwise
   * resolve to `null` and leave it unchanged. Assign-only callers manage profiles they cannot
   * edit, so they may only touch empty ones.
   */
  expectEmpty?: boolean;
}

/**
 * A path a removal or tombstone addresses: a dotted field path, which cannot name a key that
 * contains a dot, or the path's segments, which can. A dotted path may name an entry of an
 * array merged by key by its key (`endpoints.custom["Name"].headers`, see `parseConfigPath`).
 */
export type ConfigPathInput = string | { segments: ConfigPathSegments };

/** One path, or several removed or tombstoned in the same write. */
export type ConfigPathInputs = ConfigPathInput | readonly ConfigPathInput[];

function isEmptyRecord(record: ConfigRecord): boolean {
  return isConfigOverrideStateEmpty(toConfigOverrideState(record));
}

/**
 * The next draft from `state`. An omitted priority keeps the stored one, and a document a
 * write creates gets its principal type's default (`getDefaultConfigPriority`).
 */
function toDraft(
  principal: ConfigPrincipal,
  current: ConfigRecord | null,
  state: ConfigOverrideState,
  defaults: Pick<ConfigDraft, 'principalModel'> & { priority?: number },
): ConfigDraft {
  return {
    principalModel: defaults.principalModel,
    priority: defaults.priority ?? current?.priority ?? getDefaultConfigPriority(principal),
    overrides: state.overrides,
    tombstones: state.tombstones,
    isActive: current?.isActive ?? true,
  };
}

/** Everything a stored document carries over to another principal or into a rewrite. */
export function toConfigDraft(record: ConfigRecord): ConfigDraft {
  return {
    principalModel: record.principalModel,
    priority: record.priority,
    ...toConfigOverrideState(record),
    isActive: record.isActive,
  };
}

/** The record a plan that always drafts has written. */
function writtenRecord(outcome: ConfigMutationOutcome<never>): ConfigRecord {
  if (!outcome.written) {
    throw new Error('Config mutation planned no write');
  }
  return outcome.record;
}

/** A path input as a location; a malformed keyed path throws a `ConfigPathError`. */
function toLocation(path: ConfigPathInput): ConfigLocation {
  if (typeof path !== 'string') {
    return { segments: path.segments };
  }
  const location = parseConfigPath(path);
  if (!location) {
    throw new ConfigPathError(parseFieldPath(path), 'keyed_path');
  }
  return location;
}

function toPathList(paths: ConfigPathInputs): ConfigLocation[] {
  return Array.isArray(paths) ? paths.map(toLocation) : [toLocation(paths as ConfigPathInput)];
}

function isPathOrDescendant(path: string, fieldPath: string): boolean {
  return path === fieldPath || path.startsWith(`${fieldPath}.`);
}

function toTombstones(record: ConfigRecord): ConfigTombstones {
  const { principalType, principalId, tenantId, tombstones } = record;
  return tenantId == null
    ? { principalType, principalId, tombstones }
    : { principalType, principalId, tenantId, tombstones };
}

/** A write that may find nothing to change: the document after it, and whether it wrote. */
export type ConfigWriteOutcome = { config: ConfigRecord; changed: boolean };

export interface ConfigOperations {
  findConfig(
    principal: ConfigPrincipal,
    options?: { includeInactive?: boolean },
  ): Promise<ConfigRecord | null>;
  /** Every document (optionally only active or inactive ones), in merge precedence order. */
  listConfigs(filter?: { isActive?: boolean }): Promise<ConfigRecord[]>;
  /** Base and the given principals' active documents, in merge precedence order. */
  getApplicableConfigs(
    principals?: ReadonlyArray<{ principalType: string; principalId?: { toString(): string } }>,
  ): Promise<ConfigRecord[]>;
  listTombstones(fieldPath: string): Promise<ConfigTombstones[]>;
  replaceOverrides(
    principal: ConfigPrincipal,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority?: number,
    options?: ConfigLifecycleOptions & { preservePriority?: boolean },
  ): Promise<ConfigRecord | null>;
  setFields(
    principal: ConfigPrincipal,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority?: number,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord>;
  tombstoneFields(
    principal: ConfigPrincipal,
    principalModel: PrincipalModel,
    fieldPaths: ConfigPathInputs,
    priority?: number,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord>;
  unsetFields(
    principal: ConfigPrincipal,
    fieldPaths: ConfigPathInputs,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord | null>;
  deleteConfig(
    principal: ConfigPrincipal,
    options?: ConfigLifecycleOptions,
  ): Promise<ConfigRecord | null>;
  setActive(
    principal: ConfigPrincipal,
    isActive: boolean,
    options?: ConfigLifecycleOptions,
  ): Promise<ConfigWriteOutcome | null>;
  setPriority(
    principal: ConfigPrincipal,
    priority: number,
    options?: ConfigWriteOptions,
  ): Promise<ConfigWriteOutcome | null>;
  movePrincipal(
    from: ConfigPrincipal,
    to: ConfigPrincipal,
    options?: ConfigMoveOptions,
  ): Promise<ConfigRecord | null>;
}

export interface ConfigMoveOptions {
  /**
   * Move `from`'s document only while it is this one (by `_id`, at any version): how a caller
   * undoes its own move without taking a document someone else put there since.
   */
  identity?: string;
}

/**
 * The principal-scoped operations every caller uses, built only on the {@link ConfigStore}
 * contract, so each engine gets identical override semantics. A dotted `fieldPath` argument is
 * split into segments and so cannot address a key that itself contains a dot; removals take
 * `{ segments }` for that, and `setFields` callers write such a record whole at its own path.
 */
export function createConfigOperations(store: ConfigStore): ConfigOperations {
  function mutate<T = never>(
    principal: ConfigPrincipal,
    plan: (current: ConfigRecord | null) => ConfigMutationPlan<T>,
    options?: ConfigWriteOptions,
  ): Promise<ConfigMutationOutcome<T>> {
    return runConfigMutation<T>(
      {
        read: () => store.read(principal),
        write: (draft, expected) => store.write(principal, draft, expected),
      },
      plan,
      { expectedRevision: options?.expectedRevision },
    );
  }

  async function findConfig(
    principal: ConfigPrincipal,
    options?: { includeInactive?: boolean },
  ): Promise<ConfigRecord | null> {
    const record = await store.read(principal);
    if (!record || (!options?.includeInactive && !record.isActive)) {
      return null;
    }
    return record;
  }

  async function listConfigs(filter?: { isActive?: boolean }): Promise<ConfigRecord[]> {
    return sortByConfigPrecedence(await store.list(filter));
  }

  /** Base first in the query, then every principal that has an id; inactive documents excluded. */
  async function getApplicableConfigs(
    principals?: ReadonlyArray<{ principalType: string; principalId?: { toString(): string } }>,
  ): Promise<ConfigRecord[]> {
    const query: ConfigPrincipal[] = [
      { principalType: PrincipalType.ROLE, principalId: BASE_CONFIG_PRINCIPAL_ID },
    ];
    for (const principal of principals ?? []) {
      if (principal.principalId !== undefined) {
        query.push({
          principalType: principal.principalType as PrincipalType,
          principalId: principal.principalId.toString(),
        });
      }
    }
    return sortByConfigPrecedence(await store.listActive(query));
  }

  /**
   * The active documents with a tombstone at `fieldPath` or below it, in store order, without
   * their overrides. Tombstones are dotted paths, so `fieldPath` is too.
   */
  async function listTombstones(fieldPath: string): Promise<ConfigTombstones[]> {
    const found: ConfigTombstones[] = [];
    for (const record of await store.list({ isActive: true, acrossTenants: true })) {
      if (record.tombstones.some((path) => isPathOrDescendant(path, fieldPath))) {
        found.push(toTombstones(record));
      }
    }
    return found;
  }

  /**
   * Replaces the overrides whole and activates the document; tombstones stay. An omitted
   * `priority` (or `preservePriority`) keeps the stored one, so a replace never reorders
   * profiles it was not asked to.
   */
  async function replaceOverrides(
    principal: ConfigPrincipal,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority?: number,
    options?: ConfigLifecycleOptions & { preservePriority?: boolean },
  ): Promise<ConfigRecord | null> {
    const outcome = await mutate<null>(
      principal,
      (current) => {
        if (options?.expectEmpty && current && !isEmptyRecord(current)) {
          return { draft: null, result: null };
        }
        const state = replaceConfigOverrides(toConfigOverrideState(current), overrides);
        const keptPriority = options?.preservePriority ? (current?.priority ?? priority) : priority;
        return {
          draft: {
            ...toDraft(principal, current, state, { principalModel, priority: keptPriority }),
            isActive: true,
          },
        };
      },
      options,
    );
    return outcome.written ? outcome.record : null;
  }

  /** Sets dotted field paths, clearing the tombstones they write over. Creates the document. */
  async function setFields(
    principal: ConfigPrincipal,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority?: number,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord> {
    const writes = Object.entries(fields).map(([fieldPath, value]) => ({
      segments: parseFieldPath(fieldPath),
      value,
    }));
    const outcome = await mutate(
      principal,
      (current) => ({
        draft: toDraft(
          principal,
          current,
          setConfigFields(toConfigOverrideState(current), writes),
          { principalModel, priority },
        ),
      }),
      options,
    );
    return writtenRecord(outcome);
  }

  /** Tombstones every path in one write (a secret and its preview companion together). */
  async function tombstoneFields(
    principal: ConfigPrincipal,
    principalModel: PrincipalModel,
    fieldPaths: ConfigPathInputs,
    priority?: number,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord> {
    const paths = toPathList(fieldPaths);
    const outcome = await mutate(
      principal,
      (current) => ({
        draft: toDraft(
          principal,
          current,
          tombstoneConfigPaths(toConfigOverrideState(current), paths),
          { principalModel, priority },
        ),
      }),
      options,
    );
    return writtenRecord(outcome);
  }

  /** Removes every path in one write, pruning emptied parents. `null` when there is no document. */
  async function unsetFields(
    principal: ConfigPrincipal,
    fieldPaths: ConfigPathInputs,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord | null> {
    const paths = toPathList(fieldPaths);
    const outcome = await mutate<null>(
      principal,
      (current) => {
        if (!current) {
          return { draft: null, result: null };
        }
        const state = unsetConfigPaths(toConfigOverrideState(current), paths);
        return { draft: toDraft(principal, current, state, current) };
      },
      options,
    );
    return outcome.written ? outcome.record : null;
  }

  /** Deletes the principal's document; `null` when there is none (or `expectEmpty` refused). */
  async function deleteConfig(
    principal: ConfigPrincipal,
    options?: ConfigLifecycleOptions,
  ): Promise<ConfigRecord | null> {
    if (!options?.expectEmpty && !options?.expectedRevision) {
      return store.remove(principal);
    }
    for (let attempt = 1; ; attempt++) {
      const current = await store.read(principal);
      const currentRevision = current ? getConfigRevision(current) : null;
      if (
        options.expectedRevision &&
        options.expectedRevision !== (currentRevision ?? ABSENT_CONFIG_REVISION)
      ) {
        throw new ConfigRevisionConflictError(currentRevision);
      }
      if (!current || (options.expectEmpty && !isEmptyRecord(current))) {
        return null;
      }
      try {
        return await store.remove(principal, getConfigRevision(current));
      } catch (error) {
        if (
          !isConfigRevisionConflict(error) ||
          options.expectedRevision ||
          attempt >= CONFIG_WRITE_ATTEMPTS
        ) {
          throw error;
        }
      }
      await pauseBeforeRetry(attempt);
    }
  }

  /** Sets `isActive`, reporting whether this write changed it. `null` when there is no document. */
  async function setActive(
    principal: ConfigPrincipal,
    isActive: boolean,
    options?: ConfigLifecycleOptions,
  ): Promise<ConfigWriteOutcome | null> {
    const outcome = await mutate<ConfigWriteOutcome | null>(
      principal,
      (current) => {
        if (!current || (options?.expectEmpty && !isEmptyRecord(current))) {
          return { draft: null, result: null };
        }
        if (current.isActive === isActive) {
          return { draft: null, result: { config: current, changed: false } };
        }
        return { draft: { ...toConfigDraft(current), isActive } };
      },
      options,
    );
    return outcome.written ? { config: outcome.record, changed: true } : outcome.result;
  }

  /**
   * Sets the document's priority and nothing else: overrides, tombstones and `isActive` stay.
   * `null` when there is no document; an unchanged priority is not written.
   */
  async function setPriority(
    principal: ConfigPrincipal,
    priority: number,
    options?: ConfigWriteOptions,
  ): Promise<ConfigWriteOutcome | null> {
    const outcome = await mutate<ConfigWriteOutcome | null>(
      principal,
      (current) => {
        if (!current) {
          return { draft: null, result: null };
        }
        if (current.priority === priority) {
          return { draft: null, result: { config: current, changed: false } };
        }
        return { draft: { ...toConfigDraft(current), priority } };
      },
      options,
    );
    return outcome.written ? { config: outcome.record, changed: true } : outcome.result;
  }

  /**
   * The create-only copy a move starts with; a document already at `to` refuses the move. A
   * copy that committed is returned even when its acknowledgement was lost (see
   * {@link ConfigStore.write}), so any other failure leaves nothing this move can confirm it
   * created, and nothing is removed.
   */
  async function copyTo(to: ConfigPrincipal, source: ConfigRecord): Promise<ConfigRecord> {
    try {
      return await store.write(to, toConfigDraft(source), ABSENT_CONFIG_REVISION);
    } catch (error) {
      throw isConfigRevisionConflict(error)
        ? new ConfigMoveRefusedError('CONFIG_PRINCIPAL_EXISTS')
        : error;
    }
  }

  /**
   * Moves `from`'s document, as stored, to `to` (a role rename), and returns it as `to` now
   * holds it, or `null` when `from` has none. It is a create-only write at `to` followed by a
   * removal of `from` at the revision just copied. The moved document has a new identity, so
   * revisions of the old one no longer match.
   *
   * A refusal changes nothing and throws {@link ConfigMoveRefusedError}:
   * `CONFIG_PRINCIPAL_EXISTS` when `to` already has a document, and `CONFIG_PRINCIPAL_RESERVED`
   * when either side is Base, which is tenant-wide and never one principal's document. When
   * `from` changes between the copy and the removal, the copy is withdrawn and the move
   * retried. Once the retries run out, or when the copy was edited meanwhile and so is kept,
   * the revision conflict is rethrown. When a failed removal cannot be confirmed by reading
   * `from` back, the copy is kept, as it may be the only one left, and the removal's failure
   * is rethrown. A copy that cannot be withdrawn is logged with its revision, so an operator can
   * remove it. With `identity`, a `from` that holds another document (or none) moves nothing
   * and resolves to `null`.
   */
  async function movePrincipal(
    from: ConfigPrincipal,
    to: ConfigPrincipal,
    options?: ConfigMoveOptions,
  ): Promise<ConfigRecord | null> {
    if (isBaseConfigPrincipal(from) || isBaseConfigPrincipal(to)) {
      throw new ConfigMoveRefusedError('CONFIG_PRINCIPAL_RESERVED');
    }
    for (let attempt = 1; ; attempt++) {
      const current = await store.read(from);
      if (!current || (options?.identity != null && current._id !== options.identity)) {
        return null;
      }
      const moved = await copyTo(to, current);
      let failure: unknown;
      try {
        await store.remove(from, getConfigRevision(current));
        return moved;
      } catch (error) {
        failure = error;
      }
      /**
       * A removal can fail after it committed; the copy is then the only one, so it stays. A
       * source that cannot be read back may be gone as well, so the copy stays then too.
       */
      const remaining = await store.read(from).catch(() => {
        throw failure;
      });
      if (remaining == null) {
        return moved;
      }
      await store.remove(to, getConfigRevision(moved)).catch((withdrawal: unknown) => {
        logger.error('[configStore] A moved config document could not be withdrawn from its copy', {
          principalType: to.principalType,
          principalId: to.principalId,
          revision: getConfigRevision(moved),
          ...getSafeErrorFields(withdrawal),
        });
        throw withdrawal;
      });
      if (!isConfigRevisionConflict(failure) || attempt >= CONFIG_WRITE_ATTEMPTS) {
        throw failure;
      }
      await pauseBeforeRetry(attempt);
    }
  }

  return {
    findConfig,
    listConfigs,
    getApplicableConfigs,
    listTombstones,
    replaceOverrides,
    setFields,
    tombstoneFields,
    unsetFields,
    deleteConfig,
    setActive,
    setPriority,
    movePrincipal,
  };
}
