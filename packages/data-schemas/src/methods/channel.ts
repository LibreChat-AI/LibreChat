import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { AgentChannel, ChannelStorageConfig } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { SlackWorkspaceRecord } from '~/models/slackWorkspace';
import type { AgentChannelRecord } from '~/models/channel';
import {
  createSlackWorkspaceModel,
  createSlackInstallGenerationModel,
} from '~/models/slackWorkspace';
import { retireAgentChannel, initializeChannelScope, touchChannelScope } from './channelScope';
import { createDiscordApplicationModel, createDiscordGuildModel } from '~/models/discord';
import { eraseChannelFeedbackForChannel } from './channelFeedbackErasure';
import { startRequiredTransactionSession } from '~/utils/transactions';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';
import { createDiscordRouteModel } from '~/models/discordRoute';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { touchSlackWorkspace } from './slackWorkspaceScope';
import { createChannelIndexGate } from './channelIndexes';
import { touchDiscordInstallation } from './discord';
import { responseScopeKeys } from './responseScope';
import { createUserModel } from '~/models/user';

export type { AgentChannelRecord } from '~/models/channel';
export type AgentChannelMetadata = AgentChannel;

export type AgentChannelDeletionResult =
  | { status: 'deleted' }
  | { status: 'pending_drain' }
  | { status: 'not_found' };

export interface AgentChannelMethods {
  createAgentChannel(input: AgentChannelRecord): Promise<AgentChannelRecord>;
  listAgentChannels(agentId: string): Promise<AgentChannelRecord[]>;
  listAgentChannelTenants(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ channels: Array<{ tenantId?: string }>; next?: string }>;
  getAgentChannel(channelId: string): Promise<AgentChannelRecord | null>;
  /** Resolve workspace credentials and current installation status for service execution. */
  getActiveAgentChannel(channelId: string): Promise<AgentChannelRecord | null>;
  getAgentChannelMetadata(channelId: string): Promise<AgentChannelMetadata | null>;
  listDeletingAgentChannels(
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    channels: Array<{ tenantId?: string; channelId: string }>;
    next?: string;
  }>;
  updateAgentChannel(
    channelId: string,
    createdBy: string,
    update: Partial<Omit<AgentChannelRecord, 'channelId' | 'tenantId' | 'agentId' | 'createdBy'>>,
    expectedStatus?: AgentChannelRecord['status'],
    expectedRevision?: string,
  ): Promise<AgentChannelRecord | null>;
  /** Close admission and retire links before external credential cleanup. */
  beginAgentChannelDeletion(
    channelId: string,
    createdBy: string,
  ): Promise<AgentChannelRecord | null>;
  deleteAgentChannel(channelId: string, createdBy: string): Promise<AgentChannelDeletionResult>;
}

