/**
 * Byte-identity guard for the assembled system prompt.
 *
 * Each case runs the real producers: `initializeAgent` (project, memory guard,
 * artifacts, skills catalog, temporal instructions, tool context maps from
 * `loadTools`), the request stage `AgentClient.buildMessages` applies through
 * `applyContextToAgent` (RAG, memory, agent files, MCP), and `createRun`. It
 * records the `instructions` and `additional_instructions` every graph agent
 * receives.
 *
 * Cases run with `promptCache.stableContext` off, where the previous
 * implementation is the oracle. The snapshot was written by this harness on the
 * commit before structured system parts, where the producers concatenated
 * strings, so any byte the refactor moves fails here. Long fixed texts (artifacts prompts, web search
 * instructions, memory preamble) are replaced by placeholders after capture;
 * placeholders only substitute exact occurrences, so separators around them
 * are still compared byte for byte.
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

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  extractLibreChatParams: jest.fn(() => ({ resendFiles: false, modelOptions: {} })),
  getModelMaxTokens: jest.fn(() => 200000),
}));

jest.mock('~/endpoints', () => ({
  getProviderConfig: jest.fn(({ provider }: { provider: string }) => ({
    overrideProvider: provider,
    getOptions: jest.fn(async () => ({ llmConfig: { model: 'test-model', maxTokens: 4096 } })),
  })),
}));

jest.mock('~/files', () => ({
  filterFilesByEndpointConfig: jest.fn(() => []),
  filterFilesByEndpointRuntimeConfig: jest.fn(() => []),
  isLegacyFileUploadUX: jest.fn(() => false),
}));

jest.mock('../resources', () => ({
  primeResources: jest.fn().mockResolvedValue({ attachments: [], tool_resources: undefined }),
}));

import { Types } from 'mongoose';
import { Run, Providers } from '@librechat/agents';
import { EModelEndpoint, ArtifactModes, FileContext } from 'librechat-data-provider';
import type { Agent, TFile } from 'librechat-data-provider';
import type { InitializeAgentDbMethods } from '../initialize';
import type { MCPManager } from '~/mcp/MCPManager';
import { buildWebSearchContext, buildWebSearchDynamicContext } from '~/tools/toolkits/web';
import { formatMemoryContext, memoryInstructions } from '../memory';
import { generateArtifactsPrompt } from '~/prompts';
import { applyContextToAgent } from '../context';
import { initializeAgent } from '../initialize';
import { createRun } from '../run';

jest.setTimeout(30000);

const TIMEZONE = 'Africa/Nairobi';
const TURN_STARTED_AT = new Date('2026-03-09T20:30:00.000Z').getTime();
const CONVERSATION_CREATED_AT = new Date('2026-03-09T20:00:00.000Z').getTime();
const USER_ID = new Types.ObjectId();
const SKILL_ID = new Types.ObjectId();

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Longest first: the shadcn artifacts prompt starts with the default one. */
const PLACEHOLDERS: Array<[string, string]> = [
  [
    generateArtifactsPrompt({ endpoint: 'openAI', artifacts: ArtifactModes.DEFAULT }) ?? '',
    '<artifacts:default>',
  ] as [string, string],
  ...(['openAI', EModelEndpoint.anthropic] as const).map((endpoint): [string, string] => [
    generateArtifactsPrompt({ endpoint, artifacts: ArtifactModes.SHADCNUI }) ?? '',
    `<artifacts:${ArtifactModes.SHADCNUI}:${endpoint}>`,
  ]),
  [buildWebSearchContext(true), '<web_search:instructions:stable>'] as [string, string],
  [buildWebSearchContext(false), '<web_search:instructions>'] as [string, string],
  [memoryInstructions, '<memory:instructions>'] as [string, string],
].sort(([a], [b]) => b.length - a.length);

