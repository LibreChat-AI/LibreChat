import { encryptV3, logger } from '@librechat/data-schemas';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import {
  EModelEndpoint,
  FileSources,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_RUN_CONFIGS,
} from 'librechat-data-provider';
import type { CompactionSemanticIndex, SubagentTaskConfig, AgentInputs } from '@librechat/agents';
import type { SummarizationConfig, TEndpoint } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { BaseMessage } from '@langchain/core/messages';
import type { OpenAI } from 'openai';
import type { ModelBoundChatModelCallback } from '~/middleware/modelBoundContent';
import type { OpenAIConfiguration, AzureOptions } from '~/types';
import { createRun, isAskUserQuestionAdminDisabled } from '~/agents/run';
import { initializeOpenAI } from '~/endpoints/openai/initialize';
import { getOpenAIConfig } from '~/endpoints/openai/config';

// Mock winston logger — `format` must be callable so @librechat/data-schemas
// dist module-load completes cleanly; see api/test/__mocks__/logger.js.
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
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
    File: jest.fn(),
  },
}));

/** Spy on the real `resolveHeaders` instead of replacing it — the templated-header
 *  case below only proves anything if the actual substitution runs. */
jest.mock('~/utils/env', () => {
  const actual = jest.requireActual<typeof import('~/utils/env')>('~/utils/env');
  return { ...actual, resolveHeaders: jest.fn(actual.resolveHeaders) };
});

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  decryptV3: jest.fn((value: string) => {
    if (value === 'v3:test:sk-tenant-1') {
      return 'sk-tenant-1';
    }
    throw new Error('bad decrypt');
  }),
  encryptV3: jest.fn((value: string) => `v3:test:${value}`),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

// Mock Run.create to capture the graphConfig it receives
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

// Stub the durable checkpointer so the HITL-enabled path doesn't need a live Mongo.
jest.mock('~/agents/checkpointer', () => ({
  getAgentCheckpointer: jest.fn().mockResolvedValue({}),
}));

import { ChatOpenAI } from '@librechat/agents/llm/openai';
import { ChatOpenRouter } from '@librechat/agents/llm/openrouter';
import { Run, Providers, buildChildInputs, InMemorySubagentTaskStore } from '@librechat/agents';

/** Minimal RunAgent factory */
function makeAgent(
  overrides?: Record<string, unknown>,
): Record<string, unknown> & { id: string; provider: string; model: string } {
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

describe('isAskUserQuestionAdminDisabled', () => {
  it('applies includedTools precedence and the filteredTools fallback', () => {
    expect(isAskUserQuestionAdminDisabled(undefined)).toBe(false);
    expect(isAskUserQuestionAdminDisabled({ includedTools: ['calculator'] } as AppConfig)).toBe(
      true,
    );
    expect(
      isAskUserQuestionAdminDisabled({ includedTools: ['ask_user_question'] } as AppConfig),
    ).toBe(false);
    expect(
      isAskUserQuestionAdminDisabled({ filteredTools: ['ask_user_question'] } as AppConfig),
    ).toBe(true);
  });
});

type TestRunAgent = ReturnType<typeof makeAgent> & {
  subagentAgentConfigs?: TestRunAgent[];
};

type BuildChildInput = Parameters<typeof buildChildInputs>[0];

function makeSubagentChain(hops: number): TestRunAgent {
  const agents = Array.from({ length: hops + 1 }, (_, index) =>
    makeAgent({
      id: `agent_chain_${index}`,
      name: `Chain ${index}`,
    }),
  ) as TestRunAgent[];

  for (let index = 0; index < hops; index++) {
    const child = agents[index + 1];
    agents[index].subagents = { enabled: true, allowSelf: false, agent_ids: [child.id] };
    agents[index].subagentAgentConfigs = [child];
  }

  return agents[0];
}

function makeLayeredSubagentDag(width: number, depth: number): TestRunAgent {
  const root = makeAgent({ id: 'agent_dag_root', name: 'DAG Root' }) as TestRunAgent;
  const layers: TestRunAgent[][] = [[root]];

  for (let level = 1; level <= depth; level++) {
    layers.push(
      Array.from({ length: width }, (_, index) =>
        makeAgent({
          id: `agent_dag_${level}_${index}`,
          name: `DAG ${level}.${index}`,
        }),
      ) as TestRunAgent[],
    );
  }

  for (let level = 0; level < depth; level++) {
    const children = layers[level + 1];
    for (const agent of layers[level]) {
      agent.subagents = {
        enabled: true,
        allowSelf: false,
        agent_ids: children.map((child) => child.id),
      };
      agent.subagentAgentConfigs = children;
    }
  }

  return root;
}

/** Helper: call createRun and return the captured agentInputs array */
async function callAndCapture(
  opts: {
    agents?: ReturnType<typeof makeAgent>[];
    summarizationConfig?: SummarizationConfig;
    summarizeOnly?: boolean;
    initialSummary?: { text: string; tokenCount: number };
    appConfig?: AppConfig;
    messages?: BaseMessage[];
    discoveredToolNames?: string[];
    compactionSemanticIndex?: CompactionSemanticIndex;
    subagentTasks?: SubagentTaskConfig;
    modelCallbacks?: readonly ModelBoundChatModelCallback[];
    user?: IUser;
    tenantId?: string;
    requestBody?: Parameters<typeof createRun>[0]['requestBody'];
  } = {},
) {
  const agents = opts.agents ?? [makeAgent()];
  const signal = new AbortController().signal;

  await createRun({
    agents: agents as never,
    signal,
    summarizationConfig: opts.summarizationConfig,
    summarizeOnly: opts.summarizeOnly,
    initialSummary: opts.initialSummary,
    appConfig: opts.appConfig,
    messages: opts.messages,
    discoveredToolNames: opts.discoveredToolNames,
    compactionSemanticIndex: opts.compactionSemanticIndex,
    subagentTasks: opts.subagentTasks,
    modelCallbacks: opts.modelCallbacks,
    user: opts.user,
    tenantId: opts.tenantId,
    requestBody: opts.requestBody,
    streaming: true,
    streamUsage: true,
  });

  const createMock = Run.create as jest.Mock;
  expect(createMock).toHaveBeenCalledTimes(1);
  const callArgs = createMock.mock.calls[0][0];
  return callArgs.graphConfig.agents as Array<Record<string, unknown>>;
}

/** Minimal AppConfig with a single custom endpoint for testing provider resolution. */
type TestCustomEndpoint = Partial<TEndpoint> & {
  name: string;
  baseURL: string;
  apiKey: string;
};

/**
 * Shape of summarization parameters used in tests. The LibreChat config
 * schema restricts yaml `parameters` to primitive values, but the SDK
 * passes any record through as-is — tests need the wider shape to exercise
 * cross-endpoint `configuration` merging.
 */
type TestSummarizationParameters = Record<string, unknown> & {
  configuration?: Record<string, unknown>;
};

/**
 * Minimal AppConfig fixture for testing. Only `endpoints` is read by
 * `resolveSummarizationProvider`; other required AppConfig fields are
 * filled with empty/default values so the shape matches without needing
 * `as unknown as AppConfig`.
 */
function makeAppConfig(customEndpoints: TestCustomEndpoint[]): AppConfig {
  return {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      [EModelEndpoint.custom]: customEndpoints,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  delete process.env.LANGFUSE_BASEURL;
  delete process.env.LANGFUSE_HOST;
  delete process.env.LANGFUSE_FANOUT_ENABLED;
  delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
  delete process.env.LANGFUSE_FANOUT_CENTRAL_MEDIA_UPLOAD_DISABLED;
  delete process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS;
  delete process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED;
  delete process.env.LANGFUSE_TRACING_ENABLED;
  delete process.env.LANGFUSE_SAMPLE_RATE;
  process.env.TENANT_ISOLATION_STRICT = 'true';
});

describe('compaction semantic index forwarding', () => {
  it('forwards one host-derived snapshot to every top-level agent input', async () => {
    const compactionSemanticIndex = [
      {
        type: 'activity_phase',
        sourceMessageId: 'message-1',
        sourceContentIndex: 3,
        revision: 2,
        status: 'committed',
        text: 'Verified the release state',
      },
    ] satisfies CompactionSemanticIndex;

    const agents = await callAndCapture({
      agents: [makeAgent({ id: 'agent_1' }), makeAgent({ id: 'agent_2' })],
      compactionSemanticIndex,
    });

    expect(agents).toHaveLength(2);
    expect(agents[0].compactionSemanticIndex).toBe(compactionSemanticIndex);
    expect(agents[1].compactionSemanticIndex).toBe(compactionSemanticIndex);
  });

  it('does not leak the parent history index into an isolated subagent', async () => {
    const compactionSemanticIndex = [
      {
        type: 'activity_phase',
        sourceMessageId: 'message-1',
        sourceContentIndex: 3,
        revision: 2,
        status: 'committed',
        text: 'Verified the release state',
      },
    ] satisfies CompactionSemanticIndex;
    const child = makeAgent({ id: 'agent_child' });
    const [root] = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [child],
        }),
      ],
      compactionSemanticIndex,
    });
    const [childConfig] = root.subagentConfigs as Array<Record<string, unknown>>;

    expect(root.compactionSemanticIndex).toBe(compactionSemanticIndex);
    expect(childConfig.agentInputs).not.toHaveProperty('compactionSemanticIndex');
  });
});

afterAll(() => {
  delete process.env.TENANT_ISOLATION_STRICT;
});

// ---------------------------------------------------------------------------
// Suite: agent endpoint projection
// ---------------------------------------------------------------------------
describe('agent endpoint projection', () => {
  it('preserves each logical endpoint independently from its resolved provider', async () => {
    const agents = await callAndCapture({
      agents: [
        makeAgent({ id: 'sales-copilot', provider: 'bedrock', endpoint: 'bedrock' }),
        makeAgent({ id: 'dwaine', provider: 'openAI', endpoint: 'DWAINE' }),
      ],
    });

    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'sales-copilot',
          endpoint: 'bedrock',
          provider: 'bedrock',
        }),
        expect.objectContaining({
          agentId: 'dwaine',
          endpoint: 'DWAINE',
          provider: 'openAI',
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: custom endpoint stream usage defaults
// ---------------------------------------------------------------------------
describe('custom endpoint stream usage defaults', () => {
  it('disables streamUsage by default for OpenAI-compatible custom endpoints', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ endpoint: 'LiteLLM' })],
    });
    const clientOptions = agents[0].clientOptions as Record<string, unknown>;

    expect(clientOptions.streamUsage).toBe(false);
    expect(clientOptions.usage).toBe(true);
  });

  it('respects explicit streamUsage from endpoint-resolved model parameters', async () => {
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          endpoint: 'LiteLLM',
          model_parameters: {
            model: 'gpt-4o',
            streamUsage: true,
          },
        }),
      ],
    });
    const clientOptions = agents[0].clientOptions as Record<string, unknown>;

    expect(clientOptions.streamUsage).toBe(true);
    expect(clientOptions.usage).toBe(true);
  });
});

describe('model-level callbacks', () => {
  it('propagates guards through root, fallback, summary, eager, lazy, and graph clients', async () => {
    const modelCallback: ModelBoundChatModelCallback = {
      name: 'librechat-model-bound-content-filter',
      raiseError: true,
      awaitHandlers: true,
      handleChatModelStart: jest.fn(),
    };
    const eagerChild = makeAgent({ id: 'agent_eager', name: 'Eager child' });
    const lazyResolve = jest
      .fn()
      .mockResolvedValue(makeAgent({ id: 'agent_lazy', name: 'Lazy child' }));
    const graphMember = makeAgent({ id: 'agent_graph', name: 'Graph member' });
    const graphDefinition = {
      type: 'guarded_team',
      name: 'Guarded team',
      description: 'Exercises graph member client options',
      agent_ids: [graphMember.id],
      edges: [],
      entry_agent_id: graphMember.id,
      result_agent_id: graphMember.id,
    };
    const agents = await callAndCapture({
      modelCallbacks: [modelCallback],
      summarizationConfig: {
        provider: 'anthropic',
        model: 'claude-test',
        parameters: {
          fallbacks: [{ provider: 'openAI', clientOptions: { temperature: 0 } }],
        } as unknown as SummarizationConfig['parameters'],
      },
      agents: [
        makeAgent({
          model_parameters: {
            model: 'gpt-4o',
            fallbacks: [{ provider: 'anthropic', clientOptions: { temperature: 0 } }],
          },
          subagents: {
            enabled: true,
            allowSelf: false,
            agent_ids: [eagerChild.id, 'agent_lazy'],
            graphs: [graphDefinition],
          },
          subagentAgentConfigs: [eagerChild],
          lazySubagentConfigs: [
            {
              id: 'agent_lazy',
              name: 'Lazy child',
              description: 'Resolves only when selected',
              configId: 'agent_lazy:1:fingerprint',
              resolve: lazyResolve,
            },
          ],
          subagentGraphConfigs: [{ definition: graphDefinition, memberConfigs: [graphMember] }],
        }),
      ],
    });

    const root = agents[0];
    const rootOptions = root.clientOptions as Record<string, unknown>;
    expect(rootOptions.callbacks).toEqual([modelCallback]);
    expect(
      (
        (rootOptions.fallbacks as Array<Record<string, unknown>>)[0].clientOptions as Record<
          string,
          unknown
        >
      ).callbacks,
    ).toEqual([modelCallback]);

    const summary = root.summarizationConfig as Record<string, unknown>;
    const summaryParameters = summary.parameters as Record<string, unknown>;
    expect(summaryParameters.callbacks).toEqual([modelCallback]);
    expect(
      (
        (summaryParameters.fallbacks as Array<Record<string, unknown>>)[0].clientOptions as Record<
          string,
          unknown
        >
      ).callbacks,
    ).toEqual([modelCallback]);

    const configs = root.subagentConfigs as Array<Record<string, unknown>>;
    const eager = configs.find((config) => config.type === 'agent_eager');
    expect(
      ((eager?.agentInputs as Record<string, unknown>).clientOptions as Record<string, unknown>)
        .callbacks,
    ).toEqual([modelCallback]);

    const lazy = configs.find((config) => config.type === 'agent_lazy');
    const lazyInputs = await (
      lazy?.resolveAgentInputs as (context: never) => Promise<Record<string, unknown>>
    )({ signal: new AbortController().signal } as never);
    expect((lazyInputs.clientOptions as Record<string, unknown>).callbacks).toEqual([
      modelCallback,
    ]);

    const graph = configs.find((config) => config.type === 'guarded_team');
    const [member] = graph?.agents as Array<Record<string, unknown>>;
    expect((member.clientOptions as Record<string, unknown>).callbacks).toEqual([modelCallback]);
  });

  it('preserves a pre-existing callback manager when installing model guards', async () => {
    const existingLLMStart = jest.fn();
    const existingManager = CallbackManager.fromHandlers({ handleLLMStart: existingLLMStart });
    const modelCallback: ModelBoundChatModelCallback = {
      name: 'librechat-model-bound-content-filter',
      raiseError: true,
      awaitHandlers: true,
      handleChatModelStart: jest.fn(),
    };
    const agents = await callAndCapture({
      modelCallbacks: [modelCallback],
      agents: [
        makeAgent({
          model_parameters: {
            model: 'gpt-4o',
            callbacks: existingManager,
          },
        }),
      ],
    });

    const callbacks = (agents[0].clientOptions as { callbacks: CallbackManager }).callbacks;
    expect(callbacks).toBeInstanceOf(CallbackManager);
    expect(callbacks).not.toBe(existingManager);
    expect(callbacks.handlers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handleLLMStart: existingLLMStart }),
        modelCallback,
      ]),
    );
    expect(existingManager.handlers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 1: reserveRatio
// ---------------------------------------------------------------------------
describe('reserveRatio', () => {
  it('applies ratio from config using baseContextTokens, capped at maxContextTokens', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ baseContextTokens: 200_000, maxContextTokens: 200_000 })],
      summarizationConfig: { reserveRatio: 0.03, provider: 'anthropic', model: 'claude' },
    });
    // Math.round(200000 * 0.97) = 194000, min(200000, 194000) = 194000
    expect(agents[0].maxContextTokens).toBe(194_000);
  });

  it('never exceeds user-configured maxContextTokens even when ratio computes higher', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ baseContextTokens: 200_000, maxContextTokens: 50_000 })],
      summarizationConfig: { reserveRatio: 0.03, provider: 'anthropic', model: 'claude' },
    });
    // Math.round(200000 * 0.97) = 194000, but min(50000, 194000) = 50000
    expect(agents[0].maxContextTokens).toBe(50_000);
  });

  it('falls back to maxContextTokens when ratio is not set', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ maxContextTokens: 100_000, baseContextTokens: 200_000 })],
      summarizationConfig: { provider: 'anthropic', model: 'claude' },
    });
    expect(agents[0].maxContextTokens).toBe(100_000);
  });

  it('falls back to maxContextTokens when ratio is 0', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ maxContextTokens: 100_000, baseContextTokens: 200_000 })],
      summarizationConfig: { reserveRatio: 0, provider: 'anthropic', model: 'claude' },
    });
    expect(agents[0].maxContextTokens).toBe(100_000);
  });

  it('falls back to maxContextTokens when ratio is 1', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ maxContextTokens: 100_000, baseContextTokens: 200_000 })],
      summarizationConfig: { reserveRatio: 1, provider: 'anthropic', model: 'claude' },
    });
    expect(agents[0].maxContextTokens).toBe(100_000);
  });

  it('falls back to maxContextTokens when baseContextTokens is undefined', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ maxContextTokens: 100_000 })],
      summarizationConfig: { reserveRatio: 0.05, provider: 'anthropic', model: 'claude' },
    });
    expect(agents[0].maxContextTokens).toBe(100_000);
  });

  it('clamps to 1024 minimum but still capped at maxContextTokens', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ baseContextTokens: 500, maxContextTokens: 2000 })],
      summarizationConfig: { reserveRatio: 0.99, provider: 'anthropic', model: 'claude' },
    });
    // Math.round(500 * 0.01) = 5 → clamped to 1024, min(2000, 1024) = 1024
    expect(agents[0].maxContextTokens).toBe(1024);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: maxSummaryTokens passthrough
