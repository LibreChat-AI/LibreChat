import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { Constants } from '@librechat/agents';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Permissions,
  PermissionTypes,
  AgentCapabilities,
  DEFAULT_RUN_GRANT_LIFETIME_HOURS,
} from 'librechat-data-provider';
import {
  createModels,
  tenantStorage,
  createTriggerRuns,
  createConnections,
  createSubscriptions,
  createSubscriptionGrantStorage,
} from '@librechat/data-schemas';
import type {
  AgentGraphAccessContext,
  RunGrantStorage,
  Subscriptions,
  Connections,
  AppConfig,
  IRole,
  IUser,
} from '@librechat/data-schemas';
import type { RunGrant, Subscription, SubscriptionIdentity } from 'librechat-data-provider';
import type { ExecutionContext, SavedRun } from '~/agents/authority/context';
import type { SubscriptionHost, SubscriptionInput } from './subject';
import type { MCPToolsSnapshot } from '~/mcp/connection';
import type { AgentAccess } from '~/schedules/access';
import {
  restoreExecutionContext,
  createTriggerExecutionContext,
  SUBSCRIPTION_SOURCE,
  getSourceKey,
} from '~/agents/authority/context';
import { createSubscriptionHost, subscriptionSubject, RunRefusal } from './subject';
import { grantExecution, narrowGrantedTools } from '~/agents/authority/execution';
import { createAgentTriggerIngressHandlers } from '~/agents/triggers/ingress';
import { scheduleSubject } from '~/schedules/authorization/subject';
import { RunGrantPolicyError } from '~/agents/authority/policy';
import { createRunPolicy } from '~/agents/authority/run';
import { getMCPRequestContext } from '~/mcp/request';
import { placeRun } from '~/agents/authority/host';
import { keySubject } from '~/apiKeys/grants';

const DB_SETUP_TIMEOUT_MS = 60_000;
const NOW = 1_800_000_000_000;
const OWNER = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();
const AGENT = 'agent_root';
const TOOLS = ['web_search', 'execute_code', 'query_mcp_warehouse', Constants.SUBAGENT];

let server: MongoMemoryServer;
let subscriptions: Subscriptions;
let connections: Connections;
let storage: RunGrantStorage<SubscriptionIdentity>;
let host: SubscriptionHost;
let access: jest.Mock<Promise<AgentAccess>, [string, IUser]>;
let findUser: jest.Mock<Promise<IUser | null>, [string]>;
/** The generation job store, by conversation: each run's own generation, as the server creates it. */
let jobStore: Map<string, { status: string; createdAt: number }>;
let getAppConfig: jest.Mock<Promise<AppConfig | undefined>, [{ baseOnly?: boolean }?]>;
let connectionId: string;

const unused = async (): Promise<never> => {
  throw new Error('not read by a run that calls no tool');
};

type HostDeps = Parameters<typeof createSubscriptionHost>[0];

/** A role that may subscribe agents to events, and nothing more. */
const subscriber = { [PermissionTypes.AGENT_EVENTS]: { [Permissions.USE]: true } };

/** The host over the real stores, with nothing of the owner's configuration readable. */
const build = (overrides: Partial<HostDeps> = {}): SubscriptionHost =>
  createSubscriptionHost({
    storage,
    getSubscription: subscriptions.get,
    getConnection: connections.get,
    findUser,
    getRoleByName: async () => ({ permissions: subscriber }) as IRole,
    access,
    runs: createTriggerRuns(mongoose),
    usage: subscriptions,
    jobs: { getJobStore: () => ({ getJob: async (id: string) => jobStore.get(id) ?? null }) },
    enrollment: {
      getAppConfig,
      resolveGraphAccess: unused,
      getNodes: unused,
      getModelsConfig: unused,
      ensureConfigServers: unused,
      getServers: unused,
    },
    ...overrides,
  });

type TriggerRequest = NonNullable<Parameters<typeof createTriggerExecutionContext>[0]> & {
  user: { id: string; tenantId?: string };
};

/** The request the trigger host makes for a delivery a subscription matched. */
let deliveries = 0;

function delivery(
  subscriptionId: string | undefined,
  {
    user = { id: OWNER } as TriggerRequest['user'],
    agentId = AGENT as unknown,
    key = `trigger_delivery_${++deliveries}`,
  } = {},
): TriggerRequest {
  return {
    user,
    _isAgentTrigger: true,
    body: {
      agent_id: agentId,
      clientRequestId: key,
      conversationId: `conversation-${key}`,
      agentTrigger: {
        version: 1,
        event: {
          id: 'gh-delivery-1',
          type: 'github.check_suite.completed',
          occurredAt: NOW,
          source: { type: SUBSCRIPTION_SOURCE, id: subscriptionId },
        },
      },
    },
  };
}

function inputFor(
  req: TriggerRequest,
  executionContext = createTriggerExecutionContext(req),
  overrides: Partial<SubscriptionInput> = {},
): SubscriptionInput {
  return { req, context: getMCPRequestContext(req), executionContext, ...overrides };
}

const place = (input: SubscriptionInput): Promise<void> =>
  placeRun([subscriptionSubject(() => host)], input);

/** The reason a refused run was refused with, or `placed`. */
async function outcome(input: SubscriptionInput): Promise<string> {
  try {
    await place(input);
    return 'placed';
  } catch (error) {
    if (error instanceof RunGrantPolicyError) return error.failure.reason;
    throw error;
  }
}

const draft = {
  agentId: AGENT,
  events: ['github.check_suite.completed'],
  target: 'new' as const,
  prompt: 'Read the result.',
  actors: 'write' as const,
  bots: false,
  enabled: true,
};

const made = (owner = OWNER, overrides: Partial<typeof draft> = {}): Promise<Subscription> =>
  subscriptions.create(owner, { ...draft, connection: connectionId, ...overrides });

const identityOf = (subscription: Subscription): SubscriptionIdentity => ({
  subscriptionId: subscription.id,
  ownerId: subscription.user,
  tenantId: subscription.tenantId ?? null,
  agentId: subscription.agentId,
  invocationMode: 'delegated',
});

async function grant(
  subscription: Subscription,
  what: Pick<RunGrant<SubscriptionIdentity>, 'everything' | 'tools'>,
): Promise<void> {
  const committed = await storage.confirmRunGrant({
    identity: identityOf(subscription),
    expectedConfigRevision: subscription.revision,
    expectedRevision: null,
    enrollment: {
      version: 1,
      scheduleRevision: subscription.revision,
      revision: 'grant-1',
      consents: [],
      grantedAtMs: NOW - 1000,
      absoluteExpiresAtMs: Date.now() + 3_600_000,
      ...what,
    },
  });
  if (!committed) throw new Error('grant was not stored');
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  await mongoose.models.ScheduleRun.init();
  // As the release that drops the two indexes covering every row leaves the collection, so a
  // subscription's runs can be put on record. The tests of the time before put them back.
  await legacy(false);
}, DB_SETUP_TIMEOUT_MS);

