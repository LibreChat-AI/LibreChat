import { ContentTypes } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { ContextEntry, SendSnapshot, TurnContextAgent } from './registry';
import type { LiveToolGroups } from './tools';
import type { TurnContextMessage } from './anchor';
import type { TurnPlan } from './ledger';
import { collectToolGroups, getToolGroupKey, isToolGroupKey } from './tools';
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
const WEB_SEARCH: LCTool = { name: 'web_search', description: 'Searches the web.' };
const BASH: LCTool = { name: 'bash_tool', description: 'Runs bash.' };
const READ_FILE: LCTool = { name: 'read_file', description: 'Reads a file.' };
const SKILL: LCTool = { name: 'skill', description: 'Runs a skill.' };
const ASK: LCTool = { name: 'ask_user_question', description: 'Asks the user.' };
const WEB_SEARCH_GUIDE = 'Cite every web source.';
const withParameter = (tool: LCTool, name: string): LCTool => ({
  ...tool,
  parameters: { type: 'object', properties: { [name]: { type: 'string' } } },
});
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
  /** Leaves out the memory tool, the only tool every other state has. */
  bare?: boolean;
  webSearch?: boolean;
  code?: boolean;
  skills?: boolean;
  ask?: boolean;
  /** Adds the tool intents parameter to the memory tool. */
  intent?: boolean;
  /** A provider web search tool in the agent's tools. */
  providerSearch?: boolean;
  model?: string;
  /** Spawn targets of the agent's subagent tool, by description. */
  subagents?: readonly string[];
  /** Builds the same setup with its object keys in the opposite order. */
  flipKeys?: boolean;
  /** Raw names of the servers hidden from the acting user. */
  hidden?: string[];
}

const flipped = <T extends Record<string, unknown>>(value: T, flip?: boolean): T =>
  flip ? (Object.fromEntries(Object.entries(value).reverse()) as T) : value;