// ---------------------------------------------------------------------------
describe('maxSummaryTokens passthrough', () => {
  it('forwards global maxSummaryTokens value', async () => {
    const agents = await callAndCapture({
      summarizationConfig: {
        provider: 'anthropic',
        model: 'claude',
        maxSummaryTokens: 4096,
      },
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.maxSummaryTokens).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: summarizationEnabled resolution
// ---------------------------------------------------------------------------
describe('summarizationEnabled resolution', () => {
  it('true with provider + model + enabled', async () => {
    const agents = await callAndCapture({
      summarizationConfig: {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-3-haiku',
      },
    });
    expect(agents[0].summarizationEnabled).toBe(true);
  });

  it('false when provider is empty string', async () => {
    const agents = await callAndCapture({
      summarizationConfig: {
        enabled: true,
        provider: '',
        model: 'claude-3-haiku',
      },
    });
    expect(agents[0].summarizationEnabled).toBe(false);
  });

  it('false when enabled is explicitly false', async () => {
    const agents = await callAndCapture({
      summarizationConfig: {
        enabled: false,
        provider: 'anthropic',
        model: 'claude-3-haiku',
      },
    });
    expect(agents[0].summarizationEnabled).toBe(false);
  });

  it('true with self-summarize default when summarizationConfig is undefined', async () => {
    const agents = await callAndCapture({
      summarizationConfig: undefined,
    });
    expect(agents[0].summarizationEnabled).toBe(true);
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('openAI');
    expect(config.model).toBe('gpt-4o');
  });

  it('false when the effective context budget is below the viable minimum', async () => {
    /**
     * A tiny user-set maxContextTokens re-triggers summarization on every
     * graph step until the recursion limit aborts the run; the guard falls
     * back to plain pruning instead.
     */
    const agents = await callAndCapture({
      agents: [makeAgent({ maxContextTokens: 10 })],
      summarizationConfig: {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-3-haiku',
      },
    });
    expect(agents[0].summarizationEnabled).toBe(false);
  });

  it('true at exactly the 1024-token viable minimum', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ maxContextTokens: 1024 })],
      summarizationConfig: {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-3-haiku',
      },
    });
    expect(agents[0].summarizationEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: summarizationConfig field passthrough
// ---------------------------------------------------------------------------
describe('summarizationConfig field passthrough', () => {
  it('all fields pass through to agentInputs', async () => {
    const agents = await callAndCapture({
      summarizationConfig: {
        enabled: true,
        trigger: { type: 'token_ratio', value: 0.8 },
        provider: 'anthropic',
        model: 'claude-3-haiku',
        parameters: { temperature: 0.2 },
        prompt: 'Summarize this conversation',
        updatePrompt: 'Update the existing summary with new messages',
        reserveRatio: 0.1,
        maxSummaryTokens: 4096,
        retainRecent: { turns: 5, tokens: 40000 },
      },
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config).toBeDefined();
    // `enabled` is not forwarded to the agent-level config — it is resolved
    // into the separate `summarizationEnabled` boolean on the agent input.
    expect(agents[0].summarizationEnabled).toBe(true);
    expect(config.trigger).toEqual({ type: 'token_ratio', value: 0.8 });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-3-haiku');
    expect(config.parameters).toEqual({ temperature: 0.2 });
    expect(config.prompt).toBe('Summarize this conversation');
    expect(config.updatePrompt).toBe('Update the existing summary with new messages');
    expect(config.reserveRatio).toBe(0.1);
    expect(config.maxSummaryTokens).toBe(4096);
    expect(config.retainRecent).toEqual({ turns: 5, tokens: 40000 });
  });

  it('uses self-summarize default when no config provided', async () => {
    const agents = await callAndCapture({
      summarizationConfig: undefined,
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config).toBeDefined();
    // `enabled` is resolved into `summarizationEnabled`, not forwarded on config
    expect(agents[0].summarizationEnabled).toBe(true);
    expect(config.provider).toBe('openAI');
    expect(config.model).toBe('gpt-4o');
  });

  it('preserves `token_ratio` trigger with `value: 0` (documented, extreme-but-valid)', async () => {
    const agents = await callAndCapture({
      summarizationConfig: {
        enabled: true,
        trigger: { type: 'token_ratio', value: 0 },
      },
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.trigger).toEqual({ type: 'token_ratio', value: 0 });
  });

  it.each([
    ['remaining_tokens', 500],
    ['messages_to_refine', 4],
  ] as const)('passes %s trigger through unchanged', async (type, value) => {
    const agents = await callAndCapture({
      summarizationConfig: {
        enabled: true,
        trigger: { type, value },
      },
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.trigger).toEqual({ type, value });
  });
});

// ---------------------------------------------------------------------------
// Suite: reasoning effort translation
// ---------------------------------------------------------------------------
const OPENROUTER_MODEL = 'openai/gpt-5.6';
const ADAPTIVE_CLAUDE_MODEL = 'anthropic/claude-sonnet-4.6';

/** Agent whose resolved client options already carry a reasoning configuration. */
function makeReasoningAgent(overrides: {
  azureOptions?: AzureOptions;
  provider: string;
  endpoint: string;
  model: string;
  model_parameters: Record<string, unknown>;
}) {
  return makeAgent({
    ...overrides,
    provider: overrides.provider as never,
    endpoint: overrides.endpoint,
    model: overrides.model,
    model_parameters: overrides.model_parameters as never,
  });
}

describe('summarization reasoning effort', () => {
  it.each(['medium', 'low'])(
    'overrides an inherited OpenRouter reasoning object with %s, leaving the agent untouched',
    async (reasoningEffort) => {
      const agents = await callAndCapture({
        agents: [
          makeReasoningAgent({
            provider: Providers.OPENROUTER,
            endpoint: 'OpenRouter',
            model: OPENROUTER_MODEL,
            model_parameters: {
              model: OPENROUTER_MODEL,
              modelKwargs: { reasoning: { effort: 'max' } },
            },
          }),
        ],
        summarizationConfig: {
          provider: 'OpenRouter',
          model: OPENROUTER_MODEL,
          parameters: { reasoning_effort: reasoningEffort },
        },
      });

      const mainClientOptions = agents[0].clientOptions as Record<string, unknown>;
      const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;

      expect(mainClientOptions.modelKwargs).toEqual({ reasoning: { effort: 'max' } });
      expect(summaryConfig.parameters).toEqual({ reasoning: { effort: reasoningEffort } });

      /** The SDK spreads `parameters` onto the agent's own client options. */
      const summaryModel = new ChatOpenRouter({
        ...mainClientOptions,
        ...(summaryConfig.parameters as Record<string, unknown>),
        apiKey: 'test-key',
        model: summaryConfig.model as string,
      });
      const request = summaryModel.invocationParams();

      expect(request.reasoning).toEqual({ effort: reasoningEffort });
      expect(request.reasoning_effort).toBeUndefined();
    },
  );

  it('overrides an inherited OpenAI reasoning object', async () => {
    const agents = await callAndCapture({
      agents: [
        makeReasoningAgent({
          provider: EModelEndpoint.openAI,
          endpoint: EModelEndpoint.openAI,
          model: 'gpt-5.6',
          model_parameters: { model: 'gpt-5.6', reasoning: { effort: 'high' } },
        }),
      ],
      summarizationConfig: {
        provider: EModelEndpoint.openAI,
        model: 'gpt-5.6',
        parameters: { reasoning_effort: 'low' },
      },
    });

    const mainClientOptions = agents[0].clientOptions as Record<string, unknown>;
    const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;

    expect(mainClientOptions.reasoning).toEqual({ effort: 'high' });
    expect(summaryConfig.parameters).toEqual({ reasoning: { effort: 'low' } });

    const summaryModel = new ChatOpenAI({
      ...mainClientOptions,
      ...(summaryConfig.parameters as Record<string, unknown>),
      apiKey: 'test-key',
      model: summaryConfig.model as string,
    } as never);
    const request = summaryModel.invocationParams() as Record<string, unknown>;

    /** Chat Completions re-emits the object as the scalar the API expects. */
    expect(request.reasoning_effort).toBe('low');
  });

  it('maps effort to verbosity for OpenRouter adaptive Anthropic models', async () => {
    const agents = await callAndCapture({
      agents: [
        makeReasoningAgent({
          provider: Providers.OPENROUTER,
          endpoint: 'OpenRouter',
          model: ADAPTIVE_CLAUDE_MODEL,
          model_parameters: {
            model: ADAPTIVE_CLAUDE_MODEL,
            verbosity: 'max',
            modelKwargs: { reasoning: { enabled: true } },
          },
        }),
      ],
      summarizationConfig: {
        provider: 'OpenRouter',
        model: ADAPTIVE_CLAUDE_MODEL,
        parameters: { reasoning_effort: 'low' },
      },
    });

    const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;
    expect(summaryConfig.parameters).toEqual({
      verbosity: 'low',
      reasoning: { enabled: true },
    });
  });

  it('turns adaptive thinking off for reasoning_effort "none"', async () => {
    const agents = await callAndCapture({
      agents: [
        makeReasoningAgent({
          provider: Providers.OPENROUTER,
          endpoint: 'OpenRouter',
          model: ADAPTIVE_CLAUDE_MODEL,
          model_parameters: {
            model: ADAPTIVE_CLAUDE_MODEL,
            modelKwargs: { reasoning: { enabled: true } },
          },
        }),
      ],
      summarizationConfig: {
        provider: 'OpenRouter',
        model: ADAPTIVE_CLAUDE_MODEL,
        parameters: { reasoning_effort: 'none' },
      },
    });

    const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;
    expect(summaryConfig.parameters).toEqual({ reasoning: { enabled: false } });

    const summaryModel = new ChatOpenRouter({
      ...(agents[0].clientOptions as Record<string, unknown>),
      ...(summaryConfig.parameters as Record<string, unknown>),
      apiKey: 'test-key',
      model: ADAPTIVE_CLAUDE_MODEL,
    });
    expect(summaryModel.invocationParams().reasoning).toEqual({ enabled: false });
  });

  it('translates for a custom endpoint that resolves to OpenRouter by baseURL', async () => {
    const appConfig = makeAppConfig([
      { name: 'Router', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'router-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: {
        provider: 'Router',
        model: OPENROUTER_MODEL,
        parameters: { reasoning_effort: 'low' },
      },
      appConfig,
    });

    const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;
    expect(summaryConfig.provider).toBe(Providers.OPENROUTER);
    expect(summaryConfig.parameters).toMatchObject({ reasoning: { effort: 'low' } });
    expect(summaryConfig.parameters).not.toHaveProperty('reasoning_effort');
  });

  it('leaves parameters untouched for providers with no reasoning_effort concept', async () => {
    const agents = await callAndCapture({
      summarizationConfig: {
        provider: EModelEndpoint.anthropic,
        model: 'claude-3-haiku',
        parameters: { reasoning_effort: 'low' },
      },
    });

    const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;
    expect(summaryConfig.parameters).toEqual({ reasoning_effort: 'low' });
  });

  it('leaves unrelated parameters and an unset effort untouched', async () => {
    const agents = await callAndCapture({
      agents: [
        makeReasoningAgent({
          provider: Providers.OPENROUTER,
          endpoint: 'OpenRouter',
          model: OPENROUTER_MODEL,
          model_parameters: { model: OPENROUTER_MODEL },
        }),
      ],
      summarizationConfig: {
        provider: 'OpenRouter',
        model: OPENROUTER_MODEL,
        parameters: { temperature: 0.2, streaming: false, reasoning_effort: '' },
      },
    });

    const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;
    expect(summaryConfig.parameters).toEqual({
      temperature: 0.2,
      streaming: false,
      reasoning_effort: '',
    });
  });
});

type CapturedRequest = {
  url: URL;
  headers: Headers;
  body: OpenAI.ChatCompletionCreateParams & OpenAI.Responses.ResponseCreateParams;
};

async function compactSummary(
  agents: Array<Record<string, unknown>>,
  requests: CapturedRequest[] = [],
) {
  const summaryConfig = agents[0].summarizationConfig as NonNullable<
    AgentInputs['summarizationConfig']
  >;
  const clientOptions = agents[0].clientOptions as { configuration?: OpenAIConfiguration };
  const configuration = {
    ...((summaryConfig.parameters?.configuration ??
      clientOptions.configuration) as OpenAIConfiguration),
  };
  summaryConfig.parameters = { ...summaryConfig.parameters, configuration };
  configuration.fetch = async (url, init) => {
    requests.push({
      url: new URL(String(url)),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const text = 'The user asked for arithmetic and the assistant calculated four.';
    return Response.json({
      id: 'summary-response',
      model: 'summary-production',
      object: 'response',
      status: 'completed',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      output: [
        {
          type: 'message',
          id: 'msg_summary',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
      },
    });
  };
  const actual = jest.requireActual<typeof import('@librechat/agents')>('@librechat/agents');
  const runConfig = (Run.create as jest.Mock).mock.calls[0][0] as Parameters<typeof Run.create>[0];
  const run = await actual.Run.create({
    ...runConfig,
    graphConfig: { ...runConfig.graphConfig, agents: agents as unknown as AgentInputs[] },
    tokenCounter: (message) => String(message.content).length,
  });
  await run.processStream(
    { messages: [new HumanMessage('Compute 2 + 2.'), new AIMessage('4')] },
    { version: 'v2', configurable: { thread_id: 'azure-summary-test' } },
  );

  return { requests };
}

describe('Azure deployment alias', () => {
  /** `initializeAgent` maps an Azure Responses agent to the OpenAI provider. */
  const azureAstraAgent = () => {
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-azure-key',
      {
        azure: {
          azureOpenAIApiInstanceName: 'test-instance',
          azureOpenAIApiDeploymentName: 'production-deployment',
          azureOpenAIApiVersion: '2025-04-01-preview',
          azureOpenAIApiKey: 'test-azure-key',
        },
        modelOptions: { model: 'gpt-6-astra', max_tokens: 2048 },
      },
      EModelEndpoint.azureOpenAI,
    );
    return makeReasoningAgent({
      provider: EModelEndpoint.openAI,
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'gpt-6-astra',
      model_parameters: { ...llmConfig, configuration: configOptions },
    });
  };

  /** The SDK spreads `parameters` onto the agent's client options, then sets `model`. */
  const summaryRequestModel = (
    clientOptions: Record<string, unknown>,
    summaryConfig: Record<string, unknown>,
  ) => {
    const summaryModel = new ChatOpenAI({
      ...clientOptions,
      ...((summaryConfig.parameters as Record<string, unknown> | undefined) ?? {}),
      apiKey: 'test-key',
      model: summaryConfig.model as string,
    } as never);
    return (summaryModel.invocationParams() as Record<string, unknown>).model;
  };

  it("keeps the Astra agent's API mode and deployment alias out of a custom-endpoint summarizer", async () => {
    const agents = await callAndCapture({
      agents: [azureAstraAgent()],
      appConfig: makeAppConfig([
        {
          name: 'Gateway',
          apiKey: 'gateway-key',
          baseURL: 'https://gateway.example/v1',
          models: { default: ['gpt-4.1-mini'] },
        },
      ]),
      summarizeOnly: true,
      summarizationConfig: {
        provider: 'Gateway',
        model: 'gpt-4.1-mini',
        parameters: { streaming: false },
      },
    });

    expect((agents[0].clientOptions as Record<string, unknown>).modelKwargs).toEqual({
      model: 'production-deployment',
      max_output_tokens: 2048,
    });
    const { requests } = await compactSummary(agents);
    expect(requests).toHaveLength(1);
    const { url, headers, body } = requests[0];
    expect(url.origin + url.pathname).toBe('https://gateway.example/v1/chat/completions');
    expect(headers.get('api-key')).toBeNull();
    expect(body.model).toBe('gpt-4.1-mini');
    expect(body).not.toHaveProperty('include');
  });

  it.each([
    { useModelAsDeploymentName: undefined, deployment: 'env-deployment' },
    { useModelAsDeploymentName: 'true', deployment: 'gpt-41-mini' },
  ])(
    'resolves a different summary model through the legacy Azure environment to $deployment',
    async ({ useModelAsDeploymentName, deployment }) => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        AZURE_API_KEY: 'env-key',
        AZURE_OPENAI_API_INSTANCE_NAME: 'env-instance',
        AZURE_OPENAI_API_DEPLOYMENT_NAME: 'env-deployment',
        AZURE_OPENAI_API_VERSION: '2024-10-21',
        AZURE_USE_MODEL_AS_DEPLOYMENT_NAME: useModelAsDeploymentName,
      });
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        appConfig: makeAppConfig([]),
        summarizeOnly: true,
        summarizationConfig: { model: 'gpt-4.1-mini', parameters: { streaming: false } },
      });

      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      const { url, headers, body } = requests[0];
      expect(url.origin + url.pathname).toBe(
        `https://env-instance.openai.azure.com/openai/deployments/${deployment}/chat/completions`,
      );
      expect(headers.get('api-key')).toBe('env-key');
      expect(body.model).toBe(deployment);
    },
  );

  it('applies summarization base URL and API key overrides to an Azure summary deployment', async () => {
    const appConfig = makeAppConfig([]);
    appConfig.endpoints![EModelEndpoint.azureOpenAI] = {
      isValid: true,
      errors: [],
      modelNames: ['gpt-6-astra', 'gpt-4.1-mini'],
      modelGroupMap: { 'gpt-6-astra': { group: 'main' }, 'gpt-4.1-mini': { group: 'summary' } },
      groupMap: {
        main: {
          apiKey: 'test-azure-key',
          instanceName: 'test-instance',
          version: '2025-04-01-preview',
          models: { 'gpt-6-astra': { deploymentName: 'production-deployment' } },
        },
        summary: {
          apiKey: 'summary-key',
          instanceName: 'summary-instance',
          version: '2024-10-21',
          models: { 'gpt-4.1-mini': { deploymentName: 'summary-production' } },
        },
      },
    };
    const agents = await callAndCapture({
      agents: [azureAstraAgent()],
      appConfig,
      summarizeOnly: true,
      summarizationConfig: {
        model: 'gpt-4.1-mini',
        parameters: {
          streaming: false,
          apiKey: 'gateway-key',
          baseURL: 'https://summary-gateway.example/openai/deployments/${DEPLOYMENT_NAME}',
        },
      },
    });

    const { requests } = await compactSummary(agents);
    expect(requests).toHaveLength(1);
    const { url, headers } = requests[0];
    expect(url.origin + url.pathname).toBe(
      'https://summary-gateway.example/openai/deployments/summary-production/chat/completions',
    );
    expect(headers.get('api-key')).toBe('gateway-key');
  });

  it.each([
    { model: 'gpt-6-astra', initialResponses: true, useResponsesApi: true },
    { model: 'gpt-4.1', initialResponses: false, useResponsesApi: false },
    { model: 'gpt-6-astra', initialResponses: true, useResponsesApi: false },
    { model: 'gpt-4.1', initialResponses: false, useResponsesApi: true },
  ])(
    'uses same-model Azure transport overrides for $model',
    async ({ model, initialResponses, useResponsesApi }) => {
      const { llmConfig, configOptions } = getOpenAIConfig(
        'resolved-user-key',
        {
          azure: {
            azureOpenAIApiKey: 'resolved-user-key',
            azureOpenAIApiInstanceName: 'user-instance',
            azureOpenAIApiDeploymentName: 'user-deployment',
            azureOpenAIApiVersion: '2024-10-21',
          },
          modelOptions: { model, max_tokens: 1536 },
          headers: { 'X-Request': 'resolved-user-header' },
        },
        EModelEndpoint.azureOpenAI,
      );
      const agents = await callAndCapture({
        agents: [
          makeReasoningAgent({
            endpoint: EModelEndpoint.azureOpenAI,
            provider: initialResponses ? Providers.OPENAI : Providers.AZURE,
            model,
            model_parameters: { ...llmConfig, configuration: configOptions },
          }),
        ],
        appConfig: makeAppConfig([]),
        summarizeOnly: true,
        summarizationConfig: {
          model,
          parameters: {
            streaming: false,
            apiKey: 'override-key',
            useResponsesApi,
            baseURL:
              'https://summary-instance.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}',
          },
        },
      });
      expect(agents[0].summarizationEnabled).toBe(true);
      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      expect(requests[0].url.origin + requests[0].url.pathname).toBe(
        useResponsesApi
          ? 'https://summary-instance.openai.azure.com/openai/v1/responses'
          : 'https://summary-instance.openai.azure.com/openai/deployments/user-deployment/chat/completions',
      );
      expect(requests[0].headers.get('api-key')).toBe('override-key');
      expect(requests[0].headers.get('X-Request')).toBe('resolved-user-header');
      expect(requests[0].body.model).toBe('user-deployment');
      const chatTokenKey = model === 'gpt-6-astra' ? 'max_completion_tokens' : 'max_tokens';
      expect(requests[0].body[useResponsesApi ? 'max_output_tokens' : chatTokenKey]).toBe(1536);
      expect((agents[0].clientOptions as Record<string, unknown>).configuration).toEqual(
        configOptions,
      );
    },
  );

  it.each(['root', 'lazy'])(
    'retains Azure identity and resolved headers for a %s self-summary',
    async (kind) => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        AZURE_API_KEY: 'user_provided',
        SUMMARY_HEADER_SECRET: 'must-not-leak',
      });
      const user = { id: 'user-1', username: '${SUMMARY_HEADER_SECRET}' };
      const appConfig = makeAppConfig([]);
      appConfig.endpoints!.all = {
        headers: {
          'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          'X-Tenant': '{{LIBRECHAT_USER_TENANTID}}',
          'X-User': '{{LIBRECHAT_USER_USERNAME}}',
        },
      };
      const getUserKeyValues = jest.fn().mockResolvedValue({
        apiKey: JSON.stringify({
          azureOpenAIApiKey: 'user-key',
          azureOpenAIApiInstanceName: 'user-instance',
          azureOpenAIApiDeploymentName: 'user-deployment',
          azureOpenAIApiVersion: '2024-10-21',
        }),
      });
      const options = await initializeOpenAI({
        endpoint: EModelEndpoint.azureOpenAI,
        model_parameters: { model: 'gpt-6-astra' },
        runtime: { appConfig, user, requestBody: {} },
        db: { getUserKeyValues },
      } as unknown as Parameters<typeof initializeOpenAI>[0]);
      const azureAgent = {
        ...makeReasoningAgent({
          endpoint: EModelEndpoint.azureOpenAI,
          provider: Providers.OPENAI,
          model: 'gpt-6-astra',
          azureOptions: options.azureOptions,
          model_parameters: { ...options.llmConfig, configuration: options.configOptions },
        }),
        id: 'azure-child',
      };
      const lazyParent = makeAgent({
        id: 'parent',
        summarization: { enabled: false },
        subagents: { enabled: true, allowSelf: false },
        lazySubagentConfigs: [
          {
            id: azureAgent.id,
            name: 'Azure child',
            description: 'Lazy Azure child',
            configId: 'azure-child:1:test',
            resolve: jest.fn().mockResolvedValue(azureAgent),
          },
        ],
      });
      const captured = await callAndCapture({
        agents: kind === 'lazy' ? [lazyParent] : [azureAgent],
        appConfig,
        user: user as IUser,
        tenantId: 'tenant-1',
        requestBody: { conversationId: 'conversation-1' },
        summarizeOnly: true,
        summarizationConfig: {
          parameters: {
            streaming: false,
            baseURL:
              'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}',
          },
        },
      });
      let selected = captured[0];
      if (kind === 'lazy') {
        const [child] = captured[0].subagentConfigs as Array<Record<string, unknown>>;
        selected = await (
          child.resolveAgentInputs as (context: never) => Promise<Record<string, unknown>>
        )({ signal: new AbortController().signal } as never);
        selected.summarizeOnly = true;
      }
      const agents = [selected];
      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      expect(requests[0].url.origin + requests[0].url.pathname).toBe(
        'https://user-instance.openai.azure.com/openai/v1/responses',
      );
      expect(requests[0].body.model).toBe('user-deployment');
      expect(requests[0].headers.get('api-key')).toBe('user-key');
      expect(requests[0].headers.get('X-Conversation')).toBe('conversation-1');
      expect(requests[0].headers.get('X-Tenant')).toBe('tenant-1');
      expect(requests[0].headers.get('X-User')).toBe('${SUMMARY_HEADER_SECRET}');
      const mainConfiguration = (agents[0].clientOptions as Record<string, unknown>)
        .configuration as OpenAIConfiguration;
      expect(new Headers(mainConfiguration?.defaultHeaders as HeadersInit).get('X-User')).toBe(
        '${SUMMARY_HEADER_SECRET}',
      );
      expect(getUserKeyValues).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { parameterCap: undefined, expected: 512 },
    { parameterCap: '128', expected: 512 },
    { parameterCap: 0, expected: 512 },
    { parameterCap: 256, expected: 256 },
  ])(
    'honors the summary token cap with parameter cap $parameterCap',
    async ({ parameterCap, expected }) => {
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        summarizeOnly: true,
        summarizationConfig: {
          maxSummaryTokens: 512,
          parameters: {
            streaming: false,
            ...(parameterCap !== undefined ? { maxSummaryTokens: parameterCap } : {}),
          },
        },
      });
      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      expect(requests[0].body.max_output_tokens).toBe(expected);
      expect(requests[0].body.model).toBe('production-deployment');
    },
  );

  it.each([
    { nested: false, useResponsesApi: true },
    { nested: true, useResponsesApi: true },
    { nested: false, useResponsesApi: false },
  ])(
    'normalizes final Azure transport (nested: $nested, Responses: $useResponsesApi)',
    async ({ nested, useResponsesApi }) => {
      const model = 'gpt-4.1-mini';
      const appConfig = makeAppConfig([]);
      appConfig.endpoints!.azureOpenAI = {
        isValid: true,
        errors: [],
        modelNames: [model],
        modelGroupMap: { [model]: { group: 'summary' } },
        groupMap: {
          summary: {
            apiKey: 'summary-key',
            instanceName: 'summary-instance',
            version: '2024-10-21',
            models: { [model]: { deploymentName: 'summary-production' } },
            addParams: { useResponsesApi: !useResponsesApi },
          },
        },
      };
      const baseURL =
        'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}?api-version=2025-04-01-preview';
      const parameters = {
        streaming: false,
        useResponsesApi,
        ...(nested
          ? { configuration: { baseURL, defaultHeaders: { 'X-Override': 'yes' } } }
          : { baseURL }),
      } as unknown as SummarizationConfig['parameters'];
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        appConfig,
        summarizeOnly: true,
        summarizationConfig: { model, parameters },
      });
      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      expect(requests[0].url.origin + requests[0].url.pathname).toBe(
        useResponsesApi
          ? 'https://summary-instance.openai.azure.com/openai/v1/responses'
          : 'https://summary-instance.openai.azure.com/openai/deployments/summary-production/chat/completions',
      );
      expect(requests[0].headers.get('api-key')).toBe('summary-key');
      expect(requests[0].body.model).toBe('summary-production');
      if (nested) expect(requests[0].headers.get('X-Override')).toBe('yes');
      if (useResponsesApi)
        expect(requests[0].url.searchParams.get('api-version')).toBe('2025-04-01-preview');
    },
  );

  it.each([EModelEndpoint.azureOpenAI, EModelEndpoint.openAI])(
    'disables an invalid %s summary URL before constructing a run client',
    async (provider) => {
      jest.replaceProperty(process, 'env', { ...process.env, OPENAI_API_KEY: 'summary-key' });
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        appConfig: makeAppConfig([]),
        summarizeOnly: true,
        summarizationConfig: {
          provider,
          model: 'gpt-6-astra',
          parameters: { streaming: false, baseURL: 'not a URL' },
        },
      });
      expect(agents[0].summarizationEnabled).toBe(false);
      const requests: CapturedRequest[] = [];
      await expect(compactSummary(agents, requests)).rejects.toThrow(
        'Compaction skipped: summarization is not enabled for this agent',
      );
      expect(requests).toHaveLength(0);
    },
  );

  it('keeps the deployment alias when the summarizer runs the agent model', async () => {
    const agents = await callAndCapture({ agents: [azureAstraAgent()] });

    const mainClientOptions = agents[0].clientOptions as Record<string, unknown>;
    const summaryConfig = agents[0].summarizationConfig as Record<string, unknown>;

    expect(summaryConfig.parameters).toBeUndefined();
    expect(summaryRequestModel(mainClientOptions, summaryConfig)).toBe('production-deployment');
  });

  it.each<{
    model: string;
    deployed: boolean;
    proxy?: string;
    parameters?: SummarizationConfig['parameters'];
  }>([
    { model: 'gpt-4.1-mini', deployed: false, proxy: undefined },
    { model: 'gpt-4.1-mini', deployed: true, proxy: undefined },
    { model: 'gpt-6-astra', deployed: true, proxy: undefined },
    { model: 'gpt-4.1-mini', deployed: false, proxy: 'https://summary-gateway.example/v1' },
    {
      model: 'gpt-6-astra',
      deployed: true,
      parameters: { useResponsesApi: false, apiKey: 'override-key' },
    },
    {
      model: 'gpt-4.1-mini',
      deployed: false,
      parameters: { baseURL: 'https://per-summary.example/v1', useResponsesApi: true },
    },
  ])(
    'honors explicit OpenAI for $model (Azure deployed: $deployed, proxy: $proxy)',
    async ({ model, deployed, proxy, parameters }) => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        OPENAI_API_KEY: 'openai-summary-key',
        OPENAI_REVERSE_PROXY: proxy,
      });
      const appConfig = makeAppConfig([]);
      appConfig.endpoints!.all = { headers: { 'X-Global': 'global' } };
      appConfig.endpoints!.openAI = { headers: { 'X-Summary': 'openai' } };
      appConfig.endpoints!.azureOpenAI = {
        isValid: true,
        errors: [],
        modelNames: deployed ? [model] : [],
        modelGroupMap: deployed ? { [model]: { group: 'azure' } } : {},
        groupMap: {
          azure: {
            apiKey: 'test-azure-key',
            instanceName: 'test-instance',
            version: '2025-04-01-preview',
            models: { [model]: { deploymentName: 'production-deployment' } },
          },
        },
      };
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        appConfig,
        summarizeOnly: true,
        summarizationConfig: {
          provider: EModelEndpoint.openAI,
          model,
          parameters: { streaming: false, ...parameters },
        },
      });
      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      const { url, headers, body } = requests[0];
      const baseURL = parameters?.baseURL ?? proxy;
      expect(url.origin).toBe(
        typeof baseURL === 'string' ? new URL(baseURL).origin : 'https://api.openai.com',
      );
      const usesResponses = parameters?.useResponsesApi ?? model === 'gpt-6-astra';
      expect(url.pathname).toBe(usesResponses ? '/v1/responses' : '/v1/chat/completions');
      expect(url.search).toBe('');
      expect(headers.get('authorization')).toBe(
        `Bearer ${parameters?.apiKey ?? 'openai-summary-key'}`,
      );
      expect(headers.has('api-key')).toBe(false);
      expect(headers.get('X-Global')).toBe('global');
      expect(headers.get('X-Summary')).toBe('openai');
      expect(body.model).toBe(model);
      expect(body).not.toHaveProperty('max_output_tokens', 2048);
      expect((agents[0].clientOptions as OpenAIConfiguration)?.apiKey).toBe('test-azure-key');
    },
  );

  it.each([
    { setting: 'OPENAI_API_KEY', value: undefined, model: 'gpt-4.1-mini' },
    { setting: 'OPENAI_API_KEY', value: 'user_provided', model: 'gpt-4.1-nano' },
    { setting: 'OPENAI_REVERSE_PROXY', value: 'user_provided', model: 'gpt-4o-mini' },
  ])(
    'runs the agent without summarization, not through Azure, when $setting is $value',
    async ({ setting, value, model }) => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        OPENAI_API_KEY: 'openai-summary-key',
        [setting]: value,
      });
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        appConfig: makeAppConfig([]),
        summarizeOnly: true,
        summarizationConfig: {
          provider: EModelEndpoint.openAI,
          model,
          parameters: { streaming: false },
        },
      });

      expect(agents[0].summarizationEnabled).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        `[createRun] Summarization with OpenAI model "${model}" is disabled for Azure OpenAI agents: it needs a server-configured OpenAI API key and base URL.`,
      );
      const requests: CapturedRequest[] = [];
      await expect(compactSummary(agents, requests)).rejects.toThrow(
        'Compaction skipped: summarization is not enabled for this agent',
      );
      expect(requests).toHaveLength(0);
    },
  );

  it('reports an unreachable OpenAI summarizer once per tenant across runs', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, OPENAI_API_KEY: undefined });
    const run = (tenantId?: string) =>
      callAndCapture({
        agents: [azureAstraAgent()],
        appConfig: makeAppConfig([]),
        tenantId,
        summarizationConfig: { provider: EModelEndpoint.openAI, model: 'o4-mini' },
      });

    for (const tenantId of [undefined, undefined, 'tenant-a', 'tenant-a', 'tenant-b']) {
      (Run.create as jest.Mock).mockClear();
      await run(tenantId);
    }

    const warnings = (logger.warn as jest.Mock).mock.calls.filter(([message]) =>
      String(message).includes('"o4-mini"'),
    );
    expect(warnings.map(([, meta]) => meta)).toEqual([
      undefined,
      { tenantId: 'tenant-a' },
      { tenantId: 'tenant-b' },
    ]);
  });

  it('expands environment placeholders in OpenAI and Azure summarizer credentials', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      OPENAI_API_KEY: 'openai-summary-key',
      SUMMARY_OPENAI_KEY: 'expanded-openai-key',
      SUMMARY_OPENAI_URL: 'https://expanded-gateway.example/v1',
      SUMMARY_AZURE_KEY: 'expanded-azure-key',
    });
    const appConfig = makeAppConfig([]);
    appConfig.endpoints![EModelEndpoint.azureOpenAI] = {
      isValid: true,
      errors: [],
      modelNames: ['gpt-6-astra', 'gpt-4.1-mini'],
      modelGroupMap: { 'gpt-6-astra': { group: 'main' }, 'gpt-4.1-mini': { group: 'summary' } },
      groupMap: {
        main: {
          apiKey: 'test-azure-key',
          instanceName: 'test-instance',
          version: '2025-04-01-preview',
          models: { 'gpt-6-astra': { deploymentName: 'production-deployment' } },
        },
        summary: {
          apiKey: 'summary-key',
          instanceName: 'summary-instance',
          version: '2024-10-21',
          models: { 'gpt-4.1-mini': { deploymentName: 'summary-production' } },
        },
      },
    };
    const compact = async (summarizationConfig: SummarizationConfig) => {
      (Run.create as jest.Mock).mockClear();
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        appConfig,
        summarizeOnly: true,
        summarizationConfig,
      });
      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      return requests[0];
    };

    const openAI = await compact({
      provider: EModelEndpoint.openAI,
      model: 'gpt-4.1-mini',
      parameters: {
        streaming: false,
        apiKey: '${SUMMARY_OPENAI_KEY}',
        baseURL: '${SUMMARY_OPENAI_URL}',
      },
    });
    expect(openAI.url.origin).toBe('https://expanded-gateway.example');
    expect(openAI.headers.get('authorization')).toBe('Bearer expanded-openai-key');

    const azure = await compact({
      model: 'gpt-4.1-mini',
      parameters: { streaming: false, apiKey: '${SUMMARY_AZURE_KEY}' },
    });
    expect(azure.url.origin).toBe('https://summary-instance.openai.azure.com');
    expect(azure.headers.get('api-key')).toBe('expanded-azure-key');
  });

  it("leaves Azure's reserved URL templates to the summary deployment", async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      INSTANCE_NAME: 'host-instance',
      DEPLOYMENT_NAME: 'host-deployment',
      SUMMARY_GATEWAY_PATH: 'openai',
    });
    const appConfig = makeAppConfig([]);
    appConfig.endpoints![EModelEndpoint.azureOpenAI] = {
      isValid: true,
      errors: [],
      modelNames: ['gpt-6-astra', 'gpt-4.1-mini'],
      modelGroupMap: { 'gpt-6-astra': { group: 'main' }, 'gpt-4.1-mini': { group: 'summary' } },
      groupMap: {
        main: {
          apiKey: 'test-azure-key',
          instanceName: 'test-instance',
          version: '2025-04-01-preview',
          models: { 'gpt-6-astra': { deploymentName: 'production-deployment' } },
        },
        summary: {
          apiKey: 'summary-key',
          instanceName: 'summary-instance',
          version: '2024-10-21',
          models: { 'gpt-4.1-mini': { deploymentName: 'summary-production' } },
        },
      },
    };
    const agents = await callAndCapture({
      agents: [azureAstraAgent()],
      appConfig,
      summarizeOnly: true,
      summarizationConfig: {
        model: 'gpt-4.1-mini',
        parameters: {
          streaming: false,
          baseURL:
            'https://${INSTANCE_NAME}.openai.azure.com/${SUMMARY_GATEWAY_PATH}/deployments/${DEPLOYMENT_NAME}',
        },
      },
    });

    const { requests } = await compactSummary(agents);
    expect(requests).toHaveLength(1);
    const { url } = requests[0];
    expect(url.origin + url.pathname).toBe(
      'https://summary-instance.openai.azure.com/openai/deployments/summary-production/chat/completions',
    );
  });

  it('expands Azure-reserved names as ordinary variables for an OpenAI summarizer', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      OPENAI_API_KEY: 'openai-summary-key',
      INSTANCE_NAME: 'gateway-host',
    });
    const agents = await callAndCapture({
      agents: [azureAstraAgent()],
      appConfig: makeAppConfig([]),
      summarizeOnly: true,
      summarizationConfig: {
        provider: EModelEndpoint.openAI,
        model: 'gpt-4.1-mini',
        parameters: { streaming: false, baseURL: 'https://${INSTANCE_NAME}.example/v1' },
      },
    });

    expect(agents[0].summarizationEnabled).toBe(true);
    const { requests } = await compactSummary(agents);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.origin).toBe('https://gateway-host.example');
  });

  it('disables summarization when a credential placeholder has no environment value', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, OPENAI_API_KEY: 'openai-summary-key' });
    const agents = await callAndCapture({
      agents: [azureAstraAgent()],
      appConfig: makeAppConfig([]),
      summarizeOnly: true,
      summarizationConfig: {
        provider: EModelEndpoint.openAI,
        model: 'gpt-4.1',
        parameters: { streaming: false, apiKey: '${UNSET_SUMMARY_KEY}' },
      },
    });

    expect(agents[0].summarizationEnabled).toBe(false);
    const requests: CapturedRequest[] = [];
    await expect(compactSummary(agents, requests)).rejects.toThrow(
      'Compaction skipped: summarization is not enabled for this agent',
    );
    expect(requests).toHaveLength(0);
  });

  it.each([
    {
      name: 'an inherited summary model absent from the Azure map',
      agent: () => azureAstraAgent(),
      summarizationConfig: { model: 'gpt-5.4-nano' },
      env: {},
      reason: 'Model named "gpt-5.4-nano" not found in configuration.',
    },
    {
      name: 'an explicit Azure summary model absent from the map on a non-Azure agent',
      agent: () => makeAgent(),
      summarizationConfig: { provider: EModelEndpoint.azureOpenAI, model: 'gpt-5.4-mini' },
      env: {},
      reason: 'Model named "gpt-5.4-mini" not found in configuration.',
    },
    {
      name: 'a mapped summary group whose base URL is user-provided',
      agent: () => azureAstraAgent(),
      summarizationConfig: { model: 'gpt-4.1' },
      env: { AZURE_OPENAI_BASEURL: 'user_provided' },
      reason: 'it needs a server-configured Azure OpenAI API key and base URL.',
    },
    {
      name: 'a mapped summary group with an empty API key',
      agent: () => azureAstraAgent(),
      summarizationConfig: { model: 'gpt-4.1-nano' },
      env: {},
      summaryApiKey: '',
      reason: 'it needs a server-configured Azure OpenAI API key and base URL.',
    },
    {
      name: 'a legacy Azure environment whose key is user-provided',
      agent: () => azureAstraAgent(),
      summarizationConfig: { model: 'gpt-4o' },
      env: { AZURE_API_KEY: 'user_provided' },
      legacyEnvironment: true,
      reason: 'it needs a server-configured Azure OpenAI API key and base URL.',
    },
  ])('disables summarization for $name', async (target) => {
    const { agent, summarizationConfig, env, reason } = target;
    jest.replaceProperty(process, 'env', { ...process.env, ...env });
    const appConfig = makeAppConfig([]);
    appConfig.endpoints![EModelEndpoint.azureOpenAI] = target.legacyEnvironment
      ? undefined
      : {
          isValid: true,
          errors: [],
          modelNames: ['gpt-6-astra', 'gpt-4.1', 'gpt-4.1-nano'],
          modelGroupMap: {
            'gpt-6-astra': { group: 'main' },
            'gpt-4.1': { group: 'summary' },
            'gpt-4.1-nano': { group: 'summary' },
          },
          groupMap: {
            main: {
              apiKey: 'test-azure-key',
              instanceName: 'test-instance',
              version: '2025-04-01-preview',
              models: { 'gpt-6-astra': { deploymentName: 'production-deployment' } },
            },
            summary: {
              apiKey: target.summaryApiKey ?? 'summary-key',
              instanceName: 'summary-instance',
              version: '2024-10-21',
              models: {
                'gpt-4.1': { deploymentName: 'summary-production' },
                'gpt-4.1-nano': { deploymentName: 'summary-nano' },
              },
            },
          },
        };
    const agents = await callAndCapture({
      agents: [agent()],
      appConfig,
      summarizeOnly: true,
      summarizationConfig: { ...summarizationConfig, parameters: { streaming: false } },
    });

    expect(agents[0].summarizationEnabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      `[createRun] Summarization with Azure OpenAI model "${summarizationConfig.model}" is disabled: ${reason}`,
    );
    const requests: CapturedRequest[] = [];
    await expect(compactSummary(agents, requests)).rejects.toThrow(
      'Compaction skipped: summarization is not enabled for this agent',
    );
    expect(requests).toHaveLength(0);
  });

  it("sends a summary deployment to its own resource when only the agent's group sets a base URL", async () => {
    const agentBaseURL =
      'https://agent-instance.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}';
    const appConfig = makeAppConfig([]);
    appConfig.endpoints![EModelEndpoint.azureOpenAI] = {
      isValid: true,
      errors: [],
      modelNames: ['gpt-4.1', 'gpt-4.1-mini'],
      modelGroupMap: { 'gpt-4.1': { group: 'main' }, 'gpt-4.1-mini': { group: 'summary' } },
      groupMap: {
        main: {
          apiKey: 'test-azure-key',
          instanceName: 'agent-instance',
          baseURL: agentBaseURL,
          version: '2024-10-21',
          models: { 'gpt-4.1': { deploymentName: 'agent-deployment' } },
        },
        summary: {
          apiKey: 'summary-key',
          instanceName: 'summary-instance',
          version: '2024-10-21',
          models: { 'gpt-4.1-mini': { deploymentName: 'summary-production' } },
        },
      },
    };
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-azure-key',
      {
        reverseProxyUrl: agentBaseURL,
        azure: {
          azureOpenAIApiInstanceName: 'agent-instance',
          azureOpenAIApiDeploymentName: 'agent-deployment',
          azureOpenAIApiVersion: '2024-10-21',
          azureOpenAIApiKey: 'test-azure-key',
        },
        modelOptions: { model: 'gpt-4.1' },
      },
      EModelEndpoint.azureOpenAI,
    );
    const agents = await callAndCapture({
      agents: [
        makeReasoningAgent({
          provider: EModelEndpoint.azureOpenAI,
          endpoint: EModelEndpoint.azureOpenAI,
          model: 'gpt-4.1',
          model_parameters: { ...llmConfig, configuration: configOptions },
        }),
      ],
      appConfig,
      summarizeOnly: true,
      summarizationConfig: { model: 'gpt-4.1-mini', parameters: { streaming: false } },
    });

    const { requests } = await compactSummary(agents);
    expect(requests).toHaveLength(1);
    const { url, headers, body } = requests[0];
    expect(url.origin + url.pathname).toBe(
      'https://summary-instance.openai.azure.com/openai/deployments/summary-production/chat/completions',
    );
    expect(headers.get('api-key')).toBe('summary-key');
    expect(body.model).toBe('summary-production');
  });

  it('sends no empty api-version to a serverless summary group without a version', async () => {
    const appConfig = makeAppConfig([]);
    appConfig.endpoints![EModelEndpoint.azureOpenAI] = {
      isValid: true,
      errors: [],
      modelNames: ['gpt-6-astra', 'Phi-4'],
      modelGroupMap: { 'gpt-6-astra': { group: 'main' }, 'Phi-4': { group: 'serverless' } },
      groupMap: {
        main: {
          apiKey: 'test-azure-key',
          instanceName: 'test-instance',
          version: '2025-04-01-preview',
          models: { 'gpt-6-astra': { deploymentName: 'production-deployment' } },
        },
        serverless: {
          apiKey: 'serverless-key',
          baseURL: 'https://phi-instance.services.ai.azure.com/models',
          serverless: true,
          models: { 'Phi-4': true },
        },
      },
    };
    const agents = await callAndCapture({
      agents: [azureAstraAgent()],
      appConfig,
      summarizeOnly: true,
      summarizationConfig: { model: 'Phi-4', parameters: { streaming: false } },
    });

    const { requests } = await compactSummary(agents);
    expect(requests).toHaveLength(1);
    const { url, headers } = requests[0];
    expect(url.origin + url.pathname).toBe(
      'https://phi-instance.services.ai.azure.com/models/chat/completions',
    );
    expect(url.search).toBe('');
    expect(headers.get('api-key')).toBe('serverless-key');
  });

  it.each([
    { summaryModel: 'gpt-4.1-mini', instance: 'test-instance', provider: undefined },
    {
      summaryModel: 'gpt-4.1-mini',
      instance: 'summary-instance',
      provider: EModelEndpoint.azureOpenAI,
    },
    { summaryModel: 'gpt-6-astra-2026-09-03', instance: 'summary-instance', provider: undefined },
  ])(
    'compacts with $summaryModel on $instance using its configured deployment',
    async ({ summaryModel, instance, provider }) => {
      const appConfig = makeAppConfig([]);
      appConfig.endpoints![EModelEndpoint.azureOpenAI] = {
        isValid: true,
        errors: [],
        modelNames: ['gpt-6-astra', summaryModel],
        modelGroupMap: { 'gpt-6-astra': { group: 'main' }, [summaryModel]: { group: 'summary' } },
        groupMap: {
          main: {
            apiKey: 'test-azure-key',
            instanceName: 'test-instance',
            version: '2025-04-01-preview',
            models: { 'gpt-6-astra': { deploymentName: 'production-deployment' } },
          },
          summary: {
            apiKey: 'summary-key',
            instanceName: instance,
            baseURL: `https://${instance}.openai.azure.com`,
            version: '2025-04-01-preview',
            additionalHeaders: { 'X-Summary-Group': 'summary' },
            models: { [summaryModel]: { deploymentName: 'summary-production' } },
          },
        },
      };
      const agents = await callAndCapture({
        agents: [azureAstraAgent()],
        appConfig,
        summarizeOnly: true,
        summarizationConfig: { model: summaryModel, provider, parameters: { streaming: false } },
      });
      const { requests } = await compactSummary(agents);
      expect(requests).toHaveLength(1);
      const { url, headers, body } = requests[0];
      const usesResponses = summaryModel.startsWith('gpt-6-astra');
      expect(url.origin).toBe(`https://${instance}.openai.azure.com`);
      expect(url.pathname).toBe(
        usesResponses
          ? '/openai/v1/responses'
          : '/openai/deployments/summary-production/chat/completions',
      );
      expect(headers.get('api-key')).toBe('summary-key');
      expect(headers.get('X-Summary-Group')).toBe('summary');
      expect(body.model).toBe('summary-production');
      expect(body).not.toHaveProperty('max_output_tokens', 2048);
      expect((agents[0].clientOptions as OpenAIConfiguration)?.apiKey).toBe('test-azure-key');
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 5: Multi-agent + per-agent overrides
// ---------------------------------------------------------------------------
describe('multi-agent + per-agent overrides', () => {
  it('normalizes missing persisted edges before creating the SDK graph', async () => {
    await createRun({
      agents: [makeAgent({ id: 'agent_1' }), makeAgent({ id: 'agent_2' })] as never,
      signal: new AbortController().signal,
      streaming: true,
      streamUsage: true,
    });

    const createMock = Run.create as jest.Mock;
    const runConfig = createMock.mock.calls[0][0] as {
      graphConfig: { type: string; edges: unknown[] };
    };
    expect(runConfig.graphConfig).toMatchObject({
      type: 'multi-agent',
      edges: [],
    });
  });

  it('different agents get different effectiveMaxContextTokens', async () => {
    const agents = await callAndCapture({
      agents: [
        makeAgent({ id: 'agent_1', baseContextTokens: 200_000, maxContextTokens: 100_000 }),
        makeAgent({ id: 'agent_2', baseContextTokens: 100_000, maxContextTokens: 50_000 }),
      ],
      summarizationConfig: {
        reserveRatio: 0.1,
        provider: 'anthropic',
        model: 'claude',
      },
    });
    // agent_1: Math.round(200000 * 0.9) = 180000, but capped at user's maxContextTokens (100000)
    expect(agents[0].maxContextTokens).toBe(100_000);
    // agent_2: Math.round(100000 * 0.9) = 90000, but capped at user's maxContextTokens (50000)
    expect(agents[1].maxContextTokens).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: initialSummary passthrough
// ---------------------------------------------------------------------------
describe('initialSummary passthrough', () => {
  it('forwarded to agent inputs', async () => {
    const summary = { text: 'Previous conversation summary', tokenCount: 500 };
    const agents = await callAndCapture({
      initialSummary: summary,
      summarizationConfig: { provider: 'anthropic', model: 'claude' },
    });
    expect(agents[0].initialSummary).toEqual(summary);
  });

  it('undefined when not provided', async () => {
    const agents = await callAndCapture({});
    expect(agents[0].initialSummary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 7: stable/dynamic system instructions
// ---------------------------------------------------------------------------
describe('stable/dynamic system instructions', () => {
  it('keeps static tool and agent instructions separate from dynamic runtime tail', async () => {
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          instructions: 'Base instructions',
          additional_instructions: 'Memory tail',
          toolContextMap: { web_search: 'Static tool instructions' },
          dynamicToolContextMap: { web_search: 'Conversation Date & Time: anchor' },
        }),
      ],
    });

    expect(agents[0].instructions).toBe('Static tool instructions\nBase instructions');
    expect(agents[0].additional_instructions).toBe('Conversation Date & Time: anchor\nMemory tail');
  });
});

// ---------------------------------------------------------------------------
// Suite 8: custom-endpoint provider resolution
// ---------------------------------------------------------------------------
describe('custom-endpoint provider resolution', () => {
  it('remaps a custom endpoint name to openAI and injects baseURL/apiKey', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('openAI');
    expect(config.model).toBe('llama3');

    const parameters = config.parameters as Record<string, unknown>;
    expect(parameters).toMatchObject({
      configuration: { baseURL: 'http://localhost:11434/v1' },
      apiKey: 'ollama-key',
    });
  });

  it('matches Ollama case-insensitively (via normalizeEndpointName)', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('openAI');
    expect((config.parameters as Record<string, unknown>).apiKey).toBe('ollama-key');
  });

  it('resolves non-Ollama endpoints on exact-case match', async () => {
    const appConfig = makeAppConfig([
      { name: 'Together', baseURL: 'https://api.together.ai/v1', apiKey: 'together-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Together', model: 'mixtral' },
      appConfig,
    });
    expect((agents[0].summarizationConfig as Record<string, unknown>).provider).toBe('openAI');
  });

  it('does not match non-Ollama endpoints with different casing', async () => {
    const appConfig = makeAppConfig([
      { name: 'Together', baseURL: 'https://api.together.ai/v1', apiKey: 'together-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'together', model: 'mixtral' },
      appConfig,
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('together');
    expect(config.parameters).toBeUndefined();
  });

  it('leaves known SDK providers untouched', async () => {
    const appConfig = makeAppConfig([]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'anthropic', model: 'claude' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('anthropic');
    expect(config.parameters).toBeUndefined();
  });

  it('preserves unknown provider names when appConfig is missing', async () => {
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('Ollama');
    expect(config.parameters).toBeUndefined();
  });

  it('leaves unrecognized names untouched when no matching custom endpoint exists', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'nonexistent', model: 'foo' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('nonexistent');
    expect(config.parameters).toBeUndefined();
  });

  it('extracts ${ENV_VAR} references in custom endpoint credentials', async () => {
    process.env.TEST_OLLAMA_KEY = 'resolved-key-value';
    try {
      const appConfig = makeAppConfig([
        {
          name: 'Ollama',
          baseURL: 'http://localhost:11434/v1',
          apiKey: '${TEST_OLLAMA_KEY}',
        },
      ]);
      const agents = await callAndCapture({
        summarizationConfig: { provider: 'Ollama', model: 'llama3' },
        appConfig,
      });

      const config = agents[0].summarizationConfig as Record<string, unknown>;
      const parameters = config.parameters as Record<string, unknown>;
      expect(parameters.apiKey).toBe('resolved-key-value');
    } finally {
      delete process.env.TEST_OLLAMA_KEY;
    }
  });

  it('keeps raw provider when apiKey is marked user_provided', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'user_provided' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    /**
     * Keep the raw name so the SDK raises "Unsupported LLM provider: Ollama"
     * rather than silently remapping to `openAI` and routing summaries to the
     * default backend. (User-provided creds cannot be resolved here — the
     * async DB lookup is out of scope for this synchronous code path.)
     */
    expect(config.provider).toBe('Ollama');
    expect(config.parameters).toBeUndefined();
  });

  it('keeps raw provider when env var reference cannot be resolved', async () => {
    delete process.env.UNSET_TEST_KEY;
    const appConfig = makeAppConfig([
      {
        name: 'Ollama',
        baseURL: 'http://localhost:11434/v1',
        apiKey: '${UNSET_TEST_KEY}',
      },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('Ollama');
    expect(config.parameters).toBeUndefined();
  });

  it('keeps raw provider when partial env var reference (prefix/suffix) stays unresolved', async () => {
    delete process.env.UNSET_TEST_SEGMENT;
    const appConfig = makeAppConfig([
      {
        name: 'Ollama',
        baseURL: 'https://${UNSET_TEST_SEGMENT}.example.com/v1',
        apiKey: 'ollama-key',
      },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('Ollama');
    /** Even though the baseURL is a partial-match pattern, it must not be forwarded. */
    expect(config.parameters).toBeUndefined();
  });

  it('merges overrides alongside user-supplied parameters', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: {
        provider: 'Ollama',
        model: 'llama3',
        parameters: { temperature: 0.2 },
      },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    const parameters = config.parameters as Record<string, unknown>;
    expect(parameters).toMatchObject({
      temperature: 0.2,
      apiKey: 'ollama-key',
    });
    const configuration = parameters.configuration as Record<string, unknown>;
    expect(configuration.baseURL).toBe('http://localhost:11434/v1');
  });

  it('forwards custom-endpoint headers as configuration.defaultHeaders', async () => {
    const appConfig = makeAppConfig([
      {
        name: 'Ollama',
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'ollama-key',
        headers: { 'X-Custom-Header': 'value-123' },
      },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    const parameters = config.parameters as Record<string, unknown>;
    const configuration = parameters.configuration as Record<string, unknown>;
    const defaultHeaders = configuration.defaultHeaders as Record<string, string>;
    expect(defaultHeaders['X-Custom-Header']).toBe('value-123');
  });

  it('runs custom-endpoint headers through resolveHeaders (not forwarded raw)', async () => {
    const { resolveHeaders } = jest.requireMock('~/utils/env') as {
      resolveHeaders: jest.Mock;
    };
    resolveHeaders.mockClear();

    const appConfig = makeAppConfig([
      {
        name: 'Ollama',
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'ollama-key',
        headers: { Authorization: 'Bearer ${TEST_PORTKEY_KEY}' },
      },
    ]);
    await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    /**
     * Templated header values must go through the same `resolveHeaders`
     * pipeline the main agent flow uses, so `${VAR}`/`{{BODY_FIELD}}`
     * references don't get forwarded verbatim to the summarization backend.
     */
    const call = resolveHeaders.mock.calls.find(
      (args: unknown[]) =>
        (args[0] as { headers?: Record<string, string> }).headers?.Authorization ===
        'Bearer ${TEST_PORTKEY_KEY}',
    );
    expect(call).toBeDefined();
  });

  it('uses the authoritative run tenant in custom-endpoint summarization headers', async () => {
    const appConfig = makeAppConfig([
      {
        name: 'Tenant Gateway',
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'gateway-key',
        headers: { 'X-Tenant-ID': '{{LIBRECHAT_USER_TENANT_ID}}' },
      },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Tenant Gateway', model: 'summary-model' },
      appConfig,
      user: { id: 'user-1', tenantId: 'stale-user-tenant' } as IUser,
      tenantId: 'request-tenant',
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    const parameters = config.parameters as Record<string, unknown>;
    const configuration = parameters.configuration as Record<string, unknown>;

    expect(configuration.defaultHeaders).toEqual({ 'X-Tenant-ID': 'request-tenant' });
  });

  it('forwards PROXY env var into summarization client configuration', async () => {
    const originalProxy = process.env.PROXY;
    process.env.PROXY = 'http://proxy.internal:3128';
    try {
      const appConfig = makeAppConfig([
        { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
      ]);
      const agents = await callAndCapture({
        summarizationConfig: { provider: 'Ollama', model: 'llama3' },
        appConfig,
      });

      const config = agents[0].summarizationConfig as Record<string, unknown>;
      const parameters = config.parameters as Record<string, unknown>;
      const configuration = parameters.configuration as Record<string, unknown>;
      /** getOpenAIConfig wires proxy through to fetchOptions.dispatcher (undici ProxyAgent). */
      expect(configuration.fetchOptions).toBeDefined();
    } finally {
      if (originalProxy === undefined) {
        delete process.env.PROXY;
      } else {
        process.env.PROXY = originalProxy;
      }
    }
  });

  it('skips overrides when summarization targets the same endpoint as the agent', async () => {
    /**
     * When summarization provider matches the agent's endpoint, we rely on
     * the SDK's self-summarize path (which reuses agentContext.clientOptions).
     * Overriding here would shallow-replace the agent's resolved configuration
     * (dynamic headers, proxy/fetch options) with yaml-only config.
     */
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      agents: [makeAgent({ provider: 'openAI', endpoint: 'Ollama' })],
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.provider).toBe('openAI');
    /** No overrides injected — SDK will pull from agentContext.clientOptions. */
    expect(config.parameters).toBeUndefined();
  });

  it('skips overrides when endpoints differ only by case for Ollama', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      agents: [makeAgent({ provider: 'openAI', endpoint: 'Ollama' })],
      summarizationConfig: { provider: 'ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.parameters).toBeUndefined();
  });

  it('applies overrides when summarization targets a different endpoint than the agent', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
      { name: 'Together', baseURL: 'https://api.together.ai/v1', apiKey: 'together-key' },
    ]);
    const agents = await callAndCapture({
      agents: [makeAgent({ provider: 'openAI', endpoint: 'Ollama' })],
      summarizationConfig: { provider: 'Together', model: 'mixtral' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    const parameters = config.parameters as Record<string, unknown>;
    expect(parameters.apiKey).toBe('together-key');
    expect((parameters.configuration as Record<string, unknown>).baseURL).toBe(
      'https://api.together.ai/v1',
    );
  });

  it('deep-merges user configuration with endpoint-resolved configuration', async () => {
    /**
     * User-supplied `parameters.configuration.defaultQuery` must merge with —
     * not replace — the resolved `configuration` (baseURL, defaultHeaders).
     */
    const appConfig = makeAppConfig([
      {
        name: 'Ollama',
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'ollama-key',
        headers: { 'X-Required-Header': 'keep-me' },
      },
    ]);
    const parameters: TestSummarizationParameters = {
      configuration: { defaultQuery: { 'api-version': '2024-06-01' } },
    };
    const agents = await callAndCapture({
      summarizationConfig: {
        provider: 'Ollama',
        model: 'llama3',
        parameters: parameters as SummarizationConfig['parameters'],
      },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    const resolvedParameters = config.parameters as Record<string, unknown>;
    const configuration = resolvedParameters.configuration as Record<string, unknown>;
    /** Endpoint defaults preserved... */
    expect(configuration.baseURL).toBe('http://localhost:11434/v1');
    expect((configuration.defaultHeaders as Record<string, string>)['X-Required-Header']).toBe(
      'keep-me',
    );
    /** ...alongside the user's additions. */
    expect(configuration.defaultQuery).toEqual({ 'api-version': '2024-06-01' });
  });

  it('user-supplied configuration.baseURL overrides resolved baseURL', async () => {
    /**
     * Deep-merge still lets user keys win on conflict — if a user explicitly
     * sets `configuration.baseURL` in their summarization parameters, it
     * must override the baseURL resolved from the endpoint config.
     */
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const parameters: TestSummarizationParameters = {
      configuration: { baseURL: 'https://user-override.example.com/v1' },
    };
    const agents = await callAndCapture({
      summarizationConfig: {
        provider: 'Ollama',
        model: 'llama3',
        parameters: parameters as SummarizationConfig['parameters'],
      },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    const resolvedParameters = config.parameters as Record<string, unknown>;
    const configuration = resolvedParameters.configuration as Record<string, unknown>;
    expect(configuration.baseURL).toBe('https://user-override.example.com/v1');
  });

  it('user-supplied summarization.parameters override endpoint defaults', async () => {
    /**
     * `getOpenAIConfig` defaults `streaming: true`, but a user who sets
     * `summarization.parameters.streaming: false` in their config has
     * explicitly opted out; the user's setting must win over endpoint
     * defaults injected from the custom endpoint config.
     */
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: {
        provider: 'Ollama',
        model: 'llama3',
        parameters: { streaming: false },
      },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    const parameters = config.parameters as Record<string, unknown>;
    expect(parameters.streaming).toBe(false);
    /** Endpoint defaults still injected for the rest. */
    expect(parameters.apiKey).toBe('ollama-key');
  });

  it('does not leak model/modelName from getOpenAIConfig defaults', async () => {
    const appConfig = makeAppConfig([
      { name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama-key' },
    ]);
    const agents = await callAndCapture({
      summarizationConfig: { provider: 'Ollama', model: 'llama3' },
      appConfig,
    });

    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.model).toBe('llama3');
    const parameters = config.parameters as Record<string, unknown>;
    /** Summarization.model must win — parameters must not carry a stale model/modelName. */
    expect(parameters.model).toBeUndefined();
    expect(parameters.modelName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite: built-in provider request shaping (#15598)
// ---------------------------------------------------------------------------
/**
 * A built-in provider produces no custom-endpoint config, so `getOpenAIConfig`
 * was skipped entirely and the summarizer learned neither which API its model
 * takes nor whether its endpoint is first-party. The agents SDK defaults its
 * model-specific constraints off without that declaration, so configured
 * parameters reached the model unshaped.
 *
 * These assert the declaration LibreChat emits, which is the half it owns; the
 * SDK's honoring of it is covered by its own tests.
 */
describe('built-in provider request shaping', () => {
  const anthropicAgent = () =>
    makeAgent({
      provider: 'anthropic',
      endpoint: 'anthropic',
      model: 'claude-sonnet-4.6',
      model_parameters: { model: 'claude-sonnet-4.6' },
    });

  const summarizeWith = async (
    parameters?: Record<string, unknown>,
    model = 'gpt-6-astra',
    appConfig = makeAppConfig([]),
  ): Promise<Record<string, unknown>> => {
    const agents = await callAndCapture({
      agents: [anthropicAgent()],
      appConfig,
      summarizationConfig: {
        provider: 'openAI',
        model,
        parameters: parameters as SummarizationConfig['parameters'],
      },
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    return config.parameters as Record<string, unknown>;
  };

  it('declares the first-party endpoint for a cross-provider built-in summarizer', async () => {
    expect(await summarizeWith(undefined, 'gpt-4o')).toMatchObject({ firstPartyEndpoint: true });
  });

  it('routes a Responses-only model to the Responses API', async () => {
    expect(await summarizeWith()).toMatchObject({
      firstPartyEndpoint: true,
      useResponsesApi: true,
    });
  });

  it('keeps the declaration alongside a translated reasoning effort', async () => {
    /**
     * The reachable failure from #15598: `resolveReasoningParams` translates the
     * scalar effort for the summarizer, and without the declaration an effort
     * the model rejects reached it verbatim.
     */
    expect(await summarizeWith({ reasoning_effort: 'minimal' })).toMatchObject({
      firstPartyEndpoint: true,
      reasoning: { effort: 'minimal' },
    });
  });

  it('does not claim a first-party endpoint behind a user configuration.baseURL', async () => {
    const parameters = await summarizeWith({
      configuration: { baseURL: 'https://gateway.internal/v1' },
    });
    expect(parameters.firstPartyEndpoint).toBeUndefined();
    expect(parameters.configuration).toMatchObject({
      baseURL: 'https://gateway.internal/v1',
      fetchOptions: { dispatcher: expect.any(Object) },
    });
  });

  it('does not claim a first-party endpoint behind a user baseURL', async () => {
    expect(await summarizeWith({ baseURL: 'https://gateway.internal/v1' })).toEqual({
      baseURL: 'https://gateway.internal/v1',
      configuration: { fetchOptions: { dispatcher: expect.any(Object) } },
    });
  });

  it('adds only transport policy while leaving credentials and model selection to the client', async () => {
    const parameters = await summarizeWith();
    expect(parameters.apiKey).toBeUndefined();
    expect(parameters.model).toBeUndefined();
    expect(parameters.modelName).toBeUndefined();
    expect(parameters.streaming).toBeUndefined();
    expect(parameters.configuration).toEqual({
      fetchOptions: { dispatcher: expect.any(Object) },
    });
  });

  it.each([
    { bodyTimeout: 900_000, headersTimeout: 300_000 },
    { bodyTimeout: 1_800_000, headersTimeout: 120_000 },
    { bodyTimeout: 0, headersTimeout: 0 },
  ])('forwards the cross-provider timeout policy %j', async (transportTimeouts) => {
    const appConfig = makeAppConfig([]);
    appConfig.endpoints!.agents = {
      modelResponseBodyTimeoutMs: transportTimeouts.bodyTimeout,
      modelResponseHeadersTimeoutMs: transportTimeouts.headersTimeout,
    };
    const parameters = await summarizeWith(undefined, 'gpt-4o', appConfig);
    const expected = getOpenAIConfig('unused', { transportTimeouts });
    const configuration = parameters.configuration as NonNullable<OpenAIConfiguration>;
    expect(configuration.fetchOptions?.dispatcher).toBe(
      expected.configOptions?.fetchOptions?.dispatcher,
    );
  });

  it('leaves a same-endpoint summarizer on the agent client options', async () => {
    const agents = await callAndCapture({
      appConfig: makeAppConfig([]),
      summarizationConfig: { provider: 'openAI', model: 'gpt-6-astra' },
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.parameters).toBeUndefined();
  });

  it('routes a reasoning model the way the agent flow would', async () => {
    /** `getOpenAIConfig` reads the effort from modelOptions, not from the merged
     * parameters, so it has to be handed the summarizer's own effort. */
    expect(await summarizeWith({ reasoning_effort: 'medium' }, 'gpt-5.6')).toMatchObject({
      firstPartyEndpoint: true,
      useResponsesApi: true,
      reasoning: { effort: 'medium' },
    });
  });

  it('withholds the declaration when a reverse proxy serves the built-in endpoint', async () => {
    process.env.OPENAI_REVERSE_PROXY = 'https://gateway.internal/v1';
    try {
      expect(await summarizeWith()).toEqual({
        configuration: { fetchOptions: { dispatcher: expect.any(Object) } },
      });
    } finally {
      delete process.env.OPENAI_REVERSE_PROXY;
    }
  });

  it('withholds the declaration when the base URL is user-provided', async () => {
    process.env.OPENAI_REVERSE_PROXY = 'user_provided';
    try {
      expect(await summarizeWith()).toEqual({
        configuration: { fetchOptions: { dispatcher: expect.any(Object) } },
      });
    } finally {
      delete process.env.OPENAI_REVERSE_PROXY;
    }
  });

  it('declares nothing for an agent whose custom endpoint normalized to openAI', async () => {
    /**
     * `initializeAgent` rewrites a custom-endpoint agent's provider to `openAI`
     * while its endpoint keeps the custom name. With summarization omitted, the
     * summarizer reuses that agent's client — which points at the gateway, not
     * at OpenAI.
     */
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          provider: 'openAI',
          endpoint: 'MyGateway',
          model: 'gpt-6-astra',
          model_parameters: { model: 'gpt-6-astra' },
        }),
      ],
      appConfig: makeAppConfig([
        { name: 'MyGateway', baseURL: 'https://gateway.internal/v1', apiKey: 'gw-key' },
      ]),
      summarizationConfig: { model: 'gpt-6-astra' },
    });
    const config = agents[0].summarizationConfig as Record<string, unknown>;
    expect(config.parameters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 8: subagentConfigs
// ---------------------------------------------------------------------------
describe('subagentConfigs', () => {
  it('is undefined when subagents are not enabled', async () => {
    const agents = await callAndCapture({});
    expect(agents[0].subagentConfigs).toBeUndefined();
  });

  it('keeps the poll tool available for existing tasks after spawning is disabled', async () => {
    const agents = await callAndCapture({
      subagentTasks: {
        store: new InMemorySubagentTaskStore(),
        scopeId: 'existing-task-scope',
      },
    });

    expect(agents[0].subagentConfigs).toBeUndefined();
    expect(agents[0].toolDefinitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'check_background_task' })]),
    );
  });

  it('adds self-spawn when enabled and allowSelf defaults to true', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ subagents: { enabled: true } })],
    });
    const configs = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    expect(Array.isArray(configs)).toBe(true);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ self: true, type: 'self' });
  });

  it('omits self-spawn when allowSelf is false', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ subagents: { enabled: true, allowSelf: false } })],
    });
    expect(agents[0].subagentConfigs).toBeUndefined();
  });

  it('adds explicit subagent configs with agentInputs', async () => {
    const child = makeAgent({
      id: 'agent_child',
      name: 'Researcher',
      description: 'Deep web research',
    });
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [child],
        }),
      ],
    });
    const configs = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      type: 'agent_child',
      name: 'Researcher',
      description: 'Deep web research',
    });
    expect(configs[0].agentInputs).toBeDefined();
    expect(configs[0].self).toBeUndefined();
  });

  it('adds explicit lazy subagent descriptors without eager agent inputs', async () => {
    const resolve = jest
      .fn()
      .mockResolvedValue(
        makeAgent({ id: 'agent_child', name: 'Researcher', description: 'Deep web research' }),
      );
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          lazySubagentConfigs: [
            {
              id: 'agent_child',
              name: 'Researcher',
              description: 'Deep web research',
              configId: 'agent_child:3:fingerprint',
              resolve,
            },
          ],
        }),
      ],
    });
    const configs = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      type: 'agent_child',
      configId: 'agent_child:3:fingerprint',
      allowNested: true,
    });
    expect(configs[0].agentInputs).toBeUndefined();
    expect(configs[0].resolveAgentInputs).toBeInstanceOf(Function);
    expect(resolve).not.toHaveBeenCalled();

    const childInputs = await (
      configs[0].resolveAgentInputs as (context: never) => Promise<{
        name?: string;
      }>
    )({ signal: new AbortController().signal } as never);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(childInputs.name).toBe('Researcher');
  });

  it.each([
    ['foreground', undefined],
    [
      'detached',
      {
        store: new InMemorySubagentTaskStore(),
        scopeId: 'file-context-task-scope',
      } satisfies SubagentTaskConfig,
    ],
  ])("preserves a lazy child's prepared File Context in %s execution", async (_mode, tasks) => {
    const fileContext = 'Attached document(s):\n```md\n# "child.txt"\nChild-only facts\n\n```';
    const resolve = jest.fn().mockResolvedValue(
      makeAgent({
        id: 'agent_child',
        name: 'Researcher',
        additional_instructions: fileContext,
      }),
    );
    const agents = await callAndCapture({
      subagentTasks: tasks,
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          lazySubagentConfigs: [
            {
              id: 'agent_child',
              name: 'Researcher',
              description: 'Uses private File Context',
              configId: 'agent_child:3:fingerprint',
              resolve,
            },
          ],
        }),
      ],
    });
    const [config] = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    const childInputs = await (
      config.resolveAgentInputs as (context: never) => Promise<Record<string, unknown>>
    )({ signal: new AbortController().signal } as never);

    expect(childInputs.additional_instructions).toBe(fileContext);
  });

  it('preserves prepared File Context for an eager legacy subagent', async () => {
    const fileContext = 'Attached document(s):\n```md\n# "child.txt"\nLegacy child facts\n\n```';
    const child = makeAgent({
      id: 'agent_child',
      name: 'Researcher',
      additional_instructions: fileContext,
    });
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [child],
        }),
      ],
    });
    const [config] = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    const childInputs = config.agentInputs as Record<string, unknown>;

    expect(childInputs.additional_instructions).toBe(fileContext);
  });

  it('uses a fresh expansion budget for each lazy descriptor resolution', async () => {
    const nestedDescriptors = Array.from({ length: 99 }, (_, index) => ({
      id: `agent_nested_${index}`,
      name: `Nested ${index}`,
      description: 'Nested lazy child',
      configId: `agent_nested_${index}:1:fingerprint`,
      resolve: jest.fn(),
    }));
    const resolve = jest.fn().mockResolvedValue(
      makeAgent({
        id: 'agent_child',
        subagents: { enabled: true, allowSelf: false },
        lazySubagentConfigs: nestedDescriptors,
      }),
    );
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          lazySubagentConfigs: [
            {
              id: 'agent_child',
              name: 'Child',
              description: 'Lazy child',
              configId: 'agent_child:1:fingerprint',
              resolve,
            },
          ],
        }),
      ],
    });
    const resolveAgentInputs = (agents[0].subagentConfigs as Array<Record<string, unknown>>)[0]
      .resolveAgentInputs as (context: never) => Promise<unknown>;
    const context = { signal: new AbortController().signal } as never;

    await expect(resolveAgentInputs(context)).resolves.toBeDefined();
    await expect(resolveAgentInputs(context)).resolves.toBeDefined();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('uses pristine top-level inputs for a graph resolved by a lazy child', async () => {
    const topLevelMember = makeAgent({
      id: 'agent_top_level_member',
      hasDeferredTools: true,
      toolDefinitions: [{ name: 'tool_search' }],
      toolRegistry: new Map([['deep_tool', { name: 'deep_tool', defer_loading: true }]]),
    });
    const definition = {
      type: 'late_team',
      name: 'Late team',
      description: 'Resolves after the parent input is built',
      agent_ids: [topLevelMember.id],
      edges: [],
      entry_agent_id: topLevelMember.id,
      result_agent_id: topLevelMember.id,
    };
    const resolve = jest.fn().mockResolvedValue(
      makeAgent({
        id: 'agent_lazy_parent',
        subagents: { enabled: true, allowSelf: false, graphs: [definition] },
        subagentGraphConfigs: [{ definition, memberConfigs: [topLevelMember] }],
      }),
    );
    const parent = makeAgent({
      id: 'agent_parent',
      subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_lazy_parent'] },
      lazySubagentConfigs: [
        {
          id: 'agent_lazy_parent',
          name: 'Lazy parent',
          description: 'Lazy graph owner',
          configId: 'agent_lazy_parent:1:fingerprint',
          resolve,
        },
      ],
    });

    const agents = await callAndCapture({
      agents: [topLevelMember, parent],
      messages: [],
      discoveredToolNames: ['deep_tool'],
    });
    const lazyConfig = (agents[1].subagentConfigs as Array<Record<string, unknown>>)[0];
    const resolvedInputs = await (
      lazyConfig.resolveAgentInputs as (context: never) => Promise<Record<string, unknown>>
    )({ signal: new AbortController().signal } as never);
    const graphConfig = (resolvedInputs.subagentConfigs as Array<Record<string, unknown>>)[0];
    const memberInput = (graphConfig.agents as Array<Record<string, unknown>>)[0];
    const memberRegistry = memberInput.toolRegistry as Map<string, { defer_loading?: boolean }>;

    expect(
      (agents[0].toolRegistry as Map<string, { defer_loading?: boolean }>).get('deep_tool'),
    ).toMatchObject({ defer_loading: false });
    expect(memberRegistry.get('deep_tool')).toMatchObject({ defer_loading: true });
    expect(memberInput.toolDefinitions).toEqual([{ name: 'tool_search' }]);
  });

  it('builds lazy graph inputs from initialized members instead of capability metadata', async () => {
    const childId = 'agent_lazy_capability_parent';
    const memberId = 'agent_lazy_capability_member';
    const metadata = makeAgent({ id: memberId, codeEnvAvailable: true });
    const initializedMember = makeAgent({
      id: memberId,
      codeEnvAvailable: true,
      toolDefinitions: [{ name: 'initialized_tool' }],
      toolRegistry: new Map([['initialized_tool', { name: 'initialized_tool' }]]),
    });
    const definition = {
      type: 'capability_team',
      name: 'Capability team',
      description: 'Uses the initialized member runtime',
      agent_ids: [childId, memberId],
      edges: [{ from: childId, to: memberId, edgeType: 'direct' as const }],
      entry_agent_id: childId,
      result_agent_id: memberId,
    };
    const resolve = jest.fn().mockImplementation(async () => {
      const initializedChild = makeAgent({
        id: childId,
        toolDefinitions: [{ name: 'child_tool' }],
        toolRegistry: new Map([['child_tool', { name: 'child_tool' }]]),
        subagents: { enabled: true, allowSelf: false, graphs: [definition] },
      });
      initializedChild.subagentGraphConfigs = [
        { definition, memberConfigs: [initializedChild, initializedMember] },
      ];
      return initializedChild;
    });
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          id: 'agent_parent',
          subagents: {
            enabled: true,
            allowSelf: false,
            agent_ids: [childId],
          },
          lazySubagentConfigs: [
            {
              id: childId,
              name: 'Lazy capability parent',
              description: 'Resolves its team on selection',
              configId: `${childId}:1:fingerprint`,
              subagentGraphMemberMetadata: [metadata],
              resolve,
            },
          ],
        }),
      ],
    });
    const lazyConfig = (agents[0].subagentConfigs as Array<Record<string, unknown>>)[0];
    const resolvedInputs = await (
      lazyConfig.resolveAgentInputs as (context: never) => Promise<Record<string, unknown>>
    )({ signal: new AbortController().signal } as never);
    const graphConfig = (resolvedInputs.subagentConfigs as Array<Record<string, unknown>>)[0];
    const memberInputs = graphConfig.agents as Array<Record<string, unknown>>;

    expect(memberInputs[0].toolDefinitions).toEqual([{ name: 'child_tool' }]);
    expect(memberInputs[0].toolRegistry).toEqual(new Map([['child_tool', { name: 'child_tool' }]]));
    expect(memberInputs[1].toolDefinitions).toEqual([{ name: 'initialized_tool' }]);
    expect(memberInputs[1].toolRegistry).toEqual(
      new Map([['initialized_tool', { name: 'initialized_tool' }]]),
    );
  });

  it('builds an explicit saved-agent team as one graph subagent config', async () => {
    const researcher = makeAgent({
      id: 'agent_researcher',
      name: 'Researcher',
      recursion_limit: 30,
    });
    const writer = makeAgent({
      id: 'agent_writer',
      name: 'Writer',
      recursion_limit: 24,
      subagents: { enabled: true, agent_ids: ['agent_nested'] },
      subagentAgentConfigs: [makeAgent({ id: 'agent_nested' })],
    });
    const definition = {
      type: 'research_team',
      name: 'Research team',
      description: 'Researches and writes a final answer',
      agent_ids: ['agent_researcher', 'agent_writer'],
      edges: [{ from: 'agent_researcher', to: 'agent_writer', edgeType: 'direct' as const }],
      entry_agent_id: 'agent_researcher',
      result_agent_id: 'agent_writer',
    };
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, graphs: [definition] },
          subagentGraphConfigs: [{ definition, memberConfigs: [researcher, writer] }],
        }),
      ],
    });

    const configs = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      kind: 'graph',
      type: 'research_team',
      name: 'Research team',
      description: 'Researches and writes a final answer',
      edges: definition.edges,
      entryAgentId: 'agent_researcher',
      resultAgentId: 'agent_writer',
      maxTurns: 8,
    });
    const memberInputs = configs[0].agents as Array<Record<string, unknown>>;
    expect(memberInputs.map((member) => member.agentId)).toEqual([
      'agent_researcher',
      'agent_writer',
    ]);
    expect(memberInputs.every((member) => member.subagentConfigs == null)).toBe(true);
  });

  it('builds a one-member graph subagent without edges', async () => {
    const member = makeAgent({ id: 'agent_solo', name: 'Solo' });
    const definition = {
      type: 'solo_team',
      name: 'Solo team',
      description: 'Runs one isolated graph member',
      agent_ids: ['agent_solo'],
      edges: [],
      entry_agent_id: 'agent_solo',
      result_agent_id: 'agent_solo',
    };
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, graphs: [definition] },
          subagentGraphConfigs: [{ definition, memberConfigs: [member] }],
        }),
      ],
    });

    expect(agents[0].subagentConfigs).toEqual([
      expect.objectContaining({
        kind: 'graph',
        type: 'solo_team',
        agents: [expect.objectContaining({ agentId: 'agent_solo' })],
        edges: [],
        entryAgentId: 'agent_solo',
        resultAgentId: 'agent_solo',
      }),
    ]);
  });

  it('normalizes an explicit false excludeResults value before SDK validation', async () => {
    const researcher = makeAgent({ id: 'agent_researcher' });
    const writer = makeAgent({ id: 'agent_writer' });
    const definition = {
      type: 'default_results_team',
      name: 'Default results team',
      description: 'Uses the default edge result behavior',
      agent_ids: ['agent_researcher', 'agent_writer'],
      edges: [
        {
          from: 'agent_researcher',
          to: 'agent_writer',
          edgeType: 'direct' as const,
          excludeResults: false,
        },
      ],
      entry_agent_id: 'agent_researcher',
      result_agent_id: 'agent_writer',
    };
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, graphs: [definition] },
          subagentGraphConfigs: [{ definition, memberConfigs: [researcher, writer] }],
        }),
      ],
    });

    const [config] = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    expect(config.edges).toEqual([
      { from: 'agent_researcher', to: 'agent_writer', edgeType: 'direct' },
    ]);
  });

  it("adds each graph member's always-apply skills to its isolated context", async () => {
    const member = makeAgent({
      id: 'agent_skilled_member',
      additional_instructions: 'Keep the response concise.',
      alwaysApplySkillPrimes: [
        { name: 'member-workflow', body: 'Follow the member-specific workflow.' },
      ],
    });
    const definition = {
      type: 'skilled_team',
      name: 'Skilled team',
      description: 'Runs a member with its own always-apply skill',
      agent_ids: ['agent_skilled_member'],
      edges: [],
      entry_agent_id: 'agent_skilled_member',
      result_agent_id: 'agent_skilled_member',
    };
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, graphs: [definition] },
          subagentGraphConfigs: [{ definition, memberConfigs: [member] }],
        }),
      ],
    });

    const [config] = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    const [memberInput] = config.agents as Array<Record<string, unknown>>;
    expect(memberInput.additional_instructions).toBe(
      'Keep the response concise.\n\n' +
        '# Always-apply skill: member-workflow\nFollow the member-specific workflow.',
    );
  });

  it('isolates a parent graph member before discovered tools mutate the parent registry', async () => {
    const agent = makeAgent({
      id: 'agent_parent',
      name: 'Parent',
      hasDeferredTools: true,
      toolDefinitions: [{ name: 'tool_search' }],
      toolRegistry: new Map([['deep_tool', { name: 'deep_tool', defer_loading: true }]]),
    });
    const definition = {
      type: 'self_team',
      name: 'Self team',
      description: 'Runs the parent as an isolated graph member',
      agent_ids: ['agent_parent'],
      edges: [],
      entry_agent_id: 'agent_parent',
      result_agent_id: 'agent_parent',
    };
    agent.subagents = { enabled: true, allowSelf: false, graphs: [definition] };
    agent.subagentGraphConfigs = [{ definition, memberConfigs: [agent] }];

    const agents = await callAndCapture({
      agents: [agent],
      messages: [],
      discoveredToolNames: ['deep_tool'],
    });

    const parentRegistry = agents[0].toolRegistry as Map<string, { defer_loading?: boolean }>;
    const graphConfig = (agents[0].subagentConfigs as Array<Record<string, unknown>>)[0];
    const memberInputs = graphConfig.agents as Array<Record<string, unknown>>;
    const memberRegistry = memberInputs[0].toolRegistry as Map<string, { defer_loading?: boolean }>;
    expect(parentRegistry.get('deep_tool')?.defer_loading).toBe(false);
    expect(memberRegistry.get('deep_tool')?.defer_loading).toBe(true);
    expect(memberInputs[0].toolDefinitions).toEqual([{ name: 'tool_search' }]);
  });

  it('snapshots graph members before an earlier top-level input mutates them', async () => {
    const earlierAgent = makeAgent({
      id: 'agent_earlier',
      name: 'Earlier',
      hasDeferredTools: true,
      toolDefinitions: [{ name: 'tool_search' }],
      toolRegistry: new Map([['deep_tool', { name: 'deep_tool', defer_loading: true }]]),
    });
    const definition = {
      type: 'cross_root_team',
      name: 'Cross-root team',
      description: 'Uses an earlier top-level agent as an isolated member',
      agent_ids: ['agent_earlier'],
      edges: [],
      entry_agent_id: 'agent_earlier',
      result_agent_id: 'agent_earlier',
    };
    const laterAgent = makeAgent({
      id: 'agent_later',
      name: 'Later',
      subagents: { enabled: true, allowSelf: false, graphs: [definition] },
      subagentGraphConfigs: [{ definition, memberConfigs: [earlierAgent] }],
    });

    const agents = await callAndCapture({
      agents: [earlierAgent, laterAgent],
      messages: [],
      discoveredToolNames: ['deep_tool'],
    });

    const earlierRegistry = agents[0].toolRegistry as Map<string, { defer_loading?: boolean }>;
    const laterGraph = (agents[1].subagentConfigs as Array<Record<string, unknown>>)[0];
    const memberInputs = laterGraph.agents as Array<Record<string, unknown>>;
    const memberRegistry = memberInputs[0].toolRegistry as Map<string, { defer_loading?: boolean }>;
    expect(earlierRegistry.get('deep_tool')?.defer_loading).toBe(false);
    expect(memberRegistry.get('deep_tool')?.defer_loading).toBe(true);
    expect(memberInputs[0].toolDefinitions).toEqual([{ name: 'tool_search' }]);
  });

  it('preserves explicit nested subagents across the SDK child graph boundary', async () => {
    const grandchild = makeAgent({ id: 'agent_grandchild', name: 'Grandchild' });
    const child = makeAgent({
      id: 'agent_child',
      name: 'Child',
      subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_grandchild'] },
      subagentAgentConfigs: [grandchild],
    });
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [child],
        }),
      ],
    });

    expect(agents[0].maxSubagentDepth).toBe(MAX_SUBAGENT_DEPTH);
    const childConfig = (agents[0].subagentConfigs as BuildChildInput[])[0];
    expect(childConfig.allowNested).toBe(true);

    const childInputs = buildChildInputs(childConfig, 'agent_child', MAX_SUBAGENT_DEPTH);
    expect(childInputs.maxSubagentDepth).toBe(MAX_SUBAGENT_DEPTH - 1);
    expect(childInputs.subagentConfigs).toHaveLength(1);
    expect(childInputs.subagentConfigs?.[0]).toMatchObject({
      type: 'agent_grandchild',
      allowNested: true,
    });
  });

  it('prunes shared-agent cycles per traversal path without dropping valid edges', async () => {
    const left = makeAgent({
      id: 'agent_left',
      name: 'Left',
      subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_shared'] },
    }) as TestRunAgent;
    const right = makeAgent({
      id: 'agent_right',
      name: 'Right',
      subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_shared'] },
    }) as TestRunAgent;
    const shared = makeAgent({
      id: 'agent_shared',
      name: 'Shared',
      subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_left'] },
    }) as TestRunAgent;
    left.subagentAgentConfigs = [shared];
    right.subagentAgentConfigs = [shared];
    shared.subagentAgentConfigs = [left];

    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: {
            enabled: true,
            allowSelf: false,
            agent_ids: ['agent_left', 'agent_right'],
          },
          subagentAgentConfigs: [left, right],
        }),
      ],
    });

    const rootConfigs = agents[0].subagentConfigs as BuildChildInput[];
    const rootConfigsByType = new Map(rootConfigs.map((config) => [config.type, config]));
    const leftConfig = rootConfigsByType.get('agent_left');
    const rightConfig = rootConfigsByType.get('agent_right');
    if (!leftConfig || !rightConfig) {
      throw new Error('Expected both root subagent configs');
    }
    const leftInputs = buildChildInputs(leftConfig, 'agent_left', MAX_SUBAGENT_DEPTH);
    const rightInputs = buildChildInputs(rightConfig, 'agent_right', MAX_SUBAGENT_DEPTH);
    const leftShared = leftInputs.subagentConfigs?.[0] as BuildChildInput | undefined;
    const rightShared = rightInputs.subagentConfigs?.[0] as BuildChildInput | undefined;
    if (
      !leftShared ||
      !rightShared ||
      leftInputs.maxSubagentDepth == null ||
      rightInputs.maxSubagentDepth == null
    ) {
      throw new Error('Expected both shared subagent configs');
    }
    const leftSharedInputs = buildChildInputs(
      leftShared,
      'agent_shared',
      leftInputs.maxSubagentDepth,
    );
    const rightSharedInputs = buildChildInputs(
      rightShared,
      'agent_shared',
      rightInputs.maxSubagentDepth,
    );

    expect(leftSharedInputs.subagentConfigs).toBeUndefined();
    expect(rightSharedInputs.subagentConfigs).toHaveLength(1);
    expect(rightSharedInputs.subagentConfigs?.[0]).toMatchObject({ type: 'agent_left' });
  });

  it('combines self-spawn and explicit subagents when both enabled', async () => {
    const child = makeAgent({ id: 'agent_child', name: 'Helper' });
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [child],
        }),
      ],
    });
    const configs = agents[0].subagentConfigs as Array<Record<string, unknown>>;
    expect(configs).toHaveLength(2);
    expect(configs[0].self).toBe(true);
    expect(configs[1].type).toBe('agent_child');
  });

  it('skips a child that points at the parent itself', async () => {
    const self = makeAgent({ id: 'agent_1' });
    const agents = await callAndCapture({
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_1'] },
          subagentAgentConfigs: [self],
        }),
      ],
    });
    expect(agents[0].subagentConfigs).toBeUndefined();
  });

  it('does NOT leak the parent run `initialSummary` into an explicit child (Codex P1 regression)', async () => {
    /**
     * `buildAgentInput` is a shared factory that always stamps the parent
     * run's `initialSummary` on the returned AgentInputs. When it's reused
     * to build a subagent child's inputs, `buildSubagentConfigs` must clear
     * that field — otherwise the child inherits unrelated conversation
     * context, defeating the isolation contract (and burning extra tokens).
     */
    const summary = { text: 'parent conversation summary', tokenCount: 99 };
    const child = makeAgent({ id: 'agent_child', name: 'Child' });
    const agents = await callAndCapture({
      initialSummary: summary,
      agents: [
        makeAgent({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [child],
        }),
      ],
    });

    const parent = agents[0];
    /** The parent itself keeps the summary — that's how it receives
     *  cross-turn context. */
    expect(parent.initialSummary).toEqual(summary);

    const childConfig = (parent.subagentConfigs as Array<Record<string, unknown>>)[0];
    const childInputs = childConfig.agentInputs as {
      initialSummary?: unknown;
      discoveredTools?: unknown;
    };
    expect(childInputs.initialSummary).toBeUndefined();
    expect(childInputs.discoveredTools).toBeUndefined();
  });

  it('rejects subagent graphs deeper than MAX_SUBAGENT_DEPTH before Run.create', async () => {
    await expect(
      createRun({
        agents: [makeSubagentChain(MAX_SUBAGENT_DEPTH + 1)] as never,
        signal: new AbortController().signal,
        streaming: true,
        streamUsage: true,
      }),
    ).rejects.toThrow(`maximum depth of ${MAX_SUBAGENT_DEPTH}`);

    expect(logger.warn).toHaveBeenCalledWith(
      '[createRun] Subagent graph depth limit exceeded',
      expect.objectContaining({
        agentId: `agent_chain_${MAX_SUBAGENT_DEPTH + 1}`,
        depth: MAX_SUBAGENT_DEPTH + 1,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
      }),
    );
    expect(Run.create).not.toHaveBeenCalled();
  });

  it('rejects layered DAGs that exceed MAX_SUBAGENT_RUN_CONFIGS expanded entries', async () => {
    await expect(
      createRun({
        agents: [makeLayeredSubagentDag(3, MAX_SUBAGENT_DEPTH)] as never,
        signal: new AbortController().signal,
        streaming: true,
        streamUsage: true,
      }),
    ).rejects.toThrow(`maximum of ${MAX_SUBAGENT_RUN_CONFIGS} expanded entries`);

    expect(logger.warn).toHaveBeenCalledWith(
      '[createRun] Subagent run configuration limit exceeded',
      expect.objectContaining({
        expandedConfigCount: MAX_SUBAGENT_RUN_CONFIGS + 1,
        maxSubagentRunConfigs: MAX_SUBAGENT_RUN_CONFIGS,
        rootAgentIds: ['agent_dag_root'],
      }),
    );
    expect(Run.create).not.toHaveBeenCalled();
  });
});

