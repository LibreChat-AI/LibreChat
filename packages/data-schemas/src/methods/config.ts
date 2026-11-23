import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import type { PrincipalModel, TCustomConfig } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  ConfigDraft,
  ConfigStore,
  ConfigMoveOptions,
  ConfigWriteOutcome,
  ConfigRecord,
  ConfigRevision,
  ConfigPrincipal,
  ConfigListFilter,
  ConfigTombstones,
  ConfigPathInputs,
  ConfigWriteOptions,
  ConfigLifecycleOptions,
} from '~/app/store';
import type { TenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import type { StoredKeyForm } from './encoding';
import type { IConfig } from '~/types';
import {
  ABSENT_CONFIG_REVISION,
  ConfigRevisionConflictError,
  createConfigOperations,
  getConfigRevision,
  parseConfigRevision,
  isConfigRevisionConflict,
} from '~/app/store';
import {
  toStoredKeys,
  readStoredKeys,
  getStoredKeyForms,
  CONFIG_KEY_ENCODING_VERSION,
} from './encoding';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { isFieldNameRejection } from '~/utils/fields';
import logger from '~/config/winston';

/** A config document as MongoDB returns it, before the binding decodes it. */
interface StoredConfig {
  _id: Types.ObjectId | string;
  principalType: PrincipalType;
  principalId: Types.ObjectId | string;
  principalModel: PrincipalModel;
  priority: number;
  overrides?: Partial<TCustomConfig>;
  tombstones?: string[];
  isActive?: boolean;
  configVersion?: number | null;
  keyEncoding?: number;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Engine order for {@link ConfigStore.list}: ascending priority, then identity. */
const STORE_ORDER = { priority: 1, _id: 1 } as const;

function toRecord(document: StoredConfig): ConfigRecord {
  const overrides = document.overrides ?? {};
  const record: ConfigRecord = {
    _id: document._id.toString(),
    principalType: document.principalType,
    principalId: document.principalId.toString(),
    principalModel: document.principalModel,
    priority: document.priority,
    overrides: readStoredKeys(overrides, document.keyEncoding === CONFIG_KEY_ENCODING_VERSION),
    tombstones: Array.isArray(document.tombstones) ? document.tombstones : [],
    isActive: document.isActive === true,
    configVersion: document.configVersion ?? 0,
  };
  if (document.tenantId != null) {
    record.tenantId = document.tenantId;
  }
  if (document.createdAt != null) {
    record.createdAt = document.createdAt;
  }
  if (document.updatedAt != null) {
    record.updatedAt = document.updatedAt;
  }
  return record;
}

/** A principal's document in one tenant partition, as role documents are addressed. */
type PrincipalFilter = ConfigPrincipal | (ConfigPrincipal & TenantPartitionFilter);

function identityFilter(principal: ConfigPrincipal): ConfigPrincipal {
  return { principalType: principal.principalType, principalId: principal.principalId };
}

/**
 * The filter that addresses one principal's document. A role's document, `__base__` included,
 * is addressed in the active tenant partition (`tenantPartition`): role ids are names every
 * tenant reuses and a document's identity includes its tenant (the unique index is principal
 * plus `tenantId`), so without a tenant in context an unpartitioned filter would match
 * whichever tenant's document comes first, and an unscoped admin write could land in a tenant's
 * profile that the deployment's own resolution never reads. Group and user ids are unique across
 * tenants, so their documents are addressed by id alone, like the groups and users themselves:
 * inside a tenant the tenant plugin still scopes them, and outside one a group's or user's
 * cleanup reaches its document whichever tenant holds it.
 */
function principalFilter(principal: ConfigPrincipal, operation: string): PrincipalFilter {
  const filter = identityFilter(principal);
  if (principal.principalType !== PrincipalType.ROLE) {
    return filter;
  }
  return { ...filter, ...tenantPartitionFilter(operation) };
}

/** A legacy document may predate `configVersion`; version 0 matches it too. */
function versionFilter(configVersion: number): number | { $in: Array<number | null> } {
  return configVersion === 0 ? { $in: [0, null] } : configVersion;
}

function toObjectId(id: unknown): unknown {
  if (id instanceof Types.ObjectId) {
    return id;
  }
  return typeof id === 'string' && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** The filter that pins a document revision, or `null` when the revision can never match. */
function revisionFilter(
  principal: ConfigPrincipal,
  revision: ConfigRevision,
  operation: string,
): Record<string, unknown> | null {
  const parsed = parseConfigRevision(revision);
  if (!parsed || !Types.ObjectId.isValid(parsed.id)) {
    return null;
  }
  return {
    ...principalFilter(principal, operation),
    _id: new Types.ObjectId(parsed.id),
    configVersion: versionFilter(parsed.configVersion),
  };
}

/** Override keys in the form one write stores them, and whether that form carries the marker. */
interface StoredKeys {
  overrides: Partial<TCustomConfig>;
  encoded: boolean;
}

/**
 * The Mongoose engine for the portable config store. Override keys are stored raw where the
 * engine accepts them and encoded where it refuses them (see `./encoding`), and every read
 * decodes them. Queries run through the `Config` model, so the tenant-isolation plugin scopes
 * every read and write; role documents are also kept to one tenant partition (`principalFilter`),
 * and `listActive`, which a merge reads, draws every document from one partition.
 */
export function createConfigStore(mongoose: typeof import('mongoose')): ConfigStore {
  const model = () => mongoose.models.Config as Model<IConfig>;
  /** Set once the engine refuses a raw key name, so later writes encode without asking again. */
  let refusesRawKeys = false;

  /**
   * Runs `write` with the overrides raw, or encoded when a raw read could not return them
   * unchanged. When the engine refuses a raw key name, the refused write changed nothing, so it
   * runs once more encoded, under the same precondition.
   */
  async function storeKeys<T>(
    overrides: Partial<TCustomConfig>,
    write: (keys: StoredKeys) => Promise<T>,
  ): Promise<T> {
    const [form, fallback] = getStoredKeyForms(overrides, refusesRawKeys);
    const run = (next: StoredKeyForm) =>
      write({ overrides: toStoredKeys(overrides, next), encoded: next === 'encoded' });
    try {
      return await run(form);
    } catch (error) {
      if (!fallback || !isFieldNameRejection(error)) {
        throw error;
      }
      refusesRawKeys = true;
      logger.warn(
        '[configStore] The database refused a raw key name in config overrides; storing override keys encoded from now on',
      );
      return run(fallback);
    }
  }

  async function read(principal: ConfigPrincipal): Promise<ConfigRecord | null> {
    const document = await model()
      .findOne(principalFilter(principal, 'configStore.read'))
      .lean<StoredConfig>();
    return document ? toRecord(document) : null;
  }

  /**
   * Every document the caller can address by principal: the role documents of the active tenant
   * partition, and the group and user documents the tenant plugin lets it see. `acrossTenants`
   * drops the partition, so role documents of every tenant the plugin lets it see are listed too.
   */
  async function list(filter?: ConfigListFilter): Promise<ConfigRecord[]> {
    const where = {
      ...(filter?.acrossTenants
        ? {}
        : {
            $or: [
              { principalType: { $ne: PrincipalType.ROLE } },
              { principalType: PrincipalType.ROLE, ...tenantPartitionFilter('configStore.list') },
            ],
          }),
      ...(filter?.isActive !== undefined ? { isActive: filter.isActive } : {}),
    };
    const documents = await model().find(where).sort(STORE_ORDER).lean<StoredConfig[]>();
    return documents.map(toRecord);
  }

  /**
   * The active documents of `principals`, all from one tenant partition: the active tenant's, or
   * the tenantless ones outside a tenant. Role ids are names shared across tenants, so an
   * unpartitioned read would merge every tenant's `__base__` and same-named role documents into
   * one config.
   */
  async function listActive(principals: readonly ConfigPrincipal[]): Promise<ConfigRecord[]> {
    if (principals.length === 0) {
      return [];
    }
    const documents = await model()
      .find({
        $and: [
          { $or: principals.map(identityFilter) },
          tenantPartitionFilter('configStore.listActive'),
        ],
        isActive: true,
      })
      .sort(STORE_ORDER)
      .lean<StoredConfig[]>();
    return documents.map(toRecord);
  }

  /**
   * Inserts the principal's document only when it has none. An existing document matches the
   * principal filter, `$setOnInsert` leaves it untouched, and the `_id` it returns is not the one
   * offered, so the conflict is seen without relying on the unique principal index (which some
   * engines, such as DocumentDB elastic clusters, do not enforce); the index still turns two
   * racing inserts into a duplicate-key conflict. Timestamps are set here because Mongoose would
   * otherwise `$set` `updatedAt` on the document it found.
   *
   * The `_id` is chosen here, so an insert whose acknowledgement is lost (the connection drops
   * after the server applied it, where the driver cannot retry the write) is settled by looking
   * that `_id` up: found at version 1, the insert committed and its document is returned, as
   * the contract requires. Otherwise, or when the lookup fails too, the write's own error is
   * rethrown.
   */
  async function create(
    principal: ConfigPrincipal,
    fields: Record<string, unknown>,
  ): Promise<ConfigRecord> {
    const _id = new Types.ObjectId();
    const now = new Date();
    try {
      const document = await model()
        .findOneAndUpdate(
          principalFilter(principal, 'configStore.write'),
          {
            $setOnInsert: { ...fields, _id, configVersion: 1, createdAt: now, updatedAt: now },
          },
          { upsert: true, new: true, timestamps: false, setDefaultsOnInsert: true },
        )
        .lean<StoredConfig>();
      if (!document) {
        throw new ConfigRevisionConflictError();
      }
      const record = toRecord(document);
      if (record._id !== _id.toString()) {
        throw new ConfigRevisionConflictError(getConfigRevision(record));
      }
      return record;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConfigRevisionConflictError();
      }
      if (isConfigRevisionConflict(error) || isFieldNameRejection(error)) {
        throw error;
      }
      const created = await model()
        .findOne({ ...principalFilter(principal, 'configStore.write'), _id, configVersion: 1 })
        .lean<StoredConfig>()
        .catch(() => null);
      if (created) {
        return toRecord(created);
      }
      throw error;
    }
  }

  async function write(
    principal: ConfigPrincipal,
    draft: ConfigDraft,
    expected: ConfigRevision,
  ): Promise<ConfigRecord> {
    const fields = (keys: StoredKeys): Record<string, unknown> => ({
      principalModel: draft.principalModel,
      priority: draft.priority,
      overrides: keys.overrides,
      tombstones: [...draft.tombstones],
      isActive: draft.isActive,
      ...(keys.encoded ? { keyEncoding: CONFIG_KEY_ENCODING_VERSION } : {}),
    });
    if (expected === ABSENT_CONFIG_REVISION) {
      return storeKeys(draft.overrides ?? {}, (keys) => create(principal, fields(keys)));
    }
    const filter = revisionFilter(principal, expected, 'configStore.write');
    if (!filter) {
      throw new ConfigRevisionConflictError();
    }
    const configVersion = (parseConfigRevision(expected)?.configVersion ?? 0) + 1;
    const updated = await storeKeys(draft.overrides ?? {}, (keys) =>
      model()
        .findOneAndUpdate(
          filter,
          {
            $set: { ...fields(keys), configVersion },
            /** A raw write clears a marker an earlier encoded write left. */
            ...(keys.encoded ? {} : { $unset: { keyEncoding: '' } }),
          },
          { new: true },
        )
        .lean<StoredConfig>(),
    );
    if (!updated) {
      throw new ConfigRevisionConflictError();
    }
    return toRecord(updated);
  }

  async function remove(
    principal: ConfigPrincipal,
    expected?: ConfigRevision,
  ): Promise<ConfigRecord | null> {
    if (expected === undefined) {
      const deleted = await model()
        .findOneAndDelete(principalFilter(principal, 'configStore.remove'))
        .lean<StoredConfig>();
      return deleted ? toRecord(deleted) : null;
    }
    if (expected === ABSENT_CONFIG_REVISION) {
      const current = await read(principal);
      if (current) {
        throw new ConfigRevisionConflictError(getConfigRevision(current));
      }
      return null;
    }
    const filter = revisionFilter(principal, expected, 'configStore.remove');
    const deleted = filter ? await model().findOneAndDelete(filter).lean<StoredConfig>() : null;
    if (!deleted) {
      throw new ConfigRevisionConflictError();
    }
    return toRecord(deleted);
  }

  /** `snapshot` is a decoded record, as `read` and `remove` return it; it is stored like a write. */
  async function restore(snapshot: ConfigRecord): Promise<boolean> {
    const { _id, overrides, ...rest } = snapshot;
    const principalId = snapshot.principalId.toString();
    const result = await storeKeys(overrides ?? {}, (keys) =>
      model().updateOne(
        principalFilter(
          { principalType: snapshot.principalType, principalId },
          'configStore.restore',
        ),
        {
          $setOnInsert: {
            ...rest,
            principalId,
            _id: toObjectId(_id),
            overrides: keys.overrides,
            ...(keys.encoded ? { keyEncoding: CONFIG_KEY_ENCODING_VERSION } : {}),
          },
        },
        { upsert: true, timestamps: false },
      ),
    );
    return result.upsertedCount > 0;
  }

  return { read, list, listActive, write, remove, restore };
}

type ConfigPrincipalId = string | Types.ObjectId;

/**
 * Positional slot where these methods once took a Mongoose `ClientSession`. The portable store
 * does not join transactions, so only `undefined` is accepted; the slot stays so existing call
 * sites keep their argument positions.
 */
type NoSession = undefined;

function toPrincipal(
  principalType: PrincipalType,
  principalId: ConfigPrincipalId,
): ConfigPrincipal {
  return { principalType, principalId: principalId.toString() };
}

/**
 * Config methods for callers, backed by the Mongoose store. Every write reads the document,
 * applies a pure transform and stores it with one compare-and-swap; a concurrent write is
 * re-read and re-applied, and `expectedRevision` turns any mismatch into a
 * `ConfigRevisionConflictError`.
 */
export function createConfigMethods(mongoose: typeof import('mongoose')) {
  const store = createConfigStore(mongoose);
  const operations = createConfigOperations(store);

  return {
    /** The documents the store lists, in merge precedence order (`compareConfigPrecedence`). */
    listAllConfigs: (
      filter?: { isActive?: boolean },
      _session?: NoSession,
    ): Promise<ConfigRecord[]> => operations.listConfigs(filter),

    findConfigByPrincipal: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      options?: { includeInactive?: boolean },
      _session?: NoSession,
    ): Promise<ConfigRecord | null> =>
      operations.findConfig(toPrincipal(principalType, principalId), options),

    /** Base and the principals' active documents, in merge precedence order. */
    getApplicableConfigs: (
      principals?: Array<{ principalType: string; principalId?: ConfigPrincipalId }>,
      _session?: NoSession,
    ): Promise<ConfigRecord[]> => operations.getApplicableConfigs(principals),

    /**
     * Active documents with a tombstone at `fieldPath` or below it, across every tenant the
     * caller's scope can read, in store order and without their overrides.
     */
    listConfigTombstones: (fieldPath: string, _session?: NoSession): Promise<ConfigTombstones[]> =>
      operations.listTombstones(fieldPath),

    /**
     * Replaces the overrides whole and activates the document; tombstones stay. An omitted
     * `priority` keeps the stored one, or gives a new document its principal type's default.
     */
    upsertConfig: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      principalModel: PrincipalModel,
      overrides: Partial<TCustomConfig>,
      priority?: number,
      _session?: NoSession,
      options?: ConfigLifecycleOptions & { preservePriority?: boolean },
    ): Promise<ConfigRecord | null> =>
      operations.replaceOverrides(
        toPrincipal(principalType, principalId),
        principalModel,
        overrides,
        priority,
        options,
      ),

    /** Sets dotted field paths; an omitted `priority` keeps the stored one. */
    patchConfigFields: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      principalModel: PrincipalModel,
      fields: Record<string, unknown>,
      priority?: number,
      _session?: NoSession,
      options?: ConfigWriteOptions,
    ): Promise<ConfigRecord> =>
      operations.setFields(
        toPrincipal(principalType, principalId),
        principalModel,
        fields,
        priority,
        options,
      ),

    /** Tombstones one path, or several in one write; an omitted `priority` keeps the stored one. */
    tombstoneConfigField: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      principalModel: PrincipalModel,
      fieldPaths: ConfigPathInputs,
      priority?: number,
      _session?: NoSession,
      options?: ConfigWriteOptions,
    ): Promise<ConfigRecord> =>
      operations.tombstoneFields(
        toPrincipal(principalType, principalId),
        principalModel,
        fieldPaths,
        priority,
        options,
      ),

    /**
     * Removes one path, or several in one write, pruning the parents left empty. A path is a
     * dotted field path or `{ segments }`, which can name a key that contains a dot.
     */
    unsetConfigField: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      fieldPaths: ConfigPathInputs,
      _session?: NoSession,
      options?: ConfigWriteOptions,
    ): Promise<ConfigRecord | null> =>
      operations.unsetFields(toPrincipal(principalType, principalId), fieldPaths, options),

    deleteConfig: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      _session?: NoSession,
      options?: ConfigLifecycleOptions,
    ): Promise<ConfigRecord | null> =>
      operations.deleteConfig(toPrincipal(principalType, principalId), options),

    /**
     * Re-creates a deleted config document exactly as it was (tombstones, active flag,
     * version), only when no document exists for the principal. Returns whether it
     * inserted, so a document written after the snapshot is never overwritten.
     */
    restoreConfig: (snapshot: ConfigRecord): Promise<boolean> => store.restore(snapshot),

    toggleConfigActive: async (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      isActive: boolean,
      _session?: NoSession,
      options?: ConfigLifecycleOptions,
    ): Promise<ConfigRecord | null> => {
      const toggled = await operations.setActive(
        toPrincipal(principalType, principalId),
        isActive,
        options,
      );
      return toggled?.config ?? null;
    },

    /** Like `toggleConfigActive`, but also reports whether this write changed `isActive`. */
    toggleConfigActiveTracked: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      isActive: boolean,
      options?: ConfigLifecycleOptions,
    ): Promise<{ config: ConfigRecord; changed: boolean } | null> =>
      operations.setActive(toPrincipal(principalType, principalId), isActive, options),

    /**
     * Sets only the priority; overrides, tombstones and `isActive` stay. Resolves to the
     * document and whether this write changed it, or `null` when the principal has none.
     * A role's document is the one in the caller's tenant partition, as for every write.
     */
    setConfigPriority: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      priority: number,
      options?: ConfigWriteOptions,
    ): Promise<ConfigWriteOutcome | null> =>
      operations.setPriority(toPrincipal(principalType, principalId), priority, options),

    /**
     * Moves a principal's document to another id of the same type (a role rename) and
     * returns it as moved, or `null` when there is none to move. Throws a
     * `ConfigMoveRefusedError`, changing nothing, when the target already has one
     * (`CONFIG_PRINCIPAL_EXISTS`) or either side is Base (`CONFIG_PRINCIPAL_RESERVED`).
     *
     * A role's documents on both sides are the ones in the caller's tenant partition: outside a
     * tenant only a platform-level document moves, and only a platform-level one at the target
     * refuses the move, so a tenant's role of the same name keeps its profile. With `identity`
     * (how a rename undoes its move), only that document moves, and `null` means the source
     * holds another or none.
     */
    renameConfigPrincipal: (
      principalType: PrincipalType,
      fromPrincipalId: ConfigPrincipalId,
      toPrincipalId: ConfigPrincipalId,
      options?: ConfigMoveOptions,
    ): Promise<ConfigRecord | null> =>
      operations.movePrincipal(
        toPrincipal(principalType, fromPrincipalId),
        toPrincipal(principalType, toPrincipalId),
        options,
      ),

    /**
     * Writes a principal's whole document when it is still at `expected` (`absent`: only when
     * none exists). The admin API plans the next document from the one it read, so validation
     * and secret preservation see exactly what the write replaces.
     */
    writeConfigDocument: (
      principalType: PrincipalType,
      principalId: ConfigPrincipalId,
      draft: ConfigDraft,
      expected: ConfigRevision,
    ): Promise<ConfigRecord> =>
      store.write(toPrincipal(principalType, principalId), draft, expected),
  };
}

export type ConfigMethods = ReturnType<typeof createConfigMethods>;
