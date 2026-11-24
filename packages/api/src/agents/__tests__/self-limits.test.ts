import { HumanMessage } from '@langchain/core/messages';
import { MAX_SUBAGENT_DEPTH } from 'librechat-data-provider';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { AIMessageChunk } from '@librechat/agents/langchain/messages';
import { Constants, FakeChatModel, GraphEvents, Providers } from '@librechat/agents';
import type { EventHandler, SubagentUpdateEvent } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { AppConfig } from '@librechat/data-schemas';
import { createRun } from '~/agents/run';

function text(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function call(id: string, subagentType: string, description: string): ChatGenerationChunk {
  return new ChatGenerationChunk({
    text: '',
    message: new AIMessageChunk({
      content: '',
      tool_call_chunks: [
        {
          id,
          name: Constants.SUBAGENT,
          args: JSON.stringify({ subagent_type: subagentType, description }),
          index: 0,
        },
      ],
    }),
  });
}

/** How the SDK hands a child its parent's earlier tool calls: folded into a human message. */
const FOLDED = '[Previous tool interaction]';

/**
 * One scripted model for every agent in a run, deciding from the task it was handed. Once a turn
 * holds the outcome of a call, as a tool message or folded into the transcript after a refused
 * call, it reports that and stops.
 */
class Scripted extends FakeChatModel {
  constructor(private readonly decide: (task: string) => ChatGenerationChunk) {
    super({ responses: ['unused'] });
  }

  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const outcome = messages
      .filter((message) => message.getType() === 'tool' || text(message).includes(FOLDED))
      .pop();
    if (outcome != null) {
      yield this._createResponseChunk(`Reported: ${text(outcome)}`);
      return;
    }
    yield this.decide(messages.map(text).join('\n'));
  }
}

function makeAgent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    provider: Providers.OPENAI,
    endpoint: Providers.OPENAI,
    instructions: `You are ${id}.`,
    tools: [],
    maxContextTokens: 100_000,
    recursion_limit: 9,
    model_parameters: { model: 'gpt-4o', apiKey: 'test' },
    ...extra,
  };
}

async function execute(
  root: ReturnType<typeof makeAgent>,
  decide: (task: string) => ChatGenerationChunk,
  appConfig?: AppConfig,
) {
  const updates: SubagentUpdateEvent[] = [];
  const handlers: Record<string, EventHandler> = {
    [GraphEvents.ON_SUBAGENT_UPDATE]: {
      handle: (_event: string, data: unknown) => {
        updates.push(data as SubagentUpdateEvent);
      },
    },
  };
  const messages = [new HumanMessage('Begin.')];
  const run = await createRun({
    agents: [root] as never,
    messages,
    runId: 'self-limits',
    signal: new AbortController().signal,
    customHandlers: handlers,
    appConfig,
    streaming: true,
    streamUsage: true,
  });
  if (!run.Graph) {
    throw new Error('Missing graph');
  }
  const model = new Scripted(decide);
  run.Graph.overrideModel = model;
  run.Graph.setSubagentModelOverride(model);
  await run.processStream(
    { messages },
    { configurable: { thread_id: 'self-limits' }, recursionLimit: 50, version: 'v2' },
  );
  const answer = (run.getRunMessages() ?? []).map(text).join('\n');
  /** One entry per child run: what it was spawned as and how deep it ran. */
  const runs = new Map<string, { type: string; depth: number }>();
  for (const event of updates) {
    runs.set(event.subagentRunId, { type: event.subagentType, depth: event.depth ?? 0 });
  }
  return { answer, runs: [...runs.values()] };
}

