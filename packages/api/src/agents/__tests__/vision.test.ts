import { HumanMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { AIMessageChunk } from '@librechat/agents/langchain/messages';
import { Constants, FakeChatModel, Providers } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { GraphEdge } from '@librechat/agents';
import { createSequentialChainEdges } from '~/agents/chain';
import { createRun } from '~/agents/run';

const IMAGE_URL = 'data:image/png;base64,iVBORw0KGgo=';
/** What `@librechat/agents` sends a model declared text-only in place of each image. */
const OMITTED = '[Image omitted because this model does not accept image input.]';

const READER = 'agent_reader';
const WRITER = 'agent_writer';

type Request = { images: number; omitted: number };

/** The images a request carried and the markers that replaced images. */
function inspect(messages: BaseMessage[]): Request {
  const request: Request = { images: 0, omitted: 0 };
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'image_url') {
        request.images += 1;
      } else if (part.type === 'text' && (part as { text?: string }).text === OMITTED) {
        request.omitted += 1;
      }
    }
  }
  return request;
}

/**
 * One model for every agent in the run. The SDK prepares each agent's request before the model
 * sees it, so a request is what that agent's provider would receive. Every run starts at the
 * reader and reaches the writer only through its edge, so the first request is the reader's and
 * the second the writer's. With `handoff`, the reader's request transfers to the writer.
 */
class Recording extends FakeChatModel {
  readonly requests: Request[] = [];
  private readonly handoff: boolean;

  constructor({ handoff = false }: { handoff?: boolean } = {}) {
    super({ responses: ['unused'] });
    this.handoff = handoff;
  }

  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    this.requests.push(inspect(messages));
    if (this.handoff && this.requests.length === 1) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              id: 'call-transfer',
              name: `${Constants.LC_TRANSFER_TO_}${WRITER}`,
              args: '{}',
              index: 0,
            },
          ],
        }),
      });
      return;
    }
    yield this._createResponseChunk(`Answer ${this.requests.length}.`);
  }
}

function makeAgent(id: string, vision?: boolean) {
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
    ...(vision == null ? {} : { vision }),
  };
}

/**
 * Sends a question that carries an image to the reader (nothing declared), connected by `edges`
 * to the writer (declared text-only), and returns what each agent's model received, in order.
 */
async function send(edges: GraphEdge[], model: Recording): Promise<Request[]> {
  const messages = [
    new HumanMessage({
      content: [
        { type: 'text', text: 'What does this chart show?' },
        { type: 'image_url', image_url: { url: IMAGE_URL } },
      ],
    }),
  ];
  const run = await createRun({
    agents: [{ ...makeAgent(READER), edges }, makeAgent(WRITER, false)] as never,
    messages,
    runId: 'text-only-recipient',
    signal: new AbortController().signal,
    streaming: true,
    streamUsage: true,
  });
  if (!run.Graph) {
    throw new Error('Missing graph');
  }
  run.Graph.overrideModel = model;
  await run.processStream(
    { messages },
    { configurable: { thread_id: 'text-only-recipient' }, recursionLimit: 20, version: 'v2' },
  );
  return model.requests;
}

describe('an agent whose model is declared text-only', () => {
  it('gets a text marker in place of the image when it follows in an agent chain', async () => {
    /** The edges `discoverConnectedAgents` builds for an agent's `agent_ids`. */
    const edges = await createSequentialChainEdges([READER, WRITER], '{convo}');

    const requests = await send(edges, new Recording());

    expect(requests).toEqual([
      { images: 1, omitted: 0 },
      { images: 0, omitted: 1 },
    ]);
  });

  it('gets a text marker in place of the image when another agent hands off to it', async () => {
    const edges: GraphEdge[] = [{ from: READER, to: WRITER, edgeType: 'handoff' }];

    const requests = await send(edges, new Recording({ handoff: true }));

    expect(requests).toEqual([
      { images: 1, omitted: 0 },
      { images: 0, omitted: 1 },
    ]);
  });
});
