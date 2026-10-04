import { z } from 'zod';
import type { AgentInputs } from '@librechat/agents';
import { buildPromptCacheKey } from './promptCache';

describe('buildPromptCacheKey', () => {
  const searchTool = {
    name: 'search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  };
  const calculatorTool = {
    name: 'calculator',
    description: 'Compute arithmetic',
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
  };

  type InputOverrides = Record<string, unknown> & { clientOptions?: Record<string, unknown> };

  /** A finished input as `createRun` hands it to the key: first-party, per-user scope. */
  const input = (overrides: InputOverrides = {}): AgentInputs => {
    const { clientOptions, ...rest } = overrides;
    return {
      agentId: 'agent-1',
      provider: 'openAI',
      instructions: 'You are a helpful assistant.',
      toolDefinitions: [searchTool, calculatorTool],
      ...rest,
      clientOptions: {
        model: 'gpt-5.6',
        promptCacheScopeId: 'user-a',
        ...(clientOptions ?? {}),
      },
    } as unknown as AgentInputs;
  };

  const key = (overrides: InputOverrides = {}, handoffEdges?: readonly unknown[]) =>
    buildPromptCacheKey(input(overrides), handoffEdges != null ? { handoffEdges } : {});

  describe('a runtime action whose schema is edited', () => {
    /** An action's schema is self-referential, which is what sends it to the fallback. */
    const action = (schema: z.ZodTypeAny) => {
      (schema as unknown as { self?: unknown }).self = schema;
      return { name: 'lookup_order', description: 'Look up an order', schema };
    };
    const base = z.object({
      orderId: z.string().min(2),
      mode: z.literal('full'),
      filter: z.union([z.string(), z.number()]),
    });

    it.each([
      [
        'a new field',
        z.object({
          orderId: z.string().min(2),
          mode: z.literal('full'),
          filter: z.union([z.string(), z.number()]),
          history: z.boolean(),
        }),
      ],
      [
        'a tightened constraint',
        z.object({
          orderId: z.string().min(10),
          mode: z.literal('full'),
          filter: z.union([z.string(), z.number()]),
        }),
      ],
      [
        'a changed literal value',
        z.object({
          orderId: z.string().min(2),
          mode: z.literal('summary'),
          filter: z.union([z.string(), z.number()]),
        }),
      ],
      [
        'a different union member',
        z.object({
          orderId: z.string().min(2),
          mode: z.literal('full'),
          filter: z.union([z.string(), z.boolean()]),
        }),
      ],
    ])('retires the key for %s', (_label, edited) => {
      expect(key({ tools: [action(edited)] })).not.toBe(key({ tools: [action(base)] }));
    });

    it('retires the key for an edited schema that is not self-referential', () => {
      /** `canonicalize` succeeds on an acyclic schema and drops the `shape` thunk. */
      const plain = (schema: z.ZodTypeAny) => ({
        name: 'lookup_order',
        description: 'Look up an order',
        schema,
      });
      expect(key({ tools: [plain(z.object({ query: z.string() }))] })).not.toBe(
        key({ tools: [plain(z.object({ path: z.string() }))] }),
      );
      expect(key({ tools: [plain(z.object({ query: z.string() }))] })).toBe(
        key({ tools: [plain(z.object({ query: z.string() }))] }),
      );
    });

    it('retires the key for a changed lazy schema target', () => {
      const lazy = (target: z.ZodTypeAny) =>
        z.object({ orderId: z.string(), detail: z.lazy(() => target) });
      expect(key({ tools: [action(lazy(z.string()))] })).not.toBe(
        key({ tools: [action(lazy(z.object({ id: z.string() })))] }),
      );
    });

    it('builds a key for a lazy schema that refers to itself', () => {
      type Node = { children: Node[] };
      const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.array(node) }));
      expect(key({ tools: [action(z.object({ tree: node }))] })).toMatch(/^librechat:/);
    });

    it('retires the key for a changed regex pattern', () => {
      /**
       * A regular expression keeps its meaning on non-enumerable properties,
       * so a generic own-key walk reads nothing from it and files every
       * pattern under one identity while the model is shown each one.
       */
      const withPattern = (pattern: RegExp) =>
        z.object({
          orderId: z.string().regex(pattern),
          mode: z.literal('full'),
          filter: z.union([z.string(), z.number()]),
        });
      expect(key({ tools: [action(withPattern(/^A-\d+$/))] })).not.toBe(
        key({ tools: [action(withPattern(/^B-\d+$/))] }),
      );
    });

    it('retires the key for a changed default value', () => {
      /** Zod keeps a default behind a thunk, and the tool schema serializes its result. */
      const withDefault = (value: string) =>
        z.object({
          orderId: z.string().default(value),
          mode: z.literal('full'),
          filter: z.union([z.string(), z.number()]),
        });
      expect(key({ tools: [action(withDefault('a'))] })).not.toBe(
        key({ tools: [action(withDefault('b'))] }),
      );
      expect(key({ tools: [action(withDefault('a'))] })).toBe(
        key({ tools: [action(withDefault('a'))] }),
      );
    });

    it('keeps one key for the same regex pattern', () => {
      const withPattern = () =>
        z.object({
          orderId: z.string().regex(/^A-\d+$/),
          mode: z.literal('full'),
          filter: z.union([z.string(), z.number()]),
        });
      expect(key({ tools: [action(withPattern())] })).toBe(key({ tools: [action(withPattern())] }));
    });

    it('retires the key for a difference far below the old depth cutoff', () => {
      /**
       * A fixed depth cutoff collapsed everything under it to one constant, so
       * two schemas agreeing for twelve levels and differing at the leaf were
       * one identity. The walk is bounded by total work now, not by depth.
       */
      const nested = (leaf: z.ZodTypeAny) => {
        let schema: z.ZodTypeAny = z.object({ leaf });
        for (let i = 0; i < 16; i++) {
          schema = z.object({ next: schema });
        }
        return schema;
      };
      expect(key({ tools: [action(nested(z.string()))] })).not.toBe(
        key({ tools: [action(nested(z.number()))] }),
      );
      expect(key({ tools: [action(nested(z.string()))] })).toBe(
        key({ tools: [action(nested(z.string()))] }),
      );
    });

    it('builds a key for a schema deeper than the recursion bound instead of throwing', () => {
      /**
       * The walk is recursive, so a schema deep enough to exhaust the call
       * stack would throw `RangeError` while the key is being built and fail
       * the request — worse than any cache miss. Depth is bounded separately
       * from total work for that reason.
       */
      let schema: z.ZodTypeAny = z.object({ leaf: z.string() });
      for (let i = 0; i < 400; i++) {
        schema = z.object({ next: schema });
      }
      expect(() => key({ tools: [action(schema)] })).not.toThrow();
    });

    it('keeps one key for an unchanged schema', () => {
      const unchanged = () =>
        z.object({
          orderId: z.string().min(2),
          mode: z.literal('full'),
          filter: z.union([z.string(), z.number()]),
        });
      expect(key({ tools: [action(unchanged())] })).toBe(key({ tools: [action(unchanged())] }));
    });
  });

  it.each([['tool_choice'], ['parallel_tool_calls'], ['function_call']])(
    'keeps one key when only %s changes',
    (option) => {
      /**
       * A choice policy picks among schemas already in the prefix; it does not
       * change them. The legacy spelling is accepted by knownOpenAIParams and
       * reaches clientOptions exactly as its successors do.
       */
      expect(key({ clientOptions: { [option]: 'auto' } })).toBe(
        key({ clientOptions: { [option]: 'none' } }),
      );
    },
  );

  it('ignores the key order tool schemas happen to be serialized in', () => {
    expect(
      key({
        toolDefinitions: [
          {
            parameters: { properties: { query: { type: 'string' } }, type: 'object' },
            description: 'Search the web',
            name: 'search',
          },
          calculatorTool,
        ],
      }),
    ).toBe(key());
  });

  it('separates toolsets that reach the model in a different order', () => {
    expect(key({ toolDefinitions: [calculatorTool, searchTool] })).not.toBe(key());
  });

  it.each([
    ['instructions', { instructions: 'You are a terse assistant.' }],
    ['wire model', { clientOptions: { model: 'gpt-5.6-terra' } }],
    ['tool schemas', { toolDefinitions: [searchTool] }],
    ['agent name the handoff context carries', { name: 'Researcher' }],
    ['Chat Completions output schema', { clientOptions: { response_format: { type: 'json' } } }],
    ['Responses output format', { clientOptions: { text: { format: { type: 'json' } } } }],
    [
      'Responses output format beside a verbosity setting',
      { clientOptions: { text: { format: { type: 'json_schema' }, verbosity: 'low' } } },
    ],
    ['API mode', { clientOptions: { useResponsesApi: true } }],
    [
      'Responses output schema an agent set under modelKwargs',
      { clientOptions: { modelKwargs: { text: { format: { type: 'json_schema' } } } } },
    ],
  ])('retires the cache identity when the %s changes', (_label, change) => {
    expect(key(change)).not.toBe(key());
  });

  it('reads a spelled-out Chat Completions mode as the default mode', () => {
    expect(key({ clientOptions: { useResponsesApi: false } })).toBe(key());
  });

  it('keys on the deployment Azure Astra actually addresses, not its visible name', () => {
    const astra = { model: 'gpt-6-astra', modelKwargs: { model: 'astra-prod' } };

    expect(key({ clientOptions: astra })).not.toBe(
      key({ clientOptions: { ...astra, modelKwargs: { model: 'astra-canary' } } }),
    );
  });

  it('separates a provider-native tool that carries no schema of its own', () => {
    expect(key({ tools: [{ type: 'web_search' }] })).not.toBe(key());
  });

  it('distinguishes runtime tool instances whose schemas cannot be serialized', () => {
    /** A Zod schema is a class instance with internal back-references. */
    const zodLike: Record<string, unknown> = { _def: { typeName: 'ZodObject' } };
    zodLike.self = zodLike;
    const instance = (name: string) => ({
      name,
      description: 'Ask the operator a question',
      schema: zodLike,
      invoke: () => undefined,
    });

    expect(key({ graphTools: [instance('ask_user_question')] })).not.toBe(key());
    expect(key({ graphTools: [instance('ask_user_question')] })).not.toBe(
      key({ graphTools: [instance('list_run_files')] }),
    );
  });

  it('keeps definitions this conversation added out of the identity', () => {
    const deferred = {
      name: 'deferred_search',
      description: 'Discovered through tool_search',
      parameters: { type: 'object', properties: {} },
    };

    expect(
      key({
        toolDefinitions: [searchTool, calculatorTool, deferred],
        clientOptions: {
          promptCacheConfiguredToolState: { deferred_search: { appended: true } },
        },
      }),
    ).toBe(key());
  });

  it('still keys on the schema of a configured tool this conversation discovered', () => {
    const discovered = (parameters: unknown) => ({
      toolDefinitions: [searchTool, { ...calculatorTool, parameters, defer_loading: false }],
      clientOptions: {
        promptCacheConfiguredToolState: { calculator: { deferLoading: true } },
      },
    });

    expect(
      key(discovered({ type: 'object', properties: { expression: { type: 'string' } } })),
    ).not.toBe(key(discovered({ type: 'object', properties: { input: { type: 'string' } } })));
  });

  it('keys on a schema field named after the prototype setter', () => {
    /** An own `__proto__` property, as a parsed JSON schema can carry. */
    const properties = JSON.parse('{"__proto__":{"type":"string"}}') as Record<string, unknown>;
    const withField = (props: Record<string, unknown>) => ({
      toolDefinitions: [
        { ...searchTool, parameters: { type: 'object', properties: props } },
        calculatorTool,
      ],
    });

    expect(key(withField(properties))).not.toBe(key(withField({})));
  });

  it('keeps a tool named after an inherited property out of the discovered set', () => {
    const shadow = { name: 'toString', description: 'Render', parameters: { type: 'object' } };
    const withState = (deferLoading: boolean) => ({
      toolDefinitions: [{ ...shadow, defer_loading: deferLoading }, calculatorTool],
      clientOptions: {
        promptCacheConfiguredToolState: { search: { deferLoading: true } },
      },
    });

    /** No state was recorded for this tool, so its own classification still keys. */
    expect(key(withState(true))).not.toBe(key(withState(false)));
  });

  it('agrees with a conversation that has not discovered the same tool', () => {
    const deferred = { ...calculatorTool, defer_loading: true };

    /** Discovery overwrote `defer_loading`; the recorded configured value goes back. */
    expect(
      key({
        toolDefinitions: [searchTool, { ...deferred, defer_loading: false }],
        clientOptions: {
          promptCacheConfiguredToolState: { calculator: { deferLoading: true } },
        },
      }),
    ).toBe(key({ toolDefinitions: [searchTool, deferred] }));
  });

  it('follows an administrator who made a discovered tool eager', () => {
    const state = { promptCacheConfiguredToolState: { calculator: { deferLoading: false } } };

    expect(
      key({
        toolDefinitions: [searchTool, { ...calculatorTool, defer_loading: false }],
        clientOptions: state,
      }),
    ).not.toBe(
      key({
        toolDefinitions: [searchTool, { ...calculatorTool, defer_loading: false }],
        clientOptions: {
          promptCacheConfiguredToolState: { calculator: { deferLoading: true } },
        },
      }),
    );
  });

  it('reads an absent, empty and empty-array surface as the same absent surface', () => {
    expect(key({ toolDefinitions: [], tools: [], instructions: '' })).toBe(
      key({ toolDefinitions: undefined, instructions: undefined }),
    );
  });

  it.each([
    ['defer_loading', { defer_loading: true }],
    ['allowed_callers', { allowed_callers: ['code_execution'] }],
  ])('retires the key when a definition\u2019s %s changes', (_label, classification) => {
    expect(
      key({ toolDefinitions: [{ ...searchTool, ...classification }, calculatorTool] }),
    ).not.toBe(key());
  });

  describe('generated delegation tool', () => {
    const child = { type: 'child-agent-id', name: 'Researcher', description: 'Researches things' };

    it('separates an agent that can delegate from one that cannot', () => {
      expect(key({ subagentConfigs: [child] })).not.toBe(key());
    });

    it.each([
      ['the enum value the tool accepts', { type: 'other-agent-id' }],
      ['its display name', { name: 'Analyst' }],
      ['its description', { description: 'Analyzes things' }],
    ])('retires the key when a target changes %s', (_label, change) => {
      expect(key({ subagentConfigs: [{ ...child, ...change }] })).not.toBe(
        key({ subagentConfigs: [child] }),
      );
    });

    it('ignores the child inputs an entry carries, which hold the child\u2019s own key', () => {
      expect(
        key({
          subagentConfigs: [
            { ...child, agentInputs: { clientOptions: { promptCacheKey: 'child-key' } } },
          ],
        }),
      ).toBe(key({ subagentConfigs: [child] }));
    });
  });

  describe('handoff edges', () => {
    const edge = { to: 'researcher', description: 'Hand off research' };

    it('separates an agent that can hand off from one that cannot', () => {
      expect(key({}, [edge])).not.toBe(key());
    });

    it.each([
      ['target', { to: 'writer' }],
      ['description', { description: 'Hand off drafting' }],
      ['input parameter name', { promptKey: 'brief' }],
    ])('retires the key when an edge\u2019s %s changes', (_label, change) => {
      expect(key({}, [{ ...edge, ...change }])).not.toBe(key({}, [edge]));
    });
  });

  describe('cache-accounting scope', () => {
    it('separates two users running the same agent', () => {
      expect(key({ clientOptions: { promptCacheScopeId: 'user-a' } })).not.toBe(
        key({ clientOptions: { promptCacheScopeId: 'user-b' } }),
      );
    });

    it('keeps one user stable across their conversations', () => {
      expect(key({ clientOptions: { promptCacheScopeId: 'user-a' } })).toBe(
        key({ clientOptions: { promptCacheScopeId: 'user-a' } }),
      );
    });

    it('serves every user one entry once an administrator opts into sharing', () => {
      expect(
        key({ clientOptions: { promptCacheScope: 'shared', promptCacheScopeId: 'user-a' } }),
      ).toBe(key({ clientOptions: { promptCacheScope: 'shared', promptCacheScopeId: 'user-b' } }));
    });

    it('still retires a shared key when the prefix changes', () => {
      expect(
        key({ clientOptions: { promptCacheScope: 'shared' }, instructions: 'Other.' }),
      ).not.toBe(key({ clientOptions: { promptCacheScope: 'shared' } }));
    });
  });

  describe('stable instruction sources folded into the dynamic tail', () => {
    it('retires the key when a skill the agent always applies is edited', () => {
      expect(
        key({ clientOptions: { promptCacheStableInstructions: '# Always-apply skill: a\nfirst' } }),
      ).not.toBe(
        key({
          clientOptions: { promptCacheStableInstructions: '# Always-apply skill: a\nrewritten' },
        }),
      );
    });
  });

  /**
   * The exclusions are the claims this module has to keep being right about: a
   * key that followed any of these would give every conversation, every turn
   * or every slider position its own entry, and there would be nothing left to
   * reuse.
   */
  describe('what the identity deliberately ignores', () => {
    it.each([
      [
        'the dynamic system tail of memory and file context',
        { additional_instructions: 'Memory: the user prefers brevity.\nFile: report.pdf' },
      ],
      ['tools this conversation discovered through tool_search', { discoveredTools: ['search'] }],
      ['the tool-search corpus behind the binding', { toolRegistry: new Map([['deferred', {}]]) }],
      [
        'a cross-run summary of an earlier conversation',
        { initialSummary: { text: 'a', tokenCount: 1 } },
      ],
      ['the context budget', { maxContextTokens: 4096 }],
      ['sampling parameters', { clientOptions: { temperature: 0.2, topP: 0.5, maxTokens: 900 } }],
      [
        'reasoning effort and verbosity',
        { clientOptions: { modelKwargs: { verbosity: 'low', reasoning: { effort: 'high' } } } },
      ],
      [
        'per-request transport resolved from the conversation',
        { clientOptions: { configuration: { defaultHeaders: { 'X-Conversation': 'abc-123' } } } },
      ],
      ['credentials', { clientOptions: { apiKey: 'sk-rotated' } }],
      ['the service tier a request is scheduled on', { clientOptions: { service_tier: 'flex' } }],
      [
        'Responses verbosity on the native text object',
        { clientOptions: { text: { verbosity: 'low' } } },
      ],
      ['a rotated Azure resource key', { clientOptions: { azureOpenAIApiKey: 'az-rotated' } }],
      [
        'the Responses output budget',
        { clientOptions: { modelKwargs: { max_output_tokens: 4096 } } },
      ],
      ['the Responses output cap at the top level', { clientOptions: { max_output_tokens: 2048 } }],
      [
        'streaming delivery in its provider spelling',
        { clientOptions: { stream: false, stream_options: { include_usage: true } } },
      ],
      [
        'which bound tool the model may call this turn',
        { clientOptions: { tool_choice: 'required', parallel_tool_calls: false } },
      ],
      [
        'sampling in its provider spelling',
        {
          clientOptions: {
            modelKwargs: { top_p: 0.4, frequency_penalty: 0.2, logit_bias: { '1': 1 } },
          },
        },
      ],
      [
        'the cache levers in their provider spelling',
        {
          clientOptions: {
            modelKwargs: {
              prompt_cache_retention: '24h',
              prompt_cache_options: { mode: 'explicit' },
            },
          },
        },
      ],
    ])('ignores %s', (_label, change) => {
      expect(key(change)).toBe(key());
    });

    it('ignores the key it is about to write', () => {
      expect(key({ clientOptions: { promptCacheKey: 'librechat:3:stale' } })).toBe(key());
    });
  });

  /**
   * A field this module has never seen is hashed rather than dropped, so a
   * newer SDK than these types partitions the cache (a miss) instead of
   * pointing two different prefixes at one entry (a wrong identity).
   */
  it('partitions on an input field it does not know', () => {
    expect(key({ someFutureModelFacingField: 'value' })).not.toBe(key());
  });
});
