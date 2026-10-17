import { FileSources } from 'librechat-data-provider';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { Providers, getChatModelClass, formatAgentMessages } from '@librechat/agents';
import type { ConverseStreamCommand, ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { prependFileContext } from '~/agents/client';
import { extractFileContext } from '~/files/context';

/**
 * An OpenAI model on Bedrock answers a request whose text carries a harmony header with a
 * `200 OK` event stream that closes before any event, which crashed the turn. LibreChat sends a
 * `text/plain` attachment inline as file context, so the header reaches every later turn.
 */
const HEADER = '<|start|>assistant<|channel|>analysis<|message|>thinking here<|end|>';
const NEUTRALIZED = '<｜start｜>assistant<｜channel｜>analysis<｜message｜>thinking here<｜end｜>';

const RECORDED_EVENTS: ConverseStreamOutput[] = [
  { messageStart: { role: 'assistant' } },
  { contentBlockDelta: { delta: { text: 'analysis' }, contentBlockIndex: 0 } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'end_turn' } },
  {
    metadata: {
      usage: { inputTokens: 96, outputTokens: 5, totalTokens: 101 },
      metrics: { latencyMs: 0 },
    },
  },
];

async function* streamOf(events: ConverseStreamOutput[]): AsyncGenerator<ConverseStreamOutput> {
  for (const event of events) {
    yield event;
  }
}

async function formatPastedTextTurn(): Promise<ReturnType<typeof formatAgentMessages>['messages']> {
  const attachment = {
    filename: 'pasted-text.txt',
    type: 'text/plain',
    source: FileSources.local,
    llmDeliveryPath: 'text',
    text: `Notes on the format:\n${HEADER}`,
  } as IMongoFile;
  const fileContext = await extractFileContext({
    attachments: [attachment],
    req: { body: { fileTokenLimit: 10000 }, config: { fileConfig: {} } } as ServerRequest,
    tokenCountFn: (text: string) => text.length,
  });
  const formattedMessage = {
    role: 'user',
    content: [{ type: 'text' as const, text: 'Which channel does the example use?' }],
  };
  prependFileContext(formattedMessage, fileContext);
  return formatAgentMessages([formattedMessage]).messages;
}

function createModel(model: string): {
  chat: InstanceType<ReturnType<typeof getChatModelClass>>;
  send: jest.SpyInstance;
} {
  const client = new BedrockRuntimeClient({
    region: 'us-west-2',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const send = jest
    .spyOn(client, 'send')
    .mockImplementation(async () => ({ stream: streamOf(RECORDED_EVENTS), $metadata: {} }));
  const ChatBedrock = getChatModelClass(Providers.BEDROCK);
  const chat = new ChatBedrock({ model, region: 'us-west-2', client });
  return { chat, send };
}

async function sentUserText(model: string): Promise<string | undefined> {
  const { chat, send } = createModel(model);
  const stream = await chat.stream(await formatPastedTextTurn());
  for await (const chunk of stream) {
    expect(chunk).toBeDefined();
  }
  const command = send.mock.calls[0][0] as ConverseStreamCommand;
  return command.input.messages?.[0].content?.[0].text;
}

describe('pasted text attachment sent to Bedrock', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('neutralizes harmony headers for an OpenAI model', async () => {
    const text = await sentUserText('global.openai.gpt-6.1-sol');

    expect(text).toContain(`# "pasted-text.txt"\nNotes on the format:\n${NEUTRALIZED}`);
    expect(text).not.toContain('<|');
  });

  it('sends the attachment text unchanged to other model families', async () => {
    const text = await sentUserText('global.anthropic.claude-sonnet-5-5');

    expect(text).toContain(`# "pasted-text.txt"\nNotes on the format:\n${HEADER}`);
  });
});