const LEGACY = [
  { key: { scheduleId: 1, scheduledFor: 1 }, name: 'scheduleId_1_scheduledFor_1', unique: true },
  {
    key: { scheduleId: 1 },
    name: 'scheduleId_1',
    unique: true,
    partialFilterExpression: { status: 'started' },
  },
] as const;

async function legacy(present: boolean): Promise<void> {
  const collection = mongoose.models.ScheduleRun.collection;
  const names = new Set((await collection.indexes()).map((index) => index.name));
  for (const { key, ...options } of LEGACY) {
    if (present && !names.has(options.name)) await collection.createIndex(key, options);
    if (!present && names.has(options.name)) await collection.dropIndex(options.name);
  }
}

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  subscriptions = createSubscriptions(mongoose);
  connections = createConnections(mongoose);
  storage = createSubscriptionGrantStorage(mongoose);
  await mongoose.models.AgentEventSubscription.deleteMany({});
  await mongoose.models.AgentEventConnection.deleteMany({});
  await mongoose.models.ScheduleRun.deleteMany({});
  const bound = await connections.bind({
    provider: 'github',
    installation: '4242',
    account: { id: '99', name: 'acme' },
    createdBy: OWNER,
  });
  if (!bound.ok) throw new Error('connection was not bound');
  connectionId = bound.value.id;
  access = jest.fn<Promise<AgentAccess>, [string, IUser]>(async () => 'ok');
  findUser = jest.fn(async (id: string) => ({ id, role: 'USER' }) as IUser);
  // The deployment's own settings are read for a run's bounds; nothing of the owner's is.
  jobStore = new Map();
  getAppConfig = jest.fn(async (options?: { baseOnly?: boolean }) =>
    options?.baseOnly ? ({} as AppConfig) : unused(),
  );
  host = build();
});

describe('the context of a delivery a subscription matched', () => {
  it('names the subscription as the subject and is never attended', () => {
    const context = createTriggerExecutionContext(delivery('sub_1'));
    expect(context).toEqual({
      principal: { userId: OWNER },
      agentId: AGENT,
      source: {
        type: 'trigger',
        subject: { kind: 'subscription', id: 'sub_1' },
        delivery: {
          key: expect.stringMatching(/^trigger_delivery_/),
          event: { id: 'gh-delivery-1', type: 'github.check_suite.completed', occurredAt: NOW },
        },
        manual: false,
        resumed: false,
      },
      unattended: true,
    });
    expect(getSourceKey(context)).toBeUndefined();
  });

  it.each([undefined, '', '   ', 7])('refuses one that does not say which (%p)', (id) => {
    expect(() => createTriggerExecutionContext(delivery(id as string | undefined))).toThrow(
      'names a subscription as its source without identifying it',
    );
  });

  it('refuses one with no event to identify the delivery by', () => {
    const req = delivery('sub_1');
    Object.assign((req.body?.agentTrigger as { event: object }).event, { id: undefined });
    expect(() => createTriggerExecutionContext(req)).toThrow('without identifying it');
  });

  it('is not attended on a resume or on the turn that reports its background work', () => {
    const saved: SavedRun = {
      userId: OWNER,
      agent_id: AGENT,
      trigger: createTriggerExecutionContext(delivery('sub_1'))!.source as SavedRun['trigger'],
    };
    const resumed = restoreExecutionContext({ user: { id: OWNER } }, saved);
    expect(resumed).toMatchObject({
      source: { subject: { kind: 'subscription', id: 'sub_1' }, resumed: true },
      unattended: true,
    });
    const reporting = createTriggerExecutionContext({
      user: { id: OWNER },
      _isAgentTrigger: true,
      body: {
        agent_id: 'descendant',
        conversationId: 'conversation',
        clientRequestId: 'trigger_wakeup',
        agentEvent: { id: 'wake-1', type: 'task.completed', occurredAt: NOW },
        agentCompletion: {
          version: 1,
          sourceId: 'subagent-completion',
          trigger: {
            subject: { kind: 'subscription', id: 'sub_1' },
            origin: { agentId: AGENT },
          },
        },
      },
    });
    expect(reporting).toMatchObject({
      agentId: AGENT,
      source: { subject: { kind: 'subscription', id: 'sub_1' }, origin: { agentId: AGENT } },
      unattended: true,
    });
  });

  it('leaves every other triggered run attended as before', () => {
    const key = delivery('key_1');
    Object.assign((key.body?.agentTrigger as { event: { source: object } }).event.source, {
      type: 'remote_api_key',
    });
    expect(createTriggerExecutionContext(key)).toMatchObject({
      source: { subject: { kind: 'key', id: 'key_1' } },
      unattended: false,
    });
    const own = delivery('queued');
    Object.assign((own.body?.agentTrigger as { event: { source: object } }).event.source, {
      type: 'internal',
    });
    const context = createTriggerExecutionContext(own);
    expect(context?.unattended).toBe(false);
    expect(context?.source).not.toHaveProperty('subject');
  });
});

describe('who may say a delivery is a subscription', () => {
  it('is not a caller of the public event route, which stamps the key on every delivery', async () => {
    const enqueue = jest.fn(async () => ({
      id: 'stored',
      deliveryKey: `trigger_${'a'.repeat(64)}`,
      status: 'pending' as const,
      availableAt: new Date(NOW),
      replayed: false,
    }));
    const handlers = createAgentTriggerIngressHandlers({
      enqueue,
      getDeliveryStatus: jest.fn(async () => null),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: OWNER }, apiKeyId: 'key_caller' });
      next();
    });
    app.post('/events', handlers.enqueueEvent);
    const response = await request(app)
      .post('/events')
      .set('Idempotency-Key', 'delivery-1')
      .send({
        mode: 'fire',
        event: {
          id: 'event-1',
          type: 'github.check_suite.completed',
          occurredAt: NOW,
          source: { id: 'sub_victim', type: SUBSCRIPTION_SOURCE },
        },
        target: { agentId: AGENT },
        input: 'Run as the subscription.',
      });
    expect(response.status).toBe(202);
    const [[envelope]] = enqueue.mock.calls as unknown as [[{ event: { source: unknown } }]];
    expect(envelope.event.source).toEqual({ id: 'key_caller', type: 'remote_api_key' });
    // And what the trigger host then requests runs for the key, not for a subscription.
    const req = delivery('sub_victim');
    Object.assign((req.body?.agentTrigger as { event: object }).event, {
      source: envelope.event.source,
    });
    expect(createTriggerExecutionContext(req)?.source).toMatchObject({
      subject: { kind: 'key', id: 'key_caller' },
    });
  });

  it('is claimed by the subscription adapter alone', () => {
    const input = inputFor(delivery('sub_1'));
    const none = () => {
      throw new Error('not built for a request it does not claim');
    };
    expect(subscriptionSubject(none).claims(input)).toBe(true);
    expect(keySubject(none).claims(input)).toBe(false);
    expect(scheduleSubject(none).claims(input as never)).toBe(false);
  });

  it.each([
    ['a schedule', 'schedule'],
    ['an API key', 'key'],
  ] as const)('does not claim a run that acts for %s', (_name, kind) => {
    const context = createTriggerExecutionContext(delivery('sub_1'))!;
    const executionContext = {
      ...context,
      source: { ...context.source, subject: { kind, id: 'sub_1' } },
    } as ExecutionContext;
    const none = () => {
      throw new Error('not built for a request it does not claim');
    };
    expect(subscriptionSubject(none).claims(inputFor(delivery('sub_1'), executionContext))).toBe(
      false,
    );
  });

  it('does not claim an interactive request or a remote API run', () => {
    const none = () => {
      throw new Error('not built for a request it does not claim');
    };
    const adapter = subscriptionSubject(none);
    expect(adapter.claims({ req: {} })).toBe(false);
    expect(
      adapter.claims({
        req: {},
        executionContext: {
          principal: { userId: OWNER },
          source: { type: 'remote_api', protocol: 'responses', background: false },
          unattended: true,
        } as ExecutionContext,
      }),
    ).toBe(false);
  });
});

