import { EModelEndpoint, parseEphemeralAgentId } from 'librechat-data-provider';
import type { LoadAgentDeps } from './load';
import { loadEphemeralAgent } from './load';
import { resolveSender } from './sender';

const deps: LoadAgentDeps = {
  getAgent: async () => null,
  getMCPServerTools: async () => null,
};

const baseReq = {
  user: { id: 'user-1' },
  config: {
    modelSpecs: { list: [{ name: 'my-opus-spec', label: 'Spec Label' }] },
  },
  body: {},
} as unknown as Parameters<typeof loadEphemeralAgent>[0]['req'];

async function idFor(modelParameters: Record<string, unknown>) {
  const agent = await loadEphemeralAgent(
    {
      req: baseReq,
      spec: 'my-opus-spec',
      endpoint: 'my-custom-endpoint',
      model_parameters: modelParameters as never,
    },
    deps,
  );
  return agent?.id;
}

/**
 * Documents the #14253 Bug 2 mechanism: the ephemeral agent id (LangGraph node /
 * HITL checkpoint namespace) is derived from `sender = modelLabel ?? modelSpec.label`.
 * When the resume drops `modelLabel`, the id drifts and the paused checkpoint can't be
 * re-entered. The fix keeps `modelLabel` across resume (RESUME_CONTEXT_KEYS), so the
 * original and resumed ids stay equal.
 */
describe('loadEphemeralAgent ephemeral id stability (#14253 Bug 2)', () => {
  test('id changes when modelLabel is lost vs preserved', async () => {
    const withLabel = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    const withoutLabel = await idFor({ model: 'claude-opus-4' });
    expect(withLabel).toBeTruthy();
    expect(withoutLabel).toBeTruthy();
    // Original turn (has modelLabel) vs a resume that dropped it → different namespace.
    expect(withLabel).not.toEqual(withoutLabel);
  });

  test('id is stable when modelLabel is preserved across turns', async () => {
    const a = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    const b = await idFor({ model: 'claude-opus-4', modelLabel: 'My Opus' });
    expect(a).toEqual(b);
  });
});

/** Custom endpoints carry their configured name in `endpoint` at runtime,
 *  which `TEndpointOption` types as `EModelEndpoint`. */
const customEndpointOption = {
  endpoint: 'my-custom-endpoint' as EModelEndpoint,
  model: 'claude-opus-4',
};

describe('loadEphemeralAgent → resolveSender parity', () => {
  test('the persisted sender matches the spec label encoded into the agent id', async () => {
    const agent = await loadEphemeralAgent(
      {
        req: baseReq,
        spec: 'my-opus-spec',
        endpoint: 'my-custom-endpoint',
        model_parameters: { model: 'claude-opus-4' } as never,
      },
      deps,
    );
    expect(agent?.id).toBeTruthy();
    const sender = resolveSender({
      agent: { id: agent?.id },
      specLabel: 'Spec Label',
      endpointOption: customEndpointOption,
    });
    expect(sender).toBe('Spec Label');
    expect(sender).toBe(parseEphemeralAgentId(agent?.id ?? '')?.sender);
  });

  test('a user modelLabel wins over the spec label in the persisted sender', async () => {
    const agent = await loadEphemeralAgent(
      {
        req: baseReq,
        spec: 'my-opus-spec',
        endpoint: 'my-custom-endpoint',
        model_parameters: { model: 'claude-opus-4', modelLabel: 'My Opus' } as never,
      },
      deps,
    );
    const sender = resolveSender({
      agent: { id: agent?.id },
      specLabel: 'Spec Label',
      endpointOption: { ...customEndpointOption, modelLabel: 'My Opus' },
    });
    expect(sender).toBe('My Opus');
    expect(sender).toBe(parseEphemeralAgentId(agent?.id ?? '')?.sender);
  });
});

const STABLE_CONTEXT = {
  endpoints: { agents: { promptCache: { stableContext: true } } },
};

