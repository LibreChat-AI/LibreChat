import { nanoid } from 'nanoid';
import { slackAppNameSchema } from 'librechat-data-provider';
import type { SlackWorkspace, SlackAppRegistration } from 'librechat-data-provider';
import type { SlackBotManager } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  SlackInstallRecord,
  SlackWorkspaceRecord,
  SlackClaimedInstall,
  SlackInstallGeneration,
} from '~/models/slackWorkspace';
import type { BotManagerWriteResult, BotManagerUpdate } from './slackBotAccess';
import {
  createSlackInstallModel,
  createSlackWorkspaceModel,
  createSlackInstallGenerationModel,
} from '~/models/slackWorkspace';
import { prepareChannelOwnerAdmission, touchChannelOwnerAdmission } from './channelOwner';
import { getTenantId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelIndexGate } from './channelIndexes';
import { createAclEntryModel } from '~/models/aclEntry';
import { createSlackBotAccess } from './slackBotAccess';

export type SlackWorkspaceMetadata = SlackWorkspace;
export type SlackWorkspaceInstallResult =
  | { ok: true; workspace: SlackWorkspaceMetadata }
  | {
      ok: false;
      code: 'invalid_install' | 'stale_install' | 'workspace_in_use' | 'workspace_changed';
    };

class SlackWorkspaceInUse extends Error {}

export interface SlackWorkspaceStorage {
  /** Global ownership check: another tenant cannot install the same app elsewhere. */
  appInUse(appId: string, workspaceId?: string): Promise<boolean>;
  /** Credentials and the OAuth installation fence share the same organization/app revision. */
  app(appId: string): Promise<SlackInstallGeneration | null>;
  apps(cursor?: string, limit?: number): Promise<{ apps: SlackAppRegistration[]; next?: string }>;
  configureApp(
    input: Required<Pick<SlackInstallGeneration, 'appId' | 'clientId'>> &
      Pick<SlackInstallGeneration, 'name' | 'encryptedClientSecret' | 'encryptedSigningSecret'>,
    userId: string,
    expectedRevision?: string,
  ): Promise<SlackAppRegistration | null>;
  removeApp(
    appId: string,
    expectedRevision: string,
  ): Promise<'removed' | 'conflict' | 'workspace_in_use'>;
  startInstall(
    input: Omit<SlackInstallRecord, 'tenantId' | 'generation' | 'installOrder' | 'callbackId'>,
  ): Promise<SlackInstallRecord>;
  /** Internal callback lookup only; an opaque state alone does not authorize completion. */
  findInstall(stateHash: string): Promise<SlackInstallRecord | null>;
  claimInstall(stateHash: string, userId: string, now: Date): Promise<SlackClaimedInstall | null>;
  retireInstall(stateHash: string, callbackId: string): Promise<void>;
  cancelInstall(stateHash: string, userId: string): Promise<void>;
  completeInstall(
    stateHash: string,
    callbackId: string,
    input: Required<
      Pick<
        SlackWorkspaceRecord,
        'appId' | 'teamId' | 'teamName' | 'botUserId' | 'scopes' | 'encryptedBotToken'
      >
    >,
    now: Date,
  ): Promise<SlackWorkspaceInstallResult>;
  list(
    cursor?: string,
    limit?: number,
    userId?: string,
  ): Promise<{
    workspaces: SlackWorkspaceMetadata[];
    next?: string;
  }>;
  read(workspaceId: string): Promise<SlackWorkspaceRecord | null>;
  metadata(workspaceId: string, userId?: string): Promise<SlackWorkspaceMetadata | null>;
  botManagers(
    workspaceId: string,
  ): Promise<{ revision: string; managers: SlackBotManager[] } | null>;
  searchBotManagers(
    workspaceId: string,
    query: string,
    limit: number,
  ): Promise<SlackBotManager[] | null>;
  setBotManagers(input: BotManagerUpdate): Promise<BotManagerWriteResult>;
  disconnect(workspaceId: string, expectedRevision?: string): Promise<boolean>;
  /** Hide a retired installation while retaining its callback and ownership fences. */
  remove(workspaceId: string, expectedRevision: string): Promise<boolean>;
  /** Trusted routing metadata, read only after authenticating the Slack request. */
  route(appId: string, teamId: string): Promise<SlackWorkspaceMetadata | null>;
}

