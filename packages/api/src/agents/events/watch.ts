import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import { tool } from '@librechat/agents/langchain/tools';
import type {
  Connection,
  ListedWatch,
  Subscription,
  Watch,
  WatchErrorCode,
} from 'librechat-data-provider';
import type { Watches, Subscriptions, Connections, IUser } from '@librechat/data-schemas';
import type { GenericTool } from '@librechat/agents';
import type { Response } from 'express';
import type {
  AgentTriggerContinuePreparation,
  AgentTriggerExecutionHostDeps,
} from '~/agents/triggers/host';
import type { ContinueGenerationState } from '~/agents/triggers/bindingResolver';
import type { AgentContinueTriggerEnvelope } from '~/agents/triggers/envelope';
import type { PullRequestFetch } from '~/pulls/shared';
import type { App, AppConfig } from './github/app';
import type { WatchSettings } from './settings';
import type { EventConfig } from './settings';
import type { ServerRequest } from '~/types';
import { governs, pauseOf, WATCH_TOOL, UNWATCH_TOOL } from './controls';
import { AgentTriggerExecutionError } from '~/agents/triggers/host';
import { generationBusy } from '~/agents/triggers/bindingResolver';
import { SUBSCRIPTION_SOURCE } from '~/agents/authority/context';
import { eventSettings, watchSettings } from './settings';
import { getSafeErrorMetadata } from '~/utils/errors';
import { GitHubError } from './github/app';
import { createApp } from './github/app';
import { itemKey } from './item';

export { governs, pauseOf, WATCH_TOOL, UNWATCH_TOOL, WATCH_TOOLS } from './controls';

/** A pull request a person or an agent named: its repository as `owner/name`, and its number. */
export interface PullRequestRef {
  repo: string;
  number: number;
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const SHORT = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,9})$/;

/**
 * Reads `owner/name#123`, or a pull request's page on `host` such as
 * `https://github.com/owner/name/pull/123` (with anything after the number ignored).
 * `null` for anything else.
 */
export function parsePullRequest(input: string, host = 'github.com'): PullRequestRef | null {
  const text = input.trim();
  const short = SHORT.exec(text);
  if (short != null) {
    if (short[1] === '.' || short[1] === '..' || short[2] === '.' || short[2] === '..') return null;
    return { repo: `${short[1]}/${short[2]}`, number: Number(short[3]) };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.host.toLowerCase() !== host.toLowerCase()) return null;
  const [owner, name, kind, number] = url.pathname.split('/').filter((part) => part.length > 0);
  if (
    owner == null ||
    name == null ||
    kind !== 'pull' ||
    !SEGMENT.test(owner) ||
    !SEGMENT.test(name) ||
    owner === '.' ||
    owner === '..' ||
    name === '.' ||
    name === '..' ||
    !/^[1-9]\d{0,9}$/.test(number ?? '')
  ) {
    return null;
  }
  return { repo: `${owner}/${name}`, number: Number(number) };
}

/** True for a subscription under which this agent may follow pull requests from a chat. */
export function allowsWatching(subscription: Subscription, agentId: string): boolean {
  return subscription.enabled && subscription.watch && subscription.agentId === agentId;
}

/**
 * Why a `watch` call followed nothing:
 * - `invalid`: the pull request could not be read from what was given.
 * - `not_accessible`: no connection under a subscription that allows watching can read the
 *   repository, or none is active.
 * - `limit`: the conversation already follows as many pull requests as it may.
 * - `unavailable`: GitHub could not be asked; trying again later may work.
 */
export type WatchRefusal = 'invalid' | 'not_accessible' | 'limit' | 'unavailable';

export interface WatchToolDeps {
  owner: { id: string; tenantId?: string };
  agentId: string;
  conversationId: string;
  /** The owner's subscriptions on this agent that allow watching, already filtered. */
  subscriptions: readonly Subscription[];
  /** A connection of the caller's tenant by id, or `null`. */
  connection: (id: string) => Promise<Pick<Connection, 'id' | 'status' | 'installation'> | null>;
  /** The deployment's GitHub App client, or `null` when none is configured. */
  app: () => Promise<{ app: App; host: string } | null>;
  watches: Pick<Watches, 'add' | 'list' | 'remove'>;
  settings: () => Promise<WatchSettings>;
}

type Answer =
  | { status: 'watching'; pullRequest: string; url?: string; until: string; renewed: boolean }
  | { status: 'stopped'; pullRequest: string }
  | { status: 'refused'; reason: WatchRefusal | 'not_watching' };

const answer = (value: Answer): string => JSON.stringify(value);

/**
 * Follows a pull request from this conversation: finds the first subscription allowing it whose
 * connection's installation can read the repository, and stores a watch under it. The watch
 * holds the repository's numeric id, so a rename does not lose it.
 */
