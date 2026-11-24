import { Types } from 'mongoose';
import { Readable } from 'stream';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { Providers, MemorySaver, formatMessage, getChatModelClass } from '@librechat/agents';
import type {
  ConverseStreamOutput,
  ConverseStreamCommand,
  DocumentBlock as ConverseDocument,
} from '@aws-sdk/client-bedrock-runtime';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions, DocumentBlock } from '~/types';
import { encodeAndFormatDocuments } from './document';

const FILE_SIZE = 256 * 1024;
const BEDROCK_MODEL = 'anthropic.claude-sonnet-4-20250514-v1:0';
/** Base64 costs 4/3 of the file; anything past this bound is a re-encoding of the bytes. */
const SERIALIZED_BOUND = 1.4;

/** The bytes Bedrock received for a document, as one Buffer for comparison. */
function sentBytes(document: ConverseDocument): Buffer {
  const bytes = document.source?.bytes;
  expect(bytes).toBeInstanceOf(Uint8Array);
  return Buffer.from(bytes ?? []);
}

/** A CSV of the given size whose bytes include multi-byte UTF-8, so any text re-encoding shows. */
function createCsv(size: number): Buffer {
  const row = 'id,name,amount,note\n1,Zoë,12.50,café ☕\n';
  return Buffer.from(row.repeat(Math.ceil(size / Buffer.byteLength(row)))).subarray(0, size);
}

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

async function encodeForBedrock(content: Buffer, file: IMongoFile): Promise<DocumentBlock> {
  const strategy: StrategyFunctions = {
    getDownloadStream: async () => Readable.from([content]),
  };
  const result = await encodeAndFormatDocuments(
    { config: {} } as ServerRequest,
    [file],
    { provider: Providers.BEDROCK, model: BEDROCK_MODEL },
    () => strategy,
  );
  expect(result.documents).toHaveLength(1);
  return result.documents[0];
}

function formatPrompt(document: DocumentBlock): BaseMessage {
  return formatMessage({
    message: { role: 'user', content: 'Summarize the attachment', documents: [document] },
    endpoint: Providers.BEDROCK,
    langChain: true,
  }) as BaseMessage;
}

const RESPONSE_EVENTS: ConverseStreamOutput[] = [
  { messageStart: { role: 'assistant' } },
  { contentBlockDelta: { delta: { text: 'ok' }, contentBlockIndex: 0 } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'end_turn' } },
  {
    metadata: {
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 0 },
    },
  },
];

async function* streamOf(events: ConverseStreamOutput[]): AsyncGenerator<ConverseStreamOutput> {
  for (const event of events) {
    yield event;
  }
}

/** Sends `messages` through the real Converse request builder and returns the documents it sent. */
async function sendToBedrock(messages: BaseMessage[]): Promise<ConverseDocument[]> {
  const client = new BedrockRuntimeClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const send = jest
    .spyOn(client, 'send')
    .mockImplementation(async () => ({ stream: streamOf(RESPONSE_EVENTS), $metadata: {} }));
  const ChatBedrock = getChatModelClass(Providers.BEDROCK);
  const chat = new ChatBedrock({ model: BEDROCK_MODEL, region: 'us-east-1', client });
  for await (const chunk of await chat.stream(messages)) {
    expect(chunk).toBeDefined();
  }
  const command = send.mock.calls[0][0] as ConverseStreamCommand;
  return (command.input.messages ?? []).flatMap((message) =>
    (message.content ?? []).flatMap((block) => (block.document != null ? [block.document] : [])),
  );
}

describe('Bedrock document attachments', () => {
  const csv = createCsv(FILE_SIZE);

  it('keeps the prompt and the trace copy of the document within base64 size', async () => {
    const document = await encodeForBedrock(csv, createFile('text/csv', 'ledger.csv', FILE_SIZE));
    const prompt = formatPrompt(document);

    /** Langfuse records generation input and chain spans with `JSON.stringify`. */
    const traced = JSON.stringify(prompt.content).length;
    expect(traced / FILE_SIZE).toBeLessThan(SERIALIZED_BOUND);
    expect(JSON.stringify(prompt).length / FILE_SIZE).toBeLessThan(SERIALIZED_BOUND);
  });

  it('keeps a checkpoint holding the prompt within base64 size', async () => {
    const document = await encodeForBedrock(csv, createFile('text/csv', 'ledger.csv', FILE_SIZE));
    const { serde } = new MemorySaver();

    const [, bytes] = await serde.dumpsTyped({ messages: [formatPrompt(document)] });

    expect(bytes.byteLength / FILE_SIZE).toBeLessThan(SERIALIZED_BOUND);
  });

  it('sends Bedrock the exact file bytes, format and name', async () => {
    const document = await encodeForBedrock(csv, createFile('text/csv', 'ledger.csv', FILE_SIZE));

    const [sent] = await sendToBedrock([formatPrompt(document)]);

    expect(sent.format).toBe('csv');
    expect(sent.name).toBe('ledger_csv');
    expect(sentBytes(sent).equals(csv)).toBe(true);
  });

  it.each([
    ['application/csv', 'export.csv', 'csv'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'r.docx', 'docx'],
    ['application/vnd.ms-excel', 'sheet.xls', 'xls'],
  ])('sends a %s attachment as %s with its exact bytes', async (type, filename, format) => {
    const binary = Buffer.alloc(4096);
    for (let i = 0; i < binary.length; i++) {
      binary[i] = (i * 151 + 17) & 0xff;
    }
    const document = await encodeForBedrock(binary, createFile(type, filename, binary.length));

    const [sent] = await sendToBedrock([formatPrompt(document)]);

    expect(sent.format).toBe(format);
    expect(sentBytes(sent).equals(binary)).toBe(true);
  });

  it('resumes from a checkpoint and sends Bedrock the same bytes again', async () => {
    const document = await encodeForBedrock(csv, createFile('text/csv', 'ledger.csv', FILE_SIZE));
    const { serde } = new MemorySaver();
    const [type, bytes] = await serde.dumpsTyped({ messages: [formatPrompt(document)] });

    const restored = (await serde.loadsTyped(type, bytes)) as { messages: BaseMessage[] };
    const [sent] = await sendToBedrock(restored.messages);

    expect(sent.format).toBe('csv');
    expect(sentBytes(sent).equals(csv)).toBe(true);
  });
});
