import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { CodeEnvironmentPrincipalContext } from './environments';
import type { CodeEnvironmentConfig } from '~/agents/execution';
import type { SubagentCodeAgent } from './targets';
import { createCodeEnvironmentRegistry } from './environments';
import { mergeAccessibleCodeEnvironments } from './config';
import { createSubagentCodeRouting } from './targets';

/**
 * Stands in for the SDK's `SubagentHostArgumentError` until LibreChat depends
 * on an `@librechat/agents` release that exports it.
 */
jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  class MockSubagentHostArgumentError extends Error {
    constructor(name: string, reason: 'unavailable' | 'not_allowed') {
      super('Subagent host argument was rejected.');
      this.name = 'SubagentHostArgumentError';
      Object.assign(this, { argument: name, rejection: reason });
    }
  }
  return {
    ...actual,
    SubagentHostArgumentError: actual.SubagentHostArgumentError ?? MockSubagentHostArgumentError,
  };
});

const BASE_URL = 'https://bridge.example';
const TOKEN_ENV = 'TEST_SUBAGENT_TARGETS_INTEGRATION_TOKEN';

const controlPlane: CodeEnvironmentConfig = {
  id: 'control-plane',
  name: 'Control plane',
  type: 'attached',
  owner: 'deployment',
  baseURL: BASE_URL,
  pairing: { allowPrincipalWorkers: true, tokenEnv: TOKEN_ENV },
};

const deploymentConfig = {
  endpoints: { agents: { statefulCodeSessions: { environments: [controlPlane] } } },
} as AppConfig;

const sealed = [{ environmentId: 'danny-vm', workspaceId: 'agents' }];
const reviewer: SubagentCodeAgent = {
  id: 'agent_reviewer',
  code_environment_ids: ['danny-vm'],
};
const flags = { statefulCodeSessions: true, statefulCodeEnvironment: 'conversation' };

function actor(userId: Types.ObjectId): CodeEnvironmentPrincipalContext {
  return { userId, role: 'USER', idOnTheSource: null };
}

function serveReadyWorker(): void {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const workerId = /\/bridge\/workers\/([^/]+)\/status$/.exec(String(input))?.[1] ?? '';
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        workerId,
        online: true,
        ready: true,
        leaseExpiresInMs: 45_000,
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'native-srt',
          runtimes: ['bash'],
          workspaceTools: {
            protocolVersion: 1,
            operations: ['read_file', 'execute_command'],
            workspaces: [{ id: 'agents' }],
          },
        },
      }),
    );
  });
}

describe('subagent code targets against the principal-scoped machine list', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await createMethods(mongoose).seedDefaultRoles();
    process.env[TOKEN_ENV] = `token-${Math.random()}`;
    serveReadyWorker();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[TOKEN_ENV];
  });

  async function registerMachine(ownerId: Types.ObjectId): Promise<void> {
    await createCodeEnvironmentRegistry(mongoose).register({
      actor: actor(ownerId),
      environment: {
        id: 'danny-vm',
        name: "Danny's VM",
        type: 'attached',
        baseURL: BASE_URL,
        controlPlaneId: 'control-plane',
        workerId: 'w-danny',
      },
    });
  }

  async function routingFor(userId: Types.ObjectId) {
    const appConfig = await mergeAccessibleCodeEnvironments({
      appConfig: deploymentConfig,
      deploymentConfig,
      actor: actor(userId),
      registry: createCodeEnvironmentRegistry(mongoose),
    });
    return createSubagentCodeRouting({
      allowEnvironmentSelection: true,
      persistedSelections: sealed,
      environments: appConfig.endpoints?.agents?.statefulCodeSessions?.environments,
      userId: userId.toString(),
      conversationId: 'convo-1',
      getAppConfig: async () => deploymentConfig,
    });
  }

  it('offers and routes to a machine the requesting principal can use', async () => {
    const ownerId = new Types.ObjectId();
    await registerMachine(ownerId);
    const routing = await routingFor(ownerId);

    const description = await routing.describe(reviewer, flags);
    const placed = await routing.place({
      agent: reviewer,
      flags,
      context: { executionId: 'run', hostArgs: { machine: 'danny-vm' } },
    });

    expect(description.subagentHostArgs?.machine.enum).toEqual(['danny-vm']);
    expect(description.subagentHostArgs?.workspace.enum).toEqual(['agents']);
    expect(placed.agent.code_environment_id).toBe('danny-vm');
    expect(placed.target?.context).toMatchObject({
      environmentId: 'danny-vm',
      bridgeWorkerId: 'w-danny',
      codeWorkspace: { workspaceId: 'agents' },
    });
  });

  it('refuses another principal the same admitted machine', async () => {
    const ownerId = new Types.ObjectId();
    await registerMachine(ownerId);
    const routing = await routingFor(new Types.ObjectId());

    await expect(routing.describe(reviewer, flags)).resolves.toEqual({});
    await expect(
      routing.place({
        agent: reviewer,
        flags,
        context: { executionId: 'run', hostArgs: { machine: 'danny-vm' } },
      }),
    ).rejects.toMatchObject({
      argument: 'machine',
      rejection: 'not_allowed',
    });
  });

  it('refuses a machine registered in another tenant', async () => {
    const ownerId = new Types.ObjectId();
    await tenantStorage.run({ tenantId: 'tenant-a' }, () => registerMachine(ownerId));

    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      const routing = await routingFor(ownerId);
      await expect(routing.describe(reviewer, flags)).resolves.toEqual({});
      await expect(
        routing.place({
          agent: reviewer,
          flags,
          context: { executionId: 'run', hostArgs: { workspace: 'agents' } },
        }),
      ).rejects.toMatchObject({
        argument: 'workspace',
        rejection: 'not_allowed',
      });
    });
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      const routing = await routingFor(ownerId);
      await expect(
        routing.place({
          agent: reviewer,
          flags,
          context: { executionId: 'run', hostArgs: { workspace: 'agents' } },
        }),
      ).resolves.toMatchObject({
        target: { environmentId: 'danny-vm' },
      });
    });
  });
});