function buildAgent(state: ToolState): TurnContextAgent {
  const servers = state.mcp ?? [];
  const definitions: LCTool[] = [
    ...(state.bare ? [] : [state.intent ? withParameter(MEMORY, 'intent') : MEMORY]),
    ...(state.webSearch ? [WEB_SEARCH] : []),
    ...(state.code ? [BASH, READ_FILE] : []),
    ...(state.skills ? [SKILL, ...(state.code ? [] : [READ_FILE])] : []),
    ...(state.ask ? [ASK] : []),
    ...(state.calculator ? [CALCULATOR] : []),
    ...(state.action ? [ACTION] : []),
    /** Loaded in selection order: the plan orders servers itself. */
    ...servers.flatMap((server) =>
      ['search', 'fetch'].map((tool) =>
        mcpTool(tool, server, server === state.drift ? `${tool} v2` : undefined),
      ),
    ),
  ];
  return {
    provider: 'openAI',
    model_parameters: { model: state.model ?? 'model-a' },
    ...(state.subagents && {
      subagents: flipped({ enabled: true, allowSelf: false }, state.flipKeys),
      subagentAgentConfigs: new Map(
        state.subagents.map((description, i) => [
          `agent_${i}`,
          flipped({ id: `agent_${i}`, description }, state.flipKeys),
        ]),
      ),
    }),
    tools: state.providerSearch
      ? [
          flipped(
            {
              type: 'web_search',
              user_location: flipped({ country: 'US', city: 'X' }, state.flipKeys),
            },
            state.flipKeys,
          ),
        ]
      : [],
    codeEnvAvailable: state.code === true,
    toolContextMap: state.webSearch ? { web_search: WEB_SEARCH_GUIDE } : {},
    toolDefinitions: definitions,
    toolRegistry: new Map(definitions.map((definition) => [definition.name, { ...definition }])),
    selectedToolNames: [
      ...(state.bare ? [] : ['memory']),
      ...(state.webSearch ? ['web_search'] : []),
      ...(state.code ? ['execute_code'] : []),
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
    getHidden: async () => state.hidden ?? [],
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
    this.store(plan);
    const agent = snapshot.agent;
    applyTurnContext(agent, plan);
    return { plan, agent, update: plan.updates.get(messages.length - 1) };
  }

  /** Stores the anchor where the server would: write-once. */
  store(plan: TurnPlan) {
    if (plan.anchorTarget?.messageId === null) {
      this.anchor ??= plan.anchor;
    } else if (plan.anchorTarget != null) {
      const carrier = this.rows.find(({ messageId }) => messageId === plan.anchorTarget?.messageId);
      if (carrier != null && carrier.contextAnchor == null) {
        carrier.contextAnchor = plan.anchor;
      }
    }
  }

  /** Regenerates the last turn: the user message is not sent again, so nothing is written. */
  async regenerate(state: ToolState) {
    const index = this.rows.length - 2;
    const messages = this.rows.slice(0, index + 1);
    const snapshot = await snapshotOf(state);
    const plan = planTurnContext({
      messages,
      conversationAnchor: this.anchor,
      snapshot,
    });
    this.store(plan);
    applyTurnContext(snapshot.agent, plan);
    return { plan, agent: snapshot.agent, update: plan.updates.get(index) };
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
    expect(getToolGroupKey({ name: 'lc_custom_tool' })).toBeUndefined();
  });

  it('orders MCP servers and their tools by name, other groups as listed', async () => {
    const { toolGroups } = await snapshotOf({
      mcp: ['beta', 'alpha'],
      action: true,
      calculator: true,
    });
    expect([...(toolGroups as LiveToolGroups).groups.keys()]).toEqual([
      'tool:builtin:memory',
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

  it('leaves a server hidden from the user out of the bound tools and the instructions', async () => {
    const turns = await new Conversation().play([
      { mcp: ['alpha', 'beta'] },
      { mcp: ['beta'], hidden: ['alpha'] },
    ]);
    expect(boundNames(turns[0].agent)).toContain('search_mcp_alpha');
    expect(boundNames(turns[1].agent).some((name) => name.endsWith('_mcp_alpha'))).toBe(false);
    expect(boundNames(turns[1].agent)).toContain('search_mcp_beta');
    expect(turns[1].plan.tools?.mcpInstructions).not.toContain('Alpha');
    expect(turns[1].plan.tools?.mcpInstructions).toContain('Beta');
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

  it('leaves a conversation without groups untouched until it gets its first group', async () => {
    const turns = await new Conversation().play([
      { bare: true },
      { bare: true },
      { bare: true, mcp: ['beta'] },
      { bare: true },
    ]);
    expect(turns[0].agent.toolDispatch).toBeUndefined();
    expect(turns[1].plan.tools).toBeUndefined();
    expect(turns[1].agent.liveTools).toBeUndefined();
    expect(boundNames(turns[1].agent)).toEqual([]);
    expect(turns[2].agent.toolDispatch).toBe(true);
    expect(boundNames(turns[2].agent)).toEqual([]);
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
      expect(before.plan.anchor.map(({ key }) => key).filter(isToolGroupKey)).toEqual([
        'tool:builtin:memory',
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

describe('built-in capabilities as tool groups', () => {
  it('binds built-ins first, in a fixed order, with their instructions from the anchor', async () => {
    const [turn] = await new Conversation().play([
      { mcp: ['alpha'], skills: true, code: true, webSearch: true },
    ]);
    expect(turn.plan.anchor.map(({ key }) => key).filter(isToolGroupKey)).toEqual([
      'tool:builtin:web_search',
      'tool:builtin:execute_code',
      'tool:builtin:skills',
      'tool:builtin:memory',
      'tool:mcp:alpha',
    ]);
    expect(boundNames(turn.agent)).toEqual([
      'web_search',
      'bash_tool',
      'read_file',
      'skill',
      'set_memory',
      'fetch_mcp_alpha',
      'search_mcp_alpha',
    ]);
    expect(turn.agent.toolContextMap).toEqual({ web_search: WEB_SEARCH_GUIDE });
  });

  it('defers a built-in enabled mid-segment and keeps its instructions out of the system prompt', async () => {
    const turns = await new Conversation().play([
      {},
      { webSearch: true },
      { webSearch: true },
      {},
      { webSearch: true },
    ]);
    for (const turn of turns.slice(1)) {
      expect(boundTools(turn.agent)).toBe(boundTools(turns[0].agent));
      expect(turn.agent.toolContextMap).toEqual({});
    }
    expect(find(turns[1].agent, 'web_search')?.defer_loading).toBe(true);
    expect(turns[1].update).toContain(
      'Tools of built-in capability `web_search` are now available.',
    );
    expect(turns[1].update).toContain(WEB_SEARCH_GUIDE);
    expect(turns[1].update).toContain('- web_search: Searches the web.');
    expect(turns[2].update).toBeUndefined();
    expect(turns[3].update).toContain(
      'Tools of built-in capability `web_search` were switched off',
    );
    expect(turns[4].update).toContain('are available again');
  });
});

describe('declared resets', () => {
  const groupKeys = (plan: TurnPlan) => plan.anchor.map(({ key }) => key).filter(isToolGroupKey);

  it('re-anchors on the sent message when the model changes, keeping the tool order', async () => {
    const convo = new Conversation();
    const turns = await convo.play([
      { mcp: ['alpha', 'beta'] },
      { mcp: ['beta', 'gamma'] },
      { mcp: ['beta', 'gamma'], model: 'model-b' },
      { mcp: ['beta', 'gamma'], model: 'model-b' },
    ]);
    expect(turns[2].plan.reset).toEqual(['model']);
    expect(turns[2].plan.anchorTarget).toEqual({ messageId: 'u4' });
    expect(convo.rows[4].contextAnchor).toEqual(turns[2].plan.anchor);
    expect(groupKeys(turns[2].plan)).toEqual([
      'tool:builtin:memory',
      'tool:mcp:beta',
      'tool:mcp:gamma',
    ]);
    expect(boundNames(turns[2].agent)).toEqual([
      'set_memory',
      'fetch_mcp_beta',
      'search_mcp_beta',
      'fetch_mcp_gamma',
      'search_mcp_gamma',
    ]);
    /** Earlier announcements are part of the new anchor; the reset turn announces nothing. */
    expect(turns[2].plan.updates.size).toBe(0);
    expect(turns[2].plan.currentEntries).toEqual([]);
    expect(turns[3].plan.reset).toBeUndefined();
    expect(turns[3].plan.anchorTarget).toBeUndefined();
    expect(boundTools(turns[3].agent)).toBe(boundTools(turns[2].agent));
  });

  it.each([
    ['provider_tools', { providerSearch: true }],
    ['agent', { subagents: ['Reviews code.'] }],
    ['tool_profile', { intent: true }],
    ['tools', { ask: true }],
  ] as const)('re-anchors for %s', async (reason, change) => {
    const turns = await new Conversation().play([{}, change]);
    expect(turns[1].plan.reset).toEqual([reason]);
  });

  it('re-anchors without an MCP server that became hidden from the user, schemas and instructions', async () => {
    const convo = new Conversation();
    const turns = await convo.play([
      { mcp: ['alpha', 'beta'] },
      { mcp: ['beta'], hidden: ['alpha'] },
      { mcp: ['beta'], hidden: ['alpha'] },
    ]);
    expect(turns[0].plan.tools?.mcpInstructions).toContain('Alpha');
    expect(turns[1].plan.reset).toEqual(['mcp_hidden']);
    expect(turns[1].plan.anchorTarget).toEqual({ messageId: 'u2' });
    expect(groupKeys(turns[1].plan)).toEqual(['tool:builtin:memory', 'tool:mcp:beta']);
    expect(boundNames(turns[1].agent).some((name) => name.endsWith('_mcp_alpha'))).toBe(false);
    expect(turns[1].plan.tools?.mcpInstructions).not.toContain('Alpha');
    expect(turns[1].plan.tools?.mcpInstructions).toContain('Beta');
    expect(turns[2].plan.reset).toBeUndefined();
    expect(boundTools(turns[2].agent)).toBe(boundTools(turns[1].agent));
  });

  it('keeps the anchor a reset turn stored when its reply is regenerated', async () => {
    const convo = new Conversation();
    const turns = await convo.play([{}, { model: 'model-b' }]);
    const stored = convo.rows[2].contextAnchor;
    expect(stored).toEqual(turns[1].plan.anchor);

    const regenerated = await convo.regenerate({ model: 'model-c', webSearch: true });
    expect(regenerated.plan.reset).toBeUndefined();
    expect(regenerated.plan.anchorTarget).toBeUndefined();
    expect(regenerated.plan.currentEntries).toBeUndefined();
    expect(regenerated.update).toBeUndefined();
    expect(convo.rows[2].contextAnchor).toBe(stored);
    expect(boundTools(regenerated.agent)).toBe(boundTools(turns[1].agent));
  });

  it('does not reset when the same setup is built with its keys in another order', async () => {
    const convo = new Conversation();
    const setup = (flip: boolean): ToolState => ({
      providerSearch: true,
      subagents: ['Reviews code.', 'Writes tests.'],
      model: 'model-a',
      flipKeys: flip,
    });
    const turns = await convo.play([setup(false), setup(true), setup(false), setup(true)]);
    for (const turn of turns) {
      expect(turn.plan.reset).toBeUndefined();
    }
    expect(boundTools(turns[3].agent)).toBe(boundTools(turns[0].agent));
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