/**
 * Captures the top-level `Run.create` config (not just agentInputs) so tests
 * can assert presence/absence of run-level options.
 */
async function callAndCaptureRunConfig({
  overrides,
  user,
  tenantId,
  appConfig,
}: {
  overrides?: Record<string, unknown>;
  user?: Record<string, unknown>;
  tenantId?: string;
  appConfig?: AppConfig;
} = {}): Promise<Record<string, unknown>> {
  const agents = [makeAgent(overrides)];
  const signal = new AbortController().signal;

  await createRun({
    agents: agents as never,
    signal,
    streaming: true,
    streamUsage: true,
    user: user as never,
    tenantId,
    appConfig,
  });

  const createMock = Run.create as jest.Mock;
  expect(createMock).toHaveBeenCalledTimes(1);
  return createMock.mock.calls[0][0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite: Langfuse run config
// ---------------------------------------------------------------------------
const exportTelemetry = (plan: string, reason: string, tenantId?: string) => ({
  ...(tenantId ? { 'librechat.tenant.id': tenantId } : {}),
  'librechat.langfuse.export_plan': plan,
  'librechat.langfuse.export_reason': reason,
});

describe('Langfuse run config', () => {
  it('passes deterministic Langfuse trace config without tenant metadata by default', async () => {
    const callArgs = await callAndCaptureRunConfig();
    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled'),
    });
  });

  it('adds the explicit request tenant id to Langfuse trace metadata and tags', async () => {
    const callArgs = await callAndCaptureRunConfig({
      user: {
        id: 'user-1',
      },
      tenantId: 'tenant-1',
    });
    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled', 'tenant-1'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('falls back to a full user tenant id for direct createRun callers', async () => {
    const callArgs = await callAndCaptureRunConfig({
      user: {
        tenantId: 'tenant-2',
      },
    });
    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled', 'tenant-2'),
      metadata: { 'librechat.tenant.id': 'tenant-2' },
      tags: ['tenant:tenant-2'],
    });
  });

  it('forwards the requesting user and trace context into the Langfuse run config', async () => {
    await createRun({
      agents: [makeAgent()] as never,
      signal: new AbortController().signal,
      streaming: true,
      streamUsage: true,
      user: { id: 'user-1', email: 'alice@example.com', role: 'ADMIN' } as never,
      conversationId: 'convo-1',
      requestBody: { conversationId: 'convo-stale' },
      traceContext: { endpoint: 'agents', spec: 'support-bot' },
      appConfig: {
        langfuse: {
          trace: {
            userIdField: 'email',
            userMetadataFields: ['role'],
            conversationMetadataFields: ['conversationId', 'endpoint', 'provider', 'model', 'spec'],
          },
        },
      } as unknown as AppConfig,
    });

    const createMock = Run.create as jest.Mock;
    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      userId: 'alice@example.com',
      metadata: {
        'librechat.user.role': 'ADMIN',
        'librechat.conversation.id': 'convo-1',
        'librechat.endpoint': 'agents',
        'librechat.provider': 'openAI',
        'librechat.model': 'gpt-4o',
        'librechat.spec': 'support-bot',
      },
      librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled'),
    });
  });

  it('adds tenant Langfuse credentials from tenant-scoped app config', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout-collector:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'eu',
        },
      } as unknown as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-tenant-1',
      secretKey: 'sk-tenant-1',
      baseUrl: 'http://langfuse-fanout-collector:4318/tenant/eu',
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      librechatTraceAttributes: {
        ...exportTelemetry('tenant_fanout', 'configured', 'tenant-1'),
        'librechat.langfuse.tenant_export.enabled': 'true',
        'librechat.langfuse.destination': 'eu',
      },
      tags: ['tenant:tenant-1'],
    });
  });

  it('uses central env Langfuse config when deployment fanout is not enabled', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-central',
      secretKey: 'sk-central',
      baseUrl: 'https://central.langfuse.example',
      librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled', 'tenant-1'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('uses deployment fanout collector URL without auth when only tenant keys are configured', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry(
        'central_only',
        'destination_unconfigured',
        'tenant-1',
      ),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('routes tenant fanout traces to the configured tenant destination', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'us',
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toMatchObject({
      publicKey: 'pk-tenant-1',
      secretKey: 'sk-tenant-1',
      baseUrl: 'http://collector-from-env:4318/tenant/us',
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      librechatTraceAttributes: {
        ...exportTelemetry('tenant_fanout', 'configured', 'tenant-1'),
        'librechat.langfuse.tenant_export.enabled': 'true',
        'librechat.langfuse.destination': 'us',
      },
    });
  });

  it('normalizes trailing slashes when building the tenant-scoped fanout URL', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318/';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect((callArgs.langfuse as { baseUrl?: string } | undefined)?.baseUrl).toBe(
      'http://collector-from-env:4318/tenant/eu',
    );
  });

  it.each(['1', 'yes', 'on'])(
    'routes tenant fanout traces when global fanout is %s',
    async (value) => {
      process.env.LANGFUSE_FANOUT_ENABLED = value;
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

      const callArgs = await callAndCaptureRunConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'us',
          },
        } as AppConfig,
      });

      expect(callArgs.langfuse).toMatchObject({
        publicKey: 'pk-tenant-1',
        secretKey: 'sk-tenant-1',
        baseUrl: 'http://collector-from-env:4318/tenant/us',
        librechatTraceAttributes: {
          ...exportTelemetry('tenant_fanout', 'configured', 'tenant-1'),
          'librechat.langfuse.tenant_export.enabled': 'true',
          'librechat.langfuse.destination': 'us',
        },
      });
    },
  );

  it.each(['false', '0', 'no', 'off'])(
    'uses central env Langfuse config when global fanout is %s',
    async (value) => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
      process.env.LANGFUSE_SECRET_KEY = 'sk-central';
      process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
      process.env.LANGFUSE_FANOUT_ENABLED = value;
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

      const callArgs = await callAndCaptureRunConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'eu',
          },
        } as AppConfig,
      });

      expect(callArgs.langfuse).toEqual({
        deterministicTraceId: true,
        publicKey: 'pk-central',
        secretKey: 'sk-central',
        baseUrl: 'https://central.langfuse.example',
        librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled', 'tenant-1'),
        metadata: { 'librechat.tenant.id': 'tenant-1' },
        tags: ['tenant:tenant-1'],
      });
    },
  );

  it('does not append a tenant route to baseUrl when fanout is disabled', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    process.env.LANGFUSE_FANOUT_ENABLED = 'false';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toMatchObject({
      publicKey: 'pk-central',
      secretKey: 'sk-central',
      baseUrl: 'https://central.langfuse.example',
      librechatTraceAttributes: exportTelemetry('central_only', 'fanout_disabled', 'tenant-1'),
    });
    expect(callArgs.langfuse).not.toMatchObject({
      baseUrl: 'http://collector-from-env:4318/tenant/eu',
    });
  });

  it('uses central env Langfuse config when fanout has no collector URL', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      publicKey: 'pk-central',
      secretKey: 'sk-central',
      baseUrl: 'https://central.langfuse.example',
      librechatTraceAttributes: exportTelemetry(
        'central_only',
        'collector_unconfigured',
        'tenant-1',
      ),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('uses deployment fanout collector URL without auth when the tenant destination is not configured', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    process.env.LANGFUSE_FANOUT_TENANT_DESTINATIONS = 'eu=https://cloud.langfuse.com';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'unconfigured',
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry(
        'central_only',
        'destination_unconfigured',
        'tenant-1',
      ),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('uses deployment fanout collector URL without auth when tenant Langfuse config has no keys', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: { enabled: true },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'missing_credentials', 'tenant-1'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('uses deployment fanout collector URL without auth when app config is missing under fanout env', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'tenant_disabled', 'tenant-1'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('uses deployment fanout collector URL without auth when tenant fanout export is disabled', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_BASE_URL = 'https://central.langfuse.example';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'true';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'emergency_disabled', 'tenant-1'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('does not disable tenant fanout export for a blank emergency toggle', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
    process.env.LANGFUSE_SECRET_KEY = 'sk-central';
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
    process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = '  ';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: true,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
          destination: 'eu',
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318/tenant/eu',
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      publicKey: 'pk-tenant-1',
      secretKey: 'sk-tenant-1',
      tags: ['tenant:tenant-1'],
      librechatTraceAttributes: {
        ...exportTelemetry('tenant_fanout', 'configured', 'tenant-1'),
        'librechat.langfuse.tenant_export.enabled': 'true',
        'librechat.langfuse.destination': 'eu',
      },
    });
  });

  it.each(['true', '1', 'yes', 'on'])(
    'uses deployment fanout collector URL without auth when the emergency toggle is %s',
    async (value) => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
      process.env.LANGFUSE_SECRET_KEY = 'sk-central';
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
      process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = value;

      const callArgs = await callAndCaptureRunConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'eu',
          },
        } as AppConfig,
      });

      expect(callArgs.langfuse).toEqual({
        deterministicTraceId: true,
        baseUrl: 'http://collector-from-env:4318',
        librechatTraceAttributes: exportTelemetry('central_only', 'emergency_disabled', 'tenant-1'),
        metadata: { 'librechat.tenant.id': 'tenant-1' },
        tags: ['tenant:tenant-1'],
      });
    },
  );

  it.each(['false', '0', 'no', 'off'])(
    'routes tenant fanout traces when the emergency toggle is %s',
    async (value) => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-central';
      process.env.LANGFUSE_SECRET_KEY = 'sk-central';
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';
      process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = value;

      const callArgs = await callAndCaptureRunConfig({
        tenantId: 'tenant-1',
        appConfig: {
          langfuse: {
            enabled: true,
            publicKey: 'pk-tenant-1',
            secretKey: encryptV3('sk-tenant-1'),
            destination: 'eu',
          },
        } as AppConfig,
      });

      expect(callArgs.langfuse).toEqual({
        deterministicTraceId: true,
        baseUrl: 'http://collector-from-env:4318/tenant/eu',
        metadata: { 'librechat.tenant.id': 'tenant-1' },
        publicKey: 'pk-tenant-1',
        secretKey: 'sk-tenant-1',
        tags: ['tenant:tenant-1'],
        librechatTraceAttributes: {
          ...exportTelemetry('tenant_fanout', 'configured', 'tenant-1'),
          'librechat.langfuse.tenant_export.enabled': 'true',
          'librechat.langfuse.destination': 'eu',
        },
      });
    },
  );

  it('keeps central collector tracing when tenant Langfuse export is disabled', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: false,
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
        },
      } as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'tenant_disabled', 'tenant-1'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });

  it('keeps central collector tracing when tenant Langfuse enabled is the string false', async () => {
    process.env.LANGFUSE_FANOUT_ENABLED = 'true';
    process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://collector-from-env:4318';

    const callArgs = await callAndCaptureRunConfig({
      tenantId: 'tenant-1',
      appConfig: {
        langfuse: {
          enabled: 'false',
          publicKey: 'pk-tenant-1',
          secretKey: encryptV3('sk-tenant-1'),
        },
      } as unknown as AppConfig,
    });

    expect(callArgs.langfuse).toEqual({
      deterministicTraceId: true,
      baseUrl: 'http://collector-from-env:4318',
      librechatTraceAttributes: exportTelemetry('central_only', 'tenant_disabled', 'tenant-1'),
      metadata: { 'librechat.tenant.id': 'tenant-1' },
      tags: ['tenant:tenant-1'],
    });
  });
});