describe('a self-spawned copy and a graph team', () => {
  const TEAM_TASK = 'Team task: total the ledger.';
  const COPY_TASK = 'Copy task: hand the ledger to the team.';
  const TOTAL = 'The ledger total is 4217.';

  function orchestrator() {
    const entry = makeAgent('team_reader');
    const result = makeAgent('team_writer');
    const definition = {
      type: 'ledger_team',
      name: 'Ledger team',
      description: 'Reads and totals the ledger.',
      agent_ids: [entry.id, result.id],
      edges: [{ from: entry.id, to: result.id, edgeType: 'direct' as const }],
      entry_agent_id: entry.id,
      result_agent_id: result.id,
    };
    return makeAgent('orchestrator', {
      subagents: { enabled: true, agent_ids: [], graphsEnabled: true, graphs: [definition] },
      subagentGraphConfigs: [{ definition, memberConfigs: [entry, result] }],
    });
  }

  const decide = (task: string): ChatGenerationChunk => {
    if (task.includes(TEAM_TASK) || task.includes(TOTAL)) {
      return new ChatGenerationChunk({
        text: TOTAL,
        message: new AIMessageChunk({ content: TOTAL }),
      });
    }
    return task.includes(COPY_TASK)
      ? call('call-team', 'ledger_team', TEAM_TASK)
      : call('call-copy', 'self', COPY_TASK);
  };

  it('runs the team from inside the copy and carries its answer back', async () => {
    const { answer, runs } = await execute(orchestrator(), decide);

    expect(runs).toEqual(
      expect.arrayContaining([
        { type: 'self', depth: 1 },
        { type: 'ledger_team', depth: 2 },
      ]),
    );
    expect(answer).toContain(TOTAL);
  });

  it('leaves the copy without the team when subagentSelfNesting is off', async () => {
    const { answer, runs } = await execute(orchestrator(), decide, {
      endpoints: { agents: { subagentSelfNesting: false } },
    } as AppConfig);

    expect(runs.map(({ type }) => type)).toEqual(['self']);
    expect(answer).not.toContain(TOTAL);
    expect(answer).toContain(FOLDED);
  });
});

describe('a model that always delegates', () => {
  /**
   * `chain_0` through `chain_5`: a saved chain at the depth limit, every agent with self-spawn on.
   * The task says where the model is: an agent hands the task to its copy, and a copy hands it
   * to the next agent in the chain. Nothing in the script ever stops delegating.
   */
  function chain() {
    const agents = Array.from({ length: MAX_SUBAGENT_DEPTH + 1 }, (_, index) =>
      makeAgent(`chain_${index}`),
    );
    for (let index = 0; index < MAX_SUBAGENT_DEPTH; index++) {
      Object.assign(agents[index], {
        subagents: { enabled: true, agent_ids: [agents[index + 1].id] },
        subagentAgentConfigs: [agents[index + 1]],
      });
    }
    return agents[0];
  }

  const decide = (task: string): ChatGenerationChunk => {
    const hops = [...task.matchAll(/HOP (\d+) (agent|copy)/g)];
    const [, at, mode] = hops[hops.length - 1] ?? ['', '0', 'agent'];
    const index = Number(at);
    return mode === 'agent'
      ? call(`call-copy-${index}`, 'self', `HOP ${index} copy`)
      : call(`call-next-${index}`, `chain_${index + 1}`, `HOP ${index + 1} agent`);
  };

  it(`stops at ${MAX_SUBAGENT_DEPTH} hops: no child runs deeper, and the run still ends`, async () => {
    const { answer, runs } = await execute(chain(), decide);

    expect(Math.max(...runs.map(({ depth }) => depth))).toBe(MAX_SUBAGENT_DEPTH);
    /** Agent, copy, agent, copy, agent, copy: the last copy is given no subagents. */
    expect(runs.map(({ type }) => type)).toEqual(['self', 'chain_1', 'self', 'chain_2', 'self']);
    expect(answer).toMatch(/Reported:/);
  });

  it('never lets a copy spawn a copy of its own', async () => {
    const copyOfCopy = (task: string): ChatGenerationChunk =>
      task.includes('Copy task')
        ? call('call-copy-again', 'self', 'Copy task again')
        : call('call-copy', 'self', 'Copy task');
    const { runs } = await execute(chain(), copyOfCopy);

    expect(runs).toEqual([{ type: 'self', depth: 1 }]);
  });
});
