import { z } from 'zod';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import {
  discordGatewayOwnerSchema,
  discordGuildThreadSourceSchema,
  discordThreadBindingSchema,
  channelSnowflakeSchema,
  discordThreadUsable,
  discordThreadRouteSchema,
} from 'librechat-data-provider';
import type {
  DiscordGatewayOwner,
  DiscordGuildThreadSource,
  DiscordThreadBinding,
  DiscordThreadRoute,
  DiscordThreadReference,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordThreadRouteRecord } from '~/models/discordThread';
import { createDiscordThreadRouteModel, createDiscordThreadPinModel } from '~/models/discordThread';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordApplicationModel } from '~/models/discord';
import { createDiscordRouteModel } from '~/models/discordRoute';
import { withRequiredTransaction } from '~/utils/transactions';
import { touchDiscordGatewayOwner } from './discordGateway';
import { createAgentChannelModel } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';
import { touchChannelAuthority } from './channelScope';

export type DiscordThreadResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: 'owner_changed' | 'route_changed' | 'source_unavailable' | 'capacity' };
    };
export interface DiscordThreadAuthority {
  tenantId?: string;
  owner: DiscordGatewayOwner;
  channelId: string;
  channelRevision: string;
  mappingRevision: string;
  externalChannelId: string;
  externalUserId: string;
  source: DiscordGuildThreadSource;
}
export interface DiscordThreadStorage {
  bind(
    owner: DiscordGatewayOwner,
    source: DiscordGuildThreadSource,
    binding: DiscordThreadBinding,
  ): Promise<DiscordThreadResult<DiscordThreadRoute>>;
  /** Routing lookup only; authorizing a message or delivery also requires a fresh source observation. */
  read(
    owner: DiscordGatewayOwner,
    threadChannelId: string,
  ): Promise<DiscordThreadResult<DiscordThreadRoute | null>>;
  authorize(scope: DiscordThreadAuthority): Promise<DiscordThreadResult<DiscordThreadRoute>>;
}
const authorityIds = discordThreadRouteSchema
  .pick({ channelId: true, channelRevision: true, mappingRevision: true })
  .extend({ externalChannelId: channelSnowflakeSchema, externalUserId: channelSnowflakeSchema });
const policySchema = z.object({ maxThreadRoutes: z.number().int().min(1).max(100000) }).strict();
const failed = (
  code: 'owner_changed' | 'route_changed' | 'source_unavailable' | 'capacity',
): { ok: false; error: { code: typeof code } } => ({ ok: false, error: { code } });
function tenant(expected?: string): string | undefined {
  const current = getTenantId() || undefined;
  if (current === SYSTEM_TENANT_ID || (expected !== undefined && expected !== current))
    throw new TypeError('Discord thread tenant mismatch');
  return current;
}
function projection(row: DiscordThreadRouteRecord): DiscordThreadRoute {
  return {
    ...(row.tenantId ? { tenantId: row.tenantId } : {}),
    applicationId: row.applicationId,
    botUserId: row.botUserId,
    guildId: row.guildId,
    parentChannelId: row.parentChannelId,
    threadChannelId: row.threadChannelId,
    threadType: row.threadType,
    channelId: row.channelId,
    channelRevision: row.channelRevision,
    routeRevision: row.routeRevision,
    installationId: row.installationId,
    installationRevision: row.installationRevision,
    mappingRevision: row.mappingRevision,
  };
}
/** Credential revisions and Gateway owners are deliberately excluded from the permanent route pin. */
function fingerprint(row: DiscordThreadRoute): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.tenantId || '_',
        row.applicationId,
        row.botUserId,
        row.guildId,
        row.parentChannelId,
        row.threadChannelId,
        row.threadType,
        row.channelId,
        row.channelRevision,
        row.routeRevision,
        row.installationId,
        row.installationRevision,
      ]),
    )
    .digest('hex');
}
type Parent = Pick<
  DiscordGuildThreadSource,
  'applicationId' | 'botUserId' | 'guildId' | 'parentChannelId'
