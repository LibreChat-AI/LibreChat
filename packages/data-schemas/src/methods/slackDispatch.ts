import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { createSlackThreadRouteModel } from '~/models/slackRoute';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelRunModel } from '~/models/channelRun';
import { createChannelIndexGate } from './channelIndexes';
import { activeStates } from './channelProtocol';

export interface SlackDispatchStorage {
  ready(): Promise<void>;
  /** Trusted cross-tenant worker discovery; no credentials or message content. */
  discover(limit: number, now: number): Promise<Array<{ tenantId: string; channelId: string }>>;
  thread(
    workspaceId: string,
    externalUserId: string,
    externalThreadKey: string,
  ): Promise<string | null>;
  run(workspaceId: string, runId: string): Promise<string | null>;
  link(linkId: string): Promise<string | null>;
  message(workspaceId: string, externalMessageKey: string): Promise<string | null>;
}

export function createSlackDispatchStorage(
  mongoose: typeof import('mongoose'),
  getLimits: () => Promise<Partial<ChannelStorageConfig>> = async () => ({}),
): SlackDispatchStorage {
  const runs = createChannelRunModel(mongoose);
  const threads = createSlackThreadRouteModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [runs, threads]);
  const tenant = () => {
    const id = getTenantId();
    if (id === SYSTEM_TENANT_ID) throw new Error('Slack routing requires a resolved tenant');
    return id || undefined;
  };
  return {
    async ready() {
      await withRequiredTransaction(mongoose, async () => true, ensureIndexes);
    },
    async discover(limit, now) {
      if (getTenantId() !== SYSTEM_TENANT_ID)
        throw new Error('Slack discovery requires system scope');
      const limits = channelStorageConfigSchema.parse(await getLimits());
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > limits.maxMetadataPageSize ||
        !Number.isSafeInteger(now) ||
        now < 0
      )
        throw new TypeError('Invalid Slack discovery page');
      await ensureIndexes();
      const records = await runs
        .find({
          workspaceId: { $type: 'string' },
          state: { $in: activeStates },
          leaseExpiresAt: { $lte: now },
        })
        .sort({ claimCheckedAt: 1, receivedAt: 1, sequence: 1 })
        .hint('channel_run_shared_discovery')
        .select({ tenantId: 1, channelId: 1 })
        .limit(limit)
        .read('primary')
        .lean();
      // Unavailable bindings cannot reach claim(), so discovery must advance fairness too.
      if (records.length)
        await runs.updateMany(
          { _id: { $in: records.map(({ _id }) => _id) }, leaseExpiresAt: { $lte: now } },
          { $max: { claimCheckedAt: now } },
        );
      return records.map(({ tenantId, channelId }) => ({ tenantId, channelId }));
    },
    async thread(workspaceId, externalUserId, externalThreadKey) {
      const route = await threads
        .findOne({ tenantId: tenant() ?? null, workspaceId, externalUserId, externalThreadKey })
        .select({ channelId: 1 })
        .read('primary')
        .lean();
      return route?.channelId ?? null;
    },
    async run(workspaceId, runId) {
      const run = await runs
        .findOne({ tenantId: tenant() || '_', workspaceId, runId })
        .select({ channelId: 1 })
        .read('primary')
        .lean();
      return run?.channelId ?? null;
    },
    async link(linkId) {
      const link = await createChannelIdentityModel(mongoose)
        .findOne({ tenantId: tenant() || '_', linkId })
        .select({ 'identity.channelId': 1 })
        .read('primary')
        .lean();
      return link?.identity.channelId ?? null;
    },
    async message(workspaceId, externalMessageKey) {
      const records = await runs
        .find({
          tenantId: tenant() || '_',
          workspaceId,
          $or: [
            { 'progress.externalMessageKey': externalMessageKey },
            { 'receipts.externalMessageKey': externalMessageKey },
          ],
        })
        .select({ channelId: 1 })
        .limit(2)
        .read('primary')
        .lean();
      if (records.length > 1) throw new Error('Ambiguous Slack delivery route');
      return records[0]?.channelId ?? null;
    },
  };
}
