import { Run, Providers } from '@librechat/agents';
import { ReasoningResponseKey } from 'librechat-data-provider';
import { ToolMessage, AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import {
  extractDiscoveredToolsFromHistory,
  getRunDiscoveredTools,
  getReasoningKey,
  isDeepSeekReasoningProvider,
  shouldReplayReasoningContent,
  anyAgentReplaysReasoningContent,
  collectRunMCPToolAliases,
  createRun,
} from './run';
import { ContextPartKeys, contributeContext } from './systemParts';

describe('getRunDiscoveredTools', () => {
  it('uses the run discovery snapshot instead of reconstructing it from messages', () => {
    const messages = [
      new ToolMessage({
        content: JSON.stringify({ tools: [{ name: 'save_project_mcp_linear' }] }),
        tool_call_id: 'call_1',
        name: 'tool_search',
      }),
    ];

    expect(
      getRunDiscoveredTools({
        getDiscoveredTools: () => ['save_issue_mcp_linear'],
        getRunMessages: () => messages,
      }),
    ).toEqual(['save_issue_mcp_linear']);
  });

  it('falls back to tool-search messages for agents releases without a snapshot API', () => {
    const messages = [
      new ToolMessage({
        content: JSON.stringify({ tools: [{ name: 'save_issue_mcp_linear' }] }),
        tool_call_id: 'call_1',
        name: 'tool_search',
      }),
    ];

    expect(getRunDiscoveredTools({ getRunMessages: () => messages })).toEqual([
      'save_issue_mcp_linear',
    ]);
  });
});

describe('extractDiscoveredToolsFromHistory', () => {
  it('extracts tool names from tool_search JSON output', () => {
    const toolSearchOutput = JSON.stringify({
      found: 3,
      tools: [
        { name: 'tool_a', score: 1.0 },
        { name: 'tool_b', score: 0.8 },
        { name: 'tool_c', score: 0.5 },
      ],
    });

    const messages = [
      new HumanMessage('Find tools'),
      new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'tool_search', args: {} }] }),
      new ToolMessage({ content: toolSearchOutput, tool_call_id: 'call_1', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(3);
    expect(discovered.has('tool_a')).toBe(true);
    expect(discovered.has('tool_b')).toBe(true);
    expect(discovered.has('tool_c')).toBe(true);
  });

  it('extracts tool names from legacy tool_search format', () => {
    const legacyOutput = `Found 2 tools:
- tool_x (score: 0.95)
- tool_y (score: 0.80)`;

    const messages = [
      new ToolMessage({ content: legacyOutput, tool_call_id: 'call_1', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(2);
    expect(discovered.has('tool_x')).toBe(true);
    expect(discovered.has('tool_y')).toBe(true);
  });

  it('returns empty set when no tool_search messages exist', () => {
    const messages = [new HumanMessage('Hello'), new AIMessage('Hi there!')];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(0);
  });

  it('ignores non-tool_search ToolMessages', () => {
    const messages = [
      new ToolMessage({
        content: '[{"sha": "abc123"}]',
        tool_call_id: 'call_1',
        name: 'list_commits_mcp_github',
      }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(0);
  });

  it('handles multiple tool_search calls in history', () => {
    const firstOutput = JSON.stringify({
      tools: [{ name: 'tool_1' }, { name: 'tool_2' }],
    });
    const secondOutput = JSON.stringify({
      tools: [{ name: 'tool_2' }, { name: 'tool_3' }],
    });

    const messages = [
      new ToolMessage({ content: firstOutput, tool_call_id: 'call_1', name: 'tool_search' }),
      new AIMessage('Using discovered tools'),
      new ToolMessage({ content: secondOutput, tool_call_id: 'call_2', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(3);
    expect(discovered.has('tool_1')).toBe(true);
    expect(discovered.has('tool_2')).toBe(true);
    expect(discovered.has('tool_3')).toBe(true);
  });

  it('handles malformed JSON in tool_search output', () => {
    const messages = [
      new ToolMessage({
        content: 'This is not valid JSON',
        tool_call_id: 'call_1',
        name: 'tool_search',
      }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    // Should not throw, just return empty set
    expect(discovered.size).toBe(0);
  });

  it('handles tool_search output with empty tools array', () => {
    const output = JSON.stringify({
      found: 0,
      tools: [],
    });

    const messages = [
      new ToolMessage({ content: output, tool_call_id: 'call_1', name: 'tool_search' }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    expect(discovered.size).toBe(0);
  });

  it('handles non-string content in ToolMessage', () => {
    const messages = [
      new ToolMessage({
        content: [{ type: 'text', text: 'array content' }],
        tool_call_id: 'call_1',
        name: 'tool_search',
      }),
    ];

    const discovered = extractDiscoveredToolsFromHistory(messages);

    // Should handle gracefully
    expect(discovered.size).toBe(0);
  });
});

describe('getReasoningKey', () => {
  it('detects OpenRouter baseURL case-insensitively', () => {
    const llmConfig = {
      configuration: {
        baseURL: 'https://gateway.example/v1/OpenRouter',
      },
    } as Parameters<typeof getReasoningKey>[1];

    const reasoningKey = getReasoningKey(Providers.OPENAI, llmConfig);

    expect(reasoningKey).toBe('reasoning');
  });

  it('keeps Vercel AI Gateway on ChatOpenAI normalized reasoning_content', () => {
    const llmConfig = {
      configuration: {
        baseURL: 'https://ai-gateway.vercel.sh/v1',
      },
    } as Parameters<typeof getReasoningKey>[1];

    const reasoningKey = getReasoningKey(Providers.OPENAI, llmConfig);

    expect(reasoningKey).toBe('reasoning_content');
  });

  it('keeps Vercel custom endpoint names on ChatOpenAI normalized reasoning_content', () => {
    const llmConfig = {} as Parameters<typeof getReasoningKey>[1];

    const reasoningKey = getReasoningKey(Providers.OPENAI, llmConfig, 'Vercel');

    expect(reasoningKey).toBe('reasoning_content');
  });

  it('uses explicit reasoning response keys for Vercel when configured', () => {
    const llmConfig = {
      configuration: {
        baseURL: 'https://ai-gateway.vercel.sh/v1',
      },
    } as Parameters<typeof getReasoningKey>[1];

    const reasoningKey = getReasoningKey(
      Providers.OPENAI,
      llmConfig,
      'Vercel',
      ReasoningResponseKey.reasoning,
    );

    expect(reasoningKey).toBe('reasoning');
  });

  it('uses explicit reasoning response keys for otherwise default OpenAI-compatible endpoints', () => {
    const llmConfig = {} as Parameters<typeof getReasoningKey>[1];

    const reasoningKey = getReasoningKey(
      Providers.OPENAI,
      llmConfig,
      'Company Gateway',
      ReasoningResponseKey.reasoning,
    );

    expect(reasoningKey).toBe('reasoning');
  });
});

describe('isDeepSeekReasoningProvider', () => {
  it('returns true for the direct deepseek provider regardless of model', () => {
    expect(isDeepSeekReasoningProvider(Providers.DEEPSEEK)).toBe(true);
    expect(isDeepSeekReasoningProvider(Providers.DEEPSEEK, 'deepseek-chat')).toBe(true);
    expect(isDeepSeekReasoningProvider(Providers.DEEPSEEK, 'unrelated')).toBe(true);
  });

  it('returns true for openrouter when the model id is namespaced deepseek', () => {
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, 'deepseek/deepseek-v4-pro')).toBe(
      true,
    );
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, 'DeepSeek/DeepSeek-V4')).toBe(true);
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, 'deepseek-r1')).toBe(true);
  });

  it("strips OpenRouter's `~` latest-routing prefix before matching", () => {
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, '~deepseek/deepseek-v4')).toBe(true);
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, '~deepseek/r1')).toBe(true);
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, '~deepseek-chat')).toBe(true);
  });

  it('matches the provider string case-insensitively (custom endpoint names)', () => {
    expect(isDeepSeekReasoningProvider('OpenRouter', 'deepseek/deepseek-v4')).toBe(true);
    expect(isDeepSeekReasoningProvider('OPENROUTER', 'deepseek/deepseek-v4')).toBe(true);
    expect(isDeepSeekReasoningProvider('DeepSeek')).toBe(true);
  });

  it('matches custom-named endpoints and direct DeepSeek-compatible proxies via the fallback', () => {
    expect(isDeepSeekReasoningProvider('openai', 'deepseek/deepseek-v4')).toBe(true);
    expect(isDeepSeekReasoningProvider('MyCustomEndpoint', '~deepseek/r1')).toBe(true);
    expect(isDeepSeekReasoningProvider(undefined, 'deepseek/deepseek-chat')).toBe(true);
    expect(isDeepSeekReasoningProvider(null, 'deepseek/deepseek-v4')).toBe(true);
    expect(isDeepSeekReasoningProvider('', 'deepseek/deepseek-v4')).toBe(true);
    expect(isDeepSeekReasoningProvider('openai', 'deepseek-chat')).toBe(true);
    expect(isDeepSeekReasoningProvider('MyDeepSeekProxy', 'deepseek-reasoner')).toBe(true);
    expect(isDeepSeekReasoningProvider(undefined, 'deepseek-r1')).toBe(true);
    expect(isDeepSeekReasoningProvider(undefined, '~deepseek-chat')).toBe(true);
  });

  it('returns false for openrouter with non-deepseek models', () => {
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, 'anthropic/claude-opus-4-7')).toBe(
      false,
    );
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, 'openai/gpt-5')).toBe(false);
    expect(
      isDeepSeekReasoningProvider(Providers.OPENROUTER, 'meta-llama/llama-3.1-70b-instruct'),
    ).toBe(false);
  });

  it('returns false when the model is missing on openrouter', () => {
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER)).toBe(false);
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, null)).toBe(false);
    expect(isDeepSeekReasoningProvider(Providers.OPENROUTER, '')).toBe(false);
  });

  it('returns false for nullish provider input without a DeepSeek-prefixed model', () => {
    expect(isDeepSeekReasoningProvider(undefined, 'gpt-5')).toBe(false);
    expect(isDeepSeekReasoningProvider(null, 'claude-opus-4-7')).toBe(false);
    expect(isDeepSeekReasoningProvider('', 'gemini-2.5-pro')).toBe(false);
  });

  it('does not match cloned/distilled slugs that merely contain "deepseek" later in the id', () => {
    expect(
      isDeepSeekReasoningProvider(Providers.OPENROUTER, 'community/not-a-deepseek-clone'),
    ).toBe(false);
    expect(
      isDeepSeekReasoningProvider(Providers.OPENROUTER, 'mistral/deepseek-distilled-foo'),
    ).toBe(false);
    expect(isDeepSeekReasoningProvider(undefined, 'community/deepseek-r1')).toBe(false);
  });
});

