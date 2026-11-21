import { HumanMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { AIMessageChunk } from '@librechat/agents/langchain/messages';
import { Constants, FakeChatModel, GraphEvents, Providers } from '@librechat/agents';
import type { EventHandler, SubagentUpdateEvent, SubagentResolveContext } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { AppConfig } from '@librechat/data-schemas';
import { createRun } from '~/agents/run';

const QUESTION = 'Find the ledger total.';
const COPY_TASK = 'Copy task: ask the ledger subagent for the total.';
const LEDGER_TASK = 'Ledger task: report the total.';
const TOTAL = 'The ledger total is 4217.';
const UNREACHED = 'No subagent took the ledger task.';

function text(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/**
 * One model for every agent in the run. It sees no system prompt, so it tells the agents apart by
 * the task each was handed: the orchestrator spawns a copy of itself, the copy asks the ledger
 * subagent, and the ledger subagent answers. Whoever holds a tool result reports it, so the
 * answer has to travel back through each hop.
 */
class Delegating extends FakeChatModel {
  constructor() {
    super({ responses: ['unused'] });
  }

  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const transcript = messages.map(text).join('\n');
    const result = messages.filter((message) => message.getType() === 'tool').pop();
    if (result != null) {
      yield this._createResponseChunk(`Reported: ${text(result)}`);
      return;
    }
    const delegated = transcript.includes(COPY_TASK);
    if (transcript.includes(LEDGER_TASK)) {
      /** A copy that still holds its own request was refused the call, and no one answered. */
      yield this._createResponseChunk(delegated ? UNREACHED : TOTAL);
      return;
    }
    const args = delegated
      ? { subagent_type: 'ledger', description: LEDGER_TASK }
      : { subagent_type: 'self', description: COPY_TASK };
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            id: delegated ? 'call-ledger' : 'call-self',
            name: Constants.SUBAGENT,
            args: JSON.stringify(args),
            index: 0,
          },
        ],
      }),
    });
  }
}

function makeAgent(id: string, instructions: string) {
  return {
    id,
    name: id,
    provider: Providers.OPENAI,
    endpoint: Providers.OPENAI,
    instructions,
    tools: [],
    maxContextTokens: 100_000,
    recursion_limit: 9,
    model_parameters: { model: 'gpt-4o', apiKey: 'test' },
  };
}

/**
 * `lazy` loads the ledger subagent the way the server does: a descriptor now, the agent itself
 * only once a call selects it, resolved with the context of whoever made that call.
 */
async function delegate({
  appConfig,
  lazy = false,
}: { appConfig?: AppConfig; lazy?: boolean } = {}) {
  const ledger = makeAgent('ledger', 'You keep the ledger.');
  const callers: (string | undefined)[] = [];
  const orchestrator = {
    ...makeAgent('orchestrator', 'You route work to subagents.'),
    subagents: { enabled: true, agent_ids: ['ledger'] },
    ...(lazy
      ? {
          lazySubagentConfigs: [
            {
              ...ledger,
              configId: 'ledger-v1',
              resolve: async (context: SubagentResolveContext) => {
                callers.push(context.parentAgentId);
                return ledger;
              },
            },
          ],
        }
      : { subagentAgentConfigs: [ledger] }),
  };
  const updates: SubagentUpdateEvent[] = [];
  const handlers: Record<string, EventHandler> = {
    [GraphEvents.ON_SUBAGENT_UPDATE]: {
      handle: (_event: string, data: unknown) => {
        updates.push(data as SubagentUpdateEvent);
      },
    },
  };
  const messages = [new HumanMessage(QUESTION)];
  const run = await createRun({
    agents: [orchestrator] as never,
    messages,
    runId: 'self-nesting',
    signal: new AbortController().signal,
    customHandlers: handlers,
    appConfig,
    streaming: true,
    streamUsage: true,
  });
  if (!run.Graph) {
    throw new Error('Missing graph');
  }
  const model = new Delegating();
  run.Graph.overrideModel = model;
  run.Graph.setSubagentModelOverride(model);
  await run.processStream(
    { messages },
    { configurable: { thread_id: 'self-nesting' }, recursionLimit: 50, version: 'v2' },
  );
  const answer = (run.getRunMessages() ?? []).map(text).join('\n');
  const spawned = new Set(updates.map((event) => event.subagentType));
  return { answer, spawned, callers };
}

describe('a self-spawned copy delegating through the SDK', () => {
  it('reaches the specialist and carries its answer back to the orchestrator', async () => {
    const { answer, spawned } = await delegate();

    expect(spawned).toEqual(new Set(['self', 'ledger']));
    expect(answer).toContain(TOTAL);
  });

  it('loads a subagent the copy is first to call, as a call from the orchestrator', async () => {
    const { answer, spawned, callers } = await delegate({ lazy: true });

    expect(spawned).toEqual(new Set(['self', 'ledger']));
    expect(callers).toEqual(['orchestrator']);
    expect(answer).toContain(TOTAL);
  });

  it('has no subagent to call when subagentSelfNesting is off', async () => {
    const { answer, spawned } = await delegate({
      appConfig: { endpoints: { agents: { subagentSelfNesting: false } } } as AppConfig,
    });

    expect(spawned).toEqual(new Set(['self']));
    expect(answer).toContain(UNREACHED);
    expect(answer).not.toContain(TOTAL);
  });
});