export async function watchPullRequest(deps: WatchToolDeps, input: string): Promise<Answer> {
  const client = await deps.app();
  const ref = parsePullRequest(input, client?.host);
  if (ref == null) return { status: 'refused', reason: 'invalid' };
  if (client == null) return { status: 'refused', reason: 'not_accessible' };
  const tried = new Set<string>();
  let outage = false;
  for (const subscription of deps.subscriptions) {
    if (tried.has(subscription.connection)) continue;
    tried.add(subscription.connection);
    const connection = await deps.connection(subscription.connection);
    if (connection?.status !== 'active') continue;
    let found;
    try {
      found = await client.app.repository(Number(connection.installation), ref.repo);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      outage = true;
      continue;
    }
    if (!found.ok) {
      if (found.error.code === 'limited') outage = true;
      continue;
    }
    const settings = await deps.settings();
    const label = `${found.value.name}#${ref.number}`;
    const added = await deps.watches.add(
      deps.owner.id,
      {
        conversationId: deps.conversationId,
        agentId: deps.agentId,
        subscription: subscription.id,
        connection: connection.id,
        item: itemKey({ provider: 'github', kind: 'pr', repo: found.value.id, number: ref.number }),
        label,
        ...(found.value.url != null && { url: `${found.value.url}/pull/${ref.number}` }),
      },
      { max: settings.max, ttlMs: settings.ttlMs },
    );
    if (!added.ok) return { status: 'refused', reason: 'limit' };
    return {
      status: 'watching',
      pullRequest: added.value.label,
      ...(added.value.url != null && { url: added.value.url }),
      until: added.value.expiresAt,
      renewed: !added.created,
    };
  }
  return { status: 'refused', reason: outage ? 'unavailable' : 'not_accessible' };
}

/** Stops following a pull request this conversation follows, found by its `owner/name#123`. */
export async function unwatchPullRequest(deps: WatchToolDeps, input: string): Promise<Answer> {
  const client = await deps.app();
  const ref = parsePullRequest(input, client?.host);
  if (ref == null) return { status: 'refused', reason: 'invalid' };
  const wanted = `${ref.repo}#${ref.number}`.toLowerCase();
  const held = await deps.watches.list(deps.owner.id, deps.conversationId);
  const watch = held.find((entry) => entry.label.toLowerCase() === wanted);
  if (watch == null || !(await deps.watches.remove(watch.id, deps.owner.id))) {
    return { status: 'refused', reason: 'not_watching' };
  }
  return { status: 'stopped', pullRequest: watch.label };
}

const reference = z
  .string()
  .min(3)
  .max(500)
  .describe('The pull request, as its page URL or as owner/name#number.');

/**
 * The `watch` and `unwatch` tools, for a run in a conversation whose agent has at least one
 * subscription of its owner that allows watching. `undefined` when there is none.
 */
export function createWatchTools(deps: WatchToolDeps): GenericTool[] | undefined {
  if (deps.subscriptions.length === 0) return;
  const watch = tool(async ({ pullRequest }) => answer(await watchPullRequest(deps, pullRequest)), {
    name: WATCH_TOOL,
    description:
      'Follow a GitHub pull request from this conversation. When a review is submitted, a ' +
      'review or conversation comment is posted, its checks finish, or it is closed, the ' +
      'event arrives here as a new turn, so there is no need to check on it. Use this after ' +
      'opening or updating a pull request whose outcome you need. A watch ends on its own ' +
      'after a while; calling this again on the same pull request renews it.',
    schema: z.object({ pullRequest: reference }).strict(),
  });
  const unwatch = tool(
    async ({ pullRequest }) => answer(await unwatchPullRequest(deps, pullRequest)),
    {
      name: UNWATCH_TOOL,
      description:
        'Stop following a GitHub pull request this conversation follows, for example once ' +
        'nothing more is expected of it.',
      schema: z.object({ pullRequest: reference }).strict(),
    },
  );
  return [watch, unwatch];
}

type ContinueResolver = NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']>;

export interface WatchContinueResolverDeps {
  watches: Pick<Watches, 'get'>;
  /** The governing subscription as it stands, read again for every turn. */
  subscriptions: Pick<Subscriptions, 'get'>;
  getMessages: (
    filter: { user: string; conversationId: string; isCreatedByUser: boolean },
    select: string,
    options: { sort: Record<string, 1 | -1>; limit: number },
  ) => Promise<Array<{ messageId: string }>>;
  getGenerationJob?: (
    conversationId: string,
  ) => Promise<ContinueGenerationState | null | undefined>;
}

function refused(message: string, retryable: boolean, code: string): AgentTriggerExecutionError {
  return new AgentTriggerExecutionError(message, {
    mode: 'continue',
    certainty: 'definite',
    retryable,
    code,
    status: retryable ? 503 : 404,
  });
}