// ---------------------------------------------------------------------------
// Suite: toolOutputReferences gating
// ---------------------------------------------------------------------------
describe('toolOutputReferences gating', () => {
  it('passes toolOutputReferences when agent has codeEnvAvailable=true', async () => {
    const callArgs = await callAndCaptureRunConfig({
      overrides: { codeEnvAvailable: true },
    });
    expect(callArgs.toolOutputReferences).toEqual({ enabled: true });
  });

  it('omits toolOutputReferences when codeEnvAvailable is false', async () => {
    const callArgs = await callAndCaptureRunConfig({
      overrides: { codeEnvAvailable: false },
    });
    expect(callArgs).not.toHaveProperty('toolOutputReferences');
  });

  it('omits toolOutputReferences when codeEnvAvailable is unset', async () => {
    const callArgs = await callAndCaptureRunConfig();
    expect(callArgs).not.toHaveProperty('toolOutputReferences');
  });

  it('enables toolOutputReferences if any agent in a multi-agent run has codeEnvAvailable=true', async () => {
    const signal = new AbortController().signal;
    await createRun({
      agents: [
        makeAgent({ id: 'agent_a', codeEnvAvailable: false }),
        makeAgent({ id: 'agent_b', codeEnvAvailable: true }),
      ] as never,
      signal,
      streaming: true,
      streamUsage: true,
    });

    const createMock = Run.create as jest.Mock;
    const callArgs = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.toolOutputReferences).toEqual({ enabled: true });
  });

  it('enables toolOutputReferences when only a subagent has codeEnvAvailable=true', async () => {
    /**
     * Real scenario: a parent agent without `execute_code` spawns a
     * subagent that does have it. The SDK's shared tool-output
     * reference registry serves every ToolNode in the run, so the
     * subagent's `bash_tool` benefits from the run-level flag — and
     * without this gate looking at `subagentAgentConfigs`, the
     * subagent's `{{tool<idx>turn<turn>}}` placeholders would pass
     * through unsubstituted.
     */
    const signal = new AbortController().signal;
    const subagent = makeAgent({ id: 'agent_child', codeEnvAvailable: true });
    await createRun({
      agents: [
        makeAgent({
          id: 'agent_parent',
          codeEnvAvailable: false,
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [subagent],
        }),
      ] as never,
      signal,
      streaming: true,
      streamUsage: true,
    });

    const createMock = Run.create as jest.Mock;
    const callArgs = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.toolOutputReferences).toEqual({ enabled: true });
  });

  it('enables toolOutputReferences when a transitively-nested subagent has codeEnvAvailable=true', async () => {
    /**
     * Multi-level delegation (parent → child → grandchild): only the
     * grandchild has `codeEnvAvailable`. Verifies the recursion
     * descends past one level of `subagentAgentConfigs`.
     */
    const signal = new AbortController().signal;
    const grandchild = makeAgent({ id: 'agent_grandchild', codeEnvAvailable: true });
    const child = makeAgent({
      id: 'agent_child',
      codeEnvAvailable: false,
      subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_grandchild'] },
      subagentAgentConfigs: [grandchild],
    });
    await createRun({
      agents: [
        makeAgent({
          id: 'agent_parent',
          codeEnvAvailable: false,
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_child'] },
          subagentAgentConfigs: [child],
        }),
      ] as never,
      signal,
      streaming: true,
      streamUsage: true,
    });

    const createMock = Run.create as jest.Mock;
    const callArgs = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.toolOutputReferences).toEqual({ enabled: true });
  });

  it('enables tool output references from a lazy graph member metadata descriptor', async () => {
    const signal = new AbortController().signal;
    const graphMember = makeAgent({
      id: 'agent_lazy_graph_member',
      codeEnvAvailable: true,
      statefulCodeSessions: true,
    });
    const lazyChild = {
      ...makeAgent({ id: 'agent_lazy_child', codeEnvAvailable: false }),
      configId: 'agent_lazy_child:v1',
      subagentGraphMemberMetadata: [graphMember],
      resolve: jest.fn(),
    };
    await createRun({
      agents: [
        makeAgent({
          id: 'agent_parent',
          codeEnvAvailable: false,
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent_lazy_child'] },
          lazySubagentConfigs: [lazyChild],
        }),
      ] as never,
      signal,
      streaming: true,
      streamUsage: true,
    });

    const createMock = Run.create as jest.Mock;
    const callArgs = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.toolOutputReferences).toEqual({ enabled: true });
    /**
     * Stateful routing is intentionally agent-scoped. A lazy graph member must
     * not promote its execution profile into run-global SDK configuration.
     */
    expect(callArgs.toolExecution).toBeUndefined();
    expect(lazyChild.resolve).not.toHaveBeenCalled();
  });

  it('terminates and omits toolOutputReferences for a cyclic agent tree with no codeenv', async () => {
    /**
     * Cycle safety: `A → B → A`, neither has `codeEnvAvailable`. The
     * `visited` set in `anyAgentHasCodeEnv` must short-circuit the
     * recursion — without it this would stack-overflow before
     * `Run.create` is reached. Mirrors the cycle-safety pattern
     * `buildSubagentConfigs` already uses elsewhere in this module.
     */
    const signal = new AbortController().signal;
    type CyclicAgent = ReturnType<typeof makeAgent> & {
      subagentAgentConfigs?: ReturnType<typeof makeAgent>[];
    };
    const a = makeAgent({ id: 'agent_a', codeEnvAvailable: false }) as CyclicAgent;
    const b = makeAgent({ id: 'agent_b', codeEnvAvailable: false }) as CyclicAgent;
    a.subagentAgentConfigs = [b];
    b.subagentAgentConfigs = [a];

    await createRun({
      agents: [a] as never,
      signal,
      streaming: true,
      streamUsage: true,
    });

    const createMock = Run.create as jest.Mock;
    const callArgs = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('toolOutputReferences');
  });
});

