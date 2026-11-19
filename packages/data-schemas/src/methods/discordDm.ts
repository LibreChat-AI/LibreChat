import { nanoid } from 'nanoid';
import { createHash, randomBytes } from 'node:crypto';
import {
  discordChannelConfigSchema,
  channelExternalIdentitySchema,
  discordDmSelectionSchema,
  discordDmConsumeSchema,
  discordDmCurrentSchema,
  discordDmLookupSchema,
  discordDmSourceSchema,
  discordDmFenceSchema,
  discordDmIssueSchema,
  discordDmCodeSchema,
} from 'librechat-data-provider';
import type {
  DiscordDmSelection,
  DiscordDmConsume,
  DiscordDmCurrent,
  DiscordDmLookup,
  DiscordDmSource,
  DiscordDmResult,
  DiscordDmError,
  DiscordDmFence,
  DiscordDmIssue,
  DiscordChannelConfig,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordDmSelectionRecord } from '~/models/discordDm';
import { createDiscordDmCodeModel, createDiscordDmSelectionModel } from '~/models/discordDm';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { withRequiredTransaction } from '~/utils/transactions';
import { touchChannelOwnerAdmission } from './channelOwner';
import { createAgentChannelModel } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';
import { touchChannelAuthority } from './channelScope';
import { createUserModel } from '~/models/user';

