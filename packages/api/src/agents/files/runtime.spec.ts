jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  SUBAGENT_CONTEXT_VERSION: 1,
  Run: { create: jest.fn().mockResolvedValue({}) },
}));

import { z } from 'zod';
import { ImageDetail } from 'librechat-data-provider';
import { Run, InMemorySubagentTaskStore } from '@librechat/agents';
import { tool } from '@librechat/agents/langchain/tools';
import type { LCTool, SubagentExecutionContext } from '@librechat/agents';
import type { StructuredToolInterface } from '@librechat/agents/langchain/tools';
import type { RunFileSession } from './session';
import * as runtime from './runtime';
import { createRun } from '../run';

type RunAgent = Parameters<typeof createRun>[0]['agents'][number];

interface BuiltAgentInput {
  agentId: string;
  graphTools?: StructuredToolInterface[];
  tools?: StructuredToolInterface[];
  toolDefinitions?: Array<{ name: string }>;
  subagentConfigs?: Array<{
    agentInputs?: BuiltAgentInput;
    agents?: BuiltAgentInput[];
  }>;
}

function makeSession(active = true) {
  return {
    activate: jest.fn(() => active),
    isActive: () => active,
    prepare: jest.fn(async () => ({})),
    complete: jest.fn(
      async (_input: Parameters<RunFileSession['complete']>[0], result: { content: string }) =>
        result,
    ),
    list: jest.fn(async () => ({ files: [], artifacts: [] })),
    publish: jest.fn(async () => ({
      file_id: 'durable-file',
      filename: 'results.csv',
      user: 'owner',
      bytes: 1,
      embedded: false,
      filepath: '/files/results.csv',
      object: 'file' as const,
      type: 'text/csv',
      usage: 0,
    })),
    capture: jest.fn(async () => true),
    withCodeExecution: async (_agentId, _context, _signal, execute) => execute(),
    prepareTools: jest.fn(async () => undefined),
    actorFor: jest.fn((agentId: string) => ({ agentId, executionId: 'root-run' })),
    close: jest.fn(async () => undefined),
  } satisfies RunFileSession;
}

const identity: SubagentExecutionContext = {
  rootRunId: 'root-run',
  hookSessionId: 'root-run',
  depth: 1,
  ancestry: [
    {
      subagentRunId: 'child-execution',
      subagentType: 'worker',
      subagentKind: 'agent',
      subagentAgentId: 'worker',
      parentRunId: 'root-run',
      parentAgentId: 'parent',
      parentToolCallId: 'spawn-call',
    },
  ],
};

