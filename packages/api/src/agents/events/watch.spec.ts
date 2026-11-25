import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createWatches } from '@librechat/data-schemas';
import type { Subscription, Watch } from 'librechat-data-provider';
import type { Watches, IUser } from '@librechat/data-schemas';
import type { AgentContinueTriggerEnvelope } from '~/agents/triggers/envelope';
import type { AgentTriggerDispatchContext } from '~/agents/triggers/dispatch';
import type { App, Repository, Reply } from './github/app';
import type { ServerRequest } from '~/types';
import type { WatchToolDeps } from './watch';
import {
  parsePullRequest,
  allowsWatching,
  watchPullRequest,
  unwatchPullRequest,
  createWatchTools,
  createWatchHandlers,
  createWatchToolHost,
  createWatchContinueResolver,
} from './watch';
import { SUBSCRIPTION_SOURCE } from '~/agents/authority/context';
import { GitHubError } from './github/app';
import { itemKey } from './item';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const OWNER = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();
const AGENT = 'agent_root';
const CONVO = 'convo_1';
const REPO_ID = 700100;

let server: MongoMemoryServer;
let watches: Watches;

const subscription = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: 'sub_1',
  user: OWNER,
  connection: 'conn_1',
  agentId: AGENT,
  events: ['github.pull_request_review.submitted'],
  target: 'new',
  prompt: 'Read it.',
  actors: 'any',
  bots: false,
  enabled: true,
  watch: true,
  revision: 0,
  ...overrides,
});

