import { Types } from 'mongoose';
import { Readable } from 'stream';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  Providers,
  formatMessage,
  initializeModel,
  getChatModelClass,
  prepareProviderRequest,
} from '@librechat/agents';
import type { ConverseStreamOutput, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions } from '~/types';
import { encodeAndFormatDocuments } from './document';

/** An agent reading the conversation, with the parameters its initialization resolved. */
interface Agent {
  provider: Providers;
  model_parameters: { model: string; useResponsesApi?: boolean };
}

const claude: Agent = {
  provider: Providers.ANTHROPIC,
  model_parameters: { model: 'claude-sonnet-4-5' },
};
const gpt: Agent = { provider: Providers.OPENAI, model_parameters: { model: 'gpt-4.1' } };
/** Web search switches an OpenAI agent to the Responses API without its record naming it. */
const responses: Agent = {
  provider: Providers.OPENAI,
  model_parameters: { model: 'gpt-4.1', useResponsesApi: true },
};
const gemini: Agent = {
  provider: Providers.GOOGLE,
  model_parameters: { model: 'gemini-2.5-flash' },
};
const bedrock: Agent = {
  provider: Providers.BEDROCK,
  model_parameters: { model: 'anthropic.claude-sonnet-4-20250514-v1:0' },
};

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n');
const pdfData = PDF.toString('base64');

function createFile(type: string, filename: string, bytes: number): IMongoFile {
  return {
    _id: new Types.ObjectId(),
    user: new Types.ObjectId(),
    file_id: `file-${filename}`,
    filename,
    filepath: `/uploads/${filename}`,
    source: 'memory',
    type,
    bytes,
    object: 'file',
    usage: 0,
  } as IMongoFile;
}

/** Encodes one attachment as `addDocuments` does, with `readers` sharing the history. */
async function encode(
  primary: Agent,
  readers: Agent[],
  file: IMongoFile,
  content: Buffer,
): Promise<BaseMessage> {
  const strategy: StrategyFunctions = {
    getDownloadStream: async () => Readable.from([content]),
  };
  const { documents } = await encodeAndFormatDocuments(
    { config: {} } as ServerRequest,
    [file],
    {
      provider: primary.provider,
      model: primary.model_parameters.model,
      useResponsesApi: primary.model_parameters.useResponsesApi,
      recipients: readers,
    },
    () => strategy,
  );
  return formatMessage({
    message: { role: 'user', content: 'Summarize the attachment', documents },
    langChain: true,
  }) as BaseMessage;
}

type Body = Record<string, unknown>;
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Records the request body, then fails the request: only what was sent matters here. */
function createFetch(bodies: Body[]): Fetch {
  return async (input, init) => {
    const body = input instanceof Request ? await input.text() : String(init?.body);
    bodies.push(JSON.parse(body));
    throw new Error('request captured');
  };
}

const BEDROCK_EVENTS: ConverseStreamOutput[] = [
  { messageStart: { role: 'assistant' } },
  { contentBlockDelta: { delta: { text: 'ok' }, contentBlockIndex: 0 } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'end_turn' } },
];

async function* streamOf(events: ConverseStreamOutput[]): AsyncGenerator<ConverseStreamOutput> {
  for (const event of events) {
    yield event;
  }
}

/** The user content of the Converse request Bedrock receives for `messages`. */
async function sendToBedrock(agent: Agent, messages: BaseMessage[]): Promise<unknown[]> {
  const client = new BedrockRuntimeClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const send = jest
    .spyOn(client, 'send')
    .mockImplementation(async () => ({ stream: streamOf(BEDROCK_EVENTS), $metadata: {} }));
  const ChatBedrock = getChatModelClass(Providers.BEDROCK);
  const chat = new ChatBedrock({
    model: agent.model_parameters.model,
    region: 'us-east-1',
    client,
  });
  const prepared = prepareProviderRequest({ model: chat, messages, provider: agent.provider });
  for await (const chunk of await chat.stream(prepared.messages)) {
    expect(chunk).toBeDefined();
  }
  const command = send.mock.calls[0][0] as ConverseStreamCommand;
  return command.input.messages?.find((message) => message.role === 'user')?.content ?? [];
}

/**
 * The user content `agent`'s provider receives for the shared history: the agents SDK's
 * projection for that agent, then the provider's streaming request builder, as a run sends it.
 */
