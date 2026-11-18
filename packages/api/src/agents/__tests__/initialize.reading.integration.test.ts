import os from 'os';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { Providers } from '@librechat/agents';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import {
  Tools,
  FileContext,
  FileSources,
  EModelEndpoint,
  decideFileReading,
} from 'librechat-data-provider';
import type { AppConfig, IMongoFile } from '@librechat/data-schemas';
import type { Agent, TextDerivation } from 'librechat-data-provider';
import type { LCTool } from '@librechat/agents';
import type { ProvisionService } from '~/files/provision/service';
import type { InitializeAgentDbMethods } from '../initialize';
import type { ServerRequest } from '~/types';
import { getTurnReadingContext, createFileTextDeriver } from '~/files/reading';
import { extractFileContext } from '~/files/context';
import { initializeAgent } from '../initialize';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_TEXT = 'Quarter,Total\nQ1,1200\nQ2,1400\nSENTINEL-7F3A';
const SAMPLE_XLSX = path.join(__dirname, '../../files/documents/sample.xlsx');
const SAMPLE_TEXT = 'Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n';

type FileConfigInput = NonNullable<AppConfig['fileConfig']>;
type OpenStoredFile = ProvisionService['openStoredFile'];
type RoutingFields = Pick<IMongoFile, 'llmDeliveryPath' | 'text' | 'type' | 'bytes' | 'metadata'>;

interface TurnOptions {
  fileIds: string[];
  policy?: 'automatic';
  tools?: string[];
  /** Tools the loader returns definitions for; Run Code registers itself when enabled. */
  loaded?: string[];
  fileConfig?: Omit<FileConfigInput, 'endpoints'>;
  checkSessionsAlive?: InitializeAgentDbMethods['checkSessionsAlive'];
  /** Wires the request's text deriver over this storage, as the host does. */
  openStoredFile?: OpenStoredFile;
}

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let userId: string;
let storageRoot: string;
const originalApiKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-integration-'));
  process.env.OPENAI_API_KEY = 'sk-reading-integration';
}, 60000);