function redact(value: unknown): Json {
  if (typeof value === 'string') {
    let text = value;
    for (const [long, short] of PLACEHOLDERS) {
      if (long !== '') {
        text = text.split(long).join(short);
      }
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return (value ?? null) as Json;
}

interface AgentSetup {
  id?: string;
  provider?: string;
  instructions?: string;
  additional_instructions?: string;
  artifacts?: string;
  memoryTools?: boolean;
  project?: string;
  skills?: boolean;
  webSearch?: boolean;
  toolFiles?: boolean;
  /** Request stage: what `AgentClient.buildMessages` adds. */
  rag?: string;
  memory?: string;
  agentFiles?: string;
  mcp?: string;
  /** Uploads staged for this turn's code execution (`queued_code_files`). */
  queuedFile?: boolean;
  promptCache?: boolean;
}

const mcpManager = {
  formatInstructionsForContext: jest.fn(
    async () => '# MCP Server Instructions\n\n## docs\nUse docs.',
  ),
} as unknown as MCPManager;

function createDb(): InitializeAgentDbMethods {
  return {
    getProjectFiles: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([]),
    getConvoFiles: jest.fn().mockResolvedValue([]),
    updateFilesUsage: jest.fn().mockResolvedValue([]),
    getUserKey: jest.fn().mockResolvedValue('user-1'),
    getUserKeyValues: jest.fn().mockResolvedValue([]),
    getToolFilesByIds: jest.fn().mockResolvedValue([]),
    listSkillsByAccess: jest.fn(async () => ({
      skills: [
        {
          _id: SKILL_ID,
          name: 'release-notes',
          description: 'Drafts release notes from a changelog.',
          author: USER_ID,
        },
      ],
      has_more: false,
      after: null,
    })),
  } as unknown as InitializeAgentDbMethods;
}

async function initialize(setup: AgentSetup, stableContext: boolean) {
  const provider = setup.provider ?? Providers.OPENAI;
  const agent = {
    id: setup.id ?? 'agent_main',
    name: setup.id ?? 'Main',
    provider,
    model: 'test-model',
    model_parameters: { model: 'test-model' },
    tools: setup.memoryTools ? ['memory'] : [],
    instructions: setup.instructions,
    additional_instructions: setup.additional_instructions,
    artifacts: setup.artifacts,
  } as unknown as Agent;
  const toolContextMap: Record<string, string> = {};
  const dynamicToolContextMap: Record<string, string> = {};
  if (setup.webSearch) {
    toolContextMap.web_search = buildWebSearchContext(stableContext);
    dynamicToolContextMap.web_search = buildWebSearchDynamicContext({
      turnStartedAt: TURN_STARTED_AT,
      conversationStartedAt: CONVERSATION_CREATED_AT,
      timezone: TIMEZONE,
      stableContext,
    });
  }
  if (setup.toolFiles) {
    dynamicToolContextMap.execute_code =
      '- Note: files are available in "/mnt/data/":\n\t- data.csv';
    dynamicToolContextMap.file_search =
      '- Note: Semantic search is available through:\n\t- report.pdf';
    dynamicToolContextMap.image_edit_oai = '- Images available for image editing:\n\t- photo.png';
  }
  const loadTools = jest.fn(async () => ({
    tools: [],
    toolContextMap,
    dynamicToolContextMap,
    toolDefinitions: [],
    hasDeferredTools: false,
  }));
  const runtime = {
    user: { id: USER_ID.toString() },
    appConfig: { endpoints: { [EModelEndpoint.agents]: { promptCache: { stableContext } } } },
    requestBody: { timezone: TIMEZONE },
    turnStartedAt: TURN_STARTED_AT,
    conversationCreatedAt: CONVERSATION_CREATED_AT,
    ...(setup.project != null
      ? {
          chatProjectContext: {
            projectId: 'project-1',
            contextRevision: 1,
            instructions: setup.project,
            file_ids: [],
            resources: [],
          },
        }
      : {}),
  };
  return initializeAgent(
    {
      runtime: runtime as never,
      agent,
      loadTools: loadTools as never,
      endpointOption: { endpoint: EModelEndpoint.agents },
      allowedProviders: new Set([provider]),
      isInitialAgent: true,
      useChatProjectContext: setup.project != null,
      memoryAvailable: setup.memoryTools === true,
      ...(setup.skills
        ? { accessibleSkillIds: [SKILL_ID], skillStates: { [SKILL_ID.toString()]: true } }
        : {}),
    } as never,
    createDb(),
  );
}

/** Mirrors `prepareRuntimeAgent` in `AgentClient.buildMessages`. */
async function applyRequestContext(agent: Agent, setup: AgentSetup) {
  agent.instructions = agent.instructions?.trim() || undefined;
  agent.additional_instructions = agent.additional_instructions?.trim() || undefined;
  await applyContextToAgent({
    agent,
    mcpManager,
    runContext: {
      rag: setup.rag,
      memory: formatMemoryContext(setup.memory),
      agentFiles: setup.agentFiles,
    },
    ephemeralAgent: setup.mcp ? ({ mcp: [setup.mcp] } as never) : undefined,
  });
}

const QUEUED_FILE: TFile = {
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

async function prepareAgent(setup: AgentSetup, stableContext: boolean) {
  const agent = (await initialize(setup, stableContext)) as unknown as Record<string, unknown>;
  await applyRequestContext(agent as unknown as Agent, setup);
  if (setup.queuedFile) {
    agent.fileConsumers = { executeCode: true, fileSearch: false };
    agent.provisionState = {
      codeEnvFiles: [{ ...QUEUED_FILE }],
      vectorDBFiles: [],
      aliveFileIds: new Set(),
      agentScopedFileIds: new Set(),
    };
  }
  if (setup.promptCache) {
    agent.model_parameters = { ...(agent.model_parameters as object), promptCache: true };
  }
  return agent;
}

interface GraphInput {
  agentId?: string;
  instructions?: string;
  additional_instructions?: string;
  subagentConfigs?: Array<{ type?: string; agentInputs?: GraphInput }>;
}

async function captureGraphInputs(agents: Array<Record<string, unknown>>, stableContext: boolean) {
  const runSpy = jest.spyOn(Run, 'create').mockResolvedValue({} as never);
  try {
    await createRun({
      appConfig: { endpoints: { agents: { promptCache: { stableContext } } } } as never,
      agents: agents as never,
      messages: [],
      runId: 'run-snapshot',
      signal: new AbortController().signal,
      streaming: false,
      streamUsage: false,
    });
    const graphAgents = (runSpy.mock.calls[0][0] as { graphConfig: { agents: GraphInput[] } })
      .graphConfig.agents;
    const project = (input: GraphInput): Json =>
      redact({
        agentId: input.agentId,
        instructions: input.instructions,
        additional_instructions: input.additional_instructions,
        subagents: (input.subagentConfigs ?? [])
          .filter((config) => config.agentInputs != null)
          .map((config) => project(config.agentInputs as GraphInput)),
      });
    return graphAgents.map(project);
  } finally {
    runSpy.mockRestore();
  }
}

const EVERYTHING: AgentSetup = {
  instructions: 'Base. Today is {{current_date}}.',
  additional_instructions: 'Agent dynamic guidance.',
  artifacts: ArtifactModes.DEFAULT,
  memoryTools: true,
  project: 'Use metric units.',
  skills: true,
  webSearch: true,
  toolFiles: true,
  rag: 'Retrieved context: passage 7919',
  memory: 'favorite_color: blue',
  agentFiles: 'Attached file context:\nquarterly.txt: revenue up',
  mcp: 'docs',
  queuedFile: true,
};

const CASES: Record<string, AgentSetup | AgentSetup[]> = {
  bare: { instructions: 'You are a careful support assistant.' },
  'own additional instructions with surrounding whitespace': {
    instructions: 'Base.',
    additional_instructions: '  Agent dynamic guidance.\n',
    memory: 'favorite_color: blue',
  },
  'artifacts default': { instructions: 'Base.', artifacts: ArtifactModes.DEFAULT },
  'artifacts shadcn on anthropic': {
    provider: Providers.ANTHROPIC,
    instructions: 'Base.',
    artifacts: ArtifactModes.SHADCNUI,
  },
  'memory tools and memory': {
    instructions: 'Base.',
    memoryTools: true,
    memory: 'favorite_color: blue\n',
  },
  'project with trailing newline and memory': {
    instructions: 'Base.',
    project: 'Use metric units.\n',
    memory: 'favorite_color: blue',
  },
  'project only': { project: 'Use metric units.' },
  'skills catalog': { instructions: 'Base.', skills: true },
  'web search': { instructions: 'Base.', webSearch: true },
  'code, file search and image tools': { instructions: 'Base.', toolFiles: true },
  'temporal instructions': { instructions: 'Today is {{current_date}}. Be brief.' },
  'rag with surrounding whitespace': {
    instructions: 'Base.',
    artifacts: ArtifactModes.DEFAULT,
    rag: '\nRetrieved context:\n- passage 7919\n',
  },
  'agent files only': { agentFiles: 'Attached file context:\nquarterly.txt: revenue up' },
  'everything with MCP': EVERYTHING,
  'anthropic promptCache: everything': {
    ...EVERYTHING,
    provider: Providers.ANTHROPIC,
    promptCache: true,
  },
  'openrouter promptCache: memory, RAG and agent files': {
    provider: Providers.OPENROUTER,
    promptCache: true,
    instructions: 'Base.',
    artifacts: ArtifactModes.DEFAULT,
    rag: '\nRetrieved context:\n- passage 7919\n',
    memory: 'favorite_color: blue\n',
    agentFiles: 'Attached file context:\nquarterly.txt: revenue up',
  },
  'anthropic promptCache: stable parts only': {
    provider: Providers.ANTHROPIC,
    promptCache: true,
    instructions: 'Base.',
    project: 'Use metric units.\n',
    artifacts: ArtifactModes.DEFAULT,
    webSearch: true,
  },
  'anthropic promptCache: per-turn parts only': {
    provider: Providers.ANTHROPIC,
    promptCache: true,
    rag: 'Retrieved context: passage 7919',
    memory: 'favorite_color: blue',
  },
  'anthropic promptCache: queued files with web search': {
    provider: Providers.ANTHROPIC,
    promptCache: true,
    instructions: 'Base.',
    webSearch: true,
    queuedFile: true,
  },
  'anthropic promptCache: instructions only': {
    provider: Providers.ANTHROPIC,
    promptCache: true,
    instructions: 'Base.',
  },
  handoff: [
    {
      id: 'agent_router',
      instructions: 'Route.',
      artifacts: ArtifactModes.DEFAULT,
      webSearch: true,
    },
    {
      id: 'agent_writer',
      provider: Providers.ANTHROPIC,
      instructions: 'Write.',
      memoryTools: true,
      memory: 'tone: formal',
    },
  ],
};

async function prepareCase(setup: AgentSetup | AgentSetup[], stableContext: boolean) {
  const setups = Array.isArray(setup) ? setup : [setup];
  return Promise.all(setups.map((item) => prepareAgent(item, stableContext)));
}

describe.each([false])(
  'system prompt assembly is byte-identical to string concatenation (stableContext %s)',
  (stableContext) => {
    it.each(Object.keys(CASES))('%s', async (name) => {
      const agents = await prepareCase(CASES[name], stableContext);
      expect(await captureGraphInputs(agents, stableContext)).toMatchSnapshot();
    });

    it.each([false, true])(
      'isolated subagent with an always-apply skill and runtime context (promptCache %s)',
      async (promptCache) => {
        const child = await prepareAgent(
          {
            provider: Providers.ANTHROPIC,
            promptCache,
            id: 'agent_child',
            instructions: 'Child.',
            artifacts: ArtifactModes.DEFAULT,
            webSearch: true,
            memory: 'favorite_color: blue',
          },
          stableContext,
        );
        child.alwaysApplySkillPrimes = [
          { name: 'house-style', body: 'Use sentence case.\n', skillId: 'skill-1', version: 1 },
        ];
        const parent = await prepareAgent(
          {
            provider: Providers.ANTHROPIC,
            promptCache,
            instructions: 'Parent.',
            webSearch: true,
            memory: 'favorite_color: blue',
            rag: 'Retrieved context: passage 7919',
          },
          stableContext,
        );
        parent.subagents = { enabled: true, allowSelf: false, agent_ids: ['agent_child'] };
        parent.subagentAgentConfigs = [child];
        expect(await captureGraphInputs([parent], stableContext)).toMatchSnapshot();
      },
    );
  },
);