async function send(agent: Agent, message: BaseMessage): Promise<unknown[]> {
  const messages = [message];
  if (agent.provider === Providers.BEDROCK) {
    return sendToBedrock(agent, messages);
  }
  const bodies: Body[] = [];
  const fetch = createFetch(bodies);
  const { model, useResponsesApi } = agent.model_parameters;
  const options = { model, apiKey: 'test', streaming: true, maxRetries: 0 };
  let chat: ReturnType<typeof initializeModel>;
  if (agent.provider === Providers.ANTHROPIC) {
    chat = initializeModel({
      provider: Providers.ANTHROPIC,
      clientOptions: { ...options, clientOptions: { fetch } },
    });
  } else if (agent.provider === Providers.GOOGLE) {
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetch);
    chat = initializeModel({ provider: Providers.GOOGLE, clientOptions: options });
  } else {
    chat = initializeModel({
      provider: Providers.OPENAI,
      clientOptions: { ...options, useResponsesApi, configuration: { fetch } },
    });
  }
  const prepared = prepareProviderRequest({ model: chat, messages, provider: agent.provider });
  try {
    await chat.invoke(prepared.messages);
  } catch (error) {
    if (bodies.length === 0) {
      throw error;
    }
  }
  const [body] = bodies;
  if (agent.provider === Providers.GOOGLE) {
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    return contents.find((content) => content.role === 'user')?.parts ?? [];
  }
  const turns = (useResponsesApi ? body.input : body.messages) as Array<{
    role: string;
    content: unknown[];
  }>;
  return turns.find((turn) => turn.role === 'user')?.content ?? [];
}

/** The PDF part each provider receives when it is the only agent in the conversation. */
function nativePdf(agent: Agent): unknown {
  if (agent.provider === Providers.ANTHROPIC) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfData },
      citations: { enabled: true },
      context: 'File: "invoice.pdf"',
    };
  }
  if (agent.provider === Providers.GOOGLE) {
    return { inlineData: { mimeType: 'application/pdf', data: pdfData } };
  }
  if (agent.provider === Providers.BEDROCK) {
    return { document: expect.objectContaining({ name: 'invoice_pdf', format: 'pdf' }) };
  }
  if (agent.model_parameters.useResponsesApi) {
    return {
      type: 'input_file',
      filename: 'invoice.pdf',
      file_data: `data:application/pdf;base64,${pdfData}`,
    };
  }
  return {
    type: 'file',
    file: { filename: 'invoice.pdf', file_data: `data:application/pdf;base64,${pdfData}` },
  };
}

describe('documents in a history that agents on different providers read', () => {
  it.each([
    ['Claude', 'GPT', claude, gpt],
    ['GPT', 'Claude', gpt, claude],
    ['Responses API', 'Chat Completions', responses, gpt],
    ['Chat Completions', 'Responses API', gpt, responses],
    ['Claude', 'Responses API', claude, responses],
    ['Gemini', 'GPT', gemini, gpt],
    ['Claude', 'Gemini', claude, gemini],
    ['Bedrock', 'Claude', bedrock, claude],
    ['GPT', 'Bedrock', gpt, bedrock],
  ])(
    'sends each provider its own PDF block when a %s agent hands off to a %s agent',
    async (_primaryName, _readerName, primary, reader) => {
      const file = createFile('application/pdf', 'invoice.pdf', PDF.length);
      const message = await encode(primary, [reader], file, PDF);

      for (const agent of [primary, reader]) {
        expect(await send(agent, message)).toContainEqual(nativePdf(agent));
      }
    },
  );

  it('sends every agent the text of a text file', async () => {
    const text = 'quarterly total: 42 €';
    const content = Buffer.from(text);
    const file = createFile('text/plain', 'notes.txt', content.length);
    const message = await encode(claude, [gpt, responses, gemini, bedrock], file, content);
    const part = `File: "notes.txt"\n\n${text}`;

    expect(await send(gpt, message)).toContainEqual({ type: 'text', text: part });
    expect(await send(responses, message)).toContainEqual({ type: 'input_text', text: part });
    expect(await send(gemini, message)).toContainEqual({ text: part });
    expect(await send(bedrock, message)).toContainEqual({ text: part });
    expect(await send(claude, message)).toContainEqual({ type: 'text', text: part });
  });

  it('leaves a document out for an agent whose provider cannot read its type', async () => {
    const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const content = Buffer.from('PK\u0003\u0004 word document');
    const file = createFile(type, 'brief.docx', content.length);
    const message = await encode(gemini, [claude], file, content);

    expect(await send(gemini, message)).toContainEqual({
      inlineData: { mimeType: type, data: content.toString('base64') },
    });
    expect(await send(claude, message)).toEqual([
      { type: 'text', text: 'Summarize the attachment' },
    ]);
  });
});
