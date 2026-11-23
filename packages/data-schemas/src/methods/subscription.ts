import { randomUUID } from 'node:crypto';
import type { Connection, Subscription, SubscriptionUpdate } from 'librechat-data-provider';
import type { SubscriptionRecord } from '~/models/subscription';
import { createAgentEventSubscriptionModel } from '~/models/subscription';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { createChannelIndexGate } from './channelIndexes';
import { runAsSystem } from '~/config/tenantContext';

/** What an owner may edit. The connection and the agent are fixed when it is created. */
const EDITABLE = [
  'events',
  'filters',
  'target',
  'prompt',
  'actors',
  'bots',
  'cap',
  'window',
  'enabled',
] as const;

/** A subscription before it is stored: every field the store does not assign. */
export type SubscriptionDraft = Omit<Subscription, 'id' | 'user' | 'tenantId' | 'revision'>;

/** An owner's edit. A `null` clears a field that may be left out. */
export type SubscriptionPatch = Omit<SubscriptionUpdate, 'expectedRevision'>;

/**
 * `missing`: the owner has no subscription by that id. `conflict`: it was edited after the
 * revision the edit was made from.
 */
export type SubscriptionWrite =
  | { ok: true; value: Subscription }
  | { ok: false; error: { code: 'missing' | 'conflict' } };

export type Subscriptions = {
  /** Stores a new subscription for its owner, at revision 0. */
  create: (owner: string, draft: SubscriptionDraft) => Promise<Subscription>;
  /**
   * A subscription by id, or `null` when there is none. With an owner, only that owner's.
   */
  get: (id: string, owner?: string) => Promise<Subscription | null>;
  /** An owner's subscriptions, for one agent or for all, most recently edited first. */
  list: (owner: string, agentId?: string) => Promise<Subscription[]>;
  /**
   * Applies an owner's edit and moves the revision forward by one. Given the revision the
   * edit was made from, it is refused when the stored one has moved since.
   *
   * The grant the subscription holds was made for one revision. An edit that only turns the
   * subscription on or off takes the grant along, so it still stands for the new revision.
   * Any other edit leaves it behind: it allows nothing until the owner grants again.
   */
  update: (
    id: string,
    owner: string,
    patch: SubscriptionPatch,
    expected?: number,
  ) => Promise<SubscriptionWrite>;
  /** Deletes an owner's subscription; `false` when the owner had none by that id. */
  remove: (id: string, owner: string) => Promise<boolean>;
  /** Deletes every subscription an owner has, and answers how many there were. */
  purge: (owner: string) => Promise<number>;
  /**
   * The enabled subscriptions on a connection that listen for an event type. It reads the
   * connection's own tenant whatever scope the caller is in, because a delivery arrives
   * before any tenant is in scope, and so that a subscription naming another tenant's
   * connection is never matched to that connection's deliveries.
   */
  match: (
    connection: Pick<Connection, 'id' | 'tenantId'>,
    event: string,
  ) => Promise<Subscription[]>;
};

function view(row: SubscriptionRecord): Subscription {
  return {
    id: row.id,
    user: String(row.user),
    ...(row.tenantId != null && { tenantId: row.tenantId }),
    connection: row.connection,
    agentId: row.agentId,
    events: row.events,
    ...(row.filters != null && { filters: row.filters }),
    target: row.target,
    prompt: row.prompt,
    actors: row.actors,
    bots: row.bots,
    ...(row.cap != null && { cap: row.cap }),
    ...(row.window != null && { window: row.window }),
    enabled: row.enabled,
    revision: row.revision,
  };
}

export function createSubscriptions(mongoose: typeof import('mongoose')): Subscriptions {
  const Model = createAgentEventSubscriptionModel(mongoose);
  const indexed = createChannelIndexGate(() => [Model]);

  async function create(owner: string, draft: SubscriptionDraft): Promise<Subscription> {
    await indexed();
    const doc = await Model.create({
      id: `sub_${randomUUID()}`,
      user: owner,
      connection: draft.connection,
      agentId: draft.agentId,
      events: draft.events,
      filters: draft.filters,
      target: draft.target,
      prompt: draft.prompt,
      actors: draft.actors,
      bots: draft.bots,
      cap: draft.cap,
      window: draft.window,
      enabled: draft.enabled,
      revision: 0,
    });
    return view(doc.toObject());
  }

  async function get(id: string, owner?: string): Promise<Subscription | null> {
    const row = await Model.findOne({
      id,
      ...(owner != null && { user: owner }),
    }).lean<SubscriptionRecord>();
    return row == null ? null : view(row);
  }

  async function list(owner: string, agentId?: string): Promise<Subscription[]> {
    const rows = await Model.find({ user: owner, ...(agentId != null && { agentId }) })
      .sort({ updatedAt: -1 })
      .lean<SubscriptionRecord[]>();
    return rows.map(view);
  }

  async function update(
    id: string,
    owner: string,
    patch: SubscriptionPatch,
    expected?: number,
  ): Promise<SubscriptionWrite> {
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    for (const field of EDITABLE) {
      const value = patch[field];
      if (value === null) unset[field] = 1;
      else if (value !== undefined) set[field] = value;
    }
    const mine = { id, user: owner };
    const fenced = { ...mine, ...(expected !== undefined && { revision: expected }) };
    const write = (holds: Record<string, unknown>, along: Record<string, 1>) =>
      Model.findOneAndUpdate(
        { ...fenced, ...holds },
        // The only writer of `revision`: an edit moves it in the same write that applies it.
        { $set: set, $unset: unset, $inc: { revision: 1, ...along } },
        { new: true, runValidators: true },
      ).lean<SubscriptionRecord>();
    /** Turning it on or off changes nothing the owner granted against. */
    const activation =
      Object.keys(unset).length === 0 && Object.keys(set).every((field) => field === 'enabled');
    // Both numbers move by one, so a grant made for this revision is made for the next, and
    // one already left behind stays behind. Two writes, because a path that is not there
    // cannot be moved: the first matches only a subscription that holds a grant. A grant
    // stored between the two is left one revision behind, and so allows nothing.
    const row = activation
      ? ((await write({ grant: { $exists: true } }, { 'grant.scheduleRevision': 1 })) ??
        (await write({}, {})))
      : await write({}, {});
    if (row != null) return { ok: true, value: view(row) };
    // Nothing matched: the owner has no such subscription, or its revision has moved.
    const exists = await Model.exists(mine);
    return { ok: false, error: { code: exists == null ? 'missing' : 'conflict' } };
  }

  async function remove(id: string, owner: string): Promise<boolean> {
    const { deletedCount } = await Model.deleteOne({ id, user: owner });
    return deletedCount === 1;
  }

  async function purge(owner: string): Promise<number> {
    const { deletedCount } = await Model.deleteMany({ user: owner });
    return deletedCount;
  }

  async function match(
    connection: Pick<Connection, 'id' | 'tenantId'>,
    event: string,
  ): Promise<Subscription[]> {
    // The caller's scope is set aside and the connection's tenant is named in the filter. A
    // connection with no tenant reads only rows with none, not every tenant's.
    return runAsSystem(async () => {
      const rows = await Model.find({
        connection: connection.id,
        enabled: true,
        events: event,
        ...(connection.tenantId
          ? { tenantId: connection.tenantId }
          : tenantPartitionFilter('Subscription match')),
      }).lean<SubscriptionRecord[]>();
      return rows.map(view);
    });
  }

  return { create, get, list, update, remove, purge, match };
}