/** An App whose only answer is a repository lookup, by `owner/name`. */
function app(answers: Record<string, Reply<Repository> | Error>): App {
  return {
    access: jest.fn(),
    about: jest.fn(),
    installation: jest.fn(),
    owns: jest.fn(),
    repository: jest.fn(async (_installation: number, repo: string) => {
      const answer = answers[repo] ?? { ok: false, error: { code: 'missing' } };
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  } as unknown as App;
}

const found = (name = 'Example-Org/Widgets'): Reply<Repository> => ({
  ok: true,
  value: { id: REPO_ID, name, url: `https://github.com/${name}` },
});

function deps(overrides: Partial<WatchToolDeps> = {}): WatchToolDeps {
  const client = app({ 'example-org/widgets': found() });
  return {
    owner: { id: OWNER },
    agentId: AGENT,
    conversationId: CONVO,
    subscriptions: [subscription()],
    connection: async (id) => ({ id, status: 'active', installation: '4400' }),
    app: async () => ({ app: client, host: 'github.com' }),
    watches,
    settings: async () => ({ max: 5, ttlMs: 14 * 24 * 60 * 60 * 1000 }),
    ...overrides,
  };
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  watches = createWatches(mongoose);
  await mongoose.models.AgentEventWatch.deleteMany({});
});

describe('parsePullRequest', () => {
  it.each([
    ['example-org/widgets#42', { repo: 'example-org/widgets', number: 42 }],
    ['https://github.com/example-org/widgets/pull/42', { repo: 'example-org/widgets', number: 42 }],
    [
      'https://github.com/example-org/widgets/pull/42/files#diff',
      { repo: 'example-org/widgets', number: 42 },
    ],
    ['  example-org/widgets#42  ', { repo: 'example-org/widgets', number: 42 }],
  ])('reads %s', (input, expected) => {
    expect(parsePullRequest(input)).toEqual(expected);
  });

  it.each([
    'example-org/widgets',
    'example-org/widgets#0',
    'http://github.com/example-org/widgets/pull/42',
    'https://evil.example/example-org/widgets/pull/42',
    'https://github.com/example-org/widgets/issues/42',
    '../widgets#42',
    'example-org/..#42',
    'not a reference',
  ])('refuses %s', (input) => {
    expect(parsePullRequest(input)).toBeNull();
  });

  it("reads a page on the deployment's own GitHub host", () => {
    expect(parsePullRequest('https://ghe.example.com/a/b/pull/3', 'ghe.example.com')).toEqual({
      repo: 'a/b',
      number: 3,
    });
  });
});

describe('allowsWatching', () => {
  it('needs the subscription on, allowing watching, and on this agent', () => {
    expect(allowsWatching(subscription(), AGENT)).toBe(true);
    expect(allowsWatching(subscription({ enabled: false }), AGENT)).toBe(false);
    expect(allowsWatching(subscription({ watch: false }), AGENT)).toBe(false);
    expect(allowsWatching(subscription(), 'agent_other')).toBe(false);
  });
});

describe('watchPullRequest', () => {
  it("stores a watch keyed by the repository's id, under the first subscription that can read it", async () => {
    const answer = await watchPullRequest(deps(), 'example-org/widgets#42');
    expect(answer).toMatchObject({
      status: 'watching',
      pullRequest: 'Example-Org/Widgets#42',
      url: 'https://github.com/Example-Org/Widgets/pull/42',
      renewed: false,
    });
    const [stored] = await watches.list(OWNER, CONVO);
    expect(stored).toMatchObject({
      item: itemKey({ provider: 'github', kind: 'pr', repo: REPO_ID, number: 42 }),
      subscription: 'sub_1',
      connection: 'conn_1',
      agentId: AGENT,
    });
  });

  it('renews a watch asked for twice', async () => {
    await watchPullRequest(deps(), 'example-org/widgets#42');
    const again = await watchPullRequest(deps(), 'https://github.com/example-org/widgets/pull/42');
    expect(again).toMatchObject({ status: 'watching', renewed: true });
    expect(await watches.list(OWNER, CONVO)).toHaveLength(1);
  });

  it('tries the next connection when one cannot read the repository', async () => {
    const blind = app({});
    const seeing = app({ 'example-org/widgets': found() });
    const answer = await watchPullRequest(
      deps({
        subscriptions: [
          subscription({ id: 'sub_a', connection: 'conn_a' }),
          subscription({ id: 'sub_b', connection: 'conn_b' }),
        ],
        app: async () => ({
          app: {
            ...blind,
            repository: (installation: number, repo: string) =>
              installation === 2
                ? seeing.repository(installation, repo)
                : blind.repository(installation, repo),
          } as App,
          host: 'github.com',
        }),
        connection: async (id) => ({
          id,
          status: 'active',
          installation: id === 'conn_a' ? '1' : '2',
        }),
      }),
      'example-org/widgets#42',
    );
    expect(answer).toMatchObject({ status: 'watching' });
    expect((await watches.list(OWNER, CONVO))[0].subscription).toBe('sub_b');
  });

  it.each([
    ['an unreadable reference', 'widgets', {}, 'invalid'],
    ['a repository no connection can read', 'example-org/secret#1', {}, 'not_accessible'],
  ])('refuses %s', async (_label, input, _overrides, reason) => {
    expect(await watchPullRequest(deps(), input)).toEqual({ status: 'refused', reason });
    expect(await watches.list(OWNER, CONVO)).toEqual([]);
  });

  it('refuses through a suspended connection', async () => {
    const answer = await watchPullRequest(
      deps({ connection: async (id) => ({ id, status: 'suspended', installation: '4400' }) }),
      'example-org/widgets#42',
    );
    expect(answer).toEqual({ status: 'refused', reason: 'not_accessible' });
  });

  it('answers unavailable, and stores nothing, when GitHub cannot be asked', async () => {
    const answer = await watchPullRequest(
      deps({
        app: async () => ({
          app: app({ 'example-org/widgets': new GitHubError('network') }),
          host: 'github.com',
        }),
      }),
      'example-org/widgets#42',
    );
    expect(answer).toEqual({ status: 'refused', reason: 'unavailable' });
    expect(await watches.list(OWNER, CONVO)).toEqual([]);
  });

  it('refuses once the conversation follows as many pull requests as it may', async () => {
    const limited = deps({ settings: async () => ({ max: 1, ttlMs: 60_000 }) });
    const client = app({
      'example-org/widgets': found(),
      'example-org/other': found('example-org/other'),
    });
    await watchPullRequest(
      { ...limited, app: async () => ({ app: client, host: 'github.com' }) },
      'example-org/widgets#1',
    );
    const answer = await watchPullRequest(
      { ...limited, app: async () => ({ app: client, host: 'github.com' }) },
      'example-org/widgets#2',
    );
    expect(answer).toEqual({ status: 'refused', reason: 'limit' });
  });
});

describe('unwatchPullRequest', () => {
  it('stops following by the reference, whatever its case', async () => {
    await watchPullRequest(deps(), 'example-org/widgets#42');
    expect(await unwatchPullRequest(deps(), 'EXAMPLE-ORG/widgets#42')).toEqual({
      status: 'stopped',
      pullRequest: 'Example-Org/Widgets#42',
    });
    expect(await watches.list(OWNER, CONVO)).toEqual([]);
    expect(await unwatchPullRequest(deps(), 'example-org/widgets#42')).toEqual({
      status: 'refused',
      reason: 'not_watching',
    });
  });
});

describe('createWatchTools', () => {
  it('offers nothing without a subscription that allows watching', () => {
    expect(createWatchTools(deps({ subscriptions: [] }))).toBeUndefined();
  });

  it('offers watch and unwatch, answering as JSON', async () => {
    const tools = createWatchTools(deps());
    expect(tools?.map((entry) => entry.name)).toEqual(['watch', 'unwatch']);
    const result = await tools?.[0].invoke({ pullRequest: 'example-org/widgets#42' });
    expect(JSON.parse(String(result))).toMatchObject({ status: 'watching' });
  });
});

describe('createWatchToolHost', () => {
  const user = { id: OWNER } as Pick<IUser, 'id' | 'tenantId'>;
  const host = (overrides: Record<string, unknown> = {}) => {
    const list = jest.fn(async () => [
      subscription(),
      subscription({ id: 'sub_off', enabled: false }),
    ]);
    return {
      list,
      resolve: createWatchToolHost({
        getAppConfig: async () => ({ endpoints: { agents: { events: { enabled: true } } } }),
        env: {},
        subscriptions: { list } as never,
        connections: { get: jest.fn() } as never,
        watches,
        fetch: jest.fn() as never,
        ...overrides,
      }),
    };
  };

  it('reads nothing and offers nothing while events are off', async () => {
    const { list, resolve } = host({ getAppConfig: async () => ({}) });
    expect(await resolve({ user, agentId: AGENT, conversationId: CONVO })).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('offers nothing outside a conversation', async () => {
    const { list, resolve } = host();
    expect(await resolve({ user, agentId: AGENT, conversationId: 'new' })).toBeUndefined();
    expect(await resolve({ user, agentId: AGENT })).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('offers the tools for the agent when a subscription allows watching', async () => {
    const { list, resolve } = host();
    const run = await resolve({ user, agentId: AGENT, conversationId: CONVO });
    expect(run?.agentId).toBe(AGENT);
    expect(run?.tools.map((entry) => entry.name)).toEqual(['watch', 'unwatch']);
    expect(list).toHaveBeenCalledWith(OWNER, AGENT);
  });

  it("offers nothing when the only subscriptions are another tenant's or do not allow it", async () => {
    const list = jest.fn(async () => [
      subscription({ watch: false }),
      subscription({ id: 'sub_t', tenantId: 'tenant-b' }),
    ]);
    const { resolve } = host({ subscriptions: { list } });
    expect(await resolve({ user, agentId: AGENT, conversationId: CONVO })).toBeUndefined();
  });
});

describe('createWatchContinueResolver', () => {
  const NO_PARENT = '00000000-0000-0000-0000-000000000000';
  const envelope = (
    watch: Pick<Watch, 'id'>,
    overrides: Partial<AgentContinueTriggerEnvelope['target']> = {},
  ) =>
    ({
      mode: 'continue',
      principal: { userId: OWNER },
      target: { agentId: AGENT, conversationId: CONVO, parentMessageId: NO_PARENT, ...overrides },
      event: {
        id: 'e',
        type: 'github.pull_request_review.submitted',
        occurredAt: 0,
        source: { type: SUBSCRIPTION_SOURCE, id: 'sub_1' },
        payload: { watch: watch.id },
      },
      input: 'Read it.',
    }) as unknown as AgentContinueTriggerEnvelope;
  const context = {} as AgentTriggerDispatchContext;

  async function stored() {
    const added = await watches.add(
      OWNER,
      {
        conversationId: CONVO,
        agentId: AGENT,
        subscription: 'sub_1',
        connection: 'conn_1',
        item: 'github:pr:700100#42',
        label: 'example-org/widgets#42',
      },
      { max: 5, ttlMs: 60_000 },
    );
    if (!added.ok) throw new Error('watch was not added');
    return added.value;
  }

  const resolver = (overrides: Record<string, unknown> = {}) =>
    createWatchContinueResolver({
      watches,
      getMessages: jest.fn(async () => [{ messageId: 'reply_9' }]),
      getGenerationJob: jest.fn(async () => null),
      ...overrides,
    });

  it("appends the turn below the conversation's latest reply when it runs", async () => {
    const watch = await stored();
    expect(await resolver()(envelope(watch), context)).toEqual({
      status: 'ready',
      input: 'Read it.',
      parentMessageId: 'reply_9',
    });
  });

  it('leaves other sources to their own adapters', async () => {
    const watch = await stored();
    const other = envelope(watch);
    (other.event.source as { type: string }).type = 'remote_api_key';
    expect(await resolver()(other, context)).toBeUndefined();
  });

  it('refuses for good once the watch is stopped, or names another conversation', async () => {
    const watch = await stored();
    await expect(
      resolver()(envelope(watch, { conversationId: 'convo_other' }), context),
    ).rejects.toMatchObject({
      code: 'WATCH_GONE',
      retryable: false,
    });
    await watches.remove(watch.id, OWNER);
    await expect(resolver()(envelope(watch), context)).rejects.toMatchObject({
      code: 'WATCH_GONE',
      retryable: false,
    });
  });

  it("refuses for good a watch of another owner's", async () => {
    const watch = await stored();
    const theirs = envelope(watch);
    (theirs.principal as { userId: string }).userId = OTHER;
    await expect(resolver()(theirs, context)).rejects.toMatchObject({ code: 'WATCH_GONE' });
  });

  it('waits without spending an attempt while the conversation is still answering', async () => {
    const watch = await stored();
    await expect(
      resolver({ getGenerationJob: async () => ({ status: 'running' }) })(envelope(watch), context),
    ).rejects.toMatchObject({
      code: 'WATCH_CONVERSATION_BUSY',
      retryable: true,
      deferWithoutAttempt: true,
    });
  });

  it('refuses for good when the conversation has no reply to continue, as after its deletion', async () => {
    const watch = await stored();
    await expect(
      resolver({ getMessages: async () => [] })(envelope(watch), context),
    ).rejects.toMatchObject({ code: 'WATCH_GONE', retryable: false });
  });

  it('retries when history cannot be read', async () => {
    const watch = await stored();
    await expect(
      resolver({
        getMessages: async () => {
          throw new Error('down');
        },
      })(envelope(watch), context),
    ).rejects.toMatchObject({ code: 'WATCH_UNAVAILABLE', retryable: true });
  });
});

describe('createWatchHandlers', () => {
  function response() {
    const res = { statusCode: 200, body: undefined as unknown, ended: false };
    const api = {
      status: (code: number) => {
        res.statusCode = code;
        return api;
      },
      json: (body: unknown) => {
        res.body = body;
        return api;
      },
      end: () => {
        res.ended = true;
        return api;
      },
    };
    return { res, api };
  }
  const request = (overrides: Record<string, unknown>) =>
    ({ user: { id: OWNER }, query: {}, params: {}, ...overrides }) as unknown as ServerRequest;

  async function stored(owner = OWNER) {
    const added = await watches.add(
      owner,
      {
        conversationId: CONVO,
        agentId: AGENT,
        subscription: 'sub_1',
        connection: 'conn_1',
        item: 'github:pr:700100#42',
        label: 'example-org/widgets#42',
      },
      { max: 5, ttlMs: 60_000 },
    );
    if (!added.ok) throw new Error('watch was not added');
    return added.value;
  }

  it("lists the caller's watches on a conversation and refuses a missing conversation id", async () => {
    await stored();
    await stored(OTHER);
    const handlers = createWatchHandlers({ watches });
    const ok = response();
    await handlers.list(request({ query: { conversationId: CONVO } }), ok.api as never);
    expect((ok.res.body as { watches: Watch[] }).watches.map((watch) => watch.user)).toEqual([
      OWNER,
    ]);
    const bad = response();
    await handlers.list(request({ query: {} }), bad.api as never);
    expect(bad.res).toMatchObject({ statusCode: 400, body: { code: 'watch_invalid' } });
  });

  it("removes the caller's watch and answers another's as not found", async () => {
    const theirs = await stored(OTHER);
    const mine = await stored();
    const handlers = createWatchHandlers({ watches });
    const refused = response();
    await handlers.remove(request({ params: { id: theirs.id } }), refused.api as never);
    expect(refused.res).toMatchObject({ statusCode: 404, body: { code: 'watch_not_found' } });
    const removed = response();
    await handlers.remove(request({ params: { id: mine.id } }), removed.api as never);
    expect(removed.res).toMatchObject({ statusCode: 204, ended: true });
    expect(await watches.list(OTHER, CONVO)).toHaveLength(1);
  });

  it('answers a store failure with a stable code and no error text', async () => {
    const handlers = createWatchHandlers({
      watches: {
        ...watches,
        list: async () => {
          throw new Error('SECRET-DETAIL');
        },
      },
    });
    const failed = response();
    await handlers.list(request({ query: { conversationId: CONVO } }), failed.api as never);
    expect(failed.res).toMatchObject({ statusCode: 500, body: { code: 'watch_unavailable' } });
    expect(JSON.stringify(failed.res.body)).not.toContain('SECRET-DETAIL');
  });
});