describe('shouldReplayReasoningContent', () => {
  it('returns true when a custom endpoint opts in via includeReasoningHistory', () => {
    expect(
      shouldReplayReasoningContent({
        provider: Providers.OPENAI,
        model_parameters: { model: 'MiMo-V2.5' },
        includeReasoningHistory: true,
      }),
    ).toBe(true);
  });

  it('returns true for DeepSeek reasoning agents without the flag', () => {
    expect(
      shouldReplayReasoningContent({
        provider: Providers.DEEPSEEK,
        model_parameters: { model: 'deepseek-chat' },
      }),
    ).toBe(true);
    expect(
      shouldReplayReasoningContent({
        provider: Providers.OPENROUTER,
        model_parameters: { model: 'deepseek/deepseek-v4-pro' },
      }),
    ).toBe(true);
  });

  it('returns false for a non-DeepSeek agent that has not opted in', () => {
    expect(
      shouldReplayReasoningContent({
        provider: Providers.OPENAI,
        model_parameters: { model: 'MiMo-V2.5' },
      }),
    ).toBe(false);
    expect(
      shouldReplayReasoningContent({
        provider: Providers.OPENAI,
        model_parameters: { model: 'MiMo-V2.5' },
        includeReasoningHistory: false,
      }),
    ).toBe(false);
  });

  it('returns false for nullish agents', () => {
    expect(shouldReplayReasoningContent(null)).toBe(false);
    expect(shouldReplayReasoningContent(undefined)).toBe(false);
  });
});