// ---------------------------------------------------------------------------
// Suite: deferred-tool replay on HITL resume (Codex G3)
//
// The resume path rebuilds the graph with `messages: []` (state comes from the
// durable checkpoint), so the in-turn `tool_search` results that mark a deferred
// tool discovered aren't on the critical path. createRun's `discoveredToolNames`
// input replays those names — captured at pause — so the paused deferred tool is
// promoted back into `toolDefinitions` (and `defer_loading` flipped) and its schema
// is restored to the rebuilt model binding.
// ---------------------------------------------------------------------------
describe('createRun deferred-tool replay (HITL resume)', () => {
  /** Agent whose discoverable `deep_tool` lives ONLY in the registry (deferred). */
  const makeDeferredAgent = (registryExtra: Array<[string, Record<string, unknown>]> = []) => {
    const toolRegistry = new Map<string, Record<string, unknown>>([
      ['deep_tool', { name: 'deep_tool', defer_loading: true }],
      ...registryExtra,
    ]);
    return makeAgent({
      hasDeferredTools: true,
      // tool_search is in definitions; the discoverable deep_tool is NOT (deferred).
      toolDefinitions: [{ name: 'tool_search' }],
      toolRegistry,
    });
  };

  const captureAgents = async (
    agent: ReturnType<typeof makeAgent>,
    extra: Record<string, unknown>,
  ) => {
    const signal = new AbortController().signal;
    await createRun({
      agents: [agent] as never,
      signal,
      streaming: true,
      streamUsage: true,
      ...extra,
    });
    const createMock = Run.create as jest.Mock;
    const callArgs = createMock.mock.calls[0][0];
    return callArgs.graphConfig.agents as Array<Record<string, unknown>>;
  };

  const defNames = (agents: Array<Record<string, unknown>>): string[] =>
    (agents[0].toolDefinitions as Array<{ name: string }>).map((d) => d.name);

  it('promotes a replayed discovered tool into toolDefinitions when messages is empty (resume)', async () => {
    const agents = await captureAgents(makeDeferredAgent(), {
      messages: [],
      discoveredToolNames: ['deep_tool'],
    });
    expect(defNames(agents)).toContain('deep_tool');
  });

  it('does NOT include the deferred tool without replayed names (the bug being fixed)', async () => {
    const agents = await captureAgents(makeDeferredAgent(), { messages: [] });
    expect(defNames(agents)).not.toContain('deep_tool');
  });

  it('flips defer_loading=false on the replayed tool so the model binds it', async () => {
    const agents = await captureAgents(makeDeferredAgent(), {
      messages: [],
      discoveredToolNames: ['deep_tool'],
    });
    const registry = agents[0].toolRegistry as Map<string, { defer_loading?: boolean }>;
    expect(registry.get('deep_tool')?.defer_loading).toBe(false);
  });

  it('unions replayed names with names extracted from message history', async () => {
    const toolSearchResult = {
      _getType: () => 'tool',
      name: 'tool_search',
      content: JSON.stringify({ tools: [{ name: 'from_history' }] }),
    };
    const agents = await captureAgents(
      makeDeferredAgent([['from_history', { name: 'from_history', defer_loading: true }]]),
      { messages: [toolSearchResult], discoveredToolNames: ['deep_tool'] },
    );
    const names = defNames(agents);
    expect(names).toContain('deep_tool'); // replayed
    expect(names).toContain('from_history'); // extracted from messages
  });

  it('ignores replayed names when the agent has no deferred tools (inert)', async () => {
    const agents = await captureAgents(
      makeAgent({ hasDeferredTools: false, toolDefinitions: [], toolRegistry: new Map() }),
      { messages: [], discoveredToolNames: ['deep_tool'] },
    );
    expect(defNames(agents)).not.toContain('deep_tool');
  });
});

