import { nanoid } from 'nanoid';
import { channelSnowflakeSchema, discordPublicKeySchema } from 'librechat-data-provider';
import type { DiscordApplication, DiscordGuild } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordApplicationRecord } from '~/models/discord';
import { createDiscordApplicationModel, createDiscordGuildModel } from '~/models/discord';
import { prepareChannelOwnerAdmission, touchChannelOwnerAdmission } from './channelOwner';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelIndexGate } from './channelIndexes';
import { createUserModel } from '~/models/user';

export type DiscordStorageError =
  | 'application_in_use'
  | 'application_changed'
  | 'application_unavailable'
  | 'installation_changed'
  | 'principal_unavailable';
export type DiscordStorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DiscordStorageError } };

export interface ConfigureDiscordApplicationRecord {
  actorId: string;
  applicationId: string;
  botUserId: string;
  publicKey: string;
  name?: string;
  encryptedBotToken?: string;
  encryptedClientSecret?: string;
  expectedRevision?: string;
}

export interface ConnectDiscordGuild {
  actorId: string;
  applicationId: string;
  applicationRevision: string;
  guildId: string;
  guildName: string;
  installationId?: string;
  expectedRevision?: string;
}

export interface DiscordInstallationScope {
  expectedApplicationRevision: string;
  tenantId?: string;
  installationId: string;
  applicationId: string;
  guildId: string;
  expectedRevision: string;
}

export interface DiscordInstallationStorage {
  configureApplication(
    input: ConfigureDiscordApplicationRecord,
  ): Promise<DiscordStorageResult<DiscordApplication>>;
  readApplication(applicationId: string): Promise<DiscordApplication | null>;
  readApplicationCredentials(applicationId: string): Promise<DiscordApplicationRecord | null>;
  listApplications(
    cursor?: string,
    limit?: number,
  ): Promise<{ applications: DiscordApplication[]; next?: string }>;
  connectGuild(input: ConnectDiscordGuild): Promise<DiscordStorageResult<DiscordGuild>>;
  readGuild(installationId: string): Promise<DiscordGuild | null>;
  listGuilds(cursor?: string, limit?: number): Promise<{ guilds: DiscordGuild[]; next?: string }>;
  disconnectGuild(input: {
    actorId: string;
    installationId: string;
    expectedRevision: string;
  }): Promise<DiscordStorageResult<DiscordGuild>>;
}

const failure = (
  code: DiscordStorageError,
): { ok: false; error: { code: DiscordStorageError } } => ({
  ok: false,
  error: { code },
});

function tenant(): string | undefined {
  const tenantId = getTenantId();
  if (tenantId === SYSTEM_TENANT_ID) throw new TypeError('Discord storage requires a tenant scope');
  return tenantId || undefined;
}

function applicationMetadata(record: DiscordApplication): DiscordApplication {
  return {
    tenantId: record.tenantId,
    applicationId: record.applicationId,
    botUserId: record.botUserId,
    publicKey: record.publicKey,
    ...(record.name !== undefined ? { name: record.name } : {}),
    createdBy: record.createdBy,
    revision: record.revision,
    authorityWrites: record.authorityWrites,
  };
}

function guildMetadata(record: DiscordGuild): DiscordGuild {
  return {
    tenantId: record.tenantId,
    installationId: record.installationId,
    applicationId: record.applicationId,
    guildId: record.guildId,
    guildName: record.guildName,
    createdBy: record.createdBy,
    status: record.status,
    revision: record.revision,
    authorityWrites: record.authorityWrites,
  };
}

async function activeOwner(
  mongoose: typeof import('mongoose'),
  userId: string,
  tenantId: string | undefined,
  session: ClientSession,
): Promise<boolean> {
  if (!mongoose.isValidObjectId(userId)) return false;
  if (
    !(await createUserModel(mongoose)
      .exists({
        _id: userId,
        tenantId: tenantId ?? null,
        agentTriggerDeletionStartedAt: { $exists: false },
      })
      .session(session))
  )
    return false;
  return touchChannelOwnerAdmission(mongoose, { userId, tenantId }, session);
}

function pageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError('Invalid Discord metadata page size');
}

/** Joins admission to credential rotation, owner erasure and disconnect/reconnect fences. */
export async function touchDiscordInstallation(
  mongoose: typeof import('mongoose'),
  scope: DiscordInstallationScope,
  session: ClientSession,
): Promise<boolean> {
  const tenantId = tenant();
  if ((scope.tenantId || undefined) !== tenantId)
    throw new TypeError('Discord installation tenant does not match authenticated scope');
  if (!scope.expectedRevision || !scope.expectedApplicationRevision) return false;
  const application = await createDiscordApplicationModel(mongoose)
    .findOneAndUpdate(
      {
        applicationId: scope.applicationId,
        tenantId: tenantId ?? null,
        revision: scope.expectedApplicationRevision,
      },
      { $inc: { authorityWrites: 1 } },
      { new: true, session },
    )
    .lean();
  if (!application || !(await activeOwner(mongoose, application.createdBy, tenantId, session)))
    return false;
  const guild = await createDiscordGuildModel(mongoose)
    .findOneAndUpdate(
      {
        tenantId: tenantId ?? null,
        installationId: scope.installationId,
        applicationId: scope.applicationId,
        guildId: scope.guildId,
        revision: scope.expectedRevision,
        status: 'active',
      },
      { $inc: { authorityWrites: 1 } },
      { new: true, session },
    )
    .lean();
  return Boolean(guild && (await activeOwner(mongoose, guild.createdBy, tenantId, session)));
}