function agent(id: string, extra: Partial<RunAgent> = {}): RunAgent {
  return {
    id,
    name: id,
    description: null,
    avatar: null,
    created_at: 0,
    provider: 'openAI',
    endpoint: 'openAI',
    model: 'gpt-4o',
    model_parameters: {
      model: 'gpt-4o',
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
    tools: [],
    ...extra,
  };
}

function team(reader: RunAgent, writer: RunAgent): RunAgent {
  return agent('parent', {
    subagents: { enabled: true, allowSelf: false },
    subagentGraphConfigs: [
      {
        definition: {
          type: 'team',
          name: 'Team',
          description: 'Reader and writer',
          agent_ids: ['reader', 'writer'],
          edges: [],
          entry_agent_id: 'reader',
          result_agent_id: 'writer',
        },
        memberConfigs: [reader, writer],
      },
    ],
  });
}

async function create(
  session: RunFileSession,
  agents = [agent('parent')],
  options: Partial<Parameters<typeof createRun>[0]> = {},
) {
  await createRun({
    agents,
    runFiles: session,
    runId: 'root-run',
    conversationId: 'conversation',
    signal: new AbortController().signal,
    ...options,
  });
  return (Run.create as jest.Mock).mock.calls[0][0] as {
    subagentContext?: Pick<RunFileSession, 'prepare' | 'complete'>;
    subagentTasks?: Parameters<typeof createRun>[0]['subagentTasks'];
    graphConfig: {
      agents: BuiltAgentInput[];
    };
  };
}

describe('run file SDK bridge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('registers callable tools on parent and explicit children only for an active session', async () => {
    const session = makeSession();
    const config = await create(session, [
      agent('parent', {
        subagents: { enabled: true, allowSelf: false, agent_ids: ['worker'], shareFiles: true },
        subagentAgentConfigs: [agent('worker')],
      }),
    ]);
    expect(session.activate).toHaveBeenCalledWith(
      'root-run',
      'conversation',
      ['parent'],
      expect.any(AbortSignal),
    );
    expect(config.subagentContext).toEqual({
      prepare: session.prepare,
      complete: session.complete,
    });
    const parent = config.graphConfig.agents[0];
    const child = parent.subagentConfigs?.[0].agentInputs;
    for (const input of [parent, child]) {
      expect(input?.graphTools?.map((tool) => tool.name)).toEqual([
        'list_run_files',
        'publish_artifact',
      ]);
    }
    const signal = new AbortController().signal;
    await child!.graphTools![0].invoke({}, { metadata: { executionContext: identity }, signal });
    expect(session.list).toHaveBeenCalledWith('worker', identity, signal);
    const result = await child!.graphTools![1].invoke(
      { artifact_id: 'code-call:output', recipient_agent_ids: ['reviewer'] },
      { metadata: { executionContext: identity }, signal },
    );
    expect(session.publish).toHaveBeenCalledWith(
      'worker',
      identity,
      'code-call:output',
      ['reviewer'],
      signal,
    );
    expect(JSON.parse(result)).toEqual({ file_id: 'durable-file', filename: 'results.csv' });
  });

  it('keeps the adapter and tools absent when the opt-in is off', async () => {
    const config = await create(makeSession(false), [
      agent('parent', {
        subagents: { enabled: true, allowSelf: false, agent_ids: ['worker'] },
        subagentAgentConfigs: [agent('worker')],
      }),
    ]);
    expect(config.subagentContext).toBeUndefined();
    const parent = config.graphConfig.agents[0];
    expect(parent.graphTools).toBeUndefined();
    expect(parent.subagentConfigs?.[0].agentInputs?.graphTools).toBeUndefined();
  });

  it.each(['direct', 'handoff'] as const)(
    'distinguishes a nondelegating root %s member from its subagent instance',
    async (edgeType) => {
      const worker = agent('worker', { subagents: { enabled: false, shareFiles: true } });
      const config = await create(makeSession(), [
        agent('parent', {
          subagents: { enabled: true, allowSelf: false, agent_ids: ['worker'], shareFiles: true },
          subagentAgentConfigs: [worker],
          edges: [{ from: 'parent', to: 'worker', edgeType }],
        }),
        worker,
        agent('delegator', { subagents: { enabled: true, allowSelf: true } }),
      ]);
      const [parent, rootWorker, delegator] = config.graphConfig.agents;
      expect(rootWorker.agentId).toBe('worker');
      expect(rootWorker.graphTools).toBeUndefined();
      const childWorker = parent.subagentConfigs?.[0].agentInputs;
      expect(childWorker?.agentId).toBe(rootWorker.agentId);
      for (const input of [parent, delegator, childWorker]) {
        expect(input?.graphTools?.map((entry) => entry.name)).toEqual([
          'list_run_files',
          'publish_artifact',
        ]);
      }
    },
  );

  it('exposes tools to delegated team members without exposing them to their root instances', async () => {
    const reader = agent('reader');
    const writer = agent('writer', { subagents: { enabled: false } });
    const config = await create(makeSession(), [
      agent('parent', {
        subagents: { enabled: true, allowSelf: false, shareFiles: true },
        subagentGraphConfigs: [
          {
            definition: {
              type: 'team',
              name: 'Team',
              description: 'Reader and writer',
              agent_ids: ['reader', 'writer'],
              edges: [{ from: 'reader', to: 'writer', edgeType: 'direct' }],
              entry_agent_id: 'reader',
              result_agent_id: 'writer',
            },
            memberConfigs: [reader, writer],
          },
        ],
      }),
      reader,
      writer,
    ]);
    const [parent, rootReader, rootWriter] = config.graphConfig.agents;
    expect(rootReader.graphTools).toBeUndefined();
    expect(rootWriter.graphTools).toBeUndefined();
    const team = parent.subagentConfigs?.[0].agents;
    expect(team?.map((member) => member.agentId)).toEqual(['reader', 'writer']);
    for (const member of team ?? []) {
      expect(member.graphTools?.map((entry) => entry.name)).toEqual([
        'list_run_files',
        'publish_artifact',
      ]);
    }
  });

  it('keeps shared children foreground when the host supplies detached task support', async () => {
    const subagentTasks = { scopeId: 'owner:conversation', store: new InMemorySubagentTaskStore() };
    const config = await create(
      makeSession(),
      [agent('parent', { subagents: { enabled: true, allowSelf: true }, toolRegistry: new Map() })],
      { subagentTasks },
    );
    expect(config.subagentTasks).toBeUndefined();
    expect(
      config.graphConfig.agents[0].toolDefinitions?.map((definition) => definition.name),
    ).not.toContain('check_background_task');
    expect(config.graphConfig.agents[0].subagentConfigs).toHaveLength(1);
  });

  it('routes named tool implementations through host preparation and capture', async () => {
    const direct = tool(async () => '', {
      name: 'execute_code',
      description: 'Execute code',
      schema: z.object({}),
    });
    const invoke = jest.spyOn(direct, 'invoke');
    const definition: LCTool = {
      name: 'execute_code',
      description: 'Execute code',
      parameters: { type: 'object', properties: {} },
    };
    const original = agent('parent', {
      tools: [direct],
      toolDefinitions: [definition],
      subagents: { enabled: true, allowSelf: false, agent_ids: ['worker'] },
      subagentAgentConfigs: [agent('worker', { tools: [direct], toolDefinitions: [definition] })],
    });
    const config = await create(makeSession(), [original]);
    const parent = config.graphConfig.agents[0];
    for (const input of [parent, parent.subagentConfigs?.[0].agentInputs]) {
      expect(input?.tools).toEqual([]);
      expect(input?.toolDefinitions).toContainEqual(definition);
    }
    expect(original.tools).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects direct tools without a host execution definition', async () => {
    const direct = tool(async () => '', {
      name: 'execute_code',
      description: 'Execute',
      schema: z.object({}),
    });
    await expect(create(makeSession(), [agent('parent', { tools: [direct] })])).rejects.toThrow(
      'host-dispatched tools',
    );
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('rejects sharing before constructing an SDK run without execution identity support', async () => {
    jest.spyOn(runtime, 'isRunFileSharingSupported').mockReturnValue(false);
    await expect(create(makeSession())).rejects.toThrow('subagent context support');
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('rejects alternate ingresses that enable sharing without a file host', async () => {
    await expect(
      createRun({
        agents: [
          agent('parent', {
            subagents: { enabled: true, shareFiles: true },
          }),
        ],
        appConfig: {
          endpoints: { agents: { fileSharing: { enabled: true } } },
        } as Parameters<typeof createRun>[0]['appConfig'],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('a file host is required');
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('preserves a saved sharing preference without activating it when subagents are disabled', async () => {
    const config = await create(
      makeSession(false),
      [agent('parent', { subagents: { enabled: false, shareFiles: true } })],
      {
        runFiles: undefined,
        appConfig: {
          endpoints: { agents: { fileSharing: { enabled: true } } },
        } as Parameters<typeof createRun>[0]['appConfig'],
      },
    );
    expect(config.subagentContext).toBeUndefined();
    expect(config.graphConfig.agents[0].graphTools).toBeUndefined();
  });

  it.each([
    agent('writer', { provider: 'anthropic' }),
    agent('writer', { endpoint: 'restricted-endpoint' }),
    agent('writer', { imageDetail: ImageDetail.high }),
    agent('writer', { imageDetail: ImageDetail.low }),
    agent('writer', { imageDetail: ImageDetail.auto }),
    agent('writer', {
      model_parameters: { ...agent('reader').model_parameters, model: 'claude-sonnet' },
    }),
    agent('writer', {
      model_parameters: { ...agent('reader').model_parameters, useResponsesApi: true },
    }),
  ])(
    'rejects incompatible team document formats before injecting shared files (%j)',
    async (writer) => {
      await expect(create(makeSession(), [team(agent('reader'), writer)])).rejects.toThrow(
        'same provider',
      );
      expect(Run.create).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, ImageDetail.auto, ImageDetail.low, ImageDetail.high])(
    'accepts matching team image-detail settings (%s)',
    async (imageDetail) => {
      const config = await create(makeSession(), [
        team(agent('reader', { imageDetail }), agent('writer', { imageDetail })),
      ]);
      expect(config.graphConfig.agents[0].subagentConfigs?.[0].agents).toHaveLength(2);
    },
  );
});