describe('anyAgentReplaysReasoningContent', () => {
  const plainAgent = (id: string, extra = {}) =>
    ({
      id,
      provider: Providers.OPENAI,
      model_parameters: { model: 'MiMo-V2.5' },
      ...extra,
    }) as unknown as Parameters<typeof anyAgentReplaysReasoningContent>[0][number];

  it('returns true when the primary agent opts in', () => {
    expect(
      anyAgentReplaysReasoningContent([plainAgent('a', { includeReasoningHistory: true })]),
    ).toBe(true);
  });

  it('returns true when only a nested subagent opts in', () => {
    const subagent = plainAgent('child', { includeReasoningHistory: true });
    const primary = plainAgent('root', {
      subagentAgentConfigs: [plainAgent('mid', { subagentAgentConfigs: [subagent] })],
    });
    expect(anyAgentReplaysReasoningContent([primary])).toBe(true);
  });

  it('returns true when an inert lazy descriptor opts in', () => {
    const primary = plainAgent('root', {
      lazySubagentConfigs: [plainAgent('lazy-child', { includeReasoningHistory: true })],
    });
    expect(anyAgentReplaysReasoningContent([primary])).toBe(true);
  });

  it('returns false when no reachable agent opts in', () => {
    const primary = plainAgent('root', {
      subagentAgentConfigs: [plainAgent('child')],
    });
    expect(anyAgentReplaysReasoningContent([primary, null, undefined])).toBe(false);
  });

  it('is cycle-safe across subagent references', () => {
    const a = plainAgent('a');
    const b = plainAgent('b', { includeReasoningHistory: true });
    (a as { subagentAgentConfigs?: unknown[] }).subagentAgentConfigs = [b];
    (b as { subagentAgentConfigs?: unknown[] }).subagentAgentConfigs = [a];
    expect(anyAgentReplaysReasoningContent([a])).toBe(true);

    const x = plainAgent('x');
    const y = plainAgent('y');
    (x as { subagentAgentConfigs?: unknown[] }).subagentAgentConfigs = [y];
    (y as { subagentAgentConfigs?: unknown[] }).subagentAgentConfigs = [x];
    expect(anyAgentReplaysReasoningContent([x])).toBe(false);
  });
});

