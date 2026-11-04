import { nanoid } from 'nanoid';
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
import { touchChannelScope } from './channelScope';

type RouteResult =
  | { ok: true; route: SlackRouteRecord | null }
  | {
      ok: false;
      code:
        | 'principal_unavailable'
        | 'workspace_unavailable'
        | 'channel_unavailable'
        | 'route_changed';
    };

export interface SlackRouteStorage {
  read(workspaceId: string, externalChannelId?: string): Promise<SlackRouteRecord | null>;
  resolve(workspaceId: string, externalChannelId: string): Promise<SlackRouteRecord | null>;
  assign(input: {
    userId: string;
    workspaceId: string;
    externalChannelId?: string;
    channelId: string;
    expectedRevision?: string;
  }): Promise<RouteResult>;
  remove(input: {
    userId: string;
    workspaceId: string;
    externalChannelId?: string;
    expectedRevision: string;
  }): Promise<RouteResult>;
}

export function createSlackRouteStorage(mongoose: typeof import('mongoose')): SlackRouteStorage {
  const routes = createSlackRouteModel(mongoose);
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
    routes.findOne(scope(workspaceId, externalChannelId)).lean();

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
    read,
    async resolve(workspaceId, externalChannelId) {
      return (await read(workspaceId, externalChannelId)) ?? read(workspaceId);
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
        const channel = await channels
          .findOne({
            channelId: input.channelId,
            tenantId: tenantId ?? null,
            status: 'active',
            workspaceId: input.workspaceId,
            credentialMode: 'per_user',
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
        const filter = scope(input.workspaceId, input.externalChannelId);
        const previous = await routes.findOne(filter).session(session).lean();
        if ((previous?.revision ?? undefined) !== input.expectedRevision)
          return { ok: false, code: 'route_changed' };
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
            },
            { session },
          )
          .lean();
        return route ? { ok: true, route: null } : { ok: false, code: 'route_changed' };
      });
    },
  };
}