afterAll(async () => {
  process.env.OPENAI_API_KEY = originalApiKey;
  fs.rmSync(storageRoot, { recursive: true, force: true });
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  userId = new mongoose.Types.ObjectId().toString();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

const baseFile = (fileId: string) => ({
  file_id: fileId,
  user: new mongoose.Types.ObjectId(userId),
  object: 'file' as const,
  source: FileSources.local,
  context: FileContext.message_attachment,
  usage: 0,
});

/**
 * A spreadsheet the automatic upload path deferred to Run Code: no text and a `deferred`
 * marker. Written to the collection directly because the marker is a later commit's schema
 * field; reads return it as stored.
 */
async function seedDeferredXlsx(fileId = 'xlsx-deferred'): Promise<string> {
  const textDerivation: TextDerivation = { outcome: 'deferred', at: Date.now() };
  await mongoose.models.File.collection.insertOne({
    ...baseFile(fileId),
    filename: 'deferred.xlsx',
    filepath: `/uploads/${userId}/deferred.xlsx`,
    type: XLSX_TYPE,
    bytes: 4096,
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false, textDerivation },
  });
  return fileId;
}

/** Writes the real sample workbook where local storage keeps the record's original. */
async function storeSampleOriginal(fileId: string): Promise<void> {
  const [file] = (await methods.getFiles({ file_id: fileId }, null, {})) ?? [];
  const target = path.join(storageRoot, file?.filepath ?? fileId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(SAMPLE_XLSX, target);
}

/** Local storage: streams a record's original from under the storage root, observed. */
const localStorage = () =>
  jest.fn<ReturnType<OpenStoredFile>, Parameters<OpenStoredFile>>(async (file) =>
    fs.createReadStream(path.join(storageRoot, file.filepath ?? file.file_id)),
  );

async function seedPdf(fileId: string, bytes: number): Promise<string> {
  await methods.createFile({
    ...baseFile(fileId),
    filename: `${fileId}.pdf`,
    filepath: `/uploads/${userId}/${fileId}.pdf`,
    type: 'application/pdf',
    bytes,
    llmDeliveryPath: 'provider',
    metadata: { destinationChosen: false },
  });
  return fileId;
}

async function readRoutingFields(fileId: string): Promise<RoutingFields | undefined> {
  const [file] = (await methods.getFiles({ file_id: fileId }, null, {})) ?? [];
  if (file == null) {
    return undefined;
  }
  const { llmDeliveryPath, text, type, bytes, metadata } = file;
  return { llmDeliveryPath, text, type, bytes, metadata };
}

function buildDb(options: TurnOptions): InitializeAgentDbMethods {
  return {
    getFiles: methods.getFiles as InitializeAgentDbMethods['getFiles'],
    updateFilesUsage: methods.updateFilesUsage,
    getToolFilesByIds: methods.getToolFilesByIds as InitializeAgentDbMethods['getToolFilesByIds'],
    getProjectFiles: methods.getProjectFiles as InitializeAgentDbMethods['getProjectFiles'],
    getConvoFiles: async () => [],
    getUserKey: async () => '',
    getUserKeyValues: async () => ({}),
    checkSessionsAlive: options.checkSessionsAlive,
    saveFileTextDerivation: methods.saveFileTextDerivation,
  };
}

async function runTurn(options: TurnOptions) {
  const { policy, tools = [], loaded = [], fileConfig, openStoredFile } = options;
  const appConfig: Pick<AppConfig, 'fileConfig'> = {
    fileConfig: {
      ...fileConfig,
      endpoints: {
        [EModelEndpoint.openAI]: { ...(policy != null && { llmDeliveryPolicy: policy }) },
      },
    },
  };
  const req = {
    user: { id: userId, role: 'USER' },
    config: appConfig,
    body: {},
  } as ServerRequest;
  const agent = {
    id: 'agent-reading',
    provider: Providers.OPENAI,
    model: 'gpt-4o',
    tools,
    model_parameters: { model: 'gpt-4o' },
  } as Agent;
  const loadTools = jest.fn(async ({ tools: requested }: { tools: string[] }) => ({
    tools: [],
    toolContextMap: {},
    toolDefinitions: loaded
      .filter((name) => requested.includes(name))
      .map(
        (name): LCTool => ({
          name,
          description: name,
          parameters: { type: 'object', properties: {} },
        }),
      ),
  }));
  const result = await initializeAgent(
    {
      req,
      agent,
      loadTools,
      requestFiles: options.fileIds.map((file_id) => ({ file_id })) as IMongoFile[],
      codeEnvAvailable: true,
      fileSearchAvailable: true,
      endpointOption: { endpoint: EModelEndpoint.agents },
      allowedProviders: new Set([Providers.OPENAI]),
      isInitialAgent: true,
      ...(openStoredFile != null && { deriveText: createFileTextDeriver({ req, openStoredFile }) }),
    },
    buildDb(options),
  );
  return { result, req };
}

const pathsById = (files: ReadonlyArray<Pick<IMongoFile, 'file_id' | 'llmDeliveryPath'>>) =>
  Object.fromEntries(files.map((file) => [file.file_id, file.llmDeliveryPath]));

type InitializedAgentResult = Awaited<ReturnType<typeof initializeAgent>>;

/** The reader the final decision picked for each request attachment. */
const readersById = (result: InitializedAgentResult) =>
  Object.fromEntries(
    result.requestAttachments.map((file) => [
      file.file_id,
      decideFileReading({
        routing: result.deliveryRouting,
        file,
        consumers: result.fileConsumers,
      }).reader,
    ]),
  );

const injectedText = (files: IMongoFile[], req: ServerRequest) =>
  extractFileContext({ attachments: files, req, tokenCountFn: (text) => text.length });

describe('initializeAgent reading under the automatic policy (MongoDB)', () => {
  it('keeps the Run Code reader and injects no text when provisioning fails', async () => {
    const fileId = 'xlsx-sandboxed';
    await methods.createFile({
      ...baseFile(fileId),
      filename: 'sandboxed.xlsx',
      filepath: `/uploads/${userId}/sandboxed.xlsx`,
      type: XLSX_TYPE,
      bytes: 4096,
      text: SHEET_TEXT,
      llmDeliveryPath: 'text',
      metadata: {
        destinationChosen: false,
        codeEnvRef: {
          kind: 'user',
          id: userId,
          storage_session_id: 'session-1',
          file_id: 'sandbox-file-1',
        },
      },
    });
    const checkSessionsAlive = jest.fn().mockRejectedValue(new Error('Code API unreachable'));

    const { result, req } = await runTurn({
      fileIds: [fileId],
      policy: 'automatic',
      tools: [Tools.execute_code],
      checkSessionsAlive,
    });

    expect(checkSessionsAlive).toHaveBeenCalled();
    expect(result.provisionState).toBeUndefined();
    expect(result.fileConsumers?.executeCode).toBe(true);
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'none' });
    expect(await injectedText(result.requestAttachments, req)).toBeFalsy();
  });

  it('sends the PDFs that fit the context allowance natively and the third to File Search', async () => {
    const fileIds = [
      await seedPdf('pdf-a', 400 * 1024),
      await seedPdf('pdf-b', 400 * 1024),
      await seedPdf('pdf-c', 400 * 1024),
    ];

    const { result } = await runTurn({
      fileIds,
      policy: 'automatic',
      tools: [Tools.file_search],
      loaded: [Tools.file_search],
      fileConfig: { fileContextSizeLimit: 1 },
    });

    expect(pathsById(result.requestAttachments)).toEqual({
      'pdf-a': 'provider',
      'pdf-b': 'provider',
      'pdf-c': 'none',
    });
    expect(readersById(result)).toEqual({
      'pdf-a': 'provider',
      'pdf-b': 'provider',
      'pdf-c': 'search',
    });
    const context = getTurnReadingContext(result.deliveryRouting);
    expect(context?.stats().overflow).toBe(1);
    const queued = result.provisionState?.vectorDBFiles.map((file) => file.file_id) ?? [];
    expect(queued).toContain('pdf-c');
  });
});