/** The owning service authorizes administrators and verifies provider metadata before writes. */
export function createDiscordInstallationStorage(
  mongoose: typeof import('mongoose'),
): DiscordInstallationStorage {
  const applications = createDiscordApplicationModel(mongoose);
  const guilds = createDiscordGuildModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [
    applications,
    guilds,
    createUserModel(mongoose),
    createResponseScopeModel(mongoose),
  ]);
  async function mutate<T>(
    actorId: string,
    write: (
      session: ClientSession,
      tenantId: string | undefined,
    ) => Promise<DiscordStorageResult<T>>,
  ): Promise<DiscordStorageResult<T>> {
    const tenantId = tenant();
    if (!mongoose.isValidObjectId(actorId)) return failure('principal_unavailable');
    const admit = await prepareChannelOwnerAdmission(mongoose, { userId: actorId, tenantId });
    return withRequiredTransaction(
      mongoose,
      async (session) => {
        if (!(await admit(session)) || !(await activeOwner(mongoose, actorId, tenantId, session)))
          return failure('principal_unavailable');
        return write(session, tenantId);
      },
      ensureIndexes,
    );
  }
  return {
    async configureApplication(input) {
      channelSnowflakeSchema.parse(input.applicationId);
      channelSnowflakeSchema.parse(input.botUserId);
      discordPublicKeySchema.parse(input.publicKey);
      if (
        (input.name !== undefined && input.name.length > 100) ||
        input.encryptedBotToken === '' ||
        input.encryptedClientSecret === ''
      )
        throw new TypeError('Invalid Discord application metadata');
      try {
        return await mutate(input.actorId, async (session, tenantId) => {
          const current = await applications
            .findOne({
              applicationId: input.applicationId,
              tenantId: tenantId ?? null,
            })
            .session(session)
            .lean();
          if (
            current
              ? current.revision !== input.expectedRevision || current.botUserId !== input.botUserId
              : input.expectedRevision !== undefined
          )
            return failure('application_changed');
          if (!current && (!input.encryptedBotToken || !input.encryptedClientSecret))
            throw new TypeError('New Discord applications require encrypted credentials');
          if (current && !(await activeOwner(mongoose, current.createdBy, tenantId, session)))
            return failure('principal_unavailable');
          const revision = nanoid();
          if (current) {
            const saved = await applications
              .findOneAndUpdate(
                {
                  applicationId: input.applicationId,
                  tenantId: tenantId ?? null,
                  revision: input.expectedRevision,
                },
                {
                  $set: {
                    publicKey: input.publicKey,
                    revision,
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.encryptedBotToken
                      ? { encryptedBotToken: input.encryptedBotToken }
                      : {}),
                    ...(input.encryptedClientSecret
                      ? { encryptedClientSecret: input.encryptedClientSecret }
                      : {}),
                  },
                  $inc: { authorityWrites: 1 },
                },
                { new: true, session, runValidators: true },
              )
              .lean();
            return saved
              ? { ok: true, value: applicationMetadata(saved) }
              : failure('application_changed');
          }
          const [saved] = await applications.create(
            [
              {
                tenantId,
                applicationId: input.applicationId,
                botUserId: input.botUserId,
                publicKey: input.publicKey,
                ...(input.name !== undefined ? { name: input.name } : {}),
                createdBy: input.actorId,
                revision,
                authorityWrites: 0,
                encryptedBotToken: input.encryptedBotToken,
                encryptedClientSecret: input.encryptedClientSecret,
              },
            ],
            { session },
          );
          return { ok: true, value: applicationMetadata(saved) };
        });
      } catch (error) {
        if (
          error instanceof mongoose.mongo.MongoServerError &&
          error.code === 11000 &&
          error.keyPattern?.applicationId === 1 &&
          Object.keys(error.keyPattern).length === 1
        )
          return failure('application_in_use');
        throw error;
      }
    },
    async readApplication(applicationId) {
      const record = await applications
        .findOne({ applicationId, tenantId: tenant() ?? null })
        .read('primary')
        .lean();
      return record ? applicationMetadata(record) : null;
    },
    async readApplicationCredentials(applicationId) {
      const record = await applications
        .findOne({ applicationId, tenantId: tenant() ?? null })
        .select('+encryptedBotToken +encryptedClientSecret')
        .read('primary')
        .lean();
      return record
        ? {
            ...applicationMetadata(record),
            encryptedBotToken: record.encryptedBotToken,
            encryptedClientSecret: record.encryptedClientSecret,
          }
        : null;
    },
    async listApplications(cursor, limit = 50) {
      pageLimit(limit);
      const records = await applications
        .find({ tenantId: tenant() ?? null, ...(cursor ? { applicationId: { $gt: cursor } } : {}) })
        .sort({ applicationId: 1 })
        .limit(limit + 1)
        .read('primary')
        .lean();
      const page = records.slice(0, limit).map(applicationMetadata);
      return {
        applications: page,
        ...(records.length > limit ? { next: page[page.length - 1].applicationId } : {}),
      };
    },
    async connectGuild(input) {
      channelSnowflakeSchema.parse(input.applicationId);
      channelSnowflakeSchema.parse(input.guildId);
      if (!input.guildName || input.guildName.length > 256)
        throw new TypeError('Invalid Discord guild name');
      return mutate(input.actorId, async (session, tenantId) => {
        const application = await applications
          .findOneAndUpdate(
            {
              applicationId: input.applicationId,
              tenantId: tenantId ?? null,
              revision: input.applicationRevision,
            },
            { $inc: { authorityWrites: 1 } },
            { new: true, session },
          )
          .lean();
        if (!application) return failure('application_changed');
        if (!(await activeOwner(mongoose, application.createdBy, tenantId, session)))
          return failure('principal_unavailable');
        const current = await guilds
          .findOne({
            tenantId: tenantId ?? null,
            applicationId: input.applicationId,
            guildId: input.guildId,
          })
          .session(session)
          .lean();
        if (
          current
            ? current.revision !== input.expectedRevision ||
              (input.installationId !== undefined &&
                current.installationId !== input.installationId)
            : input.expectedRevision !== undefined || input.installationId !== undefined
        )
          return failure('installation_changed');
        if (current && !(await activeOwner(mongoose, current.createdBy, tenantId, session)))
          return failure('principal_unavailable');
        if (current) {
          const saved = await guilds
            .findOneAndUpdate(
              {
                installationId: current.installationId,
                tenantId: tenantId ?? null,
                revision: input.expectedRevision,
              },
              {
                $set: { guildName: input.guildName, status: 'active', revision: nanoid() },
                $inc: { authorityWrites: 1 },
              },
              { new: true, session, runValidators: true },
            )
            .lean();
          return saved
            ? { ok: true, value: guildMetadata(saved) }
            : failure('installation_changed');
        }
        const [saved] = await guilds.create(
          [
            {
              tenantId,
              installationId: nanoid(),
              applicationId: input.applicationId,
              guildId: input.guildId,
              guildName: input.guildName,
              createdBy: input.actorId,
              status: 'active',
              revision: nanoid(),
              authorityWrites: 0,
            },
          ],
          { session },
        );
        return { ok: true, value: guildMetadata(saved) };
      });
    },
    async readGuild(installationId) {
      const record = await guilds
        .findOne({ installationId, tenantId: tenant() ?? null })
        .read('primary')
        .lean();
      return record ? guildMetadata(record) : null;
    },
    async listGuilds(cursor, limit = 50) {
      pageLimit(limit);
      const records = await guilds
        .find({
          tenantId: tenant() ?? null,
          ...(cursor ? { installationId: { $gt: cursor } } : {}),
        })
        .sort({ installationId: 1 })
        .limit(limit + 1)
        .read('primary')
        .lean();
      const page = records.slice(0, limit).map(guildMetadata);
      return {
        guilds: page,
        ...(records.length > limit ? { next: page[page.length - 1].installationId } : {}),
      };
    },
    async disconnectGuild(input) {
      return mutate(input.actorId, async (session, tenantId) => {
        const current = await guilds
          .findOne({
            installationId: input.installationId,
            tenantId: tenantId ?? null,
            revision: input.expectedRevision,
            status: 'active',
          })
          .session(session)
          .lean();
        if (!current) return failure('installation_changed');
        const application = await applications.updateOne(
          {
            applicationId: current.applicationId,
            tenantId: tenantId ?? null,
          },
          { $inc: { authorityWrites: 1 } },
          { session },
        );
        if (!application.matchedCount) return failure('application_unavailable');
        const saved = await guilds
          .findOneAndUpdate(
            {
              installationId: current.installationId,
              tenantId: tenantId ?? null,
              revision: input.expectedRevision,
            },
            { $set: { status: 'disconnected', revision: nanoid() }, $inc: { authorityWrites: 1 } },
            { new: true, session },
          )
          .lean();
        return saved ? { ok: true, value: guildMetadata(saved) } : failure('installation_changed');
      });
    },
  };
}