describe('collectRunMCPToolAliases', () => {
  const alias = { name: 'delete_mcp_acme', aliasName: 'acme_delete_mcp_acme' };

  it('collects and deduplicates aliases from explicit and graph subagents', () => {
    const root = {
      id: 'root',
      subagentAgentConfigs: [
        {
          id: 'explicit',
          mcpToolAliases: [alias],
        },
      ],
      subagentGraphConfigs: [
        {
          memberConfigs: [
            {
              id: 'graph-member',
              mcpToolAliases: [alias, { name: 'read_mcp_acme', aliasName: 'acme_read_mcp_acme' }],
            },
          ],
        },
      ],
    };

    expect(collectRunMCPToolAliases([root] as never)).toEqual([
      alias,
      { name: 'read_mcp_acme', aliasName: 'acme_read_mcp_acme' },
    ]);
  });

  it('is cycle-safe across nested subagents', () => {
    const root: {
      id: string;
      mcpToolAliases: (typeof alias)[];
      subagentAgentConfigs?: unknown[];
    } = {
      id: 'root',
      mcpToolAliases: [alias],
    };
    const child = { id: 'child', subagentAgentConfigs: [root] };
    root.subagentAgentConfigs = [child];

    expect(collectRunMCPToolAliases([root] as never)).toEqual([alias]);
  });

  it('collects aliases from a graph member duplicated by a lazy descriptor', () => {
    const graphAlias = { name: 'write_mcp_acme', aliasName: 'acme_write_mcp_acme' };
    const root = {
      id: 'root',
      lazySubagentConfigs: [{ id: 'shared-agent' }],
      subagentGraphConfigs: [
        {
          memberConfigs: [{ id: 'shared-agent', mcpToolAliases: [graphAlias] }],
        },
      ],
    };

    expect(collectRunMCPToolAliases([root] as never)).toEqual([graphAlias]);
  });
});

