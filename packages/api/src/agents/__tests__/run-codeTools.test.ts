import { FileContext } from 'librechat-data-provider';
import type { AgentInputs, SubagentTaskConfig, SubagentResolveContext } from '@librechat/agents';
import type { TFile } from 'librechat-data-provider';
import type { HostSubagentTaskConfig } from '~/agents/subagentDelivery';
import type { ProvisionToolContext } from '~/files/provision/callback';
import type { ServerRequest } from '~/types';
import { createProvisionFilesCallback } from '~/files/provision/callback';
import { SUBAGENT_COMPLETION_DELIVERY } from '~/agents/subagentDelivery';
import { mergeCodeFilesIntoContext } from '~/agents/codeFilesSession';
import { CHECK_BACKGROUND_TASK_NAME } from '~/agents/background';
import { createRun } from '~/agents/run';

/**
 * Guards the code-tool eager/session wiring in `createRun`. The whole
 * create_file -> bash_tool sandbox-sharing chain depends on run.ts passing
 * `codeSessionToolNames` (so file-authoring tools share the code session) and
 * `excludeToolNames` (so side-effecting/large-arg tools aren't eager-executed).
 * These were silently missing before and only surfaced with both the
 * file-authoring and code-execution capabilities enabled — assert they're wired
 * so a future edit can't drop them without failing CI.
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

jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    ...actual,
    Run: {
      create: jest.fn().mockResolvedValue({
        processStream: jest.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

jest.mock('~/agents/checkpointer', () => ({
  getAgentCheckpointer: jest.fn().mockResolvedValue({}),
}));

import { HookRegistry, InMemorySubagentTaskStore, Run } from '@librechat/agents';

function makeAgent(overrides?: Record<string, unknown>) {
  return {
    id: 'agent_1',
    provider: 'openAI',
    endpoint: 'openAI',
    model: 'gpt-4o',
    tools: [],
    model_parameters: { model: 'gpt-4o' },
    maxContextTokens: 100_000,
    toolContextMap: {},
    ...overrides,
  };
}

async function captureRunConfig(
  agent = makeAgent(),
  subagentTasks?: SubagentTaskConfig,
): Promise<Record<string, unknown>> {
  return captureAgentsRunConfig([agent], subagentTasks);
}

async function captureAgentsRunConfig(
  agents: Array<ReturnType<typeof makeAgent>>,
  subagentTasks?: SubagentTaskConfig,
): Promise<Record<string, unknown>> {
  await createRun({
    agents: agents as never,
    signal: new AbortController().signal,
    streaming: true,
    streamUsage: true,
    subagentTasks,
  });
  const createMock = Run.create as jest.Mock;
  expect(createMock).toHaveBeenCalledTimes(1);
  return createMock.mock.calls[0][0] as Record<string, unknown>;
}

describe('createRun code-tool eager/session wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  it('includes queued paths in model instructions and reserves live paths across agents', async () => {
    const file: TFile = {
      file_id: 'uploaded',
      filename: 'data.csv',
      filepath: '/uploads/data.csv',
      type: 'text/csv',
      user: 'user-1',
      object: 'file',
      bytes: 10,
      embedded: false,
      usage: 0,
      context: FileContext.message_attachment,
    };
    const agents = ['a', 'b'].map((id) =>
      makeAgent({
        id,
        fileConsumers: { executeCode: true, fileSearch: false },
        provisionState: {
          codeEnvFiles: [{ ...file }],
          vectorDBFiles: [],
          aliveFileIds: new Set(),
          agentScopedFileIds: new Set(),
        },
        dynamicToolContextMap: { execute_code: 'Previously primed file context' },
        additional_instructions: 'Agent instructions',
        tool_resources:
          id === 'a' ? { execute_code: { files: [{ ...file, file_id: 'existing' }] } } : undefined,
      }),
    );
    const config = await captureAgentsRunConfig(agents);
    const inputs = (config.graphConfig as { agents: Array<{ additional_instructions: string }> })
      .agents;
    const paths = inputs.map(
      (input) => input.additional_instructions.match(/\/mnt\/data\/\S+/)?.[0],
    );

    expect(paths[0]).toBeDefined();
    expect(paths[0]).not.toBe('/mnt/data/data.csv');
    expect(paths[1]).toBe(paths[0]);
    for (const input of inputs) {
      expect(input.additional_instructions).toContain('Previously primed file context');
      expect(input.additional_instructions).toContain('Agent instructions');
      expect(input.additional_instructions).toContain('read or edit');
      expect(input.additional_instructions).not.toContain(file.filepath);
    }
  });

  it('preserves parent paths when a lazy child has independently planned colliding files', async () => {
    const shared: TFile = {
      file_id: 'shared',
      filename: 'data.csv',
      filepath: '/uploads/data.csv',
      type: 'text/csv',
      user: 'user-1',
      object: 'file',
      bytes: 10,
      embedded: false,
      usage: 0,
      context: FileContext.message_attachment,
      createdAt: '2026-09-01',
    };
    const child = makeAgent({
      id: 'child',
      fileConsumers: { executeCode: true, fileSearch: false },
      provisionState: {
        codeEnvFiles: [{ ...shared }, { ...shared, file_id: 'new', createdAt: '2026-10-01' }],
        vectorDBFiles: [],
        aliveFileIds: new Set(),
        agentScopedFileIds: new Set(),
        codeEnvDestinations: new Map([
          ['shared', 'draft-alias.csv'],
          ['new', 'data.csv'],
        ]),
      },
    });
    const resolve = jest.fn().mockResolvedValue(child);
    const config = await captureRunConfig(
      makeAgent({
        fileConsumers: { executeCode: true, fileSearch: false },
        provisionState: {
          codeEnvFiles: [{ ...shared }],
          vectorDBFiles: [],
          aliveFileIds: new Set(),
          agentScopedFileIds: new Set(),
        },
        subagents: { enabled: true, allowSelf: false, agent_ids: ['child'] },
        lazySubagentConfigs: [{ id: 'child', configId: 'child:1', resolve }],
      }),
    );
    const [parentInput] = (config.graphConfig as { agents: AgentInputs[] }).agents;
    expect(parentInput.additional_instructions).toContain('/mnt/data/data.csv');
    expect(resolve).not.toHaveBeenCalled();
    const lazyConfig = parentInput.subagentConfigs?.[0];
    const resolveInputs = lazyConfig?.resolveAgentInputs;
    if (!resolveInputs) throw new Error('Missing lazy subagent resolver');
    const childInput = await resolveInputs({
      signal: new AbortController().signal,
    } as SubagentResolveContext);
    expect(childInput.additional_instructions).toContain('/mnt/data/data.csv');
    expect(childInput.additional_instructions).not.toContain('draft-alias.csv');
    expect(childInput.additional_instructions?.match(/\/mnt\/data\/data\.csv/g)).toHaveLength(1);
  });

  it.each([false, true])(
    'reconciles a lazy child’s live setup file, parent already provisioned=%s',
    async (parentProvisioned) => {
      const shared: TFile = {
        file_id: 'shared',
        filename: 'data.csv',
        filepath: '/uploads/data.csv',
        type: 'text/csv',
        user: 'user-1',
        object: 'file',
        bytes: 10,
        embedded: false,
        usage: 0,
        context: FileContext.message_attachment,
      };
      const live = {
        id: 'setup-remote',
        name: 'data.csv',
        storage_session_id: 'setup-store',
        resource_id: 'child',
        kind: 'agent' as const,
      };
      const child = {
        ...makeAgent({
          id: 'child',
          primedCodeFiles: [live],
          fileConsumers: { executeCode: true, fileSearch: false },
          tool_resources: { execute_code: { files: [{ ...shared, file_id: 'setup' }] } },
        }),
        provisionState: {
          codeEnvFiles: [{ ...shared }],
          vectorDBFiles: [],
          aliveFileIds: new Set(['setup']),
          agentScopedFileIds: new Set(['setup']),
          codeEnvDestinations: new Map([['shared', 'safe-child-alias.csv']]),
        },
      };
      const resolve = jest.fn().mockResolvedValue(child);
      const provisionState = {
        codeEnvFiles: [{ ...shared }],
        vectorDBFiles: [],
        aliveFileIds: new Set(),
        agentScopedFileIds: new Set(),
      };
      const toolResources = { execute_code: { files: [] as TFile[] } };
      const config = await captureRunConfig(
        makeAgent({
          fileConsumers: { executeCode: true, fileSearch: false },
          provisionState,
          tool_resources: toolResources,
          subagents: { enabled: true, allowSelf: false, agent_ids: ['child'] },
          lazySubagentConfigs: [{ id: 'child', configId: 'child:1', resolve }],
        }),
      );
      const [parentInput] = (config.graphConfig as { agents: AgentInputs[] }).agents;
      expect(parentInput.additional_instructions).toContain('/mnt/data/data.csv');
      expect(resolve).not.toHaveBeenCalled();
      if (parentProvisioned) {
        provisionState.codeEnvFiles = [];
        toolResources.execute_code.files.push({ ...shared });
      }
      const resolveInputs = parentInput.subagentConfigs?.[0].resolveAgentInputs;
      if (!resolveInputs) throw new Error('Missing lazy subagent resolver');
      const childInput = await resolveInputs({
        signal: new AbortController().signal,
      } as SubagentResolveContext);
      const childPath = child.provisionState?.codeEnvDestinations?.get(shared.file_id);
      expect(childPath).toBeDefined();
      expect(childPath).not.toBe('data.csv');
      expect(childInput.additional_instructions).toContain(`/mnt/data/${childPath}`);
      expect(parentInput.additional_instructions).toContain('/mnt/data/data.csv');
      expect(childInput.initialSessions?.get('execute_code')?.files).toEqual([live]);
    },
  );

  it.each(
    [
      ['data.csv', 'data.csv'],
      ['data', 'data/input.csv'],
      ['data/input.csv', 'data'],
    ].flatMap(([parentName, childName]) =>
      ['sequential', 'parallel'].map((mode) => ({ parentName, childName, mode })),
    ),
  )(
    'reconciles repeated $mode lazy instances against $parentName while uploading $childName',
    async ({ mode, parentName, childName }) => {
      const parentFile: TFile = {
        file_id: 'parent-file',
        filename: parentName,
        filepath: '/uploads/data.csv',
        type: 'text/csv',
        user: 'user-1',
        object: 'file',
        bytes: 10,
        embedded: false,
        usage: 0,
        context: FileContext.message_attachment,
      };
      const childFile = {
        ...parentFile,
        file_id: 'child-file',
        filename: childName,
        context: FileContext.agents,
      };
      const makeChild = () => ({
        ...makeAgent({ id: 'child' }),
        fileConsumers: { executeCode: true, fileSearch: false },
        dynamicToolContextMap: {},
        provisionState: {
          codeEnvFiles: [{ ...childFile }],
          vectorDBFiles: [],
          aliveFileIds: new Set<string>(),
          agentScopedFileIds: new Set([childFile.file_id]),
          codeEnvDestinations: new Map([[childFile.file_id, childFile.filename]]),
        },
      });
      const children = [makeChild(), makeChild()];
      const resolve = jest
        .fn()
        .mockResolvedValueOnce(children[0])
        .mockResolvedValueOnce(children[1]);
      const parent = {
        ...makeAgent(),
        tool_resources: { execute_code: { files: [parentFile] } },
        subagents: { enabled: true, allowSelf: false, agent_ids: ['child'] },
        lazySubagentConfigs: [{ id: 'child', configId: 'child:1', resolve }],
      };
      const config = await captureRunConfig(parent);
      const [parentInput] = (config.graphConfig as { agents: AgentInputs[] }).agents;
      const resolveInputs = parentInput.subagentConfigs?.[0].resolveAgentInputs;
      if (!resolveInputs) throw new Error('Missing lazy subagent resolver');
      const resolutionContext = {
        signal: new AbortController().signal,
      } as SubagentResolveContext;
      const inputs =
        mode === 'parallel'
          ? await Promise.all(children.map(() => resolveInputs(resolutionContext)))
          : [await resolveInputs(resolutionContext), await resolveInputs(resolutionContext)];
      const names = children.map((child) =>
        child.provisionState.codeEnvDestinations.get(childFile.file_id),
      );
      for (let index = 0; index < children.length; index++) {
        expect(names[index]).toBeDefined();
        expect(names[index]).not.toBe(childFile.filename);
        expect(inputs[index].additional_instructions).toContain(`/mnt/data/${names[index]}`);
      }
      expect(names[1]).toBe(names[0]);
      expect(children[0].provisionState.codeEnvDestinations).not.toBe(
        children[1].provisionState.codeEnvDestinations,
      );

      const contexts = new Map<string, ProvisionToolContext>([[parent.id, parent]]);
      const provisionToCodeEnv = jest.fn(
        async ({ file, sandboxFilename }: { file: TFile; sandboxFilename?: string }) => {
          const ref = {
            kind: 'agent' as const,
            id: 'child',
            storage_session_id: 'child-store',
            file_id: file.file_id,
            sandboxFilename,
          };
          return {
            referenceSet: { codeEnvRefs: { default: ref } },
            refUpdate: { file_id: file.file_id, routeKey: 'default', ref },
            sandboxFilename: sandboxFilename ?? file.filename,
          };
        },
      );
      const provision = createProvisionFilesCallback({
        req: { user: { id: 'user-1' } } as ServerRequest,
        agentToolContexts: contexts,
        provisionToCodeEnv,
        provisionToVectorDB: jest.fn(),
        updateFile: jest.fn(),
        updateCodeEnvRef: jest.fn(),
        addEmbeddedEntity: jest.fn(),
      });
      for (const child of children) {
        contexts.set(child.id, child);
        const refs = await provision(['execute_code'], child.id);
        const merged = mergeCodeFilesIntoContext(
          {
            session_id: 'parent-store',
            files: [
              {
                id: parentFile.file_id,
                storage_session_id: 'parent-store',
                name: parentFile.filename,
                resource_id: 'user-1',
                kind: 'user',
              },
            ],
          },
          refs,
        );
        expect(merged?.files.map((file) => file.name)).toEqual([parentFile.filename, names[0]]);
      }
      expect(provisionToCodeEnv).toHaveBeenCalledTimes(1);
      const earlierPlan = children[0].provisionState.codeEnvDestinations;
      resolve.mockResolvedValueOnce(children[0]);
      await resolveInputs(resolutionContext);
      expect(children[0].provisionState.codeEnvDestinations).toBe(earlierPlan);
    },
  );

  it('excludes side-effecting/large-arg tools from eager execution', async () => {
    const runConfig = await captureRunConfig();
    const eager = runConfig.eagerEventToolExecution as {
      enabled?: boolean;
      excludeToolNames?: string[];
    };
    expect(eager.enabled).toBe(true);
    expect(eager.excludeToolNames).toEqual(
      expect.arrayContaining(['create_file', 'edit_file', 'execute_code', 'bash_tool']),
    );
  });

  it('declares create_file/edit_file/read_file as code-session participants', async () => {
    const runConfig = await captureRunConfig();
    expect(runConfig.codeSessionToolNames).toEqual(
      expect.arrayContaining(['create_file', 'edit_file', 'read_file']),
    );
  });

  it('passes the trusted per-agent code-session partition to the SDK', async () => {
    const codeSessionKey = 'execute_code:stateful:v1:user';
    const runConfig = await captureRunConfig(makeAgent({ codeSessionKey }));
    const [agentInput] = (runConfig.graphConfig as { agents: Array<Record<string, unknown>> })
      .agents;
    expect(agentInput.codeSessionKey).toBe(codeSessionKey);
  });

  it('registers detached task controls only on a spawn-capable parent', async () => {
    const subagentTasks: SubagentTaskConfig = {
      store: new InMemorySubagentTaskStore(),
      scopeId: 'owner:parent-thread',
    };
    const runConfig = await captureRunConfig(
      makeAgent({
        subagents: { enabled: true, allowSelf: true },
        toolDefinitions: [],
        toolRegistry: new Map(),
      }),
      subagentTasks,
    );
    const [agentInput] = (runConfig.graphConfig as { agents: Array<Record<string, unknown>> })
      .agents;
    const parentDefinitions = agentInput.toolDefinitions as Array<{ name: string }>;
    const [selfConfig] = agentInput.subagentConfigs as Array<{
      agentInputs?: {
        toolDefinitions?: Array<{ name: string }>;
        toolRegistry?: Map<string, unknown>;
      };
    }>;

    expect(runConfig.subagentTasks).toBe(subagentTasks);
    expect(parentDefinitions.map((definition) => definition.name)).toContain(
      CHECK_BACKGROUND_TASK_NAME,
    );
    expect(
      selfConfig.agentInputs?.toolDefinitions?.map((definition) => definition.name),
    ).not.toContain(CHECK_BACKGROUND_TASK_NAME);
    expect(selfConfig.agentInputs?.toolRegistry?.has(CHECK_BACKGROUND_TASK_NAME)).toBe(false);
  });

  it('registers wakeup-aware schema and handle guidance for automatic subagent delivery', async () => {
    const subagentTasks: HostSubagentTaskConfig = {
      store: new InMemorySubagentTaskStore(),
      scopeId: 'owner:wakeup-parent',
      completionDelivery: SUBAGENT_COMPLETION_DELIVERY,
    };
    const runConfig = await captureRunConfig(
      makeAgent({
        subagents: { enabled: true, allowSelf: true },
        toolDefinitions: [],
        toolRegistry: new Map(),
      }),
      subagentTasks,
    );
    const [agentInput] = (runConfig.graphConfig as { agents: Array<Record<string, unknown>> })
      .agents;
    const poll = (agentInput.toolDefinitions as Array<{ name: string; description: string }>).find(
      (definition) => definition.name === CHECK_BACKGROUND_TASK_NAME,
    );
    expect(poll?.description).toContain('automatic completion delivery');

    const hooks = runConfig.hooks as HookRegistry;
    const [matcher] = hooks.getMatchers('PostToolUse');
    expect(matcher.pattern).toBe('subagent');
    const result = await matcher.hooks[0](
      {
        hook_event_name: 'PostToolUse',
        runId: 'run-1',
        toolName: 'subagent',
        toolInput: {},
        toolOutput: JSON.stringify({ background_task_id: 'task-1', status: 'running' }),
        toolUseId: 'call-1',
        executingAgentId: 'agent_1',
      },
      new AbortController().signal,
    );
    expect(JSON.parse(result.updatedOutput as string).message).toContain(
      'the host will resume you',
    );
  });

  it('keeps wakeup guidance off an ephemeral spawning agent in a shared run', async () => {
    const subagentTasks: HostSubagentTaskConfig = {
      store: new InMemorySubagentTaskStore(),
      scopeId: 'owner:mixed-parent-run',
      completionDelivery: SUBAGENT_COMPLETION_DELIVERY,
    };
    const spawningAgent = {
      subagents: { enabled: true, allowSelf: true },
      toolDefinitions: [],
      toolRegistry: new Map(),
    };
    const runConfig = await captureAgentsRunConfig(
      [
        makeAgent({ ...spawningAgent, id: 'agent_durable' }),
        makeAgent({ ...spawningAgent, id: 'openAI__gpt-4o' }),
      ],
      subagentTasks,
    );
    const [durableInput, ephemeralInput] = (
      runConfig.graphConfig as { agents: Array<Record<string, unknown>> }
    ).agents;
    const pollDescription = (input: Record<string, unknown>) =>
      (input.toolDefinitions as Array<{ name: string; description: string }>).find(
        (definition) => definition.name === CHECK_BACKGROUND_TASK_NAME,
      )?.description;

    expect(pollDescription(durableInput)).toContain('automatic completion delivery');
    expect(pollDescription(ephemeralInput)).not.toContain('automatic completion delivery');

    const hooks = runConfig.hooks as HookRegistry;
    const [matcher] = hooks.getMatchers('PostToolUse');
    const hookInput = {
      hook_event_name: 'PostToolUse' as const,
      runId: 'run-1',
      toolName: 'subagent',
      toolInput: {},
      toolOutput: JSON.stringify({ background_task_id: 'task-1', status: 'running' }),
      toolUseId: 'call-1',
    };
    await expect(
      matcher.hooks[0](
        { ...hookInput, executingAgentId: 'openAI__gpt-4o' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({});
    await expect(
      matcher.hooks[0](
        { ...hookInput, executingAgentId: 'agent_durable' },
        new AbortController().signal,
      ),
    ).resolves.toEqual(expect.objectContaining({ updatedOutput: expect.any(String) }));
  });
});