function metadata(record: SlackWorkspaceRecord): SlackWorkspaceMetadata {
  return {
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    appId: record.appId,
    teamId: record.teamId,
    teamName: record.teamName,
    botUserId: record.botUserId,
    status: record.status,
    revision: record.revision,
    scopes: record.scopes,
  };
}

/** Tenant-owned installations and one-use attempts share a transactional disconnect fence. */
export function createSlackWorkspaceStorage(
  mongoose: typeof import('mongoose'),
): SlackWorkspaceStorage {
  const workspaces = createSlackWorkspaceModel(mongoose);
  const botAccess = createSlackBotAccess(mongoose);
  const flows = createSlackInstallModel(mongoose);
  const generations = createSlackInstallGenerationModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [
    workspaces,
    flows,
    generations,
    createAclEntryModel(mongoose),
  ]);

  function tenant(): string | undefined {
    const id = getTenantId();
    if (id === SYSTEM_TENANT_ID) throw new Error('Workspace mutation requires a tenant scope');
    return id || undefined;
  }

  async function transaction<T>(write: (session: ClientSession) => Promise<T>): Promise<T> {
    return withRequiredTransaction(mongoose, write, ensureIndexes);
  }

  async function generation(appId: string, session: ClientSession) {
    const tenantId = tenant();
    return generations.findOneAndUpdate(
      { partition: tenantId || '_', appId, tenantId: tenantId ?? null },
      { $setOnInsert: { tenantId, revision: nanoid(), writes: 0 } },
      { upsert: true, new: true, session },
    );
  }

  async function browserMetadata(
    records: SlackWorkspaceRecord[],
  ): Promise<SlackWorkspaceMetadata[]> {
    if (records.length === 0) return [];
    const tenantId = tenant();
    const apps = await generations
      .find({
        partition: tenantId || '_',
        tenantId: tenantId ?? null,
        appId: { $in: [...new Set(records.map((record) => record.appId))] },
        name: { $exists: true },
      })
      .select({ appId: 1, name: 1, _id: 0 })
      .read('primary')
      .lean();
    const names = new Map(apps.map((app) => [app.appId, app.name]));
    return records.map((record) => {
      const appName = names.get(record.appId);
      return { ...metadata(record), ...(appName ? { appName } : {}) };
    });
  }

  return {
    async appInUse(appId, workspaceId) {
      return runAsSystem(async () =>
        Boolean(
          await workspaces
            .exists({
              appId,
              status: 'active',
              ...(workspaceId ? { workspaceId: { $ne: workspaceId } } : {}),
            })
            .read('primary'),
        ),
      );
    },
    botManagers: botAccess.read,
    searchBotManagers: botAccess.search,
    setBotManagers: botAccess.set,
    async app(appId) {
      return generations
        .findOne({
          appId,
          partition: tenant() || '_',
          tenantId: tenant() ?? null,
          encryptedClientSecret: { $exists: true },
        })
        .select('+encryptedClientSecret +encryptedSigningSecret')
        .read('primary')
        .lean();
    },
    async apps(cursor, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('Invalid Slack app page');
      const records = await generations
        .find({
          partition: tenant() || '_',
          tenantId: tenant() ?? null,
          encryptedClientSecret: { $exists: true },
          ...(cursor ? { appId: { $gt: cursor } } : {}),
        })
        .sort({ appId: 1 })
        .limit(limit + 1)
        .read('primary')
        .lean();
      const apps = records.slice(0, limit).map(({ appId, clientId, revision, name }) => ({
        appId,
        clientId: clientId!,
        revision,
        ...(name ? { name } : {}),
      }));
      return { apps, ...(records.length > limit ? { next: apps[apps.length - 1].appId } : {}) };
    },
    async configureApp(input, userId, expectedRevision) {
      const parsedName = slackAppNameSchema.optional().safeParse(input.name);
      if (!parsedName.success) return null;
      const name = parsedName.data;
      if (
        (input.encryptedClientSecret !== undefined && !input.encryptedClientSecret) ||
        (input.encryptedSigningSecret !== undefined && !input.encryptedSigningSecret)
      )
        return null;
      const tenantId = tenant();
      const admit = await prepareChannelOwnerAdmission(mongoose, { userId, tenantId });
      return transaction(async (session) => {
        if (!(await admit(session))) return null;
        const current = await generation(input.appId, session);
        if (
          !current ||
          (current.clientId ? current.revision !== expectedRevision : expectedRevision != null)
        )
          return null;
        if (
          (!current.clientId && (!input.encryptedClientSecret || !input.encryptedSigningSecret)) ||
          (current.clientId && current.clientId !== input.clientId && !input.encryptedClientSecret)
        )
          return null;
        const revision = nanoid();
        const changed = await generations.updateOne(
          {
            partition: tenantId || '_',
            appId: input.appId,
            tenantId: tenantId ?? null,
            revision: current.revision,
          },
          {
            $set: {
              appId: input.appId,
              clientId: input.clientId,
              revision,
              ...(name ? { name } : {}),
              ...(input.encryptedClientSecret
                ? { encryptedClientSecret: input.encryptedClientSecret }
                : {}),
              ...(input.encryptedSigningSecret
                ? { encryptedSigningSecret: input.encryptedSigningSecret }
                : {}),
            },
            ...(name === '' ? { $unset: { name: 1 } } : {}),
            $inc: { writes: 1 },
          },
          { session },
        );
        if (!changed.matchedCount) return null;
        const savedName = name === undefined ? current.name : name;
        return {
          appId: input.appId,
          clientId: input.clientId,
          revision,
          ...(savedName ? { name: savedName } : {}),
        };
      });
    },
    async removeApp(appId, expectedRevision) {
      const tenantId = tenant();
      return transaction(async (session) => {
        const current = await generations
          .findOne({ appId, tenantId: tenantId ?? null, revision: expectedRevision })
          .session(session)
          .lean();
        if (!current) return 'conflict';
        if (
          await workspaces
            .exists({ appId, tenantId: tenantId ?? null, status: 'active' })
            .session(session)
        )
          return 'workspace_in_use';
        const changed = await generations.updateOne(
          { appId, tenantId: tenantId ?? null, revision: expectedRevision },
          {
            $set: { revision: nanoid() },
            $unset: { clientId: 1, name: 1, encryptedClientSecret: 1, encryptedSigningSecret: 1 },
          },
          { session },
        );
        if (!changed.matchedCount) return 'conflict';
        await workspaces.updateMany(
          { appId, tenantId: tenantId ?? null, status: 'disconnected' },
          { $set: { removedAt: new Date(), revision: nanoid() } },
          { session },
        );
        return 'removed';
      });
    },
    async startInstall(input) {
      const tenantId = tenant();
      const admit = await prepareChannelOwnerAdmission(mongoose, {
        userId: input.userId,
        tenantId,
      });
      return transaction(async (session) => {
        if (!(await admit(session))) throw new Error('Slack installer is no longer active');
        const epoch = await generation(input.appId, session);
        if (!epoch) throw new Error('Slack installation generation unavailable');
        const sequence = await generations.findOneAndUpdate(
          { partition: tenantId || '_', appId: input.appId, revision: epoch.revision },
          { $inc: { writes: 1 } },
          { new: true, session },
        );
        if (!sequence) throw new Error('Slack installation generation changed');
        const record = {
          ...input,
          tenantId,
          generation: epoch.revision,
          installOrder: sequence.writes,
        };
        await flows.create([record], { session });
        return record;
      });
    },
    async findInstall(stateHash) {
      return runAsSystem(async () =>
        flows.findOne({ stateHash }).select('+stateHash').read('primary').lean(),
      );
    },
    async cancelInstall(stateHash, userId) {
      await flows.deleteOne({ stateHash, userId, tenantId: tenant() ?? null });
    },
    async claimInstall(stateHash, userId, now) {
      const callbackId = nanoid();
      const record = await flows
        .findOneAndUpdate(
          {
            stateHash,
            userId,
            tenantId: tenant() ?? null,
            expiresAt: { $gt: now },
            callbackId: { $exists: false },
          },
          { $set: { callbackId } },
          { new: true },
        )
        .select('+stateHash')
        .lean();
      return record ? { ...record, callbackId } : null;
    },
    async retireInstall(stateHash, callbackId) {
      await flows.deleteOne({ stateHash, callbackId, tenantId: tenant() ?? null });
    },
    async completeInstall(stateHash, callbackId, input, now) {
      if (typeof callbackId !== 'string' || !callbackId)
        return { ok: false, code: 'invalid_install' };
      const tenantId = tenant();
      try {
        return await transaction<SlackWorkspaceInstallResult>(async (session) => {
          const flow = await flows
            .findOneAndDelete({ stateHash, callbackId, tenantId: tenantId ?? null }, { session })
            .lean();
          if (!flow || flow.appId !== input.appId || flow.expiresAt <= now)
            return { ok: false, code: 'invalid_install' };
          if (
            !(await touchChannelOwnerAdmission(
              mongoose,
              { userId: flow.userId, tenantId },
              session,
            ))
          )
            return { ok: false, code: 'invalid_install' };
          const admitted = await generations.updateOne(
            {
              partition: tenantId || '_',
              appId: input.appId,
              revision: flow.generation,
              tenantId: tenantId ?? null,
            },
            { $inc: { writes: 1 } },
            { session },
          );
          if (!admitted.matchedCount) return { ok: false, code: 'stale_install' };
          return runAsSystem(async () => {
            const active = await workspaces
              .findOne({ appId: input.appId, status: 'active' })
              .session(session)
              .lean();
            if (
              active &&
              (active.teamId !== input.teamId || (active.tenantId || undefined) !== tenantId)
            )
              return {
                ok: false,
                code:
                  flow.workspaceId === active.workspaceId && active.teamId !== input.teamId
                    ? 'workspace_changed'
                    : 'workspace_in_use',
              };
            const current =
              active ??
              (await workspaces
                .findOne({ appId: input.appId, teamId: input.teamId })
                .session(session)
                .lean());
            if (
              current &&
              (current.tenantId || undefined) === tenantId &&
              current.installOrder >= flow.installOrder
            )
              return { ok: false, code: 'stale_install' };
            if (
              flow.workspaceId &&
              (current?.workspaceId !== flow.workspaceId ||
                current.revision !== flow.workspaceRevision ||
                (current.tenantId || undefined) !== tenantId)
            )
              return { ok: false, code: 'workspace_changed' };
            const workspace: SlackWorkspaceRecord = {
              ...input,
              tenantId,
              workspaceId:
                current?.status === 'active' && (current.tenantId || undefined) === tenantId
                  ? current.workspaceId
                  : nanoid(),
              revision: nanoid(),
              status: 'active',
              installOrder: flow.installOrder,
            };
            try {
              if (current) {
                if (current.workspaceId !== workspace.workspaceId)
                  await botAccess.clear(current, session);
                const updated = await workspaces.replaceOne(
                  { workspaceId: current.workspaceId, revision: current.revision },
                  workspace,
                  { session },
                );
                if (!updated.matchedCount) throw new Error('Slack workspace ownership changed');
              } else await workspaces.create([workspace], { session });
            } catch (error) {
              if (
                error instanceof mongoose.mongo.MongoServerError &&
                error.code === 11000 &&
                error.keyPattern?.appId === 1 &&
                Object.keys(error.keyPattern).every((key) => key === 'appId' || key === 'teamId')
              )
                throw new SlackWorkspaceInUse();
              throw error;
            }
            return { ok: true, workspace: metadata(workspace) };
          });
        });
      } catch (error) {
        if (!(error instanceof SlackWorkspaceInUse)) throw error;
        await flows.deleteOne({ stateHash, callbackId, tenantId: tenantId ?? null });
        return { ok: false, code: 'workspace_in_use' };
      }
    },
    async list(cursor, limit = 50, userId) {
      const tenantId = tenant();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('Invalid Slack workspace page size');
      const allowed = userId ? await botAccess.allowedResources(undefined, userId) : undefined;
      const records = await workspaces
        .find({
          tenantId: tenantId ?? null,
          removedAt: { $exists: false },
          ...(allowed ? { _id: { $in: [...allowed] } } : {}),
          ...(cursor ? { workspaceId: { $gt: cursor } } : {}),
        })
        .sort({ workspaceId: 1 })
        .limit(limit + 1)
        .read('primary')
        .lean();
      const page = records.slice(0, limit);
      const views = await browserMetadata(page);
      return {
        workspaces: views.map((record) => ({
          ...record,
          ...(userId ? { canManageBot: true } : {}),
        })),
        ...(records.length > limit ? { next: page[page.length - 1].workspaceId } : {}),
      };
    },
    async metadata(workspaceId, userId) {
      const record = await workspaces
        .findOne({ workspaceId, tenantId: tenant() ?? null })
        .read('primary')
        .lean();
      if (!record) return null;
      const [views, canManageBot] = await Promise.all([
        browserMetadata([record]),
        userId ? botAccess.allows(record, userId) : undefined,
      ]);
      return { ...views[0], ...(userId ? { canManageBot } : {}) };
    },
    async read(workspaceId) {
      return workspaces
        .findOne({ workspaceId, tenantId: tenant() ?? null })
        .select('+encryptedBotToken')
        .read('primary')
        .lean();
    },
    async disconnect(workspaceId, expectedRevision) {
      const tenantId = tenant();
      return transaction(async (session) => {
        const current = await workspaces
          .findOne({
            workspaceId,
            tenantId: tenantId ?? null,
            ...(expectedRevision ? { revision: expectedRevision } : {}),
          })
          .session(session)
          .lean();
        if (!current) return false;
        const epoch = await generation(current.appId, session);
        if (!epoch) throw new Error('Slack installation generation unavailable');
        // All pending installs for this tenant/app must restart after a disconnect.
        const fenced = await generations.updateOne(
          { partition: tenantId || '_', appId: current.appId, revision: epoch.revision },
          { $set: { revision: nanoid() }, $inc: { writes: 1 } },
          { session },
        );
        if (!fenced.matchedCount) throw new Error('Slack installation generation changed');
        const disconnected = await workspaces.updateOne(
          { workspaceId, revision: current.revision, tenantId: tenantId ?? null },
          {
            $set: { status: 'disconnected', revision: nanoid() },
            $unset: { encryptedBotToken: 1 },
          },
          { session },
        );
        if (!disconnected.matchedCount) throw new Error('Slack workspace ownership changed');
        await botAccess.clear(current, session);
        return true;
      });
    },
    async remove(workspaceId, expectedRevision) {
      const removed = await workspaces.updateOne(
        {
          workspaceId,
          tenantId: tenant() ?? null,
          revision: expectedRevision,
          status: 'disconnected',
          removedAt: { $exists: false },
        },
        { $set: { removedAt: new Date(), revision: nanoid() } },
      );
      return removed.matchedCount === 1;
    },
    async route(appId, teamId) {
      return runAsSystem(async () => {
        const record = await workspaces
          .findOne({ appId, teamId, status: 'active' })
          .read('primary')
          .lean();
        return record ? metadata(record) : null;
      });
    },
  };
}
