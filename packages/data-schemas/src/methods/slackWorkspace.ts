import { nanoid } from 'nanoid';
import type { SlackWorkspace, SlackAppRegistration } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  SlackInstallRecord,
  SlackWorkspaceRecord,
  SlackClaimedInstall,
  SlackInstallGeneration,
} from '~/models/slackWorkspace';
import {
  createSlackInstallModel,
  createSlackWorkspaceModel,
  createSlackInstallGenerationModel,
} from '~/models/slackWorkspace';
import { prepareChannelOwnerAdmission, touchChannelOwnerAdmission } from './channelOwner';
import { getTenantId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelIndexGate } from './channelIndexes';

export type SlackWorkspaceMetadata = SlackWorkspace;
export type SlackWorkspaceInstallResult =
  | { ok: true; workspace: SlackWorkspaceMetadata }
  | {
      ok: false;
      code: 'invalid_install' | 'stale_install' | 'workspace_in_use' | 'workspace_changed';
    };

export interface SlackWorkspaceStorage {
  /** Credentials and the OAuth installation fence share the same organization/app revision. */
  app(appId: string): Promise<SlackInstallGeneration | null>;
  apps(cursor?: string, limit?: number): Promise<{ apps: SlackAppRegistration[]; next?: string }>;
  configureApp(
    input: Required<
      Pick<
        SlackInstallGeneration,
        'appId' | 'clientId' | 'encryptedClientSecret' | 'encryptedSigningSecret'
      >
    >,
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
  ): Promise<{
    workspaces: SlackWorkspaceMetadata[];
    next?: string;
  }>;
  read(workspaceId: string): Promise<SlackWorkspaceRecord | null>;
  metadata(workspaceId: string): Promise<SlackWorkspaceMetadata | null>;
  disconnect(workspaceId: string, expectedRevision?: string): Promise<boolean>;
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
  const flows = createSlackInstallModel(mongoose);
  const generations = createSlackInstallGenerationModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [workspaces, flows, generations]);

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

  return {
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
      const apps = records
        .slice(0, limit)
        .map(({ appId, clientId, revision }) => ({ appId, clientId: clientId!, revision }));
      return { apps, ...(records.length > limit ? { next: apps[apps.length - 1].appId } : {}) };
    },
    async configureApp(input, userId, expectedRevision) {
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
        const revision = nanoid();
        const changed = await generations.updateOne(
          {
            partition: tenantId || '_',
            appId: input.appId,
            tenantId: tenantId ?? null,
            revision: current.revision,
          },
          { $set: { ...input, revision }, $inc: { writes: 1 } },
          { session },
        );
        if (!changed.matchedCount) return null;
        return { appId: input.appId, clientId: input.clientId!, revision };
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
            $unset: { clientId: 1, encryptedClientSecret: 1, encryptedSigningSecret: 1 },
          },
          { session },
        );
        return changed.matchedCount ? 'removed' : 'conflict';
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
      return transaction<SlackWorkspaceInstallResult>(async (session) => {
        const flow = await flows
          .findOneAndDelete({ stateHash, callbackId, tenantId: tenantId ?? null }, { session })
          .lean();
        if (!flow || flow.appId !== input.appId || flow.expiresAt <= now)
          return { ok: false, code: 'invalid_install' };
        if (
          !(await touchChannelOwnerAdmission(mongoose, { userId: flow.userId, tenantId }, session))
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
          const current = await workspaces
            .findOne({ appId: input.appId, teamId: input.teamId })
            .session(session)
            .lean();
          if (current?.status === 'active' && (current.tenantId || undefined) !== tenantId)
            return { ok: false, code: 'workspace_in_use' };
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
          if (current) {
            const updated = await workspaces.replaceOne(
              { workspaceId: current.workspaceId, revision: current.revision },
              workspace,
              { session },
            );
            if (!updated.matchedCount) throw new Error('Slack workspace ownership changed');
          } else await workspaces.create([workspace], { session });
          return { ok: true, workspace: metadata(workspace) };
        });
      });
    },
    async list(cursor, limit = 50) {
      const tenantId = tenant();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('Invalid Slack workspace page size');
      const records = await workspaces
        .find({ tenantId: tenantId ?? null, ...(cursor ? { workspaceId: { $gt: cursor } } : {}) })
        .sort({ workspaceId: 1 })
        .limit(limit + 1)
        .read('primary')
        .lean();
      const page = records.slice(0, limit);
      return {
        workspaces: page.map(metadata),
        ...(records.length > limit ? { next: page[page.length - 1].workspaceId } : {}),
      };
    },
    async metadata(workspaceId) {
      const record = await workspaces
        .findOne({ workspaceId, tenantId: tenant() ?? null })
        .read('primary')
        .lean();
      return record ? metadata(record) : null;
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
        return true;
      });
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
