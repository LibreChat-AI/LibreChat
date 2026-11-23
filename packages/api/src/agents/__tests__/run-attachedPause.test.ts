import { z } from 'zod';
import { tool } from '@librechat/agents/langchain/tools';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { Run, Constants, Providers, FakeChatModel, executeHooks } from '@librechat/agents';
import type { AgentInputs, HookRegistry, SubagentResolveContext } from '@librechat/agents';
import {
  collectAttachedCodeEnvironmentPolicySettings,
  buildAttachedCodeEnvironmentAdmissionHooks,
  collectAttachedCodeEnvironmentAgentIds,
  collectAttachedCodeRoutePolicies,
} from '~/agents/hitl/byom';
import { canAgentGraphPause, resolveScheduledPause } from '~/agents/hitl/admission';
import { resolveToolApprovalPolicy } from '~/agents/hitl/policy';
import { createRun } from '~/agents/run';

/**
 * A scheduled run that could pause, on a deployment that cannot hold a pause, for an agent
 * whose code runs on a machine its owner attached. Admission, the fallback and graph
 * construction are the real functions; only the SDK's `Run.create` is observed.
 */

jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: { Console: jest.fn(), DailyRotateFile: jest.fn(), File: jest.fn() },
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('~/agents/checkpointer', () => ({
  getAgentCheckpointer: jest.fn().mockResolvedValue({}),
}));

type Decision = 'allow' | 'ask' | 'deny';
type RunConfig = Record<string, unknown> & { hooks: HookRegistry };

const attachedOn = (environmentId: string, commandExecution: Decision) => ({
  environmentType: 'attached',
  environmentId,
  codeEnvironmentConfigSchema: {
    permissions: { commandExecution: { allowed: ['allow', 'ask', 'deny'], default: 'ask' } },
  },
  codeEnvironmentSettings: { permissions: { commandExecution } },
});

const bash = { name: Constants.BASH_TOOL, toolType: 'builtin' };

function makeAgent(overrides?: Record<string, unknown>) {
  return {
    id: 'agent_1',
    provider: 'openAI',
    endpoint: 'openAI',
    model: 'gpt-4o',
    tools: [] as string[],
    model_parameters: { model: 'gpt-4o' },
    maxContextTokens: 100_000,
    toolContextMap: {},
    toolDefinitions: [bash],
    ...overrides,
  };
}

/** What the chat controller resolves before it builds a scheduled run. */
async function scheduledPause(
  agents: ReturnType<typeof makeAgent>[],
  toolApproval?: { enabled?: boolean },
) {
  const ids = collectAttachedCodeEnvironmentAgentIds(agents);
  const canPause = canAgentGraphPause({
    policy: resolveToolApprovalPolicy({
      endpoint: toolApproval as never,
      attachedCodeEnvironment: ids.size > 0,
    }),
    agents: agents as never,
    resolvedProgrammaticHooks: buildAttachedCodeEnvironmentAdmissionHooks(
      ids,
      collectAttachedCodeEnvironmentPolicySettings(agents),
      undefined,
      collectAttachedCodeRoutePolicies(agents),
    ),
  });
  const pause = await resolveScheduledPause({
    scheduled: true,
    canPause,
    sharedStore: false,
    getCheckpointer: async () => ({}),
    conversationId: 'convo-1',
  });
  return { canPause, pause };
}

function build(
  agents: ReturnType<typeof makeAgent>[],
  options: Record<string, unknown>,
): Promise<unknown> {
  return createRun({
    agents: agents as never,
    signal: new AbortController().signal,
    streaming: true,
    streamUsage: true,
    ...options,
  } as never);
}

function decide(config: RunConfig, executingAgentId = 'agent_1') {
  return executeHooks({
    registry: config.hooks,
    input: {
      hook_event_name: 'PreToolUse',
      runId: 'run-1',
      toolName: Constants.BASH_TOOL,
      toolInput: { command: 'touch out.txt' },
      toolUseId: 'call-1',
      executingAgentId,
    },
    matchQuery: Constants.BASH_TOOL,
  });
}

