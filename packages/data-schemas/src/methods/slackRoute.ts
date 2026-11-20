import { nanoid } from 'nanoid';
import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { SlackRouteRecord } from '~/models/slackRoute';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createSlackWorkspaceModel } from '~/models/slackWorkspace';
import { withRequiredTransaction } from '~/utils/transactions';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createSlackRouteModel } from '~/models/slackRoute';
import { touchSlackWorkspace } from './slackWorkspaceScope';
import { createAgentChannelModel } from '~/models/channel';
import { createChannelIndexGate } from './channelIndexes';
import { createSlackBotAccess } from './slackBotAccess';
import { touchChannelScope } from './channelScope';

type RouteResult =
  | { ok: true; route: SlackRouteRecord | null }
  | {
      ok: false;
      code:
        | 'principal_unavailable'
        | 'workspace_unavailable'
        | 'channel_unavailable'
        | 'route_changed'
        | 'bot_access_required';
    };

export interface SlackRouteStorage {
  listForChannel(
    channelId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    routes: Array<Pick<SlackRouteRecord, 'externalChannelId' | 'revision'>>;
    next?: string;
  }>;
  read(workspaceId: string, externalChannelId?: string): Promise<SlackRouteRecord | null>;
  resolve(workspaceId: string, externalChannelId: string): Promise<SlackRouteRecord | null>;
  assign(input: {
    userId: string;
    workspaceId: string;
    externalChannelId?: string;
    channelId: string;
    channelRevision: string;
    expectedRevision?: string;
    /** Trusted current administrator authority; never supplied by a browser. */
    isBotAdmin?: boolean;
    /** Activate an existing pending/disabled binding in the same route transaction. */
    activate?: boolean;
  }): Promise<RouteResult>;
  remove(input: {
    userId: string;
    workspaceId: string;
    externalChannelId?: string;
    expectedRevision: string;
    channelId?: string;
  }): Promise<RouteResult>;
}

export function createSlackRouteStorage(
  mongoose: typeof import('mongoose'),
  getLimits: () => Promise<Partial<ChannelStorageConfig>> = async () => ({}),
): SlackRouteStorage {
  const routes = createSlackRouteModel(mongoose);
  const botAccess = createSlackBotAccess(mongoose);
  const workspaces = createSlackWorkspaceModel(mongoose);
  const channels = createAgentChannelModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [routes, workspaces, channels]);
  const tenant = () => {
    const id = getTenantId();
    if (id === SYSTEM_TENANT_ID) throw new Error('Slack route writes require a tenant scope');
    return id || undefined;
  };
  const scope = (workspaceId: string, externalChannelId?: string) => ({
    tenantId: tenant() ?? null,
    workspaceId,
    externalChannelId: externalChannelId ?? null,
  });
  const read = async (workspaceId: string, externalChannelId?: string) =>
    routes.findOne(scope(workspaceId, externalChannelId)).read('primary').lean();

  async function change(
    userId: string,
    write: (session: ClientSession) => Promise<RouteResult>,
  ): Promise<RouteResult> {
    const admit = await prepareChannelOwnerAdmission(mongoose, { userId, tenantId: tenant() });
    return withRequiredTransaction(
      mongoose,
      async (session) => {
        if (!(await admit(session))) return { ok: false, code: 'principal_unavailable' };
        return write(session);
      },
      ensureIndexes,
    );
  }

  return {
    async listForChannel(channelId, cursor, limit = 50) {
      const limits = channelStorageConfigSchema.parse(await getLimits());
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > limits.maxMetadataPageSize ||
        (cursor !== undefined && !mongoose.isValidObjectId(cursor))
      )
        throw new TypeError('Invalid Slack route page');
      const records = await routes
        .find({
          tenantId: tenant() ?? null,
          channelId,
          ...(cursor ? { _id: { $gt: cursor } } : {}),
        })
        .sort({ _id: 1 })
        .limit(limit + 1)
        .select({ externalChannelId: 1, revision: 1 })
        .read('primary')
        .lean();
      const page = records.slice(0, limit);
      return {
        routes: page.map(({ externalChannelId, revision }) => ({ externalChannelId, revision })),
        ...(records.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    read,
    async resolve(workspaceId, externalChannelId) {
      return routes
        .findOne({
          tenantId: tenant() ?? null,
          workspaceId,
          externalChannelId: { $in: [externalChannelId, null] },
        })
        .sort({ externalChannelId: -1 })
        .read('primary')
        .lean();
    },
    async assign(input) {
      return change(input.userId, async (session) => {
        const tenantId = tenant();
        const workspace = await workspaces
          .findOne({
            workspaceId: input.workspaceId,
            tenantId: tenantId ?? null,
            status: 'active',
          })
          .session(session)
          .lean();
        if (!workspace) return { ok: false, code: 'workspace_unavailable' };
        const filter = scope(input.workspaceId, input.externalChannelId);
        const previous = await routes.findOne(filter).session(session).lean();
        if ((previous?.revision ?? undefined) !== input.expectedRevision)
          return { ok: false, code: 'route_changed' };
        if (!input.isBotAdmin && !(await botAccess.allows(workspace, input.userId, session)))
          return { ok: false, code: 'bot_access_required' };
        const channel = await channels
          .findOne({
            channelId: input.channelId,
            tenantId: tenantId ?? null,
            status: input.activate ? { $in: ['pending_install', 'disabled'] } : 'active',
            workspaceId: input.workspaceId,
            credentialMode: 'per_user',
            revision: input.channelRevision,
            ...(input.activate ? { createdBy: input.userId } : {}),
          })
          .session(session)
          .lean();
        if (!channel || !(await touchChannelScope(mongoose, tenantId, channel.channelId, session)))
          return { ok: false, code: 'channel_unavailable' };
        // Serialize routing with disconnect and replacement without changing link consent.
        if (
          !(await touchSlackWorkspace(
            mongoose,
            { workspaceId: workspace.workspaceId, tenantId },
            session,
          ))
        )
          return { ok: false, code: 'workspace_unavailable' };
        if (input.activate) {
          const activated = await channels.updateOne(
            {
              channelId: channel.channelId,
              tenantId: tenantId ?? null,
              revision: input.channelRevision,
              status: channel.status,
            },
            {
              $set: {
                status: 'active',
                revision: nanoid(),
                slack: {
                  appId: workspace.appId,
                  teamId: workspace.teamId,
                  botUserId: workspace.botUserId,
                },
              },
            },
            { session },
          );
          if (!activated.matchedCount) throw new Error('Slack binding changed during activation');
        }
        const route: SlackRouteRecord = {
          tenantId,
          workspaceId: input.workspaceId,
          externalChannelId: input.externalChannelId,
          channelId: input.channelId,
          revision: nanoid(),
        };
        if (previous) {
          const updated = await routes.replaceOne(
            { ...filter, revision: previous.revision },
            route,
            { session },
          );
          if (!updated.matchedCount) throw new Error('Slack route changed during transaction');
        } else await routes.create([route], { session });
        return { ok: true, route };
      });
    },
    async remove(input) {
      return change(input.userId, async (session) => {
        const route = await routes
          .findOneAndDelete(
            {
              ...scope(input.workspaceId, input.externalChannelId),
              revision: input.expectedRevision,
              ...(input.channelId ? { channelId: input.channelId } : {}),
            },
            { session },
          )
          .lean();
        return route ? { ok: true, route: null } : { ok: false, code: 'route_changed' };
      });
    },
  };
}
