import { ContentTypes } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { ContextEntry, SendSnapshot, TurnContextAgent } from './registry';
import type { LiveToolGroups } from './tools';
import type { TurnContextMessage } from './anchor';
import type { TurnPlan } from './ledger';
import { collectToolGroups, getToolGroupKey } from './tools';
import { applyTurnContext } from './anchor';
import { planTurnContext } from './ledger';

const AT = '2026-03-09T20:00:00.000Z';
const INSTRUCTIONS: Record<string, string> = {
  alpha: 'Alpha answers in French.',
  beta: 'Beta needs an order id.',
};

const mcpTool = (tool: string, server: string, description = `${tool} on ${server}`): LCTool => ({
  name: `${tool}_mcp_${server}`,
  description,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  serverName: server,
});

const MEMORY: LCTool = { name: 'set_memory', description: 'Saves a memory.' };
const ACTION: LCTool = { name: 'getWeather_action_api---example---com', description: 'Weather.' };
const CALCULATOR: LCTool = { name: 'calculator', description: 'Calculates.' };

interface ToolState {
  mcp?: string[];
  /** Servers the agent selected whose catalog could not be loaded. */
  down?: string[];
  action?: boolean;
  calculator?: boolean;
  /** Replaces a server's tool descriptions, as a server-side schema change would. */
  drift?: string;
  /** The tool names a server offers; `search` and `fetch` by default. */
  tools?: Record<string, string[]>;
}

function buildAgent(state: ToolState): TurnContextAgent {
  const servers = state.mcp ?? [];
  const definitions: LCTool[] = [
    MEMORY,
    ...(state.calculator ? [CALCULATOR] : []),
    ...(state.action ? [ACTION] : []),
    /** Loaded in selection order: the plan orders servers itself. */
    ...servers.flatMap((server) =>
      (state.tools?.[server] ?? ['search', 'fetch']).map((tool) =>
        mcpTool(tool, server, server === state.drift ? `${tool} v2` : undefined),
      ),
    ),
  ];
  return {
    toolDefinitions: definitions,
    toolRegistry: new Map(definitions.map((definition) => [definition.name, { ...definition }])),
    selectedToolNames: [
      'memory',
      ...servers.map((server) => `sys__all__sys_mcp_${server}`),
      ...(state.down ?? []).map((server) => `sys__all__sys_mcp_${server}`),
    ],
  };
}

async function snapshotOf(state: ToolState): Promise<SendSnapshot> {
  const agent = buildAgent(state);
  const toolGroups = await collectToolGroups({
    agent,
    getInstructions: async (servers) =>
      Object.fromEntries(servers.filter((s) => INSTRUCTIONS[s]).map((s) => [s, INSTRUCTIONS[s]])),
  });
  return {
    agent,
    turnStartedAt: AT,
    dateContext: false,
    messageTimestamps: false,
    toolGroups,
  };
}

interface Row extends TurnContextMessage {
  messageId: string;
  contextUpdates?: ContextEntry[];
  contextAnchor?: ContextEntry[];
}

class Conversation {
  rows: Row[] = [];
  anchor: ContextEntry[] | null = null;

  async send(state: ToolState, { summary = false } = {}) {
    const user: Row = { messageId: `u${this.rows.length}`, isCreatedByUser: true };
    const messages = [...this.rows, user];
    const snapshot = await snapshotOf(state);
    const plan = planTurnContext({
      messages,
      conversationAnchor: this.anchor,
      snapshot,
      currentIndex: messages.length - 1,
    });
    this.rows.push({ ...user, contextUpdates: plan.currentEntries });
    this.rows.push({
      messageId: `a${this.rows.length}`,
      isCreatedByUser: false,
      content: summary
        ? [
            {
              type: ContentTypes.SUMMARY,
              content: [{ type: ContentTypes.TEXT, text: 'Earlier.' }],
              boundary: { messageId: 'm', contentIndex: 0 },
            },
          ]
        : [{ type: ContentTypes.TEXT, text: 'Answer' }],
    });
    if (plan.anchorTarget?.messageId === null) {
      this.anchor ??= plan.anchor;
    } else if (plan.anchorTarget != null) {
      const carrier = this.rows.find(({ messageId }) => messageId === plan.anchorTarget?.messageId);
      if (carrier != null) {
        carrier.contextAnchor ??= plan.anchor;
      }
    }
    const agent = snapshot.agent;
    applyTurnContext(agent, plan);
    return { plan, agent, update: plan.updates.get(messages.length - 1) };
  }

  async play(states: ToolState[]) {
    const turns = [];
    for (const state of states) {
      turns.push(await this.send(state));
    }
    return turns;
  }
}