export function createAgentChannelMethods(
  mongoose: typeof import('mongoose'),
  getStorageConfig: () => Promise<Partial<ChannelStorageConfig>> = async () => ({}),
): AgentChannelMethods {
  const channel = () => mongoose.model<AgentChannelRecord>('AgentChannel');
  const ensureIndexes = createChannelIndexGate(() => [channel()]);
  const secrets = '+encryptedBotToken +encryptedSigningSecret';

  function withInstallation(
    record: AgentChannelRecord,
    workspace?: SlackWorkspaceRecord | null,
  ): AgentChannelRecord {
    // A restored row of another provider must not inherit Slack workspace credentials.
    if (record.type !== 'slack') return { ...record, status: 'disabled' };
    if (
      !workspace ||
      record.credentialMode !== 'per_user' ||
      (workspace.tenantId || undefined) !== (record.tenantId || undefined)
    )
      return { ...record, status: 'disabled' };
    return {
      ...record,
      slack: { teamId: workspace.teamId, appId: workspace.appId, botUserId: workspace.botUserId },
      ...(workspace.encryptedBotToken ? { encryptedBotToken: workspace.encryptedBotToken } : {}),
    };
  }

  async function discordInstallations(
    records: AgentChannelRecord[],
    includeCredentials: boolean,
  ): Promise<AgentChannelRecord[]> {
    const active = records.filter(
      (record) => record.type === 'discord' && record.status === 'active',
    );
    if (!active.length) return records;
    const appQuery = createDiscordApplicationModel(mongoose)
      .find({
        applicationId: {
          $in: active.flatMap((record) =>
            record.discord?.applicationId ? [record.discord.applicationId] : [],
          ),
        },
      })
      .read('primary');
    const [guilds, apps, routes] = await Promise.all([
      createDiscordGuildModel(mongoose)
        .find({
          installationId: { $in: active.map((record) => record.installationId) },
          status: 'active',
        })
        .read('primary')
        .lean(),
      (includeCredentials ? appQuery.select('+encryptedBotToken') : appQuery).lean(),
      createDiscordRouteModel(mongoose)
        .find({ channelId: { $in: active.map((record) => record.channelId) } })
        .select('tenantId installationId externalChannelId channelId')
        .read('primary')
        .lean(),
    ]);
    const owners = [...guilds, ...apps].filter((record) =>
      mongoose.isValidObjectId(record.createdBy),
    );
    const keys = owners.map(
      (record) =>
        responseScopeKeys(
          { userId: record.createdBy, tenantId: record.tenantId || undefined },
          '',
        )[0],
    );
    const [users, scopes] = await Promise.all([
      createUserModel(mongoose)
        .find({
          _id: { $in: owners.map((record) => record.createdBy) },
          agentTriggerDeletionStartedAt: { $exists: false },
        })
        .select('_id tenantId')
        .read('primary')
        .lean(),
      createResponseScopeModel(mongoose)
        .find({ _id: { $in: keys }, closed: false })
        .select('_id')
        .read('primary')
        .lean(),
    ]);
    const availableUsers = new Map(
      users.map((user) => [String(user._id), user.tenantId || undefined]),
    );
    const availableScopes = new Set(scopes.map((scope) => scope._id));
    const ownerActive = (record: { createdBy: string; tenantId?: string }) =>
      availableUsers.has(record.createdBy) &&
      availableUsers.get(record.createdBy) === (record.tenantId || undefined) &&
      availableScopes.has(
        responseScopeKeys(
          { userId: record.createdBy, tenantId: record.tenantId || undefined },
          '',
        )[0],
      );
    const guildById = new Map(guilds.map((guild) => [guild.installationId, guild]));
    const appById = new Map(apps.map((app) => [app.applicationId, app]));
    const routeByChannel = new Map(routes.map((route) => [route.channelId, route]));
    return records.map((record) => {
      if (record.type !== 'discord' || record.status !== 'active') return record;
      const guild = guildById.get(record.installationId);
      const app = appById.get(record.discord?.applicationId);
      const route = routeByChannel.get(record.channelId);
      if (
        !guild ||
        !app ||
        !route ||
        !record.discord?.externalChannelId ||
        record.credentialMode !== 'per_user' ||
        guild.applicationId !== record.discord.applicationId ||
        guild.guildId !== record.discord.guildId ||
        guild.revision !== record.installationRevision ||
        app.botUserId !== record.discord.botUserId ||
        (guild.tenantId || undefined) !== (record.tenantId || undefined) ||
        (app.tenantId || undefined) !== (record.tenantId || undefined) ||
        (route.tenantId || undefined) !== (record.tenantId || undefined) ||
        route.installationId !== record.installationId ||
        route.externalChannelId !== record.discord.externalChannelId ||
        !ownerActive(guild) ||
        !ownerActive(app) ||
        (includeCredentials && !app.encryptedBotToken)
      )
        return { ...record, status: 'disabled' };
      return {
        ...record,
        ...(includeCredentials
          ? { encryptedBotToken: app.encryptedBotToken, applicationRevision: app.revision }
          : {}),
      };
    });
  }

  async function touchDiscord(
    record: AgentChannelRecord,
    session: ClientSession,
  ): Promise<boolean> {
    if (record.type !== 'discord') return true;
    if (!record.applicationRevision || !record.discord) return false;
    if (
      !(await createDiscordApplicationModel(mongoose)
        .exists({
          tenantId: record.tenantId ?? null,
          applicationId: record.discord.applicationId,
          botUserId: record.discord.botUserId,
          revision: record.applicationRevision,
        })
        .session(session))
    )
      return false;
    return touchDiscordInstallation(
      mongoose,
      {
        tenantId: record.tenantId,
        installationId: record.installationId,
        applicationId: record.discord.applicationId,
        guildId: record.discord.guildId,
        expectedRevision: record.installationRevision,
        expectedApplicationRevision: record.applicationRevision,
      },
      session,
    );
  }

  async function installed(
    record: AgentChannelRecord | null,
    includeCredentials: boolean,
  ): Promise<AgentChannelRecord | null> {
    if (record?.type === 'discord')
      return (await discordInstallations([record], includeCredentials))[0];
    if (!record?.workspaceId || record.status !== 'active') return record;
    const query = createSlackWorkspaceModel(mongoose)
      .findOne({
        workspaceId: record.workspaceId,
        tenantId: record.tenantId ?? null,
        status: 'active',
      })
      .read('primary');
    const workspace = await (
      includeCredentials ? query.select('+encryptedBotToken') : query
    ).lean();
    const resolved = withInstallation(record, workspace);
    if (!includeCredentials || !workspace || resolved.status !== 'active') return resolved;
    const app = await createSlackInstallGenerationModel(mongoose)
      .findOne({
        partition: record.tenantId || '_',
        tenantId: record.tenantId ?? null,
        appId: workspace.appId,
        clientId: { $exists: true },
      })
      .select('+encryptedSigningSecret')
      .read('primary')
      .lean();
    return app?.encryptedSigningSecret
      ? { ...resolved, encryptedSigningSecret: app.encryptedSigningSecret }
      : { ...resolved, status: 'disabled' };
  }

  function validWorkspaceBinding(record: AgentChannelRecord): void {
    if (record.type === 'discord') {
      if (
        record.credentialMode !== 'per_user' ||
        !record.installationId ||
        !record.installationRevision ||
        !record.discord ||
        record.workspaceId ||
        record.slack ||
        record.encryptedBotToken ||
        record.encryptedSigningSecret
      )
        throw new TypeError(
          'Discord channels require an immutable installation and personal identities',
        );
      return;
    }
    if (record.installationId || record.installationRevision || record.discord)
      throw new TypeError('Invalid Slack provider binding');
    if (
      record.workspaceId &&
      (record.credentialMode !== 'per_user' ||
        record.encryptedBotToken ||
        record.encryptedSigningSecret)
    )
      throw new TypeError(
        'Workspace channels require personal identities and installation-owned credentials',
      );
  }

  async function ownerWrite<T>(
    createdBy: string,
    tenantId: string | undefined,
    write: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const admit = await prepareChannelOwnerAdmission(mongoose, { userId: createdBy, tenantId });
    const session = await startRequiredTransactionSession(mongoose);
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        if (!(await admit(session))) throw new Error('Channel owner unavailable');
        result = await write(session);
      });
      if (result === undefined) throw new Error('Channel write did not commit');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function validateMetadataPage(cursor: string | undefined, limit: number): Promise<void> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      (cursor !== undefined && (typeof cursor !== 'string' || !mongoose.isValidObjectId(cursor)))
    )
      throw new Error('Invalid channel metadata page');
    const limits = channelStorageConfigSchema.parse(await getStorageConfig());
    if (limit > limits.maxMetadataPageSize) throw new Error('Invalid channel metadata page');
  }

  async function beginDeletion(channelId: string, createdBy: string) {
    const parent = await channel().findOne({ channelId, createdBy }).select('tenantId type').lean();
    if (!parent) return null;
    return retireAgentChannel(
      mongoose,
      { channelId, createdBy, tenantId: parent.tenantId },
      false,
      parent.type === 'discord'
        ? channelStorageConfigSchema.parse(await getStorageConfig()).erasureBatchSize
        : undefined,
    );
  }

  return {
    async createAgentChannel(input: AgentChannelRecord): Promise<AgentChannelRecord> {
      const currentTenant = getTenantId();
      input = {
        ...input,
        tenantId:
          input.tenantId ?? (currentTenant === SYSTEM_TENANT_ID ? undefined : currentTenant),
      };
      validWorkspaceBinding(input);
      if (input.status === 'deleting') throw new TypeError('Channel deletion requires retirement');
      await ensureIndexes();
      await initializeChannelScope(mongoose, input.tenantId, input.channelId);
      return ownerWrite(input.createdBy, input.tenantId, async (session) => {
        if (!(await touchChannelScope(mongoose, input.tenantId, input.channelId, session)))
          throw new Error('Channel admission closed');
        if (
          input.workspaceId &&
          input.status === 'active' &&
          !(await touchSlackWorkspace(
            mongoose,
            { workspaceId: input.workspaceId, tenantId: input.tenantId },
            session,
          ))
        )
          throw new Error('Slack installation unavailable');
        if (!(await touchDiscord(input, session)))
          throw new Error('Discord installation unavailable');
        const [record] = await channel().create([input], { session });
        return record.toObject();
      });
    },
    async listAgentChannels(agentId: string): Promise<AgentChannelRecord[]> {
      const records = await channel()
        .find({ agentId })
        .sort({ createdAt: 1 })
        .read('primary')
        .lean();
      const workspaceIds = [
        ...new Set(
          records
            .filter((record) => record.status === 'active')
            .flatMap((record) => (record.workspaceId ? [record.workspaceId] : [])),
        ),
      ];
      if (!workspaceIds.length) return discordInstallations(records, false);
      const workspaces = await createSlackWorkspaceModel(mongoose)
        .find({ workspaceId: { $in: workspaceIds }, status: 'active' })
        .read('primary')
        .lean();
      const byId = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
      return discordInstallations(
        records.map((record) =>
          record.workspaceId && record.status === 'active'
            ? withInstallation(record, byId.get(record.workspaceId))
            : record,
        ),
        false,
      );
    },
    async listAgentChannelTenants(cursor, limit) {
      await validateMetadataPage(cursor, limit);
      const records = await channel()
        .find(cursor ? { _id: { $gt: cursor } } : {})
        .select({ _id: 1, tenantId: 1 })
        .sort({ _id: 1 })
        .limit(limit + 1)
        .lean();
      const page = records.slice(0, limit);
      return {
        channels: page.map(({ tenantId }) => ({ tenantId })),
        ...(records.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    async getAgentChannel(channelId: string): Promise<AgentChannelRecord | null> {
      return channel().findOne({ channelId }).select(secrets).lean();
    },
    async getActiveAgentChannel(channelId) {
      const record = await installed(
        await channel().findOne({ channelId }).select(secrets).read('primary').lean(),
        true,
      );
      return record?.status === 'active' ? record : null;
    },
    async getAgentChannelMetadata(channelId) {
      const record = await channel()
        .findOne({ channelId })
        .select({
          _id: 0,
          channelId: 1,
          tenantId: 1,
          agentId: 1,
          createdBy: 1,
          type: 1,
          status: 1,
          credentialMode: 1,
          revision: 1,
          workspaceId: 1,
          installationId: 1,
          installationRevision: 1,
          discord: 1,
          'slack.teamId': 1,
          'slack.appId': 1,
          'slack.botUserId': 1,
        })
        .read('primary')
        .lean();
      return installed(record, false);
    },
    async listDeletingAgentChannels(cursor, limit) {
      await validateMetadataPage(cursor, limit);
      await ensureIndexes();
      const records = await channel()
        .find({ status: 'deleting', ...(cursor ? { _id: { $gt: cursor } } : {}) })
        .select({ _id: 1, tenantId: 1, channelId: 1 })
        .sort({ _id: 1 })
        .limit(limit + 1)
        .lean();
      const page = records.slice(0, limit);
      return {
        channels: page.map(({ tenantId, channelId }) => ({ tenantId, channelId })),
        ...(records.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    async updateAgentChannel(
      channelId: string,
      createdBy: string,
      update: Partial<Omit<AgentChannelRecord, 'channelId' | 'tenantId' | 'agentId' | 'createdBy'>>,
      expectedStatus?: AgentChannelRecord['status'],
      expectedRevision?: string,
    ): Promise<AgentChannelRecord | null> {
      // Deleting is an irreversible lifecycle operation, never a generic metadata patch.
      if (expectedStatus === 'deleting' || update.status === 'deleting') return null;
      const write = async (session: ClientSession): Promise<AgentChannelRecord | null> =>
        channel()
          .findOneAndUpdate(
            {
              channelId,
              createdBy,
              status: expectedStatus ?? { $ne: 'deleting' },
              ...(expectedRevision !== undefined ? { revision: expectedRevision } : {}),
            },
            { $set: update },
            { new: true, session, runValidators: true },
          )
          .select(secrets)
          .lean();
      const parent = await channel()
        .findOne({ channelId, createdBy })
        .select('tenantId type')
        .lean();
      if (!parent) return null;
      await initializeChannelScope(mongoose, parent.tenantId, channelId);
      return ownerWrite(createdBy, parent.tenantId, async (session) => {
        if (!(await touchChannelScope(mongoose, parent.tenantId, channelId, session))) return null;
        const current = await channel()
          .findOne({ channelId, createdBy })
          .select(secrets)
          .session(session)
          .lean();
        if (!current) return null;
        if (update.type !== undefined && update.type !== current.type) return null;
        if (
          current.type === 'discord' &&
          (update.installationId !== undefined ||
            update.installationRevision !== undefined ||
            update.discord !== undefined ||
            update.workspaceId !== undefined ||
            update.slack !== undefined ||
            update.credentialMode !== undefined ||
            update.encryptedBotToken !== undefined ||
            update.encryptedSigningSecret !== undefined)
        )
          return null;
        if (
          current.type === 'slack' &&
          (update.installationId !== undefined ||
            update.installationRevision !== undefined ||
            update.discord !== undefined)
        )
          return null;
        const next: AgentChannelRecord =
          current.type === 'discord'
            ? {
                ...current,
                status: update.status ?? current.status,
                revision: update.revision ?? current.revision,
              }
            : {
                ...current,
                ...update,
                type: 'slack',
                installationId: undefined,
                installationRevision: undefined,
                discord: undefined,
              };
        validWorkspaceBinding(next);
        if (
          next.workspaceId &&
          next.status === 'active' &&
          !(await touchSlackWorkspace(
            mongoose,
            { workspaceId: next.workspaceId, tenantId: parent.tenantId },
            session,
          ))
        )
          return null;
        if (next.type === 'discord' && next.status === 'active') {
          const application = await createDiscordApplicationModel(mongoose)
            .findOne({
              applicationId: next.discord.applicationId,
              tenantId: next.tenantId ?? null,
            })
            .session(session)
            .lean();
          if (
            !application ||
            !(await touchDiscord({ ...next, applicationRevision: application.revision }, session))
          )
            return null;
        }
        return write(session);
      });
    },
    beginAgentChannelDeletion: beginDeletion,
    async deleteAgentChannel(
      channelId: string,
      createdBy: string,
    ): Promise<AgentChannelDeletionResult> {
      const deleting = await beginDeletion(channelId, createdBy);
      if (!deleting) return { status: 'not_found' };
      if (
        await mongoose.models.ChannelRun.exists({
          channelId,
          tenantId: deleting.tenantId || '_',
          state: { $in: ['queued', 'executing', 'requires_action', 'delivering', 'blocked'] },
        })
      )
        return { status: 'pending_drain' };
      // Keep the deleting parent available for a retry if dependent cleanup fails.
      await eraseChannelFeedbackForChannel(mongoose, deleting.tenantId, channelId);
      const result = await channel().deleteOne({
        channelId,
        createdBy,
        status: 'deleting',
      });
      return { status: result.deletedCount > 0 ? 'deleted' : 'not_found' };
    },
  };
}