describe('loadEphemeralAgent MCP ordering', () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    alpha: { b_mcp_alpha: {}, a_mcp_alpha: {} },
    beta: { z_mcp_beta: {}, c_mcp_beta: {}, m_mcp_beta: {} },
    gamma: { only_mcp_gamma: {} },
  };
  const orderDeps: LoadAgentDeps = {
    getAgent: async () => null,
    getMCPServerTools: async (_userId, serverName) => catalogs[serverName] ?? null,
  };

  async function load(mcp: string[], deps: LoadAgentDeps = orderDeps, stableContext = true) {
    const req = {
      user: { id: 'user-1' },
      config: stableContext ? STABLE_CONTEXT : {},
      body: { ephemeralAgent: { mcp } },
    } as unknown as Parameters<typeof loadEphemeralAgent>[0]['req'];
    const agent = await loadEphemeralAgent(
      { req, endpoint: 'my-custom-endpoint', model_parameters: { model: 'm' } as never },
      deps,
    );
    return { agent, published: req.body?.ephemeralAgent?.mcp };
  }

  test('different picker orders of the same servers yield identical tools and published servers', async () => {
    const first = await load(['gamma', 'alpha', 'beta']);
    const second = await load(['beta', 'gamma', 'alpha']);
    expect(first.agent?.tools).toEqual([
      'a_mcp_alpha',
      'b_mcp_alpha',
      'c_mcp_beta',
      'm_mcp_beta',
      'z_mcp_beta',
      'only_mcp_gamma',
    ]);
    expect(second.agent?.tools).toEqual(first.agent?.tools);
    expect(first.published).toEqual(['alpha', 'beta', 'gamma']);
    expect(second.published).toEqual(first.published);
  });

  test('keeps the picker order and the catalog order without stableContext', async () => {
    const result = await load(['gamma', 'alpha', 'beta'], orderDeps, false);
    expect(result.agent?.tools).toEqual([
      'only_mcp_gamma',
      'b_mcp_alpha',
      'a_mcp_alpha',
      'z_mcp_beta',
      'c_mcp_beta',
      'm_mcp_beta',
    ]);
    expect(result.published).toEqual(['gamma', 'alpha', 'beta']);
  });

  test('shuffled tool map key order yields the same tool list', async () => {
    const reordered: LoadAgentDeps = {
      ...orderDeps,
      getMCPServerTools: async (_userId, serverName) => {
        const catalog = catalogs[serverName];
        if (catalog == null) {
          return null;
        }
        return Object.fromEntries(Object.entries(catalog).reverse());
      },
    };
    const baseline = await load(['alpha', 'beta']);
    const shuffled = await load(['alpha', 'beta'], reordered);
    expect(shuffled.agent?.tools).toEqual(baseline.agent?.tools);
  });

  test('every permutation of the picker selection yields the same tools', async () => {
    const servers = ['alpha', 'beta', 'gamma'];
    const permutations = (items: string[]): string[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const baseline = (await load(servers)).agent?.tools;
    for (const order of permutations(servers)) {
      expect((await load(order)).agent?.tools).toEqual(baseline);
    }
  });

  test('similarly named servers are ordered by plain code-unit comparison', async () => {
    const similar: LoadAgentDeps = {
      ...orderDeps,
      getMCPServerTools: async (_userId, serverName) => ({ [`t_mcp_${serverName}`]: {} }),
    };
    const first = await load(['a_b', 'a', 'A'], similar);
    const second = await load(['A', 'a', 'a_b'], similar);
    expect(first.published).toEqual(['A', 'a', 'a_b']);
    expect(first.agent?.tools).toEqual(['t_mcp_A', 't_mcp_a', 't_mcp_a_b']);
    expect(second.agent?.tools).toEqual(first.agent?.tools);
  });

  test('duplicates collapse and empty servers contribute no tools', async () => {
    const withEmpty: LoadAgentDeps = {
      ...orderDeps,
      getMCPServerTools: async (_userId, serverName) =>
        serverName === 'empty' ? {} : (catalogs[serverName] ?? null),
    };
    const result = await load(['gamma', 'empty', 'gamma', 'alpha', 'empty'], withEmpty);
    expect(result.published).toEqual(['alpha', 'empty', 'gamma']);
    expect(result.agent?.tools).toEqual(['a_mcp_alpha', 'b_mcp_alpha', 'only_mcp_gamma']);
  });

  test('a failing server keeps its placeholder in name order among resolved servers', async () => {
    const partial: LoadAgentDeps = {
      ...orderDeps,
      getMCPServerTools: async (_userId, serverName) =>
        serverName === 'beta' ? null : (catalogs[serverName] ?? null),
    };
    const result = await load(['gamma', 'beta', 'alpha'], partial);
    expect(result.agent?.tools).toEqual([
      'a_mcp_alpha',
      'b_mcp_alpha',
      'sys__all__sys_mcp_beta',
      'only_mcp_gamma',
    ]);
  });

  test('spec servers merge with the picker selection in one name-ordered set', async () => {
    const req = {
      user: { id: 'user-1' },
      config: {
        ...STABLE_CONTEXT,
        modelSpecs: { list: [{ name: 'pinned', mcpServers: ['gamma', 'alpha'] }] },
      },
      body: { ephemeralAgent: { mcp: ['beta', 'alpha'] } },
    } as unknown as Parameters<typeof loadEphemeralAgent>[0]['req'];
    const agent = await loadEphemeralAgent(
      {
        req,
        spec: 'pinned',
        endpoint: 'my-custom-endpoint',
        model_parameters: { model: 'm' } as never,
      },
      orderDeps,
    );
    expect(req.body?.ephemeralAgent?.mcp).toEqual(['alpha', 'beta', 'gamma']);
    expect(agent?.tools).toEqual([
      'a_mcp_alpha',
      'b_mcp_alpha',
      'c_mcp_beta',
      'm_mcp_beta',
      'z_mcp_beta',
      'only_mcp_gamma',
    ]);
  });

  test('placeholders for unresolved servers follow server name order', async () => {
    const result = await load(['beta', 'unknown_b', 'unknown_a'], {
      ...orderDeps,
      getMCPServerTools: async () => null,
    });
    expect(result.agent?.tools).toEqual([
      'sys__all__sys_mcp_beta',
      'sys__all__sys_mcp_unknown_a',
      'sys__all__sys_mcp_unknown_b',
    ]);
  });
});
