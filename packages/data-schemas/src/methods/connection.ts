import { randomUUID } from 'node:crypto';
import type { Connection, ConnectionStatus } from 'librechat-data-provider';
import type { ConnectionRecord } from '~/models/connection';
import { getTenantId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { createAgentEventConnectionModel } from '~/models/connection';
import { createChannelIndexGate } from './channelIndexes';

const DUPLICATE_KEY = 11000;

/** A provider install as the provider reports it, and the user binding it. */
export type ConnectionBinding = Pick<
  Connection,
  'provider' | 'installation' | 'account' | 'createdBy'
>;

/** `taken`: the install is already bound somewhere the caller cannot see. */
export type ConnectionBound =
  | { ok: true; value: Connection }
  | { ok: false; error: { code: 'taken' } };

/** What names a connection before its tenant is known: its id, or the install it holds. */
export type ConnectionRef = { id: string } | Pick<Connection, 'provider' | 'installation'>;

/**
 * Every method but `resolve` acts on one side only: the calling tenant's connections, or the
 * ones with no tenant when the caller has none. A caller with no tenant is never shown a
 * tenant's connection, even where other collections would let it through.
 */
export type Connections = {
  /**
   * Binds a provider install to the caller's side. Binding it again from the same side
   * refreshes the account and keeps the connection's id, status and first binder.
   */
  bind: (binding: ConnectionBinding) => Promise<ConnectionBound>;
  /** One of the caller's connections, or `null` when it has none by that id. */
  get: (id: string) => Promise<Connection | null>;
  /** The caller's connections, newest first. */
  list: () => Promise<Connection[]>;
  /**
   * The connection a ref names, whichever tenant holds it, or `null` when none does. This
   * is how a delivery's tenant is found, so it is for trusted callers only: an id taken from
   * an ingress URL, or an install taken from a delivery whose signature was verified.
   */
  resolve: (ref: ConnectionRef) => Promise<Connection | null>;
  /** Records the provider holding or restoring an install. `null` when there is none by that id. */
  mark: (id: string, status: ConnectionStatus) => Promise<Connection | null>;
  /** Unbinds an install. Its record is deleted; `false` when there was none by that id. */
  remove: (id: string) => Promise<boolean>;
};

function view(row: ConnectionRecord): Connection {
  return {
    id: row.id,
    ...(row.tenantId != null && { tenantId: row.tenantId }),
    provider: row.provider,
    installation: row.installation,
    account: { id: row.account.id, name: row.account.name },
    status: row.status,
    createdBy: row.createdBy,
  };
}

const found = (row: ConnectionRecord | null): Connection | null => (row == null ? null : view(row));

export function createConnections(mongoose: typeof import('mongoose')): Connections {
  const Model = createAgentEventConnectionModel(mongoose);
  // The install index decides who holds an install, with automatic indexing on or off.
  const indexed = createChannelIndexGate(() => [Model]);
  /** The caller's side, spelled out: the tenant plugin alone lets a caller with no tenant see all. */
  const mine = () => tenantPartitionFilter('Connection');

  async function bind(binding: ConnectionBinding): Promise<ConnectionBound> {
    if (getTenantId() === SYSTEM_TENANT_ID) {
      throw new Error('Binding a connection requires a tenant scope');
    }
    const install = { provider: binding.provider, installation: binding.installation };
    const account = { id: binding.account.id, name: binding.account.name };
    await indexed();
    try {
      const doc = await Model.create({
        ...install,
        account,
        id: `conn_${randomUUID()}`,
        status: 'active',
        createdBy: binding.createdBy,
      });
      return { ok: true, value: view(doc.toObject()) };
    } catch (error) {
      if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
    }
    // The install index refused the insert, so the install is already held. Only a row on
    // the caller's own side is refreshed; one held elsewhere is not seen.
    const row = await Model.findOneAndUpdate(
      { ...install, ...mine() },
      { $set: { account } },
      { new: true },
    ).lean<ConnectionRecord>();
    return row == null ? { ok: false, error: { code: 'taken' } } : { ok: true, value: view(row) };
  }

  async function get(id: string): Promise<Connection | null> {
    return found(await Model.findOne({ id, ...mine() }).lean<ConnectionRecord>());
  }

  async function list(): Promise<Connection[]> {
    const rows = await Model.find(mine()).sort({ createdAt: -1 }).lean<ConnectionRecord[]>();
    return rows.map(view);
  }

  async function resolve(ref: ConnectionRef): Promise<Connection | null> {
    const filter =
      'id' in ref ? { id: ref.id } : { provider: ref.provider, installation: ref.installation };
    return runAsSystem(async () => found(await Model.findOne(filter).lean<ConnectionRecord>()));
  }

  async function mark(id: string, status: ConnectionStatus): Promise<Connection | null> {
    return found(
      await Model.findOneAndUpdate(
        { id, ...mine() },
        { $set: { status } },
        { new: true, runValidators: true },
      ).lean<ConnectionRecord>(),
    );
  }

  async function remove(id: string): Promise<boolean> {
    const { deletedCount } = await Model.deleteOne({ id, ...mine() });
    return deletedCount === 1;
  }

  return { bind, get, list, resolve, mark, remove };
}
