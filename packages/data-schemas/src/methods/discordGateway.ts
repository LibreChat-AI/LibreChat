import { z } from 'zod';
import { discordGatewayOwnerSchema } from 'librechat-data-provider';
import type { DiscordGatewayOwner } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordGatewayCheckpointRecord } from '~/models/discordGateway';
import type { DiscordApplicationRecord } from '~/models/discord';
import { createDiscordGatewayCheckpointModel } from '~/models/discordGateway';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';
import { createDiscordApplicationModel } from '~/models/discord';
import { createResourceLockModel } from '~/models/resourceLock';
import { withRequiredTransaction } from '~/utils/transactions';
import { touchChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
import { createUserModel } from '~/models/user';

export interface DiscordGatewayScope extends DiscordGatewayOwner {
  tenantId?: string;
}
export interface DiscordGatewayStoragePolicy {
  ownershipLeaseMs: number;
  shardCount: number;
}
export interface DiscordGatewayPrivateState {
  applicationId: string;
  applicationRevision: string;
  botUserId: string;
  encryptedBotToken: string;
  checkpoints: DiscordGatewayCheckpointRecord[];
}
export interface DiscordGatewayStorage {
  acquire(owner: DiscordGatewayOwner, leaseMs: number): Promise<boolean>;
  renew(owner: DiscordGatewayOwner, leaseMs: number): Promise<boolean>;
  release(owner: DiscordGatewayOwner): Promise<boolean>;
  load(owner: DiscordGatewayOwner): Promise<DiscordGatewayPrivateState | null>;
  save(
    owner: DiscordGatewayOwner,
    botUserId: string,
    checkpoints: { shardId: number; encryptedSession: string | null }[],
  ): Promise<boolean>;
}
const policySchema = z
  .object({
    ownershipLeaseMs: z.number().int().min(5000).max(120000),
    shardCount: z.number().int().min(1).max(128),
  })
  .strict();
function tenant(): string | undefined {
  const value = getTenantId();
  if (value === SYSTEM_TENANT_ID) throw new TypeError('Discord Gateway requires tenant scope');
  return value || undefined;
}
const key = (applicationId: string) => `discord:gateway:${applicationId}`;
const holder = (owner: DiscordGatewayOwner) => `${owner.applicationRevision}:${owner.ownerId}`;
async function authority(
  mongoose: typeof import('mongoose'),
  scope: DiscordGatewayScope,
  session: ClientSession,
) {
  discordGatewayOwnerSchema.parse({
    applicationId: scope.applicationId,
    applicationRevision: scope.applicationRevision,
    ownerId: scope.ownerId,
  });
  if ((scope.tenantId || undefined) !== tenant())
    throw new TypeError('Discord Gateway tenant mismatch');
  const app = await createDiscordApplicationModel(mongoose)
    .findOneAndUpdate(
      {
        applicationId: scope.applicationId,
        revision: scope.applicationRevision,
        tenantId: tenant() ?? null,
      },
      { $inc: { authorityWrites: 1 } },
      { new: true, session },
    )
    .select('+encryptedBotToken')
    .lean();
  if (
    !app ||
    !mongoose.isValidObjectId(app.createdBy) ||
    !(await createUserModel(mongoose)
      .exists({
        _id: app.createdBy,
        tenantId: scope.tenantId ?? null,
        agentTriggerDeletionStartedAt: { $exists: false },
      })
      .session(session)) ||
    !(await touchChannelOwnerAdmission(
      mongoose,
      { userId: app.createdBy, tenantId: scope.tenantId },
      session,
    ))
  )
    return null;
  return app;
}
async function touchLease(
  mongoose: typeof import('mongoose'),
  scope: DiscordGatewayScope,
  session: ClientSession,
): Promise<boolean> {
  const touched = await createResourceLockModel(mongoose).updateOne(
    {
      key: key(scope.applicationId),
      ownerId: holder(scope),
      expiresAt: { $gt: new Date() },
    },
    { $inc: { fenceWrites: 1 } },
    { session },
  );
  return touched.matchedCount === 1;
}
/** Joins admission to lease takeover/release and credential rotation without extending the lease. */
export async function touchDiscordGatewayOwner(
  mongoose: typeof import('mongoose'),
  scope: DiscordGatewayScope,
  session: ClientSession,
): Promise<boolean> {
  return Boolean(
    (await authority(mongoose, scope, session)) && (await touchLease(mongoose, scope, session)),
  );
}
/** Server policy and clock own lease duration; checkpoint capabilities remain encrypted. */
export function createDiscordGatewayStorage(
  mongoose: typeof import('mongoose'),
  readPolicy: () => Promise<DiscordGatewayStoragePolicy | null>,
): DiscordGatewayStorage {
  const locks = createResourceLockModel(mongoose);
  const checkpoints = createDiscordGatewayCheckpointModel(mongoose);
  const applications = createDiscordApplicationModel(mongoose);
  const indexes = createChannelIndexGate(() => [
    locks,
    checkpoints,
    applications,
    createUserModel(mongoose),
    createResponseScopeModel(mongoose),
  ]);
  async function operation<T>(
    owner: DiscordGatewayOwner,
    denied: T,
    work: (
      scope: DiscordGatewayScope,
      policy: DiscordGatewayStoragePolicy,
      session: ClientSession,
      app: DiscordApplicationRecord,
    ) => Promise<T>,
  ): Promise<T> {
    discordGatewayOwnerSchema.parse(owner);
    const settings = await readPolicy();
    if (!settings) return denied;
    const policy = policySchema.parse(settings);
    const scope = { ...owner, tenantId: tenant() };
    return withRequiredTransaction(
      mongoose,
      async (session) => {
        const app = await authority(mongoose, scope, session);
        if (!app) return denied;
        return work(scope, policy, session, app);
      },
      indexes,
    );
  }
  const lease = (owner: DiscordGatewayOwner) => ({
    key: key(owner.applicationId),
    ownerId: holder(owner),
    expiresAt: { $gt: new Date() },
  });
  return {
    acquire: (owner, leaseMs) =>
      operation(owner, false, async (_scope, policy, session) => {
        if (leaseMs !== policy.ownershipLeaseMs) return false;
        const existing = await locks
          .findOne({ key: key(owner.applicationId) })
          .session(session)
          .lean();
        const now = Date.now();
        if (existing && existing.expiresAt.getTime() > now) {
          if (existing.ownerId !== holder(owner)) return false;
          const renewed = await locks.updateOne(
            lease(owner),
            { $max: { expiresAt: new Date(now + leaseMs) }, $inc: { fenceWrites: 1 } },
            { session },
          );
          return renewed.matchedCount === 1;
        }
        if (existing) {
          const result = await locks.updateOne(
            { _id: existing._id, expiresAt: { $lte: new Date(now) } },
            {
              $set: { ownerId: holder(owner), expiresAt: new Date(now + policy.ownershipLeaseMs) },
              $inc: { fenceWrites: 1 },
            },
            { session },
          );
          return result.matchedCount === 1;
        }
        await locks.create(
          [
            {
              key: key(owner.applicationId),
              ownerId: holder(owner),
              expiresAt: new Date(now + policy.ownershipLeaseMs),
              fenceWrites: 0,
            },
          ],
          { session },
        );
        return true;
      }),
    renew: (owner, leaseMs) =>
      operation(owner, false, async (_scope, policy, session) => {
        if (leaseMs !== policy.ownershipLeaseMs) return false;
        const result = await locks.updateOne(
          lease(owner),
          {
            $max: { expiresAt: new Date(Date.now() + policy.ownershipLeaseMs) },
            $inc: { fenceWrites: 1 },
          },
          { session },
        );
        return result.matchedCount === 1;
      }),
    // Cleanup remains possible after disable/rotation, but never releases a replacement owner's lease.
    async release(owner) {
      discordGatewayOwnerSchema.parse(owner);
      const app = await applications.exists({
        applicationId: owner.applicationId,
        tenantId: tenant() ?? null,
      });
      if (!app) return false;
      const result = await locks.deleteOne({
        key: key(owner.applicationId),
        ownerId: holder(owner),
      });
      return result.deletedCount === 1;
    },
    load: (owner) =>
      operation<DiscordGatewayPrivateState | null>(
        owner,
        null,
        async (scope, policy, session, app) => {
          if (!(await touchLease(mongoose, scope, session))) return null;
          const rows = await checkpoints
            .find({
              applicationId: owner.applicationId,
              tenantId: tenant() ?? null,
              applicationRevision: owner.applicationRevision,
              botUserId: app.botUserId,
              shardCount: policy.shardCount,
            })
            .select('+encryptedSession')
            .session(session)
            .lean();
          return {
            applicationId: app.applicationId,
            applicationRevision: app.revision,
            botUserId: app.botUserId,
            encryptedBotToken: app.encryptedBotToken,
            checkpoints: rows.map((row) => ({
              tenantId: row.tenantId,
              applicationId: row.applicationId,
              applicationRevision: row.applicationRevision,
              botUserId: row.botUserId,
              shardId: row.shardId,
              shardCount: row.shardCount,
              encryptedSession: row.encryptedSession,
            })),
          };
        },
      ),
    save: (owner, botUserId, rows) =>
      operation(owner, false, async (scope, policy, session, app) => {
        if (
          rows.length > policy.shardCount ||
          new Set(rows.map((row) => row.shardId)).size !== rows.length
        )
          throw new TypeError('Invalid Discord Gateway checkpoint batch');
        for (const row of rows) {
          z.number()
            .int()
            .min(0)
            .max(policy.shardCount - 1)
            .parse(row.shardId);
          z.string().min(1).max(8192).nullable().parse(row.encryptedSession);
        }
        if (app.botUserId !== botUserId || !(await touchLease(mongoose, scope, session)))
          return false;
        await checkpoints.deleteMany(
          {
            tenantId: tenant() ?? null,
            applicationId: owner.applicationId,
            $or: [
              { applicationRevision: { $ne: owner.applicationRevision } },
              { shardCount: { $ne: policy.shardCount } },
              { botUserId: { $ne: botUserId } },
            ],
          },
          { session },
        );
        for (const row of rows) {
          const filter = {
            tenantId: tenant() ?? null,
            applicationId: owner.applicationId,
            shardId: row.shardId,
          };
          if (row.encryptedSession === null) await checkpoints.deleteOne(filter, { session });
          else
            await checkpoints.updateOne(
              filter,
              {
                $set: {
                  applicationRevision: owner.applicationRevision,
                  botUserId,
                  shardCount: policy.shardCount,
                  encryptedSession: row.encryptedSession,
                },
              },
              { upsert: true, session, runValidators: true },
            );
        }
        return true;
      }),
  };
}