// ---------------------------------------------------------------------------
// Suite: HITL wiring gated to resumable callers (Codex J3)
//
// The tool-approval wiring (humanInTheLoop switch + PreToolUse hook) must engage ONLY for
// callers that implement the pause/resume lifecycle. AgentClient passes hitlCapable: true;
// the OpenAI-compatible + Responses controllers don't, so an approval-gated tool can't
// pause on a route with no approval surface or resume endpoint.
// ---------------------------------------------------------------------------
describe('HITL wiring is gated on hitlCapable', () => {
  const hitlAppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      [EModelEndpoint.agents]: { toolApproval: { enabled: true } },
    },
  } as unknown as AppConfig;

  const runAndGetConfig = async (extra: Record<string, unknown>) => {
    await createRun({
      agents: [makeAgent()] as never,
      signal: new AbortController().signal,
      appConfig: hitlAppConfig,
      streaming: true,
      streamUsage: true,
      ...extra,
    });
    const createMock = Run.create as jest.Mock;
    return createMock.mock.calls[0][0] as Record<string, unknown>;
  };

  it('attaches humanInTheLoop when the caller is hitlCapable and approval is enabled', async () => {
    const config = await runAndGetConfig({ hitlCapable: true });
    expect(config.humanInTheLoop).toBeDefined();
    expect(config.hooks).toBeDefined();
  });

  it('does NOT attach HITL for a non-resumable caller even when approval is enabled', async () => {
    const config = await runAndGetConfig({ hitlCapable: false });
    expect(config).not.toHaveProperty('humanInTheLoop');
    expect(config.graphConfig).toBeDefined();
    // No checkpointer either — the run is identical to the no-HITL path.
    expect(
      (config.graphConfig as { compileOptions?: { checkpointer?: unknown } }).compileOptions
        ?.checkpointer,
    ).toBeUndefined();
  });

  it('defaults to non-HITL when hitlCapable is omitted', async () => {
    const config = await runAndGetConfig({});
    expect(config).not.toHaveProperty('humanInTheLoop');
  });

  it('heals aliases discovered when a lazy subagent resolves', async () => {
    const alias = { name: 'delete_mcp_acme', aliasName: 'acme_delete_mcp_acme' };
    const resolvedChild = makeAgent({ id: 'lazy-child', mcpToolAliases: [alias] });
    const lazyChild = {
      ...makeAgent({ id: 'lazy-child' }),
      configId: 'lazy-child:v1',
      resolve: jest.fn().mockResolvedValue(resolvedChild),
    };
    const parent = makeAgent({
      subagents: { enabled: true, allowSelf: false },
      lazySubagentConfigs: [lazyChild],
    });
    const appConfig = {
      ...hitlAppConfig,
      endpoints: {
        [EModelEndpoint.agents]: {
          toolApproval: { enabled: true, mode: 'bypass', deny: [alias.aliasName] },
        },
      },
    } as unknown as AppConfig;

    await createRun({
      agents: [parent] as never,
      signal: new AbortController().signal,
      appConfig,
      streaming: true,
      streamUsage: true,
      hitlCapable: true,
    });
    const config = (Run.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    const hooks = config.hooks as { getMatchers: (event: string) => unknown[] };
    const lazyConfig = (
      (config.graphConfig as { agents: Array<Record<string, unknown>> }).agents[0]
        .subagentConfigs as Array<Record<string, unknown>>
    ).find((entry) => entry.configId === lazyChild.configId);

    expect(hooks.getMatchers('PreToolUse')).toHaveLength(1);
    await (lazyConfig?.resolveAgentInputs as (context: never) => Promise<unknown>)({
      signal: new AbortController().signal,
    } as never);
    expect(hooks.getMatchers('PreToolUse')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite: ask_user_question run wiring
//
// The ask tool pauses via a LangGraph `interrupt()` raised from its own body, so it
// needs a durable checkpointer but NOT the tool-approval policy. It must be stripped
// fail-closed from non-HITL callers (no resume surface) and from subagent child
// configs (a child graph cannot pause the parent run).
// ---------------------------------------------------------------------------
describe('ask_user_question run wiring', () => {
  const ASK = 'ask_user_question';
  const askToolInstance = { name: ASK };
  /** Approval policy NOT enabled — the ask tool must work without it. */
  const plainAppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: { [EModelEndpoint.agents]: {} },
  } as unknown as AppConfig;

  const runAndGetConfig = async (
    agent: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => {
    await createRun({
      agents: [agent] as never,
      signal: new AbortController().signal,
      appConfig: plainAppConfig,
      streaming: true,
      streamUsage: true,
      ...extra,
    });
    const createMock = Run.create as jest.Mock;
    return createMock.mock.calls[0][0] as Record<string, unknown>;
  };

  const getCheckpointer = (config: Record<string, unknown>) =>
    (config.graphConfig as { compileOptions?: { checkpointer?: unknown } }).compileOptions
      ?.checkpointer;

  const firstAgent = (config: Record<string, unknown>) =>
    (config.graphConfig as { agents: Array<Record<string, unknown>> }).agents[0];

  /**
   * Every run now carries a `PostToolBatch`-only registry for step-budget
   * awareness, so registry presence no longer proves HITL wiring. What still
   * distinguishes an approval-gated run is the `PreToolUse` policy hook, and
   * `PostToolBatch` is deliberately outside the SDK's
   * `RESULT_ALTERING_HOOK_EVENTS`, so it cannot disable eager tool prestart.
   */
  const hasToolApprovalPolicyHook = (config: Record<string, unknown>) =>
    (config.hooks as { hasHookFor?: (event: string) => boolean } | undefined)?.hasHookFor?.(
      'PreToolUse',
    ) === true;

  it('attaches the checkpointer WITHOUT humanInTheLoop when hitlCapable and the ask tool is present (approval disabled)', async () => {
    const config = await runAndGetConfig(makeAgent({ tools: [askToolInstance] }), {
      hitlCapable: true,
    });
    expect(config).not.toHaveProperty('humanInTheLoop');
    expect(hasToolApprovalPolicyHook(config)).toBe(false);
    expect(getCheckpointer(config)).toBeDefined();
    const agent = firstAgent(config);
    // The tool rides the in-graph direct path (graphTools) — never the
    // event-dispatched surfaces, where interrupt() cannot pause the run.
    expect((agent.graphTools as Array<{ name: string }>).map((t) => t.name)).toEqual([ASK]);
    expect((agent.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain(ASK);
  });

  it('detects the tool via toolRegistry / toolDefinitions too', async () => {
    const viaRegistry = await runAndGetConfig(
      makeAgent({ toolRegistry: new Map([[ASK, { name: ASK }]]) }),
      { hitlCapable: true },
    );
    expect(getCheckpointer(viaRegistry)).toBeDefined();
    jest.clearAllMocks();
    const viaDefinitions = await runAndGetConfig(makeAgent({ toolDefinitions: [{ name: ASK }] }), {
      hitlCapable: true,
    });
    expect(getCheckpointer(viaDefinitions)).toBeDefined();
  });

  it('strips the tool and attaches no checkpointer for a non-HITL caller', async () => {
    const config = await runAndGetConfig(
      makeAgent({
        tools: [askToolInstance, { name: 'other_tool' }],
        toolDefinitions: [{ name: ASK }, { name: 'other_tool' }],
        toolRegistry: new Map([
          [ASK, { name: ASK }],
          ['other_tool', { name: 'other_tool' }],
        ]),
      }),
      { hitlCapable: false },
    );
    expect(getCheckpointer(config)).toBeUndefined();
    const agent = firstAgent(config);
    expect((agent.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['other_tool']);
    expect((agent.toolDefinitions as Array<{ name: string }>).map((d) => d.name)).toEqual([
      'other_tool',
    ]);
    expect((agent.toolRegistry as Map<string, unknown>).has(ASK)).toBe(false);
    expect((agent.toolRegistry as Map<string, unknown>).has('other_tool')).toBe(true);
  });

  it('does not mutate the caller-owned toolRegistry when stripping (clone-before-mutate)', async () => {
    const sharedRegistry = new Map([[ASK, { name: ASK }]]);
    await runAndGetConfig(makeAgent({ toolRegistry: sharedRegistry }), { hitlCapable: false });
    expect(sharedRegistry.has(ASK)).toBe(true);
  });

  it('strips the tool from subagent child configs even on an HITL-capable run', async () => {
    const child = makeAgent({
      id: 'agent_child',
      name: 'Child',
      tools: [askToolInstance],
      toolDefinitions: [{ name: ASK }],
      toolRegistry: new Map([[ASK, { name: ASK }]]),
    });
    const parent = makeAgent({
      tools: [askToolInstance],
      subagents: { enabled: true, allowSelf: false },
      subagentAgentConfigs: [child],
    });
    const config = await runAndGetConfig(parent, { hitlCapable: true });
    // Parent keeps the tool — as an in-graph direct tool — and gets the checkpointer…
    expect((firstAgent(config).graphTools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      ASK,
    ]);
    expect(getCheckpointer(config)).toBeDefined();
    // …the child copy is stripped everywhere, with no graphTools replacement.
    const subagentConfigs = firstAgent(config).subagentConfigs as Array<{
      agentInputs: Record<string, unknown>;
    }>;
    expect(subagentConfigs).toHaveLength(1);
    const childInputs = subagentConfigs[0].agentInputs;
    expect(childInputs.graphTools).toBeUndefined();
    expect((childInputs.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain(ASK);
    expect((childInputs.toolDefinitions as Array<{ name: string }>).map((d) => d.name)).toEqual([]);
    expect((childInputs.toolRegistry as Map<string, unknown>).has(ASK)).toBe(false);
  });

  it('a subagent-only ask tool attaches no checkpointer (top-level agents decide)', async () => {
    const child = makeAgent({ id: 'agent_child', name: 'Child', tools: [askToolInstance] });
    const parent = makeAgent({
      subagents: { enabled: true, allowSelf: false },
      subagentAgentConfigs: [child],
    });
    const config = await runAndGetConfig(parent, { hitlCapable: true });
    expect(getCheckpointer(config)).toBeUndefined();
  });

  it('excludes ask_user_question from eager event tool execution', async () => {
    const config = await runAndGetConfig(makeAgent(), { hitlCapable: true });
    const eager = config.eagerEventToolExecution as { excludeToolNames: string[] };
    expect(eager.excludeToolNames).toContain(ASK);
  });

  it('admin filteredTools is a real kill switch: strips the tool and blocks the checkpointer even on an HITL-capable run', async () => {
    const filteredConfig = {
      ...(plainAppConfig as unknown as Record<string, unknown>),
      filteredTools: [ASK],
    } as unknown as AppConfig;
    await createRun({
      agents: [
        makeAgent({
          tools: [askToolInstance],
          toolDefinitions: [{ name: ASK }],
          toolRegistry: new Map([[ASK, { name: ASK }]]),
        }),
      ] as never,
      signal: new AbortController().signal,
      appConfig: filteredConfig,
      streaming: true,
      streamUsage: true,
      hitlCapable: true,
    });
    const config = (Run.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(getCheckpointer(config)).toBeUndefined();
    const agent = firstAgent(config);
    expect((agent.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([]);
    expect((agent.toolDefinitions as Array<{ name: string }>).map((d) => d.name)).toEqual([]);
    expect((agent.toolRegistry as Map<string, unknown>).has(ASK)).toBe(false);
  });

  it('an includedTools allowlist disables the tool unless listed (allowlist precedence)', async () => {
    const withoutTool = {
      ...(plainAppConfig as unknown as Record<string, unknown>),
      includedTools: ['calculator'],
    } as unknown as AppConfig;
    await createRun({
      agents: [makeAgent({ tools: [askToolInstance] })] as never,
      signal: new AbortController().signal,
      appConfig: withoutTool,
      streaming: true,
      streamUsage: true,
      hitlCapable: true,
    });
    let config = (Run.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(getCheckpointer(config)).toBeUndefined();
    expect((firstAgent(config).tools as Array<{ name: string }>).map((t) => t.name)).toEqual([]);

    jest.clearAllMocks();
    const withTool = {
      ...(plainAppConfig as unknown as Record<string, unknown>),
      // includedTools wins over filteredTools — same precedence as loadAndFormatTools.
      includedTools: [ASK],
      filteredTools: [ASK],
    } as unknown as AppConfig;
    await createRun({
      agents: [makeAgent({ tools: [askToolInstance] })] as never,
      signal: new AbortController().signal,
      appConfig: withTool,
      streaming: true,
      streamUsage: true,
      hitlCapable: true,
    });
    config = (Run.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(getCheckpointer(config)).toBeDefined();
    expect((firstAgent(config).graphTools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      ASK,
    ]);
  });

  it('composes with the approval policy: both humanInTheLoop and the checkpointer attach', async () => {
    const approvalConfig = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      endpoints: { [EModelEndpoint.agents]: { toolApproval: { enabled: true } } },
    } as unknown as AppConfig;
    await createRun({
      agents: [makeAgent({ tools: [askToolInstance] })] as never,
      signal: new AbortController().signal,
      appConfig: approvalConfig,
      streaming: true,
      streamUsage: true,
      hitlCapable: true,
    });
    const config = (Run.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(config.humanInTheLoop).toBeDefined();
    expect(getCheckpointer(config)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// summarizeOnly resolution (manual compaction)
// ---------------------------------------------------------------------------
describe('summarizeOnly resolution', () => {
  it('is absent on an ordinary run', async () => {
    const agents = await callAndCapture();
    expect(agents[0].summarizeOnly).toBeUndefined();
  });

  it('marks only the primary agent of a compaction run', async () => {
    const agents = await callAndCapture({
      agents: [makeAgent({ id: 'agent_primary' }), makeAgent({ id: 'agent_next' })],
      summarizeOnly: true,
    });
    expect(agents[0].summarizeOnly).toBe(true);
    expect(agents[1].summarizeOnly).toBeUndefined();
  });
});