>;
async function currentParent(
  mongoose: typeof import('mongoose'),
  owner: Pick<DiscordGatewayOwner, 'applicationId' | 'applicationRevision'>,
  source: Parent,
  binding: DiscordThreadBinding,
  session: ClientSession,
) {
  const tenantId = tenant();
  const channel = await createAgentChannelModel(mongoose)
    .findOne({
      tenantId: tenantId ?? null,
      channelId: binding.channelId,
      revision: binding.channelRevision,
      type: 'discord',
      status: 'active',
      'discord.applicationId': owner.applicationId,
      'discord.botUserId': source.botUserId,
      'discord.guildId': source.guildId,
      'discord.externalChannelId': source.parentChannelId,
    })
    .select('channelId agentId revision installationId installationRevision discord')
    .session(session)
    .lean();
  if (
    !channel ||
    !channel.installationId ||
    !channel.installationRevision ||
    source.applicationId !== owner.applicationId
  )
    return null;
  if (
    !(await touchChannelAuthority(
      mongoose,
      {
        tenantId,
        channelId: channel.channelId,
        channelRevision: channel.revision,
        agentId: channel.agentId,
        provider: 'discord',
        applicationId: owner.applicationId,
        applicationRevision: owner.applicationRevision,
        guildId: source.guildId,
        externalChannelId: source.parentChannelId,
      },
      session,
    ))
  )
    return null;
  const route = await createDiscordRouteModel(mongoose)
    .exists({
      tenantId: tenantId ?? null,
      installationId: channel.installationId,
      externalChannelId: source.parentChannelId,
      channelId: channel.channelId,
      revision: binding.routeRevision,
    })
    .session(session);
  return route
    ? { installationId: channel.installationId, installationRevision: channel.installationRevision }
    : null;
}
async function currentMapping(
  mongoose: typeof import('mongoose'),
  owner: Pick<DiscordGatewayOwner, 'applicationId' | 'applicationRevision'>,
  row: DiscordThreadRouteRecord,
  session: ClientSession,
): Promise<boolean> {
  const parent = await currentParent(mongoose, owner, row, row, session);
  if (
    !parent ||
    parent.installationId !== row.installationId ||
    parent.installationRevision !== row.installationRevision
  )
    return false;
  return Boolean(
    await createDiscordThreadPinModel(mongoose)
      .exists({
        applicationId: row.applicationId,
        threadChannelId: row.threadChannelId,
        fingerprint: fingerprint(row),
      })
      .session(session),
  );
}
async function authorize(
  mongoose: typeof import('mongoose'),
  scope: DiscordThreadAuthority,
  session: ClientSession,
): Promise<DiscordThreadRouteRecord | null> {
  tenant(scope.tenantId);
  authorityIds.parse({
    channelId: scope.channelId,
    channelRevision: scope.channelRevision,
    mappingRevision: scope.mappingRevision,
    externalChannelId: scope.externalChannelId,
    externalUserId: scope.externalUserId,
  });
  discordGatewayOwnerSchema.parse(scope.owner);
  const source = discordGuildThreadSourceSchema.parse(scope.source);
  if (
    !discordThreadUsable(source) ||
    source.applicationId !== scope.owner.applicationId ||
    source.threadChannelId !== scope.externalChannelId ||
    source.authorId !== scope.externalUserId
  )
    return null;
  const row = await createDiscordThreadRouteModel(mongoose)
    .findOne({
      tenantId: tenant() ?? null,
      applicationId: scope.owner.applicationId,
      threadChannelId: source.threadChannelId,
      mappingRevision: scope.mappingRevision,
      channelId: scope.channelId,
      channelRevision: scope.channelRevision,
    })
    .session(session)
    .lean();
  if (
    !row ||
    row.botUserId !== source.botUserId ||
    row.guildId !== source.guildId ||
    row.parentChannelId !== source.parentChannelId ||
    row.threadType !== source.threadType ||
    !(await currentMapping(mongoose, scope.owner, row, session))
  )
    return null;
  const touched = await createDiscordThreadRouteModel(mongoose).updateOne(
    {
      tenantId: tenant() ?? null,
      applicationId: row.applicationId,
      threadChannelId: row.threadChannelId,
      mappingRevision: row.mappingRevision,
    },
    { $inc: { authorityWrites: 1 } },
    { session },
  );
  return touched.matchedCount === 1 ? row : null;
}
/** Canonical mapping fence for inbox lease/reply recovery only, never an actor permission grant. */
export async function touchDiscordThreadBinding(
  mongoose: typeof import('mongoose'),
  scope: {
    tenantId?: string;
    applicationId: string;
    applicationRevision?: string;
    channelId: string;
    channelRevision: string;
    externalChannelId: string;
    thread: DiscordThreadReference;
  },
  session: ClientSession,
): Promise<boolean> {
  tenant(scope.tenantId);
  const row = await createDiscordThreadRouteModel(mongoose)
    .findOne({
      tenantId: tenant() ?? null,
      applicationId: scope.applicationId,
      channelId: scope.channelId,
      channelRevision: scope.channelRevision,
      threadChannelId: scope.externalChannelId,
      parentChannelId: scope.thread.parentChannelId,
      mappingRevision: scope.thread.mappingRevision,
    })
    .session(session)
    .lean();
  if (!row) return false;
  const applicationRevision =
    scope.applicationRevision ??
    (
      await createDiscordApplicationModel(mongoose)
        .findOne({ tenantId: tenant() ?? null, applicationId: scope.applicationId })
        .select('revision')
        .session(session)
        .lean()
    )?.revision;
  if (
    !applicationRevision ||
    !(await currentMapping(
      mongoose,
      {
        applicationId: scope.applicationId,
        applicationRevision,
      },
      row,
      session,
    ))
  )
    return false;
  const result = await createDiscordThreadRouteModel(mongoose).updateOne(
    {
      tenantId: tenant() ?? null,
      applicationId: row.applicationId,
      threadChannelId: row.threadChannelId,
      mappingRevision: row.mappingRevision,
    },
    { $inc: { authorityWrites: 1 } },
    { session },
  );
  return result.matchedCount === 1;
}
/** Join future admission/effect transactions to the actual thread and fresh actor-specific source. */
export async function touchDiscordThreadRoute(
  mongoose: typeof import('mongoose'),
  scope: DiscordThreadAuthority,
  session: ClientSession,
): Promise<boolean> {
  tenant(scope.tenantId);
  return Boolean(
    (await touchDiscordGatewayOwner(mongoose, { ...scope.owner, tenantId: tenant() }, session)) &&
      (await authorize(mongoose, scope, session)),
  );
}
/** Replaced parent bindings require a new thread. This API never silently retargets a conversation. */
export function createDiscordThreadStorage(
  mongoose: typeof import('mongoose'),
  readPolicy: () => Promise<{ maxThreadRoutes: number } | null>,
): DiscordThreadStorage {
  const routes = createDiscordThreadRouteModel(mongoose);
  const pins = createDiscordThreadPinModel(mongoose);
  const indexes = createChannelIndexGate(() => [routes, pins]);
  async function operation<T>(
    owner: DiscordGatewayOwner,
    work: (
      policy: { maxThreadRoutes: number },
      session: ClientSession,
    ) => Promise<DiscordThreadResult<T>>,
  ): Promise<DiscordThreadResult<T>> {
    discordGatewayOwnerSchema.parse(owner);
    const tenantId = tenant();
    const settings = await readPolicy();
    if (!settings) return failed('owner_changed');
    const policy = policySchema.parse(settings);
    return withRequiredTransaction(
      mongoose,
      async (session) => {
        if (!(await touchDiscordGatewayOwner(mongoose, { ...owner, tenantId }, session)))
          return failed('owner_changed');
        return work(policy, session);
      },
      indexes,
    );
  }
  return {
    bind: (owner, input, expected) =>
      operation(owner, async (policy, session) => {
        const source = discordGuildThreadSourceSchema.parse(input);
        const binding = discordThreadBindingSchema.parse(expected);
        if (!discordThreadUsable(source) || source.applicationId !== owner.applicationId)
          return failed('source_unavailable');
        const key = { applicationId: owner.applicationId, threadChannelId: source.threadChannelId };
        const row = await routes
          .findOne({ ...key, tenantId: tenant() ?? null })
          .session(session)
          .lean();
        const pin = await pins.findOne(key).session(session).lean();
        if (row) {
          if (
            !pin ||
            row.channelId !== binding.channelId ||
            row.channelRevision !== binding.channelRevision ||
            row.routeRevision !== binding.routeRevision ||
            row.parentChannelId !== source.parentChannelId ||
            row.guildId !== source.guildId ||
            row.botUserId !== source.botUserId ||
            row.threadType !== source.threadType ||
            !(await currentMapping(mongoose, owner, row, session))
          )
            return failed('route_changed');
          return { ok: true, value: projection(row) };
        }
        if (pin) return failed('route_changed');
        const parent = await currentParent(mongoose, owner, source, binding, session);
        if (!parent) return failed('route_changed');
        // The application owner write above serializes count/create, including retired opaque pins.
        if (
          (await pins.countDocuments({ applicationId: owner.applicationId }).session(session)) >=
          policy.maxThreadRoutes
        )
          return failed('capacity');
        const value: DiscordThreadRoute = {
          ...binding,
          tenantId: tenant(),
          applicationId: owner.applicationId,
          botUserId: source.botUserId,
          guildId: source.guildId,
          parentChannelId: source.parentChannelId,
          threadChannelId: source.threadChannelId,
          threadType: source.threadType,
          installationId: parent.installationId,
          installationRevision: parent.installationRevision,
          mappingRevision: nanoid(),
        };
        await routes.create([{ ...value, authorityWrites: 0 }], { session });
        await pins.create([{ ...key, fingerprint: fingerprint(value) }], { session });
        return { ok: true, value };
      }),
    read: (owner, threadChannelId) =>
      operation<DiscordThreadRoute | null>(owner, async (_policy, session) => {
        channelSnowflakeSchema.parse(threadChannelId);
        const row = await routes
          .findOne({
            tenantId: tenant() ?? null,
            applicationId: owner.applicationId,
            threadChannelId,
          })
          .session(session)
          .lean();
        if (!row) {
          const retired = await pins
            .exists({ applicationId: owner.applicationId, threadChannelId })
            .session(session);
          return retired ? failed('route_changed') : { ok: true, value: null };
        }
        return (await currentMapping(mongoose, owner, row, session))
          ? { ok: true, value: projection(row) }
          : failed('route_changed');
      }),
    authorize: (scope) =>
      operation(scope.owner, async (_policy, session) => {
        tenant(scope.tenantId);
        if (!discordThreadUsable(scope.source)) return failed('source_unavailable');
        const row = await authorize(mongoose, scope, session);
        return row ? { ok: true, value: projection(row) } : failed('route_changed');
      }),
  };
}