describe('initializeAgent text derivation from stored originals (MongoDB)', () => {
  it('derives a deferred spreadsheet without Run Code once and keeps the text on the record', async () => {
    const fileId = await seedDeferredXlsx();
    await storeSampleOriginal(fileId);
    const openStoredFile = localStorage();

    const { result, req } = await runTurn({
      fileIds: [fileId],
      policy: 'automatic',
      openStoredFile,
    });

    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: false });
    expect(pathsById(result.requestAttachments)).toEqual({ [fileId]: 'text' });
    expect(readersById(result)).toEqual({ [fileId]: 'text' });
    expect(result.requestAttachments[0].text).toBe(SAMPLE_TEXT);
    expect(await injectedText(result.requestAttachments, req)).toContain('Data,on,first,sheet');
    expect(openStoredFile).toHaveBeenCalledTimes(1);
    expect(await readRoutingFields(fileId)).toMatchObject({
      llmDeliveryPath: 'none',
      text: SAMPLE_TEXT,
      metadata: {
        destinationChosen: false,
        textDerivation: { outcome: 'complete', extractor: 'document_parser' },
      },
    });

    const next = await runTurn({ fileIds: [fileId], policy: 'automatic', openStoredFile });

    expect(openStoredFile).toHaveBeenCalledTimes(1);
    expect(pathsById(next.result.requestAttachments)).toEqual({ [fileId]: 'text' });
    expect(next.result.requestAttachments[0].text).toBe(SAMPLE_TEXT);
  });
});