export interface DiscordDmStorage {
  issue(
    userId: string,
    input: DiscordDmIssue,
    now: number,
  ): Promise<DiscordDmResult<{ code: string; expiresAtMs: number }>>;
  /** Null means no pending code with live authority, including disabled policy. */
  resolvePending(input: DiscordDmLookup, now: number): Promise<DiscordDmSource | null>;
  consume(input: DiscordDmConsume, now: number): Promise<DiscordDmResult<DiscordDmSelection>>;
  /** Null means no currently authorized, unexpired selection. Query failures propagate. */
  current(input: DiscordDmCurrent, now: number): Promise<DiscordDmSelection | null>;
  revoke(userId: string, selectionId: string, revision: string): Promise<boolean>;
}
function tenant(): string | undefined {
  const value = getTenantId();
  if (value === SYSTEM_TENANT_ID) throw new TypeError('Discord DM requires a tenant scope');
  return value || undefined;
}
function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Discord DM clock');
}
const failure = (code: DiscordDmError): { ok: false; error: { code: DiscordDmError } } => ({
  ok: false,
  error: { code },
});
/** Raw codes cross only the issuance boundary and are never persisted. */
export function hashDiscordDmCode(code: string): string {
  return createHash('sha256').update(discordDmCodeSchema.parse(code)).digest('hex');
}
const slot = (
  input: Pick<DiscordDmCurrent, 'applicationId' | 'externalUserId' | 'dmChannelId'>,
) => ({
  tenantId: tenant() ?? null,
  applicationId: input.applicationId,
  externalUserId: input.externalUserId,
  dmChannelId: input.dmChannelId,
});
function view(record: DiscordDmSelectionRecord): DiscordDmSelection | null {
  const parsed = discordDmSelectionSchema.safeParse({
    scope: record.scope,
    selectionId: record.selectionId,
    revision: record.revision,
    applicationId: record.applicationId,
    externalUserId: record.externalUserId,
    dmChannelId: record.dmChannelId,
    confirmationEventId: record.confirmationEventId,
    source: record.source,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  });
  return parsed.success ? parsed.data : null;
}
/** Returns the real current source-link expiry after joining every parent and user fence. */
async function sourceAuthority(
  mongoose: typeof import('mongoose'),
  source: DiscordDmSource,
  applicationRevision: string | undefined,
  now: number,
  session: ClientSession,
): Promise<number | null> {
  if (!discordDmSourceSchema.safeParse(source).success) return null;
  const tenantId = tenant();
  if (
    !mongoose.isValidObjectId(source.userId) ||
    !(await createUserModel(mongoose)
      .exists({
        _id: source.userId,
        tenantId: tenantId ?? null,
        agentTriggerDeletionStartedAt: { $exists: false },
      })
      .session(session)) ||
    !(await touchChannelOwnerAdmission(mongoose, { userId: source.userId, tenantId }, session))
  )
    return null;
  const parent = await createAgentChannelModel(mongoose)
    .exists({
      tenantId: tenantId || { $in: [null, ''] },
      channelId: source.channelId,
      type: 'discord',
      revision: source.channelRevision,
      installationId: source.installationId,
      installationRevision: source.installationRevision,
      'discord.externalChannelId': source.externalChannelId,
    })
    .session(session);
  if (
    !parent ||
    !(await touchChannelAuthority(
      mongoose,
      {
        tenantId,
        provider: 'discord',
        ...source,
        applicationRevision,
        principal: {
          userId: source.userId,
          linkId: source.linkId,
          linkRevision: source.linkRevision,
        },
        now,
      },
      session,
    ))
  )
    return null;
  const linked = await createChannelIdentityModel(mongoose)
    .findOne({
      tenantId: tenantId || '_',
      linkId: source.linkId,
      revision: source.linkRevision,
      userId: source.userId,
      state: 'active',
      expiresAtMs: { $gt: now },
    })
    .session(session)
    .lean();
  return linked && Number.isSafeInteger(linked.expiresAtMs) ? linked.expiresAtMs : null;
}
/** Joins the original real guild authority for an already loaded, validated active selection. */
async function touchLoadedSelection(
  mongoose: typeof import('mongoose'),
  record: DiscordDmSelectionRecord,
  applicationRevision: string | undefined,
  now: number,
  session: ClientSession,
): Promise<boolean> {
  if (!(await sourceAuthority(mongoose, record.source, applicationRevision, now, session)))
    return false;
  const touched = await createDiscordDmSelectionModel(mongoose).updateOne(
    {
      ...slot(record),
      selectionId: record.selectionId,
      revision: record.revision,
      state: 'active',
      expiresAtMs: { $gt: now },
    },
    { $inc: { authorityWrites: 1 } },
    { session },
  );
  return touched.matchedCount === 1;
}
/** Future run transactions must join this current generation and the original real guild authority. */
export async function touchDiscordDmSelection(
  mongoose: typeof import('mongoose'),
  input: DiscordDmFence,
  now: number,
  session: ClientSession,
): Promise<boolean> {
  const parsed = discordDmFenceSchema.parse(input);
  clock(now);
  const record = await createDiscordDmSelectionModel(mongoose)
    .findOne({
      ...slot(parsed),
      selectionId: parsed.selectionId,
      revision: parsed.revision,
      state: 'active',
      expiresAtMs: { $gt: now },
    })
    .session(session)
    .lean();
  if (!record || !view(record)) return false;
  return touchLoadedSelection(mongoose, record, parsed.applicationRevision, now, session);
}
/** Inactive until the authenticated browser and signed BOT_DM adapters are composed. */
export function createDiscordDmStorage(
  mongoose: typeof import('mongoose'),
  readPolicy: () => Promise<Partial<DiscordChannelConfig['dm']>> = async () => ({}),
): DiscordDmStorage {
  const codes = createDiscordDmCodeModel(mongoose);
  const selections = createDiscordDmSelectionModel(mongoose);
  const identities = createChannelIdentityModel(mongoose);
  const channels = createAgentChannelModel(mongoose);
  const indexes = createChannelIndexGate(() => [codes, selections]);
  const policy = async () => discordChannelConfigSchema.shape.dm.parse(await readPolicy());
  const transact = <T>(work: (session: ClientSession) => Promise<T>) =>
    withRequiredTransaction(mongoose, work, indexes);
  return {
    async issue(userId, input, now) {
      const parsed = discordDmIssueSchema.parse(input);
      clock(now);
      const limits = await policy();
      if (!limits.enabled) return failure('disabled');
      if (typeof userId !== 'string' || !mongoose.isValidObjectId(userId))
        return failure('unavailable');
      return transact(async (session) => {
        const linked = await identities
          .findOne({
            tenantId: tenant() || '_',
            userId,
            linkId: parsed.linkId,
            revision: parsed.expectedLinkRevision,
            state: 'active',
            expiresAtMs: { $gt: now },
          })
          .session(session)
          .lean();
        const identity = channelExternalIdentitySchema.safeParse(linked?.identity);
        if (
          !linked ||
          !identity.success ||
          !('provider' in identity.data) ||
          identity.data.provider !== 'discord'
        )
          return failure('unavailable');
        const parent = await channels
          .findOne({
            tenantId: tenant() || { $in: [null, ''] },
            channelId: identity.data.channelId,
            type: 'discord',
          })
          .session(session)
          .lean();
        if (!parent || parent.type !== 'discord' || !parent.discord) return failure('unavailable');
        const candidate = discordDmSourceSchema.safeParse({
          applicationId: identity.data.applicationId,
          externalUserId: identity.data.externalUserId,
          guildId: identity.data.guildId,
          externalChannelId: parent.discord.externalChannelId,
          channelId: identity.data.channelId,
          channelRevision: identity.data.channelRevision,
          agentId: identity.data.agentId,
          installationId: parent.installationId,
          installationRevision: parent.installationRevision,
          userId,
          linkId: linked.linkId,
          linkRevision: linked.revision,
        });
        if (
          !candidate.success ||
          !(await sourceAuthority(mongoose, candidate.data, undefined, now, session))
        )
          return failure('unavailable');
        const source = candidate.data;
        // The source's application authority write serializes counts across all its bindings.
        const pending = await codes
          .find({
            tenantId: tenant() ?? null,
            applicationId: source.applicationId,
            externalUserId: { $ne: source.externalUserId },
            state: 'pending',
            expiresAtMs: { $gt: now },
          })
          .select('_id')
          .limit(limits.maxPendingPerApplication)
          .session(session)
          .lean();
        if (pending.length >= limits.maxPendingPerApplication) return failure('capacity');
        const code = randomBytes(32).toString('base64url');
        const expiresAtMs = Math.min(now + limits.codeTtlMs, linked.expiresAtMs);
        await codes.deleteMany(
          {
            tenantId: tenant() ?? null,
            applicationId: source.applicationId,
            externalUserId: source.externalUserId,
            state: 'pending',
          },
          { session },
        );
        await codes.create(
          [
            {
              tenantId: tenant(),
              applicationId: source.applicationId,
              externalUserId: source.externalUserId,
              codeHash: hashDiscordDmCode(code),
              issuedAtMs: now,
              source,
              expiresAtMs,
              state: 'pending',
              purgeAt: new Date(expiresAtMs),
            },
          ],
          { session },
        );
        return { ok: true, value: { code, expiresAtMs } };
      });
    },
    async resolvePending(input, now) {
      const parsed = discordDmLookupSchema.parse(input);
      clock(now);
      if (!(await policy()).enabled) return null;
      return transact(async (session) => {
        const record = await codes
          .findOne({
            tenantId: tenant() ?? null,
            applicationId: parsed.applicationId,
            externalUserId: parsed.externalUserId,
            codeHash: parsed.codeHash,
            state: 'pending',
            expiresAtMs: { $gt: now },
          })
          .session(session)
          .lean();
        const source = discordDmSourceSchema.safeParse(record?.source);
        return source.success &&
          source.data.applicationId === parsed.applicationId &&
          source.data.externalUserId === parsed.externalUserId &&
          (await sourceAuthority(mongoose, source.data, parsed.applicationRevision, now, session))
          ? source.data
          : null;
      });
    },
    async consume(input, now) {
      const parsed = discordDmConsumeSchema.parse(input);
      clock(now);
      const limits = await policy();
      if (!limits.enabled) return failure('disabled');
      return transact(async (session) => {
        const filter = {
          tenantId: tenant() ?? null,
          applicationId: parsed.applicationId,
          externalUserId: parsed.externalUserId,
          codeHash: parsed.codeHash,
        };
        const code = await codes.findOne(filter).session(session).lean();
        if (!code || code.state === 'revoked') return failure('invalid_code');
        const source = discordDmSourceSchema.safeParse(code.source);
        if (
          !source.success ||
          source.data.applicationId !== parsed.applicationId ||
          source.data.externalUserId !== parsed.externalUserId ||
          !Number.isSafeInteger(code.expiresAtMs) ||
          code.expiresAtMs <= 0
        )
          return failure('invalid_code');
        const sourceExpiry = await sourceAuthority(
          mongoose,
          source.data,
          parsed.applicationRevision,
          now,
          session,
        );
        if (!sourceExpiry) return failure('unavailable');
        if (code.state === 'consumed') {
          if (
            !discordDmFenceSchema.shape.selectionId.safeParse(code.selectionId).success ||
            code.dmChannelId !== parsed.dmChannelId
          )
            return failure('changed');
          const current = await selections
            .findOne({
              ...slot(parsed),
              selectionId: code.selectionId,
              state: 'active',
              expiresAtMs: { $gt: now },
            })
            .session(session)
            .lean();
          const selected = current && view(current);
          return selected &&
            code.dmChannelId === parsed.dmChannelId &&
            JSON.stringify(selected.source) === JSON.stringify(source.data)
            ? { ok: true, value: selected }
            : failure('changed');
        }
        if (code.state !== 'pending' || code.expiresAtMs <= now) return failure('invalid_code');
        const others = await selections
          .find({
            tenantId: tenant() ?? null,
            applicationId: parsed.applicationId,
            state: 'active',
            expiresAtMs: { $gt: now },
            $nor: [{ externalUserId: parsed.externalUserId, dmChannelId: parsed.dmChannelId }],
          })
          .select('_id')
          .limit(limits.maxSelectionsPerApplication)
          .session(session)
          .lean();
        if (others.length >= limits.maxSelectionsPerApplication) return failure('capacity');
        const selected = discordDmSelectionSchema.parse({
          scope: 'dm',
          selectionId: nanoid(),
          revision: nanoid(),
          applicationId: parsed.applicationId,
          externalUserId: parsed.externalUserId,
          dmChannelId: parsed.dmChannelId,
          confirmationEventId: parsed.confirmationEventId,
          source: source.data,
          createdAtMs: now,
          expiresAtMs: Math.min(now + limits.selectionTtlMs, sourceExpiry),
        });
        await codes.deleteMany(
          {
            tenantId: tenant() ?? null,
            applicationId: parsed.applicationId,
            externalUserId: parsed.externalUserId,
            dmChannelId: parsed.dmChannelId,
            state: 'consumed',
          },
          { session },
        );
        await selections.updateOne(
          slot(parsed),
          {
            $set: {
              ...selected,
              state: 'active',
              authorityWrites: 0,
              purgeAt: new Date(selected.expiresAtMs),
            },
          },
          { upsert: true, session, runValidators: true },
        );
        const used = await codes.updateOne(
          { ...filter, state: 'pending' },
          {
            $set: {
              state: 'consumed',
              consumedAtMs: now,
              selectionId: selected.selectionId,
              dmChannelId: parsed.dmChannelId,
              purgeAt: new Date(selected.expiresAtMs),
            },
          },
          { session },
        );
        if (used.matchedCount !== 1) throw new Error('Discord DM code changed during selection');
        return { ok: true, value: selected };
      });
    },
    async current(input, now) {
      const parsed = discordDmCurrentSchema.parse(input);
      clock(now);
      if (!(await policy()).enabled) return null;
      return transact(async (session) => {
        const record = await selections
          .findOne({ ...slot(parsed), state: 'active', expiresAtMs: { $gt: now } })
          .session(session)
          .lean();
        const selected = record && view(record);
        return selected &&
          record &&
          (await touchLoadedSelection(mongoose, record, parsed.applicationRevision, now, session))
          ? selected
          : null;
      });
    },
    async revoke(userId, selectionId, revision) {
      if (typeof userId !== 'string' || !mongoose.isValidObjectId(userId)) return false;
      discordDmFenceSchema.shape.selectionId.parse(selectionId);
      discordDmFenceSchema.shape.revision.parse(revision);
      return transact(async (session) => {
        const record = await selections
          .findOneAndUpdate(
            {
              tenantId: tenant() ?? null,
              'source.userId': userId,
              selectionId,
              revision,
              state: 'active',
            },
            { $set: { state: 'revoked', revision: nanoid() } },
            { session },
          )
          .lean();
        if (!record) return false;
        await codes.deleteMany(
          {
            tenantId: tenant() ?? null,
            applicationId: record.applicationId,
            externalUserId: record.externalUserId,
            'source.userId': userId,
            $or: [{ state: 'pending' }, { state: 'consumed', selectionId }],
          },
          { session },
        );
        return true;
      });
    },
  };
}