describe('a subscription with no grant', () => {
  it('starts the run under the subscription and loads nothing a grant could list', async () => {
    const subscription = await made();
    const input = inputFor(delivery(subscription.id));
    await place(input);
    const execution = grantExecution(input.context);
    expect(execution).toMatchObject({
      identity: identityOf(subscription),
      stage: 'invoke',
      enrolled: false,
      coversTools: true,
      detaches: true,
      completion: false,
    });
    // Only the SDK's own control is left: no MCP tool, and none of the agent's other tools.
    expect(execution!.narrow(AGENT, TOOLS)).toEqual([Constants.SUBAGENT]);
    expect(narrowGrantedTools(input.req, AGENT, TOOLS)).toEqual([Constants.SUBAGENT]);
    expect(await execution!.needsGrant()).toBe(true);
  });

  it('refuses every tool call that reaches it anyway, MCP or not', async () => {
    const subscription = await made();
    const input = inputFor(delivery(subscription.id));
    await place(input);
    const execution = grantExecution(input.context)!;
    const policy = createRunPolicy(execution, [
      {
        id: AGENT,
        toolRegistry: new Map([
          [
            'query_mcp_warehouse',
            { name: 'query_mcp_warehouse', toolType: 'mcp', serverName: 'warehouse' },
          ],
        ]),
      },
    ]);
    const call = (toolName: string) =>
      policy.hook(
        {
          hook_event_name: 'PreToolUse',
          runId: 'run',
          executingAgentId: AGENT,
          toolName,
          toolUseId: 'call',
          toolInput: {},
        },
        new AbortController().signal,
      );
    for (const name of ['web_search', 'execute_code'])
      expect(await call(name)).toEqual({
        decision: 'deny',
        reason: expect.stringContaining('consent_missing'),
      });
    // An MCP call is refused where it is made.
    await expect(
      execution.bind(AGENT, 'query').authorize({
        user: { id: OWNER },
        serverName: 'warehouse',
        serverConfig: { type: 'streamable-http', url: 'https://warehouse.example/mcp' },
        toolName: 'query',
        loadTools: unused,
      }),
    ).rejects.toMatchObject({ failure: { reason: 'consent_missing' } });
  });

  describe('an MCP call under a grant of the whole agent', () => {
    const mcp = { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } };
    /** A run put under a grant of everything, ready to make one call on an undeclared server. */
    async function call(permissions: object = { ...subscriber, ...mcp }) {
      host = build({ getRoleByName: async () => ({ permissions }) as IRole });
      const subscription = await made();
      await grant(subscription, { everything: true });
      const input = inputFor(delivery(subscription.id));
      await place(input);
      return () =>
        grantExecution(input.context)!
          .bind(AGENT, 'query')
          .authorize({
            user: { id: OWNER },
            serverName: 'warehouse',
            serverConfig: { type: 'streamable-http', url: 'https://warehouse.example/mcp' },
            toolName: 'query',
            loadTools: unused,
          });
    }

    it('goes ahead, reading the owner and their configuration fail-closed', async () => {
      getAppConfig.mockResolvedValue({} as never);
      const authorize = await call();
      findUser.mockClear();
      await expect(authorize()).resolves.toBeUndefined();
      expect(findUser).toHaveBeenCalledWith(OWNER);
      expect(getAppConfig).toHaveBeenCalledWith(expect.objectContaining({ failClosed: true }));
    });

    it("is refused when the owner's role no longer allows MCP servers", async () => {
      getAppConfig.mockResolvedValue({} as never);
      const authorize = await call(subscriber);
      await expect(authorize()).rejects.toMatchObject({ failure: { reason: 'rbac_denied' } });
    });

    it('is refused when the owner is gone by the time of the call', async () => {
      getAppConfig.mockResolvedValue({} as never);
      const authorize = await call();
      findUser.mockResolvedValue(null);
      await expect(authorize()).rejects.toMatchObject({ failure: { reason: 'rbac_denied' } });
      expect(getAppConfig).not.toHaveBeenCalledWith(expect.objectContaining({ failClosed: true }));
    });

    it("is refused when the owner's configuration cannot be read", async () => {
      getAppConfig.mockImplementation(async (options) => {
        if (options?.baseOnly) return {} as AppConfig;
        throw new Error('config store down');
      });
      const authorize = await call();
      await expect(authorize()).rejects.toMatchObject({
        failure: { reason: 'dependency_unavailable' },
      });
    });
  });

  it('is not lifted by anything the deployment sets for schedules', async () => {
    const subscription = await made();
    const input = inputFor(delivery(subscription.id));
    await place(input);
    expect(await grantExecution(input.context)!.needsGrant()).toBe(true);
    // No setting of the owner's was read to decide it: there is none that could say otherwise.
    // Only the deployment's own bounds on the run were read.
    expect(getAppConfig.mock.calls.every(([options]) => options?.baseOnly === true)).toBe(true);
  });
});