/** What reaches the provider: the bound tools, in order, and the schema bytes. */
const boundTools = (agent: TurnContextAgent) =>
  JSON.stringify(
    (agent.toolDefinitions ?? [])
      .filter((tool) => tool.defer_loading !== true)
      .map(({ name, description, parameters }) => ({ name, description, parameters })),
  );
const boundNames = (agent: TurnContextAgent) =>
  (agent.toolDefinitions ?? []).filter((t) => t.defer_loading !== true).map(({ name }) => name);
const find = (agent: TurnContextAgent, name: string) =>
  agent.toolDefinitions?.find((tool) => tool.name === name);

describe('tool groups', () => {
  it('groups MCP tools by server, actions by domain and agent tools by toolkit', () => {
    expect(getToolGroupKey(mcpTool('search', 'alpha'))).toBe('tool:mcp:alpha');
    expect(getToolGroupKey({ name: 'search_mcp_my-server' })).toBe('tool:mcp:my-server');
    expect(getToolGroupKey({ name: 'x_mcp_srv', serverName: 'My Server' })).toBe(
      'tool:mcp:My_Server',
    );
    expect(getToolGroupKey(ACTION)).toBe('tool:action:api---example---com');
    expect(getToolGroupKey(CALCULATOR)).toBe('tool:agent:calculator');
    expect(getToolGroupKey({ name: 'image_edit_oai' })).toBe('tool:agent:image_gen_oai');
    for (const name of [
      'web_search',
      'file_search',
      'ask_user_question',
      'set_memory',
      'bash_tool',
    ]) {
      expect(getToolGroupKey({ name })).toBeUndefined();
    }
  });

  it('orders MCP servers and their tools by name, other groups as listed', async () => {
    const { toolGroups } = await snapshotOf({
      mcp: ['beta', 'alpha'],
      action: true,
      calculator: true,
    });
    expect([...(toolGroups as LiveToolGroups).groups.keys()]).toEqual([
      'tool:mcp:alpha',
      'tool:mcp:beta',
      'tool:agent:calculator',
      'tool:action:api---example---com',
    ]);
    const alpha = JSON.parse(toolGroups?.groups.get('tool:mcp:alpha')?.value as string);
    expect(alpha.instructions).toBe(INSTRUCTIONS.alpha);
    expect(alpha.tools.map(({ name }: LCTool) => name)).toEqual([
      'fetch_mcp_alpha',
      'search_mcp_alpha',
    ]);
    const reordered = await snapshotOf({ mcp: ['alpha', 'beta'], action: true, calculator: true });
    expect([...(reordered.toolGroups as LiveToolGroups).groups]).toEqual(
      [...(toolGroups as LiveToolGroups).groups].map(([key, { value }]) => [
        key,
        expect.objectContaining({ value }),
      ]),
    );
  });

  it('leaves deferred and code-only tools out of a group and reports unavailable selections', async () => {
    const agent = buildAgent({ mcp: ['alpha'], down: ['gamma'] });
    agent.toolDefinitions = [
      ...(agent.toolDefinitions ?? []),
      { ...mcpTool('lazy', 'alpha'), defer_loading: true },
      { ...mcpTool('coded', 'alpha'), allowed_callers: ['code_execution'] },
    ];
    const { groups, unavailable } = await collectToolGroups({ agent });
    const alpha = JSON.parse(groups.get('tool:mcp:alpha')?.value as string);
    expect(alpha.tools.map(({ name }: LCTool) => name)).toEqual([
      'fetch_mcp_alpha',
      'search_mcp_alpha',
    ]);
    expect([...unavailable]).toEqual(['tool:mcp:gamma']);
  });
});

