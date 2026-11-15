import type { ClientSession } from 'mongoose';
import type { DiscordInstallRecord, DiscordInstallView } from '~/models/discordInstall';
import { createDiscordApplicationModel, createDiscordGuildModel } from '~/models/discord';
import { prepareChannelOwnerAdmission, touchChannelOwnerAdmission } from './channelOwner';
import { getTenantId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordInstallModel } from '~/models/discordInstall';
import { createResponseScopeModel } from '~/models/responseScope';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelIndexGate } from './channelIndexes';
import { createUserModel } from '~/models/user';

export type DiscordInstallError =
  | 'invalid_state'
  | 'application_changed'
  | 'installation_changed'
  | 'principal_unavailable';
export type DiscordInstallResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: DiscordInstallError } };
export interface StartDiscordInstall {
  stateHash: string;
  sessionHash: string;
  userId: string;
  applicationId: string;
  applicationRevision: string;
  expiresAt: Date;
  installationId?: string;
  installationRevision?: string;
}
export interface ConsumeDiscordInstall {
  stateHash: string;
  sessionHash: string;
  userId: string;
  now: Date;
}
export interface DiscordInstallStorage {
  start(input: StartDiscordInstall): Promise<DiscordInstallResult<DiscordInstallView>>;
  /** Server-only callback discovery; the caller must verify its authenticated session. */
  lookup(stateHash: string, now: Date): Promise<DiscordInstallView | null>;
  consume(input: ConsumeDiscordInstall): Promise<DiscordInstallResult<DiscordInstallView>>;
  cancel(input: Pick<ConsumeDiscordInstall, 'stateHash' | 'sessionHash' | 'userId'>): Promise<void>;
}
const failure = (
  code: DiscordInstallError,
): { ok: false; error: { code: DiscordInstallError } } => ({ ok: false, error: { code } });
const hash = /^[a-f\d]{64}$/;
function tenant(): string | undefined {
  const value = getTenantId();
  if (value === SYSTEM_TENANT_ID)
    throw new TypeError('Discord OAuth writes require a tenant scope');
  return value || undefined;
}
function view(record: DiscordInstallRecord): DiscordInstallView {
  return {
    tenantId: record.tenantId,
    stateHash: record.stateHash,
    userId: record.userId,
    applicationId: record.applicationId,
    applicationRevision: record.applicationRevision,
    expiresAt: record.expiresAt,
    ...(record.installationId
      ? {
          installationId: record.installationId,
          installationRevision: record.installationRevision,
          guildId: record.guildId,
        }
      : {}),
  };
}

export function createDiscordInstallStorage(
  mongoose: typeof import('mongoose'),
): DiscordInstallStorage {
  const states = createDiscordInstallModel(mongoose);
  const applications = createDiscordApplicationModel(mongoose);
  const guilds = createDiscordGuildModel(mongoose);
  const users = createUserModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [
    states,
    applications,
    guilds,
    createResponseScopeModel(mongoose),
  ]);
  async function admit(
    userId: string,
    ownerId: string,
    tenantId: string | undefined,
    session: ClientSession,
  ): Promise<boolean> {
    const ids = [...new Set([userId, ownerId])];
    if (!ids.every((id) => mongoose.isValidObjectId(id))) return false;
    if (
      (await users
        .countDocuments({
          _id: { $in: ids },
          tenantId: tenantId ?? null,
          agentTriggerDeletionStartedAt: { $exists: false },
        })
        .session(session)) !== ids.length
    )
      return false;
    for (const id of ids)
      if (!(await touchChannelOwnerAdmission(mongoose, { userId: id, tenantId }, session)))
        return false;
    return true;
  }
  async function canonical(
    record: StartDiscordInstall,
    session: ClientSession,
    tenantId: string | undefined,
  ): Promise<DiscordInstallResult<string | undefined>> {
    const application = await applications
      .findOneAndUpdate(
        {
          tenantId: tenantId ?? null,
          applicationId: record.applicationId,
          revision: record.applicationRevision,
        },
        { $inc: { authorityWrites: 1 } },
        { new: true, session },
      )
      .lean();
    if (!application) return failure('application_changed');
    if (!(await admit(record.userId, application.createdBy, tenantId, session)))
      return failure('principal_unavailable');
    if (!record.installationId) return { ok: true, value: undefined };
    const guild = await guilds
      .findOneAndUpdate(
        {
          tenantId: tenantId ?? null,
          installationId: record.installationId,
          revision: record.installationRevision,
          applicationId: record.applicationId,
          status: { $in: ['active', 'disconnected'] },
        },
        { $inc: { authorityWrites: 1 } },
        { new: true, session },
      )
      .lean();
    if (!guild) return failure('installation_changed');
    if (!(await admit(record.userId, guild.createdBy, tenantId, session)))
      return failure('principal_unavailable');
    return { ok: true, value: guild.guildId };
  }
  return {
    async start(input) {
      const tenantId = tenant();
      if (
        !hash.test(input.stateHash) ||
        !hash.test(input.sessionHash) ||
        !Number.isFinite(input.expiresAt.getTime()) ||
        !input.applicationRevision ||
        Boolean(input.installationId) !== Boolean(input.installationRevision)
      )
        throw new TypeError('Invalid Discord authorization state');
      if (!mongoose.isValidObjectId(input.userId)) return failure('principal_unavailable');
      await prepareChannelOwnerAdmission(mongoose, { userId: input.userId, tenantId });
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          const current = await canonical(input, session, tenantId);
          if (!current.ok) return current;
          const record: DiscordInstallRecord = {
            ...input,
            tenantId,
            ...(current.value ? { guildId: current.value } : {}),
          };
          await states.create([record], { session });
          return { ok: true, value: view(record) };
        },
        ensureIndexes,
      );
    },
    async lookup(stateHash, now) {
      if (!hash.test(stateHash)) return null;
      return runAsSystem(async () => {
        const record = await states
          .findOne({ stateHash, expiresAt: { $gt: now } })
          .select('+stateHash')
          .read('primary')
          .lean();
        return record ? view(record) : null;
      });
    },
    async consume(input) {
      const tenantId = tenant();
      if (!hash.test(input.stateHash) || !hash.test(input.sessionHash))
        return failure('invalid_state');
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          const record = await states
            .findOneAndDelete(
              {
                tenantId: tenantId ?? null,
                stateHash: input.stateHash,
                sessionHash: input.sessionHash,
                userId: input.userId,
                expiresAt: { $gt: input.now },
              },
              { session },
            )
            .select('+stateHash')
            .lean();
          if (!record) return failure('invalid_state');
          const current = await canonical(
            { ...record, sessionHash: input.sessionHash },
            session,
            tenantId,
          );
          if (!current.ok) return current;
          if (current.value !== record.guildId) return failure('installation_changed');
          return { ok: true, value: view(record) };
        },
        ensureIndexes,
      );
    },
    async cancel(input) {
      const tenantId = tenant();
      if (!hash.test(input.stateHash) || !hash.test(input.sessionHash)) return;
      await states.deleteOne({ ...input, tenantId: tenantId ?? null });
    },
  };
}