describe('a subscription with a grant', () => {
  it('loads everything under a grant of the whole agent', async () => {
    const subscription = await made();
    await grant(subscription, { everything: true });
    const input = inputFor(delivery(subscription.id));
    await place(input);
    const execution = grantExecution(input.context)!;
    expect(execution.enrolled).toBe(true);
    expect(execution.narrow(AGENT, TOOLS)).toEqual(TOOLS);
    expect(await execution.needsGrant()).toBe(false);
    expect(execution.wording).toEqual({
      leftOut:
        'The owner of this event subscription has not allowed this tool. Continue without it.',
      ask: 'subscription_owner_approval',
    });
  });

  it('loads only what a grant lists', async () => {
    const subscription = await made();
    await grant(subscription, { tools: [{ agentId: AGENT, tools: ['web_search'] }] });
    const input = inputFor(delivery(subscription.id));
    await place(input);
    expect(grantExecution(input.context)!.narrow(AGENT, TOOLS)).toEqual([
      'web_search',
      Constants.SUBAGENT,
    ]);
  });

  it('refuses the run once the subscription was edited after the grant was made', async () => {
    const subscription = await made();
    await grant(subscription, { everything: true });
    await subscriptions.update(subscription.id, OWNER, { prompt: 'Do something else.' });
    const input = inputFor(delivery(subscription.id));
    expect(await outcome(input)).toBe('binding_mismatch');
    expect(grantExecution(input.context)).toBeUndefined();
  });

  it('still stands after the subscription was turned off and on again', async () => {
    const subscription = await made();
    await grant(subscription, { everything: true });
    await subscriptions.update(subscription.id, OWNER, { enabled: false });
    await subscriptions.update(subscription.id, OWNER, { enabled: true });
    const input = inputFor(delivery(subscription.id));
    expect(await outcome(input)).toBe('placed');
    expect(grantExecution(input.context)!.enrolled).toBe(true);
  });

  it('refuses a stored grant it cannot read', async () => {
    const subscription = await made();
    await mongoose.models.AgentEventSubscription.collection.updateOne(
      { id: subscription.id },
      { $set: { grant: { version: 2 } } },
    );
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('binding_mismatch');
  });
});

describe('a subscription that is not live', () => {
  it('refuses a subscription that does not exist', async () => {
    const input = inputFor(delivery('sub_missing'));
    expect(await outcome(input)).toBe('binding_mismatch');
    expect(grantExecution(input.context)).toBeUndefined();
  });

  it("refuses another owner's subscription", async () => {
    const subscription = await made(OTHER);
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('binding_mismatch');
  });

  it('refuses one that was turned off', async () => {
    const subscription = await made(OWNER, { enabled: false });
    await grant(subscription, { everything: true });
    const input = inputFor(delivery(subscription.id));
    expect(await outcome(input)).toBe('binding_mismatch');
    expect(grantExecution(input.context)).toBeUndefined();
  });

  it('refuses a delivery for another agent than the subscription is for', async () => {
    const subscription = await made();
    expect(await outcome(inputFor(delivery(subscription.id, { agentId: 'agent_other' })))).toBe(
      'binding_mismatch',
    );
  });

  it('refuses a delivery that names no agent', async () => {
    const subscription = await made();
    expect(await outcome(inputFor(delivery(subscription.id, { agentId: null })))).toBe(
      'binding_mismatch',
    );
  });

  it('refuses when its owner is gone or belongs to another tenant now', async () => {
    const subscription = await made();
    findUser.mockResolvedValueOnce(null);
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('binding_mismatch');
    findUser.mockResolvedValueOnce({ id: OWNER, tenantId: 'tenant-b' } as IUser);
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('binding_mismatch');
  });

  it('refuses when its connection is suspended or gone', async () => {
    const subscription = await made();
    await connections.mark(connectionId, 'suspended');
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('provider_missing');
    await connections.mark(connectionId, 'active');
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('placed');
    await connections.remove(connectionId);
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('provider_missing');
  });

  it.each<AgentAccess>(['forbidden', 'missing'])(
    'refuses when the owner may no longer run the agent (%s)',
    async (answer) => {
      const subscription = await made();
      await grant(subscription, { everything: true });
      access.mockResolvedValue(answer);
      const input = inputFor(delivery(subscription.id));
      expect(await outcome(input)).toBe('rbac_denied');
      expect(access).toHaveBeenCalledWith(AGENT, expect.objectContaining({ id: OWNER }));
      expect(grantExecution(input.context)).toBeUndefined();
    },
  );

  it("refuses when the owner's role no longer allows event subscriptions", async () => {
    const subscription = await made();
    await grant(subscription, { everything: true });
    host = build({ getRoleByName: async () => ({ permissions: {} }) as IRole });
    const input = inputFor(delivery(subscription.id));
    expect(await outcome(input)).toBe('rbac_denied');
    expect(grantExecution(input.context)).toBeUndefined();
  });

  it('refuses a request that has nowhere to hold the check, or no owner', async () => {
    const subscription = await made();
    const req = delivery(subscription.id);
    expect(await outcome({ req, executionContext: createTriggerExecutionContext(req) })).toBe(
      'binding_mismatch',
    );
    const executionContext = createTriggerExecutionContext(req);
    const anonymous = { ...req, user: undefined } as unknown as TriggerRequest;
    expect(await outcome(inputFor(anonymous, executionContext))).toBe('binding_mismatch');
  });

  it('never reads a subscription of another tenant', async () => {
    const subscription = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => made());
    const stranger = { id: OWNER, tenantId: 'tenant-b' };
    findUser.mockResolvedValue({ id: OWNER, role: 'USER', tenantId: 'tenant-b' } as IUser);
    const req = delivery(subscription.id, { user: stranger });
    expect(
      await tenantStorage.run({ tenantId: 'tenant-b' }, async () => outcome(inputFor(req))),
    ).toBe('binding_mismatch');
  });

  it('refuses a subscription of another tenant even where the store hands it over', async () => {
    const subscription = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => made());
    findUser.mockResolvedValue({ id: OWNER, role: 'USER', tenantId: 'tenant-b' } as IUser);
    // No tenant is in scope here, so the read is not narrowed for the caller.
    const req = delivery(subscription.id, { user: { id: OWNER, tenantId: 'tenant-b' } });
    expect(await subscriptions.get(subscription.id, OWNER)).not.toBeNull();
    expect(await outcome(inputFor(req))).toBe('binding_mismatch');
  });

  it("refuses another owner's subscription even where the lookup ignores the owner", async () => {
    const subscription = await made(OTHER);
    host = build({ getSubscription: (id) => subscriptions.get(id) });
    expect(await outcome(inputFor(delivery(subscription.id)))).toBe('binding_mismatch');
  });

  it('refuses when the subscription is deleted before the run is put under it', async () => {
    const subscription = await made();
    host = build({ storage: { ...storage, readRunGrant: async () => null } });
    const input = inputFor(delivery(subscription.id));
    expect(await outcome(input)).toBe('binding_mismatch');
    expect(grantExecution(input.context)).toBeUndefined();
  });

  it('lets an unexpected failure reach the caller as it is', async () => {
    const subscription = await made();
    access.mockRejectedValueOnce(new Error('acl store down'));
    await expect(place(inputFor(delivery(subscription.id)))).rejects.toThrow('acl store down');
  });
});