/** Runs one scripted shell call through the SDK under the hooks a built run was given. */
async function execute(config: RunConfig): Promise<{ executions: number; output: string }> {
  let executions = 0;
  const shell = tool(
    async () => {
      executions++;
      return 'ran';
    },
    {
      name: Constants.BASH_TOOL,
      description: 'Runs a shell command',
      schema: z.object({ command: z.string() }),
    },
  );
  const llmConfig = {
    provider: Providers.OPENAI,
    model: 'gpt-4o-mini',
    apiKey: 'test-placeholder',
    streaming: true,
    streamUsage: false,
  };
  const run = await Run.create({
    runId: 'run-attached',
    graphConfig: {
      type: 'standard',
      llmConfig,
      agents: [
        {
          agentId: 'agent_1',
          provider: Providers.OPENAI,
          endpoint: Providers.OPENAI,
          clientOptions: llmConfig,
          instructions: 'Use the shell.',
          tools: [shell],
        },
      ],
    },
    returnContent: true,
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    humanInTheLoop: config.humanInTheLoop as never,
    hooks: config.hooks,
  });
  if (!run.Graph) throw new Error('The test run did not initialize its graph.');
  run.Graph.overrideModel = new FakeChatModel({
    responses: ['Done.'],
    toolCalls: [
      {
        name: Constants.BASH_TOOL,
        args: { command: 'touch out.txt' },
        id: 'call-1',
        type: 'tool_call',
      },
    ],
  });
  const stream = {
    configurable: { thread_id: 'convo-1' },
    streamMode: 'values' as const,
    version: 'v2' as const,
  };
  await run.processStream({ messages: [new HumanMessage('run')] }, stream);
  expect(run.getInterrupt()).toBeUndefined();
  return {
    executions,
    output: JSON.stringify((run.getRunMessages() ?? []).map((message) => message.content)),
  };
}