/** The watch a subscription's continuation names in its payload, or `undefined`. */
function watchOf(envelope: AgentContinueTriggerEnvelope): string | undefined {
  const payload = envelope.event.payload;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return;
  const id = (payload as Record<string, unknown>).watch;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Prepares a watched pull request's event as the next turn of the watching conversation. The
 * watch is read again, so one stopped, expired or deleted with its conversation continues
 * nothing; the turn waits while the conversation is still answering an earlier one; and the
 * turn is appended below the conversation's latest reply at the time it runs, never a parent
 * chosen when the event arrived.
 */
export function createWatchContinueResolver(deps: WatchContinueResolverDeps): ContinueResolver {
  return async (envelope): Promise<AgentTriggerContinuePreparation | undefined> => {
    if (envelope.event.source.type !== SUBSCRIPTION_SOURCE) return;
    const id = watchOf(envelope);
    if (id == null)
      throw refused('A subscription continuation names no watch.', false, 'WATCH_GONE');
    const user = envelope.principal.userId;
    let watch: Watch | null;
    try {
      watch = await deps.watches.get(id, user);
    } catch {
      throw refused('Watch state is temporarily unavailable.', true, 'WATCH_UNAVAILABLE');
    }
    if (
      watch == null ||
      watch.conversationId !== envelope.target.conversationId ||
      watch.agentId !== envelope.target.agentId ||
      watch.subscription !== envelope.event.source.id
    ) {
      throw refused('The watch no longer follows this pull request here.', false, 'WATCH_GONE');
    }
    // A turn queued behind a busy conversation runs later: the owner may have turned watching
    // or the subscription off meanwhile, and then it does not run.
    let subscription: Subscription | null;
    try {
      subscription = await deps.subscriptions.get(watch.subscription, user);
    } catch {
      throw refused('Subscription state is temporarily unavailable.', true, 'WATCH_UNAVAILABLE');
    }
    if (!governs(watch, subscription)) {
      throw refused('Watching is no longer allowed here.', false, 'WATCH_NOT_ALLOWED');
    }
    if (deps.getGenerationJob != null) {
      let active;
      try {
        active = await deps.getGenerationJob(watch.conversationId);
      } catch {
        throw refused('Generation state is temporarily unavailable.', true, 'WATCH_UNAVAILABLE');
      }
      // Also while the last turn has ended but its reply is not written yet: the history would
      // hold no reply to continue, and the turn would be refused for good.
      if (generationBusy(active)) {
        throw new AgentTriggerExecutionError(
          'The conversation is still answering an earlier turn.',
          {
            mode: 'continue',
            certainty: 'definite',
            retryable: true,
            deferWithoutAttempt: true,
            code: 'WATCH_CONVERSATION_BUSY',
            status: 409,
          },
        );
      }
    }
    let latest;
    try {
      [latest] = await deps.getMessages(
        { user, conversationId: watch.conversationId, isCreatedByUser: false },
        'messageId createdAt',
        { sort: { createdAt: -1, _id: -1 }, limit: 1 },
      );
    } catch {
      throw refused('Conversation history is temporarily unavailable.', true, 'WATCH_UNAVAILABLE');
    }
    if (latest == null) {
      throw refused('The watching conversation has no reply to continue.', false, 'WATCH_GONE');
    }
    return { status: 'ready', input: envelope.input, parentMessageId: latest.messageId };
  };
}

export interface WatchToolHostDeps {
  /** The deployment's config; events are read from the base config alone. */
  getAppConfig: (options: {
    baseOnly: true;
  }) => Promise<{ endpoints?: { agents?: { events?: Partial<EventConfig> } } } | null | undefined>;
  env: Record<string, string | undefined>;
  subscriptions: Pick<Subscriptions, 'list'>;
  connections: Pick<Connections, 'get'>;
  watches: Pick<Watches, 'add' | 'list' | 'remove'>;
  fetch: PullRequestFetch;
}

/** What a run in a conversation is given to follow pull requests: its agent and the two tools. */
export interface RunWatchTools {
  agentId: string;
  tools: GenericTool[];
}

/**
 * Builds, per run, the `watch` and `unwatch` tools a conversation's agent is offered. Nothing is
 * offered, and nothing is read beyond the config, while events are off; otherwise one read of
 * the owner's subscriptions on the agent decides whether any allows watching. One App client
 * is kept per app configuration, so its installation tokens are reused across runs.
 */
export function createWatchToolHost(
  deps: WatchToolHostDeps,
): (run: {
  user: Pick<IUser, 'id' | 'tenantId'>;
  agentId: string;
  conversationId?: string | null;
}) => Promise<RunWatchTools | undefined> {
  let held: { key: string; app: App } | null = null;
  const appFor = (config: AppConfig): App => {
    const key = JSON.stringify([config.id, config.host, config.timeoutMs, config.key]);
    if (held?.key !== key) held = { key, app: createApp(config, { fetch: deps.fetch }) };
    return held.app;
  };
  return async ({ user, agentId, conversationId }) => {
    if (!user?.id || !agentId || !conversationId || conversationId === Constants.NEW_CONVO) return;
    const events = (await deps.getAppConfig({ baseOnly: true }))?.endpoints?.agents?.events;
    const settings = eventSettings(events, deps.env);
    if (settings == null) return;
    const tenantId = user.tenantId ?? null;
    const subscriptions = (await deps.subscriptions.list(user.id, agentId)).filter(
      (subscription) =>
        allowsWatching(subscription, agentId) && (subscription.tenantId ?? null) === tenantId,
    );
    const tools = createWatchTools({
      owner: { id: user.id, ...(user.tenantId != null && { tenantId: user.tenantId }) },
      agentId,
      conversationId,
      subscriptions,
      connection: (id) => deps.connections.get(id),
      app: async () => {
        const github = settings.github;
        return github == null ? null : { app: appFor(github.app), host: github.app.host };
      },
      watches: deps.watches,
      settings: async () => watchSettings(events),
    });
    return tools == null ? undefined : { agentId, tools };
  };
}

const WATCH_STATUSES: Record<WatchErrorCode, number> = {
  watch_invalid: 400,
  watch_not_found: 404,
  watch_unavailable: 500,
};

class WatchRequestRefusal extends Error {
  constructor(readonly code: WatchErrorCode) {
    super(code);
  }
}

export interface WatchHandlers {
  /** The caller's watches on the conversation named by `?conversationId=`, in their tenant. */
  list: (req: ServerRequest, res: Response) => Promise<void>;
  /** Ends the caller's watch named in the path. */
  remove: (req: ServerRequest, res: Response) => Promise<void>;
}

/**
 * The REST surface an owner sees and stops their conversations' watches through. Every watch
 * it reads or removes is the caller's own, in the caller's tenant; anyone else's answers as if
 * it did not exist.
 */
export function createWatchHandlers(deps: {
  watches: Pick<Watches, 'list' | 'get' | 'remove'>;
  /** Each listed watch's governing subscription, so a paused one is not shown as live. */
  subscriptions: Pick<Subscriptions, 'get'>;
}): WatchHandlers {
  const handler =
    (operation: (req: ServerRequest & { user: IUser }, res: Response) => Promise<void>) =>
    async (req: ServerRequest, res: Response): Promise<void> => {
      try {
        if (!req.user?.id) throw new WatchRequestRefusal('watch_not_found');
        await operation(req as ServerRequest & { user: IUser }, res);
      } catch (error) {
        const code = error instanceof WatchRequestRefusal ? error.code : 'watch_unavailable';
        if (!(error instanceof WatchRequestRefusal))
          logger.error('[events] Watch request failed', getSafeErrorMetadata(error));
        res.status(WATCH_STATUSES[code]).json({ code });
      }
    };
  const mine = (watch: Watch | null, user: IUser): watch is Watch =>
    watch != null && (watch.tenantId ?? null) === (user.tenantId ?? null);

  return {
    list: handler(async (req, res) => {
      const { conversationId } = req.query as { conversationId?: unknown };
      if (
        typeof conversationId !== 'string' ||
        conversationId === '' ||
        conversationId.length > 200
      )
        throw new WatchRequestRefusal('watch_invalid');
      const tenantId = req.user.tenantId ?? null;
      const owned = (await deps.watches.list(req.user.id, conversationId)).filter(
        (watch) => (watch.tenantId ?? null) === tenantId,
      );
      // One read per governing subscription, however many watches name it.
      const ids = Array.from(new Set(owned.map((watch) => watch.subscription)));
      const governing = new Map(
        await Promise.all(
          ids.map(async (id) => [id, await deps.subscriptions.get(id, req.user.id)] as const),
        ),
      );
      const watches: ListedWatch[] = owned.map((watch) => {
        const paused = pauseOf(watch, governing.get(watch.subscription));
        return paused == null ? watch : { ...watch, paused };
      });
      res.json({ watches });
    }),
    remove: handler(async (req, res) => {
      const { id } = req.params as { id?: string };
      if (!id) throw new WatchRequestRefusal('watch_not_found');
      const watch = await deps.watches.get(id, req.user.id);
      if (!mine(watch, req.user) || !(await deps.watches.remove(watch.id, req.user.id)))
        throw new WatchRequestRefusal('watch_not_found');
      res.status(204).end();
    }),
  };
}