describe('planning tools against the anchor', () => {
  it('binds the anchored groups after the ungrouped tools and binds the dispatcher', async () => {
    const [turn] = await new Conversation().play([{ mcp: ['beta', 'alpha'] }]);
    expect(boundNames(turn.agent)).toEqual([
      'set_memory',
      'fetch_mcp_alpha',
      'search_mcp_alpha',
      'fetch_mcp_beta',
      'search_mcp_beta',
    ]);
    expect(turn.agent.toolDispatch).toBe(true);
    expect(turn.plan.tools?.mcpInstructions).toContain('## alpha MCP Server Instructions');
    expect(turn.plan.tools?.mcpInstructions.indexOf('alpha')).toBeLessThan(
      turn.plan.tools?.mcpInstructions.indexOf('beta') as number,
    );
    expect(turn.update).toBeUndefined();
  });

  it('defers a server enabled mid-segment and announces it once, with schemas', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha'] },
      { mcp: ['alpha', 'beta'] },
      { mcp: ['alpha', 'beta'] },
    ]);
    expect(boundTools(turns[1].agent)).toBe(boundTools(turns[0].agent));
    expect(boundTools(turns[2].agent)).toBe(boundTools(turns[0].agent));
    expect(find(turns[1].agent, 'search_mcp_beta')?.defer_loading).toBe(true);
    expect(turns[1].agent.toolRegistry?.get('search_mcp_beta')?.defer_loading).toBe(true);
    expect(turns[1].update).toContain('Tools of MCP server `beta` are now available.');
    expect(turns[1].update).toContain('call them with `call_tool`');
    expect(turns[1].update).toContain(INSTRUCTIONS.beta);
    expect(turns[1].update).toContain('- search_mcp_beta: search on beta');
    expect(turns[1].update).toContain('parameters: {"type":"object","properties":{"q":');
    expect(turns[1].plan.currentEntries?.map(({ key }) => key)).toEqual(['tool:mcp:beta']);
    expect(turns[2].update).toBeUndefined();
    /** Its instructions stay out of the system prompt until the next anchor. */
    expect(turns[2].plan.tools?.mcpInstructions).not.toContain(INSTRUCTIONS.beta);
  });

  it('keeps a switched-off anchored server bound, refusing calls, and announces both ways', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha', 'beta'] },
      { mcp: ['beta'] },
      { mcp: ['alpha', 'beta'] },
    ]);
    expect(boundTools(turns[1].agent)).toBe(boundTools(turns[0].agent));
    expect(find(turns[1].agent, 'search_mcp_alpha')?.disabled).toEqual({ reason: 'switched off' });
    expect(turns[1].agent.toolRegistry?.get('search_mcp_alpha')?.disabled).toEqual({
      reason: 'switched off',
    });
    expect(turns[1].update).toBe(
      '<context_update>\nTools of MCP server `alpha` were switched off; calls to them will fail.\n</context_update>',
    );
    expect(find(turns[2].agent, 'search_mcp_alpha')?.disabled).toBeUndefined();
    expect(turns[2].update).toContain('Tools of MCP server `alpha` are available again.');
    expect(turns[2].plan.tools?.mcpInstructions).toBe(turns[0].plan.tools?.mcpInstructions);
  });

  it('announces what changed while a server was switched off when it comes back', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha', 'beta'] },
      { mcp: ['beta'] },
      { mcp: ['alpha', 'beta'], drift: 'alpha' },
    ]);
    expect(turns[2].update).toContain('Tools of MCP server `alpha` are available again.');
    expect(turns[2].update).toContain('- search_mcp_alpha: search v2');
  });

  it('states only that a server is available again when it did not change while off', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha', 'beta'] },
      { mcp: ['beta'] },
      { mcp: ['alpha', 'beta'] },
    ]);
    expect(turns[2].update).toBe(
      '<context_update>\nTools of MCP server `alpha` are available again.\n</context_update>',
    );
  });

  it('marks an anchored server that cannot be reached unavailable, without an update', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha', 'beta'] },
      { mcp: ['beta'], down: ['alpha'] },
      { mcp: ['alpha', 'beta'] },
    ]);
    expect(boundTools(turns[1].agent)).toBe(boundTools(turns[0].agent));
    expect(find(turns[1].agent, 'fetch_mcp_alpha')?.disabled).toEqual({ reason: 'unavailable' });
    expect(turns[1].update).toBeUndefined();
    expect(turns[2].update).toBeUndefined();
    /** The anchor keeps the instructions it was given. */
    expect(turns[1].plan.tools?.mcpInstructions).toContain(INSTRUCTIONS.alpha);
  });

  it('announces a schema a server changed mid-segment and keeps the bound tools', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha'] },
      { mcp: ['alpha'], drift: 'alpha' },
      { mcp: ['alpha'], drift: 'alpha' },
    ]);
    expect(boundTools(turns[1].agent)).toBe(boundTools(turns[0].agent));
    expect(turns[1].update).toContain('Tools of MCP server `alpha` changed.');
    expect(turns[1].update).toContain('Your tool list still shows their previous parameters');
    expect(turns[1].update).toContain('search v2');
    expect(turns[1].update).toContain('fetch v2');
    /** A change is announced once, on the message sent with it. */
    expect(turns[2].update).toBeUndefined();
    expect(boundTools(turns[2].agent)).toBe(boundTools(turns[0].agent));
  });

  it('announces a server that adds and removes tools without changing the bound ones', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha'] },
      { mcp: ['alpha'], tools: { alpha: ['search', 'fetch', 'export'] } },
      { mcp: ['alpha'], tools: { alpha: ['search', 'export'] } },
    ]);
    expect(boundTools(turns[1].agent)).toBe(boundTools(turns[0].agent));
    expect(turns[1].update).toContain('New tools.');
    expect(turns[1].update).toContain('call them with `call_tool`');
    expect(turns[1].update).toContain('- export_mcp_alpha');
    expect(turns[2].update).toContain('Removed tools, calls to them will fail: fetch_mcp_alpha.');
    expect(find(turns[1].agent, 'export_mcp_alpha')?.defer_loading).toBe(true);
    expect(find(turns[2].agent, 'fetch_mcp_alpha')?.disabled).toBeDefined();
  });

  it('announces a deferred server switched off and on again without repeating its schemas', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha'] },
      { mcp: ['alpha', 'beta'] },
      { mcp: ['alpha'] },
      { mcp: ['alpha', 'beta'] },
    ]);
    expect(turns[2].update).toContain('Tools of MCP server `beta` were switched off');
    expect(find(turns[2].agent, 'search_mcp_beta')).toBeUndefined();
    expect(turns[3].update).toContain('Tools of MCP server `beta` are available again.');
    expect(turns[3].update).not.toContain('parameters');
    expect(find(turns[3].agent, 'search_mcp_beta')?.defer_loading).toBe(true);
  });

  describe('toggles flipped before sending', () => {
    it('send the untouched tools when a server ends switched off', async () => {
      const untouched = await new Conversation().play([{ mcp: ['alpha'] }, { mcp: ['alpha'] }]);
      /** On, off, on, off between the turns: only the state at send time is read. */
      const flapped = await new Conversation().play([{ mcp: ['alpha'] }, { mcp: ['alpha'] }]);
      expect(flapped[1].plan.currentEntries).toEqual([]);
      expect(flapped[1].update).toBeUndefined();
      expect(JSON.stringify(flapped[1].agent.toolDefinitions)).toBe(
        JSON.stringify(untouched[1].agent.toolDefinitions),
      );
    });
  });

  it('leaves a conversation without groups untouched until it gets its first group', async () => {
    const turns = await new Conversation().play([{}, {}, { mcp: ['beta'] }, {}]);
    expect(turns[0].agent.toolDispatch).toBeUndefined();
    expect(turns[1].plan.tools).toBeUndefined();
    expect(turns[1].agent.liveTools).toBeUndefined();
    expect(boundNames(turns[1].agent)).toEqual(['set_memory']);
    expect(turns[2].agent.toolDispatch).toBe(true);
    expect(boundNames(turns[2].agent)).toEqual(['set_memory']);
    expect(turns[2].update).toContain('Tools of MCP server `beta` are now available.');
    /** Bound from then on, so the tool list does not change back. */
    expect(turns[3].agent.toolDispatch).toBe(true);
  });

  describe('compaction', () => {
    async function compacted() {
      const convo = new Conversation();
      await convo.play([
        { mcp: ['beta', 'gamma'], calculator: true },
        { mcp: ['alpha', 'beta', 'gamma', 'delta'], calculator: true },
      ]);
      await convo.send({ mcp: ['alpha', 'delta', 'gamma'], calculator: true }, { summary: true });
      return convo;
    }

    it('keeps the anchored order, drops what is off and appends what was deferred', async () => {
      const convo = await compacted();
      const before = await convo.send({ mcp: ['alpha', 'delta', 'gamma'], calculator: true });
      expect(boundNames(before.agent)).toEqual([
        'set_memory',
        'fetch_mcp_gamma',
        'search_mcp_gamma',
        'calculator',
        'fetch_mcp_alpha',
        'search_mcp_alpha',
        'fetch_mcp_delta',
        'search_mcp_delta',
      ]);
      expect(before.plan.anchor.map(({ key }) => key)).toEqual([
        'tool:mcp:gamma',
        'tool:agent:calculator',
        'tool:mcp:alpha',
        'tool:mcp:delta',
      ]);
      expect(before.update).toBeUndefined();
      expect(before.plan.tools?.mcpInstructions).toContain(INSTRUCTIONS.alpha);
      expect(before.agent.toolDispatch).toBe(true);
    });
  });
});

describe('applying a tool plan', () => {
  it('adds the anchored MCP instructions and keeps the loaded tools for subagent copies', async () => {
    const convo = new Conversation();
    const snapshot = await snapshotOf({ mcp: ['alpha'] });
    const agent = snapshot.agent;
    agent.instructions = 'Be brief.';
    const loaded = agent.toolDefinitions;
    const registry = agent.toolRegistry;
    const plan: TurnPlan = planTurnContext({
      messages: [{ messageId: 'u0', isCreatedByUser: true }],
      conversationAnchor: convo.anchor,
      snapshot,
      currentIndex: 0,
    });
    applyTurnContext(agent, plan);
    expect(agent.instructions).toBe(
      `Be brief.\n\n# MCP Server Instructions\n\nThe following MCP servers are available with their specific instructions:\n\n## alpha MCP Server Instructions\n\n${INSTRUCTIONS.alpha}\n\nPlease follow these instructions when using tools from the respective MCP servers.`,
    );
    expect(agent.liveTools).toEqual({ toolDefinitions: loaded, toolRegistry: registry });
    expect(registry?.get('search_mcp_alpha')?.defer_loading).toBeUndefined();
  });
});
