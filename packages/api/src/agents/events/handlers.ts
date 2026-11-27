import { logger } from '@librechat/data-schemas';
import {
  isAgentEventType,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
} from 'librechat-data-provider';
import type {
  SubscriptionIdentity,
  SubscriptionActors,
  ConnectionChoice,
  Subscription,
  Connection,
} from 'librechat-data-provider';
import type { Subscriptions, Connections, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { RunGrantHandlers } from '~/agents/authority/handlers';
import type { RunGrantService } from '~/agents/authority/service';
import type { AgentAccess } from '~/schedules/access';
import type { ServerRequest } from '~/types';
import { createRunGrantHandlers } from '~/agents/authority/handlers';
import { getSafeErrorMetadata } from '~/utils/errors';

/** The fallback when the deployment sets no rule for who may start a run. */
export const DEFAULT_SUBSCRIPTION_ACTORS: SubscriptionActors = 'write';

/**
 * What an owner's request about a subscription can fail with. `agent_unavailable`: the agent
 * is gone or the owner may not run it. `connection_not_found`: no connection of the caller's
 * tenant by that id.
 */
export type SubscriptionCode =
  | 'subscription_invalid'
  | 'subscription_not_found'
  | 'subscription_conflict'
  | 'agent_unavailable'
  | 'connection_not_found'
  | 'subscription_unavailable';

const statuses: Record<SubscriptionCode, number> = {
  subscription_invalid: 400,
  subscription_not_found: 404,
  subscription_conflict: 409,
  agent_unavailable: 403,
  connection_not_found: 404,
  subscription_unavailable: 500,
};

export interface SubscriptionHandlersDeps {
  subscriptions: Pick<Subscriptions, 'create' | 'get' | 'list' | 'update' | 'remove'>;
  /** The caller's tenant's connections; neither reads another tenant's. */
  connections: Pick<Connections, 'get' | 'list'>;
  /** The caller's access to an agent now. */
  access: (agentId: string, user: IUser) => Promise<AgentAccess>;
  /** Who may start a run, for a subscription created without saying. Absent: `write`. */
  actors?: (user: IUser) => SubscriptionActors;
  /** The service that holds subscriptions' grants, built on first use. */
  grants: () => RunGrantService<SubscriptionIdentity>;
}

export interface SubscriptionHandlers {
  list: (req: ServerRequest, res: Response) => Promise<void>;
  create: (req: ServerRequest, res: Response) => Promise<void>;
  update: (req: ServerRequest, res: Response) => Promise<void>;
  remove: (req: ServerRequest, res: Response) => Promise<void>;
  connections: (req: ServerRequest, res: Response) => Promise<void>;
  /** The grant of the caller's subscription in the request's path: read, confirm, revoke. */
  grant: Pick<RunGrantHandlers, 'get' | 'confirm' | 'revoke'>;
}

class Refusal extends Error {
  constructor(readonly code: SubscriptionCode) {
    super(code);
  }
}

/** Event types a connection's provider sends, and only those the catalog lists. */
function events(types: readonly string[], connection: Connection): void {
  const prefix = `${connection.provider}.`;
  if (!types.every((type) => isAgentEventType(type) && type.startsWith(prefix)))
    throw new Refusal('subscription_invalid');
}

/**
 * The REST surface an owner manages their event subscriptions through. Every subscription it
 * reads or writes is the caller's own, in the caller's tenant; anyone else's answers as if it
 * did not exist.
 */
export function createSubscriptionHandlers(deps: SubscriptionHandlersDeps): SubscriptionHandlers {
  /** The caller's subscription by id in their tenant, or `null`. */
  const mine = async (req: ServerRequest): Promise<Subscription | null> => {
    const user = req.user;
    const { id } = req.params as { id?: string };
    if (!user?.id || !id) return null;
    const subscription = await deps.subscriptions.get(id, user.id);
    if (!subscription || (subscription.tenantId ?? null) !== (user.tenantId ?? null)) return null;
    return subscription;
  };

  const connection = async (id: string): Promise<Connection> => {
    const found = await deps.connections.get(id);
    if (!found) throw new Refusal('connection_not_found');
    return found;
  };

  const agent = async (agentId: string, user: IUser): Promise<void> => {
    if ((await deps.access(agentId, user)) !== 'ok') throw new Refusal('agent_unavailable');
  };

  let built: RunGrantHandlers | undefined;
  /** The grant handlers, over the service the caller builds when a grant is first asked for. */
  const grants = (): RunGrantHandlers =>
    (built ??= createRunGrantHandlers<SubscriptionIdentity>({
      service: deps.grants(),
      resolveIdentity: async (req) => {
        const subscription = await mine(req);
        if (!subscription || !req.user) return null;
        return {
          subscriptionId: subscription.id,
          ownerId: req.user.id,
          tenantId: req.user.tenantId ?? null,
          agentId: subscription.agentId,
          invocationMode: 'delegated',
        };
      },
    }));

  const handler =
    (operation: (req: ServerRequest & { user: IUser }, res: Response) => Promise<void>) =>
    async (req: ServerRequest, res: Response): Promise<void> => {
      try {
        if (!req.user?.id) throw new Refusal('subscription_not_found');
        await operation(req as ServerRequest & { user: IUser }, res);
      } catch (error) {
        const code = error instanceof Refusal ? error.code : 'subscription_unavailable';
        if (!(error instanceof Refusal))
          logger.error('[events] Subscription request failed', getSafeErrorMetadata(error));
        res.status(statuses[code]).json({ code });
      }
    };

  return {
    list: handler(async (req, res) => {
      const { agentId } = req.query as { agentId?: unknown };
      if (agentId !== undefined && (typeof agentId !== 'string' || agentId === ''))
        throw new Refusal('subscription_invalid');
      const tenantId = req.user.tenantId ?? null;
      const subscriptions = (await deps.subscriptions.list(req.user.id, agentId)).filter(
        (subscription) => (subscription.tenantId ?? null) === tenantId,
      );
      res.json({ subscriptions });
    }),

    create: handler(async (req, res) => {
      const parsed = subscriptionCreateSchema.safeParse(req.body);
      if (!parsed.success) throw new Refusal('subscription_invalid');
      const input = parsed.data;
      const [target] = await Promise.all([
        connection(input.connection),
        agent(input.agentId, req.user),
      ]);
      events(input.events, target);
      const subscription = await deps.subscriptions.create(req.user.id, {
        ...input,
        actors: input.actors ?? deps.actors?.(req.user) ?? DEFAULT_SUBSCRIPTION_ACTORS,
      });
      res.status(201).json(subscription);
    }),

    update: handler(async (req, res) => {
      const parsed = subscriptionUpdateSchema.safeParse(req.body);
      if (!parsed.success) throw new Refusal('subscription_invalid');
      const current = await mine(req);
      if (!current) throw new Refusal('subscription_not_found');
      const { expectedRevision, ...patch } = parsed.data;
      if (patch.events) events(patch.events, await connection(current.connection));
      // Turning it off needs no access to the agent: an owner who lost it can still stop it.
      if (patch.enabled !== false || Object.keys(patch).some((key) => key !== 'enabled'))
        await agent(current.agentId, req.user);
      const written = await deps.subscriptions.update(
        current.id,
        req.user.id,
        patch,
        expectedRevision,
      );
      if (!written.ok)
        throw new Refusal(
          written.error.code === 'conflict' ? 'subscription_conflict' : 'subscription_not_found',
        );
      res.json(written.value);
    }),

    remove: handler(async (req, res) => {
      const current = await mine(req);
      if (!current || !(await deps.subscriptions.remove(current.id, req.user.id)))
        throw new Refusal('subscription_not_found');
      res.status(204).end();
    }),

    connections: handler(async (_req, res) => {
      // The store reads only the caller's side: their tenant's connections, or the tenantless.
      const connections: ConnectionChoice[] = (await deps.connections.list()).map(
        ({ id, provider, account, status }) => ({
          id,
          provider,
          account: account.name,
          status,
        }),
      );
      res.json({ connections });
    }),

    grant: {
      get: (req, res) => grants().get(req, res),
      confirm: (req, res) => grants().confirm(req, res),
      revoke: (req, res) => grants().revoke(req, res),
    },
  };
}
