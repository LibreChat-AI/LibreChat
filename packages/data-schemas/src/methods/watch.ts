import { randomUUID } from 'node:crypto';
import type { Connection, Watch } from 'librechat-data-provider';
import type { WatchRecord } from '~/models/watch';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { createAgentEventWatchModel } from '~/models/watch';
import { createChannelIndexGate } from './channelIndexes';
import { runAsSystem } from '~/config/tenantContext';

/** A watch before it is stored: every field the store does not assign. */
export type WatchDraft = Pick<
  Watch,
  'conversationId' | 'agentId' | 'subscription' | 'connection' | 'item' | 'label' | 'url'
>;

/** How many watches a conversation may hold, and how long a new or renewed one lasts. */
export interface WatchBounds {
  max: number;
  ttlMs: number;
  now?: Date;
}

/**
 * `created` is false when the conversation already followed the item; its watch then lasts
 * from now again. `limit`: the conversation already follows as many items as it may.
 */
export type WatchAdd =
  | { ok: true; value: Watch; created: boolean }
  | { ok: false; error: { code: 'limit' } };

export type Watches = {
  /** Has an owner's conversation follow an item, once per conversation and item. */
  add: (owner: string, draft: WatchDraft, bounds: WatchBounds) => Promise<WatchAdd>;
  /** An owner's watch by id, or `null` when there is none or it has ended. */
  get: (id: string, owner: string, now?: Date) => Promise<Watch | null>;
  /** The watches an owner's conversation holds that have not ended, oldest first. */
  list: (owner: string, conversationId: string, now?: Date) => Promise<Watch[]>;
  /** Ends an owner's watch; `false` when the owner had none by that id. */
  remove: (id: string, owner: string) => Promise<boolean>;
  /** Ends the watch an owner's conversation holds on an item; `false` when there was none. */
  drop: (owner: string, conversationId: string, item: string) => Promise<boolean>;
  /**
   * The watches on a connection that follow any of the items and have not ended. It reads the
   * connection's own tenant whatever scope the caller is in, as a delivery arrives before any
   * tenant is in scope.
   */
  following: (
    connection: Pick<Connection, 'id' | 'tenantId'>,
    items: readonly string[],
    now?: Date,
  ) => Promise<Watch[]>;
};

function view(row: WatchRecord): Watch {
  return {
    id: row.id,
    user: String(row.user),
    ...(row.tenantId != null && { tenantId: row.tenantId }),
    conversationId: row.conversationId,
    agentId: row.agentId,
    subscription: row.subscription,
    connection: row.connection,
    item: row.item,
    label: row.label,
    ...(row.url != null && { url: row.url }),
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

/** True for a write refused by a unique index. */
function duplicate(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}

export function createWatches(mongoose: typeof import('mongoose')): Watches {
  const Model = createAgentEventWatchModel(mongoose);
  const indexed = createChannelIndexGate(() => [Model]);

  /** An owner's watch on one item in one conversation, renewed to last from `now`. */
  async function renew(owner: string, draft: WatchDraft, expiresAt: Date, now: Date) {
    return Model.findOneAndUpdate(
      {
        user: owner,
        conversationId: draft.conversationId,
        item: draft.item,
        expiresAt: { $gt: now },
      },
      { $set: { expiresAt, label: draft.label, ...(draft.url != null && { url: draft.url }) } },
      { new: true },
    ).lean<WatchRecord>();
  }

  async function add(owner: string, draft: WatchDraft, bounds: WatchBounds): Promise<WatchAdd> {
    await indexed();
    const now = bounds.now ?? new Date();
    const expiresAt = new Date(now.getTime() + bounds.ttlMs);
    const renewed = await renew(owner, draft, expiresAt, now);
    if (renewed != null) return { ok: true, value: view(renewed), created: false };
    // An ended watch the TTL monitor has not removed yet holds the item's place: clear it.
    await Model.deleteOne({
      user: owner,
      conversationId: draft.conversationId,
      item: draft.item,
      expiresAt: { $lte: now },
    });
    const held = await Model.countDocuments({
      user: owner,
      conversationId: draft.conversationId,
      expiresAt: { $gt: now },
    });
    if (held >= bounds.max) return { ok: false, error: { code: 'limit' } };
    try {
      const doc = await Model.create({
        id: `watch_${randomUUID()}`,
        user: owner,
        conversationId: draft.conversationId,
        agentId: draft.agentId,
        subscription: draft.subscription,
        connection: draft.connection,
        item: draft.item,
        label: draft.label,
        ...(draft.url != null && { url: draft.url }),
        expiresAt,
      });
      return { ok: true, value: view(doc.toObject()), created: true };
    } catch (error) {
      if (!duplicate(error)) throw error;
      // Another call made the same watch first: this one renews it instead.
      const raced = await renew(owner, draft, expiresAt, now);
      if (raced == null) throw error;
      return { ok: true, value: view(raced), created: false };
    }
  }

  async function get(id: string, owner: string, now = new Date()): Promise<Watch | null> {
    const row = await Model.findOne({
      id,
      user: owner,
      expiresAt: { $gt: now },
    }).lean<WatchRecord>();
    return row == null ? null : view(row);
  }

  async function list(owner: string, conversationId: string, now = new Date()): Promise<Watch[]> {
    const rows = await Model.find({ user: owner, conversationId, expiresAt: { $gt: now } })
      .sort({ createdAt: 1 })
      .lean<WatchRecord[]>();
    return rows.map(view);
  }

  async function remove(id: string, owner: string): Promise<boolean> {
    const { deletedCount } = await Model.deleteOne({ id, user: owner });
    return deletedCount === 1;
  }

  async function drop(owner: string, conversationId: string, item: string): Promise<boolean> {
    const { deletedCount } = await Model.deleteOne({ user: owner, conversationId, item });
    return deletedCount === 1;
  }

  async function following(
    connection: Pick<Connection, 'id' | 'tenantId'>,
    items: readonly string[],
    now = new Date(),
  ): Promise<Watch[]> {
    if (items.length === 0) return [];
    // The caller's scope is set aside and the connection's tenant is named in the filter. A
    // connection with no tenant reads only rows with none, not every tenant's.
    return runAsSystem(async () => {
      const rows = await Model.find({
        connection: connection.id,
        item: { $in: [...items] },
        expiresAt: { $gt: now },
        ...(connection.tenantId
          ? { tenantId: connection.tenantId }
          : tenantPartitionFilter('Watch following')),
      }).lean<WatchRecord[]>();
      return rows.map(view);
    });
  }

  return { add, get, list, remove, drop, following };
}