describe('createRun instructions with prompt caching', () => {
  const STATIC = 'Static artifacts prompt.';
  const RUNTIME = 'Conversation started: 2026-03-09 23:00 +03:00 (Mon)';
  const MEMORY = 'Memory: prefers metric units.';
  const RAG = 'Retrieved context for this question.';
  const VOLATILE = `${RAG}\n\n${MEMORY}`;
  /** An agent as `initializeAgent` and `AgentClient.buildMessages` leave it. */
  const withParts = (rag = RAG) => {
    const agent = {};
    contributeContext(agent, ContextPartKeys.artifacts, STATIC);
    contributeContext(agent, ContextPartKeys.rag, rag);
    contributeContext(agent, ContextPartKeys.memory, MEMORY);
    return agent;
  };
  let runSpy: jest.SpyInstance;

  beforeEach(() => {
    runSpy = jest.spyOn(Run, 'create').mockResolvedValue({} as never);
  });

  afterEach(() => {
    runSpy.mockRestore();
  });

  async function agentInput(
    provider: string,
    promptCache: boolean,
    agent: object,
    stableContext = true,
  ) {
    await createRun({
      appConfig: { endpoints: { agents: { promptCache: { stableContext } } } } as never,
      agents: [
        {
          id: 'agent_1',
          provider,
          endpoint: provider,
          instructions: 'Base instructions.',
          dynamicToolContextMap: { web_search: RUNTIME },
          model_parameters: { model: 'test-model', apiKey: 'test-key', promptCache },
          ...agent,
        },
      ] as never,
      messages: [],
      runId: 'run-1',
      signal: new AbortController().signal,
      streaming: false,
      streamUsage: false,
    });
    return runSpy.mock.calls[0][0].graphConfig.agents[0];
  }

  it.each([Providers.ANTHROPIC, Providers.OPENROUTER, Providers.BEDROCK])(
    'passes the stable part as the conversation block for %s and leaves the memory and RAG part',
    async (provider) => {
      const input = await agentInput(provider, true, withParts());
      expect(input.instructions).toBe('Base instructions.');
      expect(input.conversation_instructions).toBe(`${STATIC}\n${RUNTIME}`);
      expect(input.additional_instructions).toBe(VOLATILE);
    },
  );

  it('passes everything as the conversation block when no part is per-turn', async () => {
    const input = await agentInput(Providers.ANTHROPIC, true, { additional_instructions: STATIC });
    expect(input.instructions).toBe('Base instructions.');
    expect(input.conversation_instructions).toBe(`${STATIC}\n${RUNTIME}`);
    expect(input.additional_instructions).toBeUndefined();
  });

  it('keeps only the per-turn parts dynamic when a memory or RAG part is empty', async () => {
    const input = await agentInput(Providers.ANTHROPIC, true, withParts(''));
    expect(input.conversation_instructions).toBe(`${STATIC}\n${RUNTIME}`);
    expect(input.additional_instructions).toBe(MEMORY);
  });

  it('assembles the tail from the parts, not from a direct write to additional_instructions', async () => {
    const input = await agentInput(Providers.ANTHROPIC, true, {
      ...withParts(),
      additional_instructions: 'Written directly.',
    });
    expect(input.conversation_instructions).toBe(`${STATIC}\n${RUNTIME}`);
    expect(input.additional_instructions).toBe(VOLATILE);
    expect(JSON.stringify(input)).not.toContain('Written directly.');
  });

  it('builds the request as before when stableContext is off', async () => {
    const input = await agentInput(Providers.ANTHROPIC, true, withParts(), false);
    expect(input.instructions).toBe('Base instructions.');
    expect(input.conversation_instructions).toBeUndefined();
    expect(input.additional_instructions).toBe(`${RUNTIME}\n${STATIC}\n\n${VOLATILE}`);
  });

  it.each([
    [Providers.ANTHROPIC, false],
    [Providers.OPENROUTER, false],
    [Providers.BEDROCK, false],
    [Providers.OPENAI, true],
    [Providers.GOOGLE, true],
  ])('keeps the split for %s (promptCache %s)', async (provider, promptCache) => {
    const input = await agentInput(provider, promptCache, withParts());
    expect(input.instructions).toBe('Base instructions.');
    expect(input.conversation_instructions).toBeUndefined();
    expect(input.additional_instructions).toBe(`${STATIC}\n\n${VOLATILE}\n${RUNTIME}`);
  });

  const queuedFiles = () => ({
    fileConsumers: { executeCode: true, fileSearch: false },
    provisionState: {
      codeEnvFiles: [
        {
          file_id: 'report',
          filename: 'report.csv',
          filepath: '/uploads/report.csv',
          type: 'text/csv',
          user: 'user-1',
          object: 'file',
          bytes: 10,
          embedded: false,
          usage: 0,
        },
      ],
      vectorDBFiles: [],
      aliveFileIds: new Set(),
      agentScopedFileIds: new Set(),
    },
  });

  it('moves the one-turn queued file context after the per-turn part and keeps other runtime keys stable', async () => {
    const input = await agentInput(Providers.ANTHROPIC, true, {
      ...withParts(),
      ...queuedFiles(),
    });
    expect(input.conversation_instructions).toBe(`${STATIC}\n${RUNTIME}`);
    expect(input.additional_instructions.startsWith(`${VOLATILE}\n\n`)).toBe(true);
    expect(input.additional_instructions).toContain('report.csv');
  });

  it('keeps the queued file context in place when nothing is merged', async () => {
    const input = await agentInput(Providers.OPENAI, false, {
      additional_instructions: STATIC,
      ...queuedFiles(),
    });
    expect(input.instructions).toBe('Base instructions.');
    expect(input.additional_instructions.startsWith(`${STATIC}\n${RUNTIME}\n`)).toBe(true);
    expect(input.additional_instructions).toContain('report.csv');
  });
});