describe('a scheduled run on an attached machine where no pause can be held', () => {
  let create: jest.SpyInstance;
  const captured = () => create.mock.calls[0][0] as RunConfig;
  const fallback = async (
    agents: ReturnType<typeof makeAgent>[],
    options: Record<string, unknown> = {},
  ) => {
    const { pause } = await scheduledPause(agents);
    await build(agents, { hitlCapable: pause.capable, pauseGap: pause.missing, ...options });
    return captured();
  };

  beforeEach(() => {
    create = jest
      .spyOn(Run, 'create')
      .mockResolvedValue({ processStream: jest.fn().mockResolvedValue(undefined) } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('could pause, and cannot here', async () => {
    const { canPause, pause } = await scheduledPause([
      makeAgent({ codeExecutionContext: attachedOn('laptop', 'ask') }),
    ]);

    expect(canPause).toBe(true);
    expect(pause).toEqual({ capable: false, prunes: true, missing: 'shared_store' });
  });

  it('starts, and refuses the call that needs approval', async () => {
    const config = await fallback([
      makeAgent({ codeExecutionContext: attachedOn('laptop', 'ask') }),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(config.humanInTheLoop).toBeUndefined();
    const verdict = await decide(config);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('needs approval');
  });

  it('never runs the body of a call the machine asks about', async () => {
    const config = await fallback([
      makeAgent({ codeExecutionContext: attachedOn('laptop', 'ask') }),
    ]);
    create.mockRestore();

    const { executions, output } = await execute(config);

    expect(executions).toBe(0);
    expect(output).toContain('needs approval, and this run cannot wait for one');
  });

  it('runs a call the machine permits without asking, as a run that can pause does', async () => {
    const agents = [makeAgent({ codeExecutionContext: attachedOn('laptop', 'allow') })];
    /** Alone, a machine that never asks cannot pause; the ask-user tool is what makes this
     *  run one that could. */
    const asking = [{ ...agents[0], tools: ['ask_user_question'] }];
    expect((await scheduledPause(asking)).pause.capable).toBe(false);
    const config = await fallback(asking);
    create.mockRestore();

    const { executions } = await execute(config);

    expect(executions).toBe(1);
  });

  it.each([
    ['allow', 'allow', 'allow'],
    ['ask', 'ask', 'deny'],
    ['deny', 'deny', 'deny'],
  ] as const)(
    'holds a machine set to %s to its own policy: %s where a pause can be held, %s where not',
    async (machine, attended, unattended) => {
      const agents = [
        makeAgent({
          codeExecutionContext: attachedOn('laptop', machine),
          tools: ['ask_user_question'],
        }),
      ];

      await build(agents, { hitlCapable: true });
      expect((await decide(captured())).decision).toBe(attended);
      create.mockClear();

      expect((await decide(await fallback(agents))).decision).toBe(unattended);
    },
  );

  it('refuses a skill file edit the machine would otherwise allow', async () => {
    const config = await fallback([
      makeAgent({
        codeExecutionContext: {
          ...attachedOn('laptop', 'ask'),
          codeEnvironmentConfigSchema: {
            permissions: {
              commandExecution: { allowed: ['allow', 'ask', 'deny'], default: 'ask' },
              fileWrite: { allowed: ['allow', 'ask', 'deny'], default: 'allow' },
            },
          },
        },
        skillAuthoringAvailable: true,
      }),
    ]);

    const verdict = await executeHooks({
      registry: config.hooks,
      input: {
        hook_event_name: 'PreToolUse',
        runId: 'run-1',
        toolName: 'edit_file',
        toolInput: { path: 'skills/notes/SKILL.md' },
        toolUseId: 'call-1',
        executingAgentId: 'agent_1',
      },
      matchQuery: 'edit_file',
    });

    expect(verdict.decision).toBe('deny');
  });

  it('covers a child that is routed to an attached machine only when it is called', async () => {
    const resolve = jest
      .fn()
      .mockResolvedValue(
        makeAgent({ id: 'child', codeExecutionContext: attachedOn('buildbox', 'ask') }),
      );
    const agents = [
      makeAgent({
        tools: ['ask_user_question'],
        subagents: { enabled: true, allowSelf: false, agent_ids: ['child'] },
        lazySubagentConfigs: [
          {
            id: 'child',
            configId: 'child:1',
            resolve,
            codeExecutionChoices: [{ ...attachedOn('buildbox', 'ask'), statefulSessions: true }],
          },
        ],
      }),
    ];

    const config = await fallback(agents);
    expect((await decide(config, 'child')).decision).toBe('deny');

    const [parent] = (config.graphConfig as { agents: AgentInputs[] }).agents;
    const resolveInputs = parent.subagentConfigs?.[0].resolveAgentInputs;
    if (!resolveInputs) throw new Error('Missing lazy subagent resolver');
    await resolveInputs({ signal: new AbortController().signal } as SubagentResolveContext);

    expect((await decide(config, 'child')).decision).toBe('deny');
  });

  it('still refuses any other caller that has no way to resume', async () => {
    const agents = [makeAgent({ codeExecutionContext: attachedOn('laptop', 'ask') })];

    await expect(build(agents, { hitlCapable: false })).rejects.toMatchObject({
      code: 'BYOM_TOOL_APPROVAL_UNSUPPORTED',
    });
    await expect(build(agents, {})).rejects.toMatchObject({
      code: 'BYOM_TOOL_APPROVAL_UNSUPPORTED',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('installs no machine policy where the administrator turned approval off, as before', async () => {
    const agents = [makeAgent({ codeExecutionContext: attachedOn('laptop', 'ask') })];
    const appConfig = { endpoints: { agents: { toolApproval: { enabled: false } } } };

    await build(agents, { hitlCapable: false, appConfig });
    expect((await decide(captured())).decision).toBeUndefined();
    create.mockClear();

    await build(agents, { hitlCapable: false, pauseGap: 'shared_store', appConfig });
    expect((await decide(captured())).decision).toBeUndefined();
  });
});
