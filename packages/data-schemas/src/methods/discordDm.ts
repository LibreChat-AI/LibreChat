import { nanoid } from 'nanoid';
import { isDeepStrictEqual } from 'node:util';
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
  channelRunAdmissionSchema,
  channelSnowflakeSchema,
  discordGuildTextActorUsable,
  discordRunEffectAuthoritySchema,
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
  ChannelRunAdmission,
  ChannelRunPrincipal,
  DiscordNativeAuthority,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordDmSelectionRecord } from '~/models/discordDm';
import { createDiscordDmCodeModel, createDiscordDmSelectionModel } from '~/models/discordDm';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { createDiscordApplicationModel } from '~/models/discord';
import { withRequiredTransaction } from '~/utils/transactions';
import { touchChannelOwnerAdmission } from './channelOwner';
import { touchDiscordGatewayOwner } from './discordGateway';
import { createAgentChannelModel } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';
import { touchChannelAuthority } from './channelScope';
import { createUserModel } from '~/models/user';

export interface DiscordDmStorage {
  /** Owner cleanup remains available while disabled; callers project current eligibility. */
  list(
    userId: string,
    cursor?: string,
  ): Promise<{
    selections: (DiscordDmSelection & { state: 'active' | 'revoked' })[];
    next?: string;
  }>;
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
  /** Current explicit physical DM selection metadata, including while execution is disabled. */
  currentReference(input: DiscordDmCurrent, now: number): Promise<DiscordDmSelection | null>;
  /** Exact canonical metadata for existing runs, including while DM execution is disabled. */
  reference(
    input: Omit<DiscordDmFence, 'applicationRevision'>,
    now: number,
  ): Promise<DiscordDmSelection | null>;
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
  promptEventAtMs?: number,
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
        promptEventAtMs,
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
/** Future run transactions must join this current generation and the original real guild authority. */
export async function touchDiscordDmSelection(
  mongoose: typeof import('mongoose'),
  input: DiscordDmFence,
  now: number,
  session: ClientSession,
): Promise<boolean> {
  const parsed = discordDmFenceSchema.parse(input);
  clock(now);
  const selections = createDiscordDmSelectionModel(mongoose);
  const filter = {
    ...slot(parsed),
    selectionId: parsed.selectionId,
    revision: parsed.revision,
    state: 'active',
    expiresAtMs: { $gt: now },
  };
  const record = await selections.findOne(filter).session(session).lean();
  if (
    !record ||
    !view(record) ||
    !(await sourceAuthority(mongoose, record.source, parsed.applicationRevision, now, session))
  )
    return false;
  const touched = await selections.updateOne(filter, { $inc: { authorityWrites: 1 } }, { session });
  return touched.matchedCount === 1;
}

export interface DiscordDmDestinationScope {
  tenantId?: string;
  channelId: string;
  agentId: string;
  principal: ChannelRunPrincipal;
  admission: ChannelRunAdmission;
  applicationRevision: string;
  now: number;
  expectedSource?: DiscordDmSource;
  /** Supplied only for a new prompt, decoded from its original physical event ID. */
  promptEventAtMs?: number;
}

/** Canonical metadata join for continuation and projections, never a fresh permission grant. */
export async function touchDiscordDmDestination(
  mongoose: typeof import('mongoose'),
  scope: DiscordDmDestinationScope,
  session: ClientSession,
): Promise<boolean> {
  const tenantId = scope.tenantId === '_' ? undefined : scope.tenantId || undefined;
  if (tenantId !== tenant()) throw new TypeError('Discord DM destination tenant mismatch');
  clock(scope.now);
  const admission = channelRunAdmissionSchema.safeParse(scope.admission);
  if (!admission.success) return false;
  const { actor, discordDestination: destination } = admission.data;
  if (
    !('provider' in actor) ||
    actor.provider !== 'discord' ||
    !('scope' in actor) ||
    actor.scope !== 'dm' ||
    destination?.kind !== 'dm'
  )
    return false;
  const fence = discordDmFenceSchema.safeParse({
    applicationId: actor.applicationId,
    applicationRevision: scope.applicationRevision,
    externalUserId: actor.externalUserId,
    dmChannelId: admission.data.externalChannelId,
    selectionId: actor.selectionId,
    revision: actor.selectionRevision,
  });
  if (!fence.success || !channelSnowflakeSchema.safeParse(admission.data.eventId).success)
    return false;
  const filter = {
    ...slot(fence.data),
    selectionId: fence.data.selectionId,
    revision: fence.data.revision,
    state: 'active',
    expiresAtMs: { $gt: scope.now },
  };
  const selections = createDiscordDmSelectionModel(mongoose);
  const record = await selections.findOne(filter).session(session).lean();
  const selected = record && view(record);
  if (!selected) return false;
  const source = selected.source;
  if (!scope.principal) return false;
  if (
    (scope.expectedSource !== undefined && !isDeepStrictEqual(source, scope.expectedSource)) ||
    source.channelId !== scope.channelId ||
    source.agentId !== scope.agentId ||
    source.userId !== scope.principal.userId ||
    source.channelRevision !== scope.principal.channelRevision ||
    source.linkId !== scope.principal.linkId ||
    source.linkRevision !== scope.principal.linkRevision ||
    source.externalChannelId !== destination.parentChannelId ||
    admission.data.externalThreadKey !==
      `${selected.dmChannelId}:${selected.confirmationEventId}` ||
    admission.data.externalMessageKey !== `${selected.dmChannelId}:${admission.data.eventId}`
  )
    return false;
  if (scope.promptEventAtMs !== undefined) {
    const event = BigInt(admission.data.eventId);
    const eventAtMs = Number(event >> BigInt(22)) + 1420070400000;
    if (scope.promptEventAtMs !== eventAtMs || event <= BigInt(selected.confirmationEventId))
      return false;
  }
  if (
    !(await sourceAuthority(
      mongoose,
      source,
      scope.applicationRevision,
      scope.now,
      session,
      scope.promptEventAtMs,
    ))
  )
    return false;
  const touched = await selections.updateOne(filter, { $inc: { authorityWrites: 1 } }, { session });
  return touched.matchedCount === 1;
}

/** Provider effects also require a current owned Gateway and fresh real-source actor observation. */
export async function authorizeDiscordDmDestination(
  mongoose: typeof import('mongoose'),
  scope: DiscordDmDestinationScope,
  native: Extract<DiscordNativeAuthority, { kind: 'dm' }>,
  session: ClientSession,
): Promise<boolean> {
  const parsed = discordRunEffectAuthoritySchema.safeParse({
    applicationRevision: scope.applicationRevision,
    native,
  });
  const admission = channelRunAdmissionSchema.safeParse(scope.admission);
  if (!admission.success || !scope.principal) return false;
  const actor = admission.data.actor;
  const destination = admission.data.discordDestination;
  if (
    !parsed.success ||
    native.kind !== 'dm' ||
    !('provider' in actor) ||
    actor.provider !== 'discord' ||
    !('scope' in actor) ||
    actor.scope !== 'dm' ||
    destination?.kind !== 'dm' ||
    native.owner.applicationId !== actor.applicationId ||
    native.source.authorId !== actor.externalUserId ||
    native.source.channelId !== destination.parentChannelId ||
    !discordGuildTextActorUsable(native.source)
  )
    return false;
  const tenantId = scope.tenantId === '_' ? undefined : scope.tenantId || undefined;
  if (tenantId !== tenant()) throw new TypeError('Discord DM destination tenant mismatch');
  const parent = await createAgentChannelModel(mongoose)
    .exists({
      tenantId: tenantId || { $in: [null, ''] },
      channelId: scope.channelId,
      agentId: scope.agentId,
      revision: scope.principal.channelRevision,
      type: 'discord',
      'discord.applicationId': native.source.applicationId,
      'discord.guildId': native.source.guildId,
      'discord.botUserId': native.source.botUserId,
      'discord.externalChannelId': native.source.channelId,
    })
    .session(session);
  return Boolean(
    parent &&
      (await touchDiscordGatewayOwner(mongoose, { tenantId, ...native.owner }, session)) &&
      (await touchDiscordDmDestination(mongoose, scope, session)),
  );
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
  const current = (input: DiscordDmCurrent | DiscordDmFence, now: number) =>
    transact(async (session) => {
      const record = await selections
        .findOne({
          ...slot(input),
          ...('selectionId' in input
            ? { selectionId: input.selectionId, revision: input.revision }
            : {}),
          state: 'active',
          expiresAtMs: { $gt: now },
        })
        .session(session)
        .lean();
      const selected = record && view(record);
      return selected &&
        (await touchDiscordDmSelection(
          mongoose,
          { ...input, selectionId: selected.selectionId, revision: selected.revision },
          now,
          session,
        ))
        ? selected
        : null;
    });
  return {
    async list(userId, cursor) {
      if (typeof userId !== 'string' || !mongoose.isValidObjectId(userId))
        throw new TypeError('Invalid Discord DM owner');
      if (cursor !== undefined) discordDmFenceSchema.shape.selectionId.parse(cursor);
      const rows = await selections
        .find({
          tenantId: tenant() ?? null,
          'source.userId': userId,
          selectionId: {
            $type: 'string',
            $regex: '^[\\w-]{1,128}$',
            ...(cursor ? { $gt: cursor } : {}),
          },
        })
        .sort({ selectionId: 1 })
        .limit(101)
        .read('primary')
        .lean();
      const page = rows.slice(0, 100);
      return {
        selections: page.flatMap((record) => {
          const selected = view(record);
          return selected && (record.state === 'active' || record.state === 'revoked')
            ? [{ ...selected, state: record.state }]
            : [];
        }),
        ...(rows.length > 100 ? { next: page[page.length - 1].selectionId } : {}),
      };
    },
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
      return current(parsed, now);
    },
    async currentReference(input, now) {
      const parsed = discordDmCurrentSchema.parse(input);
      clock(now);
      return current(parsed, now);
    },
    async reference(input, now) {
      const parsed = discordDmFenceSchema.omit({ applicationRevision: true }).parse(input);
      clock(now);
      const application = await createDiscordApplicationModel(mongoose)
        .findOne({ applicationId: parsed.applicationId, tenantId: tenant() ?? null })
        .select('revision')
        .read('primary')
        .lean();
      const fence =
        application &&
        discordDmFenceSchema.safeParse({ ...parsed, applicationRevision: application.revision });
      return fence?.success ? current(fence.data, now) : null;
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