describe("the owner's grant, made through the consent service", () => {
  /** A deployment with one MCP server, which nothing declares for subscriptions. */
  const served = (overrides: Partial<HostDeps> = {}): SubscriptionHost =>
    build({
      getRoleByName: async () =>
        ({
          permissions: {
            ...subscriber,
            [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
          },
        }) as IRole,
      enrollment: {
        getAppConfig: async () =>
          ({
            // What schedules may be granted says nothing about subscriptions.
            interfaceConfig: {
              schedules: {
                mcpConsent: {
                  enabled: false,
                  resources: {
                    warehouse: {
                      url: 'https://warehouse.example/mcp',
                      credentialMode: 'anonymous',
                      issuer: null,
                      audience: null,
                      scopes: [],
                    },
                  },
                },
              },
            },
            endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
            mcpConfig: {
              warehouse: { type: 'streamable-http', url: 'https://warehouse.example/mcp' },
            },
          }) as unknown as AppConfig,
        getModelsConfig: async () => ({ test: ['test'] }),
        ensureConfigServers: async () => ({}),
        getServers: async () => ({
          warehouse: { type: 'streamable-http' as const, url: 'https://warehouse.example/mcp' },
        }),
        getNodes: async (ids: string[]) =>
          ids.map((id) => ({
            id,
            provider: 'test',
            model: 'test',
            tools: ['web_search', 'query_mcp_warehouse'],
            agent_ids: [],
          })),
        resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
      },
      ...overrides,
    });

  it('offers the whole agent or its tools one by one, and says the grant is required', async () => {
    host = served();
    const subscription = await made();
    const view = await host.service.view(identityOf(subscription));
    expect(view).toMatchObject({
      state: 'missing',
      required: true,
      requireAfterMs: null,
      // No server is declared for subscriptions, so none is offered as a recipient.
      targets: [],
      tools: { offered: ['query_mcp_warehouse', 'web_search'], allowed: [] },
      offer: { maxLifetimeHours: DEFAULT_RUN_GRANT_LIFETIME_HOURS, everything: true },
    });
  });

  it('stores what the owner confirms, and the next delivery runs under it', async () => {
    host = served();
    const subscription = await made();
    const identity = identityOf(subscription);
    const offered = await host.service.view(identity);
    const confirmed = await host.service.confirm(identity, {
      offerDigest: offered.offer!.digest,
      expectedRevision: offered.revision,
      lifetimeHours: 1,
      allow: {},
      tools: ['web_search'],
    });
    expect(confirmed).toMatchObject({
      state: 'active',
      required: false,
      tools: { allowed: ['web_search'] },
    });
    const input = inputFor(delivery(subscription.id));
    await place(input);
    expect(grantExecution(input.context)!.narrow(AGENT, TOOLS)).toEqual([
      'web_search',
      Constants.SUBAGENT,
    ]);
    // Withdrawn, the grant allows nothing again.
    await host.service.revoke(identity, confirmed.revision!);
    const after = inputFor(delivery(subscription.id));
    await place(after);
    expect(grantExecution(after.context)!.grantsTool(AGENT, 'web_search')).toBe(false);
  });

  it('reports a grant the subscription was edited after as changed', async () => {
    host = served();
    const subscription = await made();
    const identity = identityOf(subscription);
    const offered = await host.service.view(identity);
    await host.service.confirm(identity, {
      offerDigest: offered.offer!.digest,
      expectedRevision: offered.revision,
      lifetimeHours: 1,
      allow: {},
      everything: true,
    });
    await subscriptions.update(subscription.id, OWNER, { prompt: 'Do something else.' });
    expect(await host.service.view(identity)).toMatchObject({ state: 'changed' });
  });

  it('bounds the lifetime by what the deployment sets, and by the default without it', async () => {
    const getMaxLifetimeHours = jest.fn(async () => 2);
    host = served({ getMaxLifetimeHours });
    const subscription = await made();
    const identity = identityOf(subscription);
    const offered = await host.service.view(identity);
    expect(offered.offer).toMatchObject({ maxLifetimeHours: 2 });
    expect(offered.required).toBe(true);
    expect(getMaxLifetimeHours).toHaveBeenCalledWith(expect.objectContaining({ id: OWNER }));
    const choice = {
      offerDigest: offered.offer!.digest,
      expectedRevision: offered.revision,
      allow: {},
      everything: true as const,
    };
    await expect(host.service.confirm(identity, { ...choice, lifetimeHours: 3 })).rejects.toThrow(
      'consent_invalid',
    );
    await expect(
      host.service.confirm(identity, { ...choice, lifetimeHours: 2 }),
    ).resolves.toMatchObject({ state: 'active' });
    // An owner who is gone has no setting to read: the default bounds what is shown.
    findUser.mockResolvedValue(null);
    await expect(host.service.view(identity)).resolves.toMatchObject({ offer: null });
  });
});

describe('the later turns of a run a subscription started', () => {
  const saved = (subscription: Subscription): SavedRun => ({
    userId: OWNER,
    agent_id: AGENT,
    trigger: createTriggerExecutionContext(delivery(subscription.id))!
      .source as SavedRun['trigger'],
  });

  it('puts a resumed run under the grant again, with the approvals its owner gave', async () => {
    const subscription = await made();
    await grant(subscription, { everything: true });
    const req = delivery(subscription.id);
    const executionContext = restoreExecutionContext({ user: { id: OWNER } }, saved(subscription));
    const input = inputFor(req, executionContext, { approvedToolCalls: ['call_1'] });
    const attach = jest.spyOn(host.execution, 'attach');
    await place(input);
    expect(grantExecution(input.context)).toMatchObject({ stage: 'resume', enrolled: true });
    expect(attach).toHaveBeenCalledWith(input.context, identityOf(subscription), 'resume', false, {
      approvedToolCalls: ['call_1'],
    });
  });

  it('carries no approval into a fresh delivery, whatever the request says', async () => {
    const subscription = await made();
    const input = inputFor(delivery(subscription.id), undefined, { approvedToolCalls: ['call_1'] });
    const attach = jest.spyOn(host.execution, 'attach');
    await place(input);
    expect(attach).toHaveBeenCalledWith(
      input.context,
      identityOf(subscription),
      'invoke',
      false,
      {},
    );
  });

  it('asks whether the subscription is live again when the run resumes', async () => {
    const subscription = await made();
    await grant(subscription, { everything: true });
    const job = saved(subscription);
    await subscriptions.update(subscription.id, OWNER, { enabled: false });
    const executionContext = restoreExecutionContext({ user: { id: OWNER } }, job);
    expect(await outcome(inputFor(delivery(subscription.id), executionContext))).toBe(
      'binding_mismatch',
    );
  });

  it('puts the turn that reports background work under the subscription, as a completion', async () => {
    const subscription = await made();
    await grant(subscription, { everything: true });
    const req: TriggerRequest = {
      user: { id: OWNER },
      _isAgentTrigger: true,
      body: {
        agent_id: 'descendant',
        conversationId: 'conversation',
        clientRequestId: 'trigger_wakeup',
        agentEvent: { id: 'wake-1', type: 'task.completed', occurredAt: NOW },
        agentCompletion: {
          version: 1,
          sourceId: 'subagent-completion',
          trigger: {
            subject: { kind: 'subscription', id: subscription.id },
            origin: { agentId: AGENT },
          },
        },
      },
    };
    const input = inputFor(req);
    await place(input);
    expect(grantExecution(input.context)).toMatchObject({
      identity: identityOf(subscription),
      stage: 'invoke',
      completion: true,
    });
  });
});

describe("the subscription's readiness check", () => {
  const warehouse = { type: 'streamable-http' as const, url: 'https://warehouse.example/mcp' };
  const config = {
    interfaceConfig: {},
    endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
    mcpConfig: { warehouse },
  } as unknown as AppConfig;
  const mcp = { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } };
  let connect: jest.Mock;
  /** The listing the warehouse answers with; it may say the owner's sign-in was refused. */
  let listing: () => MCPToolsSnapshot;

  const readiness = (): NonNullable<HostDeps['readiness']> => ({
    resolveAgentGraphAccess: async () => ({}) as AgentGraphAccessContext,
    getAgentGraphNodes: async (ids: string[]) =>
      ids.map((id) => ({
        id,
        provider: 'test',
        model: 'test',
        tools: ['query_mcp_warehouse'],
        agent_ids: [],
      })),
    getModelsConfig: async () => ({ test: ['test'] }),
    getRoleByName: async () => ({ permissions: { ...subscriber, ...mcp } }) as IRole,
    getUser: async (id: string) => ({ id, role: 'USER' }) as IUser,
    getAppConfig: async () => config,
    ensureConfigServers: async () => ({}),
    getServerConfigs: async () => ({ warehouse: { ...warehouse } }),
    findPluginAuthsByKeys: async () => [],
    connect,
  });

  beforeEach(() => {
    listing = () => ({
      tools: [{ name: 'query', inputSchema: { type: 'object' as const, properties: {} } }],
      complete: true,
    });
    connect = jest.fn(async () => ({ fetchToolsSnapshot: async () => listing() }));
    getAppConfig.mockResolvedValue(config as never);
  });
  afterEach(() => jest.restoreAllMocks());

  /** A subscription granted the whole agent, and a check of its servers for one delivery. */
  async function subscribed(overrides: Partial<HostDeps> = {}) {
    host = build({
      getRoleByName: async () => ({ permissions: { ...subscriber, ...mcp } }) as IRole,
      readiness: readiness(),
      ...overrides,
    });
    const subscription = await made();
    await grant(subscription, { everything: true });
    const check = () =>
      host.preflight!(AGENT, { id: OWNER }, { subscriptionId: subscription.id, concurrency: 2 });
    return { subscription, check };
  }

  it('is offered only to a host given what it reads', () => {
    expect(build().preflight).toBeUndefined();
    expect(build({ readiness: readiness() }).preflight).toEqual(expect.any(Function));
  });

  it('reuses a server found ready for five minutes when nothing sets how long', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const { check } = await subscribed();
    await expect(check()).resolves.toEqual([{ server: 'warehouse', status: 'ready' }]);
    clock.mockReturnValue(NOW + 300_000 - 1);
    await check();
    expect(connect).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(NOW + 300_000);
    await check();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('reuses for as long as the deployment sets, and checks every delivery at 0', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const lasting = (readyTtlSeconds: number) =>
      getAppConfig.mockResolvedValue({
        ...config,
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools], events: { readyTtlSeconds } },
        },
      } as never);
    lasting(600);
    const longer = await subscribed();
    await longer.check();
    clock.mockReturnValue(NOW + 599_000);
    await longer.check();
    expect(connect).toHaveBeenCalledTimes(1);
    // Read from librechat.yaml alone: the base configuration, never one resolved for a user.
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    connect.mockClear();
    lasting(0);
    const never = await subscribed();
    await never.check();
    await never.check();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("checks a server again once one of the run's calls finds the owner's sign-in refused", async () => {
    const { subscription, check } = await subscribed();
    await check();
    const input = inputFor(delivery(subscription.id));
    await place(input);
    // What the MCP call path says when the server rejects or asks for the owner's sign-in.
    grantExecution(input.context)!.bind(AGENT, 'query').rejected!('warehouse');
    await check();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('keeps reusing a server another call was refused by, or another owner was', async () => {
    const { subscription, check } = await subscribed();
    await check();
    const input = inputFor(delivery(subscription.id));
    await place(input);
    grantExecution(input.context)!.bind(AGENT, 'query').rejected!('docs');
    await check();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('is told of a refused sign-in only by a call, never by its own check', async () => {
    const { check } = await subscribed();
    listing = () => ({ tools: [], complete: false, authenticationError: new Error('401') });
    await expect(check()).rejects.toMatchObject({ code: 'mcp_reauth_required' });
    listing = () => ({
      tools: [{ name: 'query', inputSchema: { type: 'object' as const, properties: {} } }],
      complete: true,
    });
    await check();
    await check();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe("a subscription's runs on record", () => {
  const runs = () => createTriggerRuns(mongoose);
  const refOf = (subscription: Subscription, req: TriggerRequest) => ({
    subject: { kind: 'subscription', id: subscription.id },
    delivery: { key: String(req.body?.clientRequestId), event: { occurredAt: NOW } },
  });
  const fields = [
    'status',
    'revision',
    'owner',
    'error',
    'conversationId',
    'jobCreatedAt',
  ] as const;
  const row = (subscription: Subscription, req: TriggerRequest) =>
    runs().get(refOf(subscription, req), [...fields]);
  const stored = (id: string) =>
    mongoose.models.AgentEventSubscription.findOne({ id }).lean<Record<string, unknown>>();
  const bounds = (settings: Record<string, number>) =>
    getAppConfig.mockImplementation(async (options) =>
      options?.baseOnly
        ? ({ endpoints: { agents: { events: { runs: settings } } } } as unknown as AppConfig)
        : unused(),
    );

  /** Why a run was not started: the record's own reason, or the grant check's. */
  async function refusal(input: SubscriptionInput): Promise<string> {
    try {
      await place(input);
      return 'placed';
    } catch (error) {
      if (error instanceof RunRefusal) return error.refusal;
      if (error instanceof RunGrantPolicyError) return error.failure.reason;
      throw error;
    }
  }

  async function started(subscription: Subscription) {
    const req = delivery(subscription.id);
    // The chat route creates the run's generation before the run is initialized.
    jobStore.set(String(req.body?.conversationId), { status: 'running', createdAt: Date.now() });
    const input = inputFor(req);
    await place(input);
    return { req, input };
  }

  it('puts the first turn of a delivery on record, under the revision it starts with', async () => {
    const subscription = await made();
    const { req } = await started(subscription);
    expect(await row(subscription, req)).toEqual({
      status: 'started',
      revision: 0,
      owner: OWNER,
      // The generation's key and when it was created: together they name this generation.
      conversationId: req.body?.conversationId,
      jobCreatedAt: new Date(jobStore.get(String(req.body?.conversationId))!.createdAt),
    });
  });

  it('refuses a delivery that already has a run', async () => {
    const subscription = await made();
    const { req } = await started(subscription);
    expect(await refusal(inputFor(req))).toBe('duplicate');
  });

  it('refuses every run while the record cannot hold its row, and writes nothing', async () => {
    await legacy(true);
    try {
      const subscription = await made();
      const req = delivery(subscription.id);
      expect(await refusal(inputFor(req))).toBe('blocked');
      expect(await row(subscription, req)).toBeNull();
    } finally {
      await legacy(false);
    }
  });

  it('refuses every delivery against the indexes this release builds at startup', async () => {
    const ScheduleRun = mongoose.models.ScheduleRun;
    await ScheduleRun.collection.dropIndexes();
    // What the server builds: every index the schema declares, the two legacy ones included.
    await ScheduleRun.createIndexes();
    host = build();
    try {
      const subscription = await made();
      const req = delivery(subscription.id);
      expect(await refusal(inputFor(req))).toBe('blocked');
      expect(await row(subscription, req)).toBeNull();
      expect(await ScheduleRun.countDocuments({ kind: 'subscription' })).toBe(0);
    } finally {
      await legacy(false);
    }
  });

  it("does not count a run older than the owner's turning it back on", async () => {
    bounds({ failures: 1 });
    const subscription = await made();
    const { input } = await started(subscription);
    // While the run is under way the owner turns it off and on again: a new streak.
    await subscriptions.update(subscription.id, OWNER, { enabled: false });
    await subscriptions.update(subscription.id, OWNER, { enabled: true });
    await host.settle({
      request: input.req,
      executionContext: input.executionContext,
      status: 'error',
    });
    expect(await stored(subscription.id)).toMatchObject({ enabled: true });
    expect((await stored(subscription.id))?.failures).toBeUndefined();
  });

  it("keeps only a stable reason on the row, never an error's own text", async () => {
    const subscription = await made();
    const { req, input } = await started(subscription);
    await host.settle({
      request: input.req,
      executionContext: input.executionContext,
      status: 'error',
      error: 'connect ECONNREFUSED SECRET-MARKER-7f3 token=abc',
    });
    const stored = await row(subscription, req);
    expect(stored).toMatchObject({ status: 'error', error: 'run_failed' });
    expect(JSON.stringify(stored)).not.toContain('SECRET-MARKER');
  });

  it('counts a replayed run once, however many runs were counted since', async () => {
    bounds({ failures: 0 });
    const subscription = await made();
    const { req, input } = await started(subscription);
    await host.settle({
      request: input.req,
      executionContext: input.executionContext,
      status: 'error',
    });
    // Sixty newer failures push this run's key out of the subscription's remembered keys.
    for (let i = 0; i < 60; i++) {
      await subscriptions.tally(subscription.id, OWNER, { key: `newer-${i}`, failed: true }, 0);
    }
    expect(await stored(subscription.id)).toMatchObject({ failures: 61 });
    // Its subscription step is replayed, as a sweep does for a row whose mark never landed.
    await mongoose.models.ScheduleRun.updateOne(
      { kind: 'subscription', deliveryKey: req.body?.clientRequestId },
      { $set: { bookkept: false, settledAt: new Date(Date.now() - 3 * 3_600_000) } },
    );
    await expect(host.reconcile()).resolves.toBe(1);
    expect(await stored(subscription.id)).toMatchObject({ failures: 61 });
  });

  it('records a delivery over the hourly cap as skipped, and does not run it', async () => {
    const subscription = await subscriptions.create(OWNER, {
      ...draft,
      connection: connectionId,
      cap: { perHour: 1 },
    });
    await started(subscription);
    const req = delivery(subscription.id);
    expect(await refusal(inputFor(req))).toBe('capped');
    expect(await row(subscription, req)).toMatchObject({ status: 'skipped_cap' });
  });

  it("holds an owner's cap to the deployment's ceiling", async () => {
    bounds({ maxPerHour: 1 });
    const subscription = await subscriptions.create(OWNER, {
      ...draft,
      connection: connectionId,
      cap: { perHour: 50 },
    });
    await started(subscription);
    expect(await refusal(inputFor(delivery(subscription.id)))).toBe('capped');
  });

  it('lets no more than the cap through a burst of concurrent deliveries', async () => {
    bounds({ perHour: 3 });
    const subscription = await made();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => refusal(inputFor(delivery(subscription.id)))),
    );
    expect(results.filter((result) => result === 'placed')).toHaveLength(3);
    expect(results.filter((result) => result === 'capped')).toHaveLength(5);
  });

  it('records how a run ended and starts its failure streak over on a success', async () => {
    const subscription = await made();
    const { req, input } = await started(subscription);
    await expect(
      host.settle({
        request: input.req,
        executionContext: input.executionContext,
        status: 'success',
        conversationId: 'conversation-1',
      }),
    ).resolves.toBe(true);
    expect(await row(subscription, req)).toMatchObject({
      status: 'success',
      conversationId: 'conversation-1',
    });
    expect(await stored(subscription.id)).toMatchObject({ counted: [req.body?.clientRequestId] });
  });

  it('turns the subscription off after enough runs in a row fail', async () => {
    bounds({ failures: 2 });
    const subscription = await made();
    for (let i = 0; i < 2; i++) {
      const { input } = await started(subscription);
      await host.settle({
        request: input.req,
        executionContext: input.executionContext,
        status: 'error',
        error: 'x',
      });
    }
    const after = await subscriptions.get(subscription.id, OWNER);
    expect(after).toMatchObject({ enabled: false, suspended: { reason: 'failures', failures: 2 } });
    // Turned off, its next delivery is refused before anything is recorded.
    expect(await refusal(inputFor(delivery(subscription.id)))).toBe('binding_mismatch');
  });

  it('counts neither a balance skip nor a pause into the streak', async () => {
    bounds({ failures: 1 });
    const subscription = await made();
    const first = await started(subscription);
    await host.settle({
      request: first.input.req,
      executionContext: first.input.executionContext,
      status: 'skipped_balance',
    });
    const second = await started(subscription);
    await expect(
      host.settle({
        request: second.input.req,
        executionContext: second.input.executionContext,
        status: 'requires_action',
      }),
    ).resolves.toBe(true);
    expect(await row(subscription, second.req)).toMatchObject({ status: 'requires_action' });
    expect(await stored(subscription.id)).toMatchObject({ enabled: true });
  });

  it('settles nothing for a turn that reports earlier work', async () => {
    const subscription = await made();
    const { req, input } = await started(subscription);
    const source = input.executionContext!.source as Record<string, unknown>;
    const reporting = {
      ...input.executionContext!,
      source: { ...source, origin: { agentId: AGENT } },
    } as ExecutionContext;
    await expect(
      host.settle({ request: input.req, executionContext: reporting, status: 'error' }),
    ).resolves.toBe(true);
    expect(await row(subscription, req)).toMatchObject({ status: 'started' });
  });

  it('answers false when the run it started is no longer active on record', async () => {
    const subscription = await made();
    const { req, input } = await started(subscription);
    await runs().finish(refOf(subscription, req), { status: 'success' });
    await expect(
      host.settle({
        request: input.req,
        executionContext: input.executionContext,
        status: 'error',
      }),
    ).resolves.toBe(false);
  });

  it('never settles the run of another request that holds the same delivery', async () => {
    bounds({ failures: 1 });
    const subscription = await made();
    const { req } = await started(subscription);
    // The same delivery again, refused as a duplicate while the first request runs it; its
    // initialization failure is then settled on the way out.
    const again = inputFor({ ...req });
    expect(await refusal(again)).toBe('duplicate');
    await expect(
      host.settle({
        request: again.req,
        executionContext: again.executionContext,
        status: 'error',
      }),
    ).resolves.toBe(true);
    expect(await row(subscription, req)).toMatchObject({ status: 'started' });
    expect(await stored(subscription.id)).toMatchObject({ enabled: true });
  });

  it('settles nothing for a request that put no run on record', async () => {
    const subscription = await made();
    const { req } = await started(subscription);
    const stranger = inputFor({ ...req });
    await expect(
      host.settle({
        request: {},
        executionContext: stranger.executionContext,
        status: 'success',
      }),
    ).resolves.toBe(true);
    expect(await row(subscription, req)).toMatchObject({ status: 'started' });
  });

  describe('reconcile', () => {
    const aged = (subscription: Subscription, req: TriggerRequest, field: string) =>
      mongoose.models.ScheduleRun.updateOne(
        { kind: 'subscription', subject: subscription.id, deliveryKey: req.body?.clientRequestId },
        { $set: { [field]: new Date(Date.now() - 3 * 3_600_000) } },
      );
    const generationOf = (req: TriggerRequest) => jobStore.get(String(req.body?.conversationId))!;

    it('ends a stale run whose generation is gone as interrupted, without counting it', async () => {
      bounds({ failures: 1 });
      const subscription = await made();
      const { req } = await started(subscription);
      await aged(subscription, req, 'firedAt');
      jobStore.delete(String(req.body?.conversationId));
      await expect(host.reconcile()).resolves.toBe(1);
      expect(await row(subscription, req)).toMatchObject({ status: 'interrupted' });
      expect(await stored(subscription.id)).toMatchObject({ enabled: true });
    });

    it.each(['running', 'requires_action'])(
      'leaves a stale run whose own generation is still %s',
      async (status) => {
        const subscription = await made();
        const { req } = await started(subscription);
        await aged(subscription, req, 'firedAt');
        generationOf(req).status = status;
        await expect(host.reconcile()).resolves.toBe(0);
        expect(await row(subscription, req)).toMatchObject({ status: 'started' });
      },
    );

    it('treats a run as lost when a later generation runs in its conversation', async () => {
      const subscription = await made();
      const { req } = await started(subscription);
      await aged(subscription, req, 'firedAt');
      // A later turn of the same conversation: the same key, another generation.
      jobStore.set(String(req.body?.conversationId), {
        status: 'running',
        createdAt: generationOf(req).createdAt + 60_000,
      });
      await expect(host.reconcile()).resolves.toBe(1);
      expect(await row(subscription, req)).toMatchObject({ status: 'interrupted' });
    });

    it('never reads an outcome from a generation that completed: a lost settle is interrupted', async () => {
      bounds({ failures: 2 });
      const subscription = await made();
      const first = await started(subscription);
      await host.settle({
        request: first.input.req,
        executionContext: first.input.executionContext,
        status: 'error',
      });
      // The next run's turn ended in an error part, which a generation still marks complete,
      // and its settle never landed.
      const { req } = await started(subscription);
      await aged(subscription, req, 'firedAt');
      generationOf(req).status = 'complete';
      await expect(host.reconcile()).resolves.toBe(1);
      expect(await row(subscription, req)).toMatchObject({ status: 'interrupted' });
      expect(await stored(subscription.id)).toMatchObject({ enabled: true, failures: 1 });
    });

    it('reaches a lost run behind more live runs than one pass reads', async () => {
      const subscription = await made();
      const old = new Date(Date.now() - 3 * 3_600_000);
      const createdAt = Date.now();
      for (let i = 0; i < 60; i++) {
        const ref = {
          subject: { kind: 'subscription', id: subscription.id },
          delivery: { key: `live-${i}`, event: { occurredAt: NOW } },
        };
        await runs().reserve(ref, {
          user: OWNER as never,
          firedAt: new Date(old.getTime() - (60 - i) * 1000),
          conversationId: `live-${i}`,
          jobCreatedAt: new Date(createdAt),
          configRevision: 0,
        });
        jobStore.set(`live-${i}`, { status: 'running', createdAt });
      }
      const { req } = await started(subscription);
      await aged(subscription, req, 'firedAt');
      jobStore.delete(String(req.body?.conversationId));
      await expect(host.reconcile()).resolves.toBe(0);
      await expect(host.reconcile()).resolves.toBe(1);
      expect(await row(subscription, req)).toMatchObject({ status: 'interrupted' });
    });

    it("finishes the subscription's step a crash left undone after the row was written", async () => {
      bounds({ failures: 1 });
      const subscription = await made();
      const { req } = await started(subscription);
      // The row was written, then the process stopped before the subscription's own step.
      await runs().finish(refOf(subscription, req), { status: 'error' });
      await aged(subscription, req, 'settledAt');
      await expect(host.reconcile()).resolves.toBe(1);
      expect(await stored(subscription.id)).toMatchObject({ enabled: false });
      await expect(host.reconcile()).resolves.toBe(0);
    });

    it('leaves a recent run alone', async () => {
      const subscription = await made();
      const { req } = await started(subscription);
      jobStore.delete(String(req.body?.conversationId));
      await expect(host.reconcile()).resolves.toBe(0);
    });
  });
});
