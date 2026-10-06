import { FileContext, resolveTurnLLMDeliveryPath } from 'librechat-data-provider';
import type { AppConfig, IMongoFile } from '@librechat/data-schemas';
import type { SteerMediaClient, SteerReadingAgent } from '../media';
import type { FileTextDeriver } from '~/files/reading';
import type { SteerFileFetcher } from '../request';
import type { ServerRequest } from '~/types';
import { buildSteerMedia, collectSteerStampTargets, stampSteerPartMedia } from '../media';
import { applyTurnDelivery, resolveTurnDeliveryRouting } from '../../files/delivery';
import { buildTurnReadingContext, prepareTurnFiles } from '~/files/reading';
import { AttachmentObjectNotFoundError } from '~/files/encode/utils';
import { extractFileContext } from '~/files/context';

jest.spyOn(console, 'log').mockImplementation();

/** Stand-in for AgentClient: the encode fan-out is stubbed at the same seam
 *  BaseClient exposes (processAttachments populates media fields in place). */
function createClient({
  image_urls,
  documents,
  fileContext,
}: {
  image_urls?: Array<Record<string, unknown>>;
  documents?: Array<Record<string, unknown>>;
  fileContext?: string;
} = {}): SteerMediaClient & { processAttachments: jest.Mock; resolveTurnAttachments: jest.Mock } {
  return {
    resolveTurnAttachments: jest.fn((files: IMongoFile[]) => files),
    addFileContextToMessage: jest.fn(async (pseudo: Record<string, unknown>) => {
      if (fileContext) {
        pseudo.fileContext = fileContext;
      }
    }),
    processAttachments: jest.fn(async (pseudo: Record<string, unknown>, files: IMongoFile[]) => {
      if (image_urls) {
        pseudo.image_urls = image_urls;
      }
      if (documents) {
        pseudo.documents = documents;
      }
      return files;
    }),
  };
}

const user = { id: 'user-1' };
/** A stored record carrying only the fields a test reads. */
const asStoredFile = (fields: Partial<IMongoFile>): IMongoFile => fields as IMongoFile;
const imagePart = {
  type: 'image_url',
  image_url: { url: 'data:image/png;base64,abc', detail: 'auto' },
};
const imageDoc = {
  file_id: 'f1',
  type: 'image/png',
  filepath: '/uploads/u1/f1.png',
  filename: 'shot.png',
  height: 10,
  width: 20,
  bytes: 1234,
  user: 'user-1',
} as unknown as IMongoFile;
const secondDoc = {
  file_id: 'f2',
  type: 'image/png',
  filepath: '/uploads/u1/f2.png',
  bytes: 99,
} as unknown as IMongoFile;

const steerItem = (files: Array<{ file_id: string }>, text = 'look at this') => ({
  steerId: 's1',
  text,
  userId: 'user-1',
  createdAt: Date.now(),
  files,
});

describe('buildSteerMedia', () => {
  it('fetches owner-scoped files and assembles text + media content', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => [imageDoc]);
    const client = createClient({ image_urls: [imagePart] });

    const result = await buildSteerMedia({
      client,
      user,
      item: steerItem([{ file_id: 'f1' }]),
      getFiles,
    });

    expect(getFiles).toHaveBeenCalledWith({ file_id: { $in: ['f1'] }, user: 'user-1' }, {}, {});
    expect(result?.content).toEqual([{ type: 'text', text: 'look at this' }, imagePart]);
    expect(result?.files).toEqual([
      {
        file_id: 'f1',
        type: 'image/png',
        filepath: '/uploads/u1/f1.png',
        filename: 'shot.png',
        height: 10,
        width: 20,
        bytes: 1234,
      },
    ]);
  });

  it('restores the composer ref order over the $in result', async () => {
    // DB returns f1 before f2; the user attached f2 first.
    const getFiles: SteerFileFetcher = jest.fn(async () => [imageDoc, secondDoc]);
    const client = createClient({ image_urls: [imagePart] });

    const result = await buildSteerMedia({
      client,
      user,
      item: steerItem([{ file_id: 'f2' }, { file_id: 'f1' }]),
      getFiles,
    });

    expect(client.processAttachments).toHaveBeenCalledWith(
      expect.anything(),
      [secondDoc, imageDoc],
      { executeCode: false, fileSearch: false },
    );
    expect(result?.files?.map((file) => file.file_id)).toEqual(['f2', 'f1']);
  });

  it('preflights hydrated files before encoding them', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => [imageDoc]);
    const client = createClient({ image_urls: [imagePart] });
    const blocked = new Error('blocked by content policy');
    const assertFilesAllowed = jest.fn(() => {
      throw blocked;
    });

    await expect(
      buildSteerMedia({
        client,
        user,
        item: steerItem([{ file_id: 'f1' }]),
        getFiles,
        assertFilesAllowed,
      }),
    ).rejects.toBe(blocked);

    expect(assertFilesAllowed).toHaveBeenCalledWith([imageDoc]);
    expect(client.addFileContextToMessage).not.toHaveBeenCalled();
    expect(client.processAttachments).not.toHaveBeenCalled();
  });

  it('checks and encodes the turn view of the records it loads', async () => {
    /* A tool-routed file this turn delivers as text is stored as `none`: the preflight and the
     * encoders must both see the turn's copy, or the text would skip the model-bound checks. */
    const storedCsv = { file_id: 'csv', type: 'text/csv', llmDeliveryPath: 'none' };
    const turnCsv = { ...storedCsv, llmDeliveryPath: 'text' };
    const getFiles: SteerFileFetcher = jest.fn(async () => [storedCsv as unknown as IMongoFile]);
    const client = createClient();
    client.resolveTurnAttachments.mockReturnValueOnce([turnCsv]);
    const assertFilesAllowed = jest.fn();

    await buildSteerMedia({
      client,
      user,
      item: steerItem([{ file_id: 'csv' }]),
      getFiles,
      assertFilesAllowed,
    });

    expect(client.resolveTurnAttachments).toHaveBeenCalledWith([storedCsv], {
      executeCode: false,
      fileSearch: false,
    });
    expect(assertFilesAllowed).toHaveBeenCalledWith([turnCsv]);
    expect(client.addFileContextToMessage).toHaveBeenCalledWith(expect.anything(), [turnCsv], {
      executeCode: false,
      fileSearch: false,
    });
    expect(client.processAttachments).toHaveBeenCalledWith(expect.anything(), [turnCsv], {
      executeCode: false,
      fileSearch: false,
    });
  });

  it('checks and encodes the copies a host that derives text prepares', async () => {
    const storedXlsx = { file_id: 'xlsx', type: 'text/csv', llmDeliveryPath: 'none' };
    const preparedXlsx = { ...storedXlsx, llmDeliveryPath: 'text', text: 'derived' };
    const getFiles: SteerFileFetcher = jest.fn(async () => [asStoredFile(storedXlsx)]);
    const client = createClient();
    const prepareTurnAttachments = jest.fn(async () => [asStoredFile(preparedXlsx)]);
    const assertFilesAllowed = jest.fn();

    await buildSteerMedia({
      client: { ...client, prepareTurnAttachments },
      user,
      item: steerItem([{ file_id: 'xlsx' }]),
      getFiles,
      assertFilesAllowed,
    });

    const consumers = { executeCode: false, fileSearch: false };
    expect(prepareTurnAttachments).toHaveBeenCalledWith([storedXlsx], consumers);
    expect(client.resolveTurnAttachments).not.toHaveBeenCalled();
    expect(assertFilesAllowed).toHaveBeenCalledWith([preparedXlsx]);
    expect(client.processAttachments).toHaveBeenCalledWith(
      expect.anything(),
      [preparedXlsx],
      consumers,
    );
  });

  it('prepends extracted file context to the steer text', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => [
      { file_id: 'f2', type: 'text/plain' } as unknown as IMongoFile,
    ]);
    const client = createClient({ fileContext: 'Attached document(s): notes' });

    const result = await buildSteerMedia({
      client,
      user,
      item: steerItem([{ file_id: 'f2' }], 'summarize it'),
      getFiles,
    });

    expect(result?.content).toEqual([
      { type: 'text', text: 'Attached document(s): notes\nsummarize it' },
    ]);
  });

  it('returns undefined when no authorized files remain', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const client = createClient({ image_urls: [imagePart] });

    const result = await buildSteerMedia({
      client,
      user,
      item: steerItem([{ file_id: 'not-yours' }]),
      getFiles,
    });

    expect(result).toBeUndefined();
    expect(client.processAttachments).not.toHaveBeenCalled();
  });

  it('scopes the fetch to the tenant when present', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    await buildSteerMedia({
      client: createClient(),
      user: { id: 'user-1', tenantId: 'ten-1' },
      item: steerItem([{ file_id: 'f1' }], 'x'),
      getFiles,
    });
    expect(getFiles).toHaveBeenCalledWith(
      { file_id: { $in: ['f1'] }, user: 'user-1', tenantId: 'ten-1' },
      {},
      {},
    );
  });

  it('merges quoted excerpts into the encoded text part', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => [imageDoc]);
    const client = createClient({ image_urls: [imagePart] });

    const result = await buildSteerMedia({
      client,
      user,
      item: { ...steerItem([{ file_id: 'f1' }], 'what about this?'), quotes: ['the excerpt'] },
      getFiles,
    });

    expect(result?.content).toEqual([
      { type: 'text', text: '> the excerpt\n\nwhat about this?' },
      imagePart,
    ]);
  });
});

describe('stampSteerPartMedia', () => {
  it('stamps media onto steer parts immutably with one batched fetch', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => [imageDoc]);
    const client = createClient({ image_urls: [imagePart] });
    const steerPart = {
      type: 'steer',
      steer: 'inline steer',
      steerId: 's1',
      files: [{ file_id: 'f1' }],
    };
    const otherPart = { type: 'text', text: 'assistant text' };
    const originalContent = [otherPart, steerPart];
    const message: { messageId: string; role: string; content: unknown } = {
      messageId: 'assistant-source',
      role: 'assistant',
      content: originalContent,
    };
    const payload = [{ role: 'user', content: 'hi' }, message];

    const stamped = await stampSteerPartMedia({ client, user, payload, getFiles });

    expect(getFiles).toHaveBeenCalledTimes(1);
    const content = message.content as Array<Record<string, unknown>>;
    expect(content).not.toBe(originalContent);
    expect(content[0]).toBe(otherPart);
    expect(content[1]).not.toBe(steerPart);
    expect(content[1].media).toEqual([{ type: 'text', text: 'inline steer' }, imagePart]);
    expect(steerPart).not.toHaveProperty('media');
    expect(stamped).toEqual([
      {
        index: 1,
        sourceMessageId: 'assistant-source',
        fileIds: ['f1'],
        media: [{ type: 'text', text: 'inline steer' }, imagePart],
        steerText: 'inline steer',
      },
    ]);
  });

  it('encodes the turn view of the records it fetches itself', async () => {
    const storedCsv = { file_id: 'csv', type: 'text/csv', llmDeliveryPath: 'none' };
    const turnCsv = { ...storedCsv, llmDeliveryPath: 'text' };
    const getFiles: SteerFileFetcher = jest.fn(async () => [storedCsv as unknown as IMongoFile]);
    const client = createClient();
    client.resolveTurnAttachments.mockReturnValueOnce([turnCsv]);
    const message = {
      role: 'assistant',
      content: [
        { type: 'steer', steer: 'use the sheet', steerId: 's3', files: [{ file_id: 'csv' }] },
      ],
    };

    await stampSteerPartMedia({ client, user, payload: [message], getFiles });

    expect(client.resolveTurnAttachments).toHaveBeenCalledWith([storedCsv]);
    expect(client.processAttachments).toHaveBeenCalledWith(expect.anything(), [turnCsv], undefined);
  });

  it('consumes prefetched docs without issuing a second query', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const client = createClient({ image_urls: [imagePart] });
    const steerPart = {
      type: 'steer',
      steer: 'prefetched steer',
      steerId: 's2',
      files: [{ file_id: 'f1' }, { file_id: 'unauthorized' }],
    };
    const message = { role: 'assistant', content: [steerPart] };

    const stamped = await stampSteerPartMedia({
      client,
      user,
      payload: [message],
      docsById: new Map([['f1', imageDoc]]),
      getFiles,
    });

    expect(getFiles).not.toHaveBeenCalled();
    expect(stamped).toHaveLength(1);
    expect(stamped[0].index).toBe(0);
    expect(client.processAttachments).toHaveBeenCalledWith(
      expect.anything(),
      [imageDoc],
      undefined,
    );
  });

  it('does nothing when no steer part carries files', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const payload = [{ role: 'assistant', content: [{ type: 'steer', steer: 'text only' }] }];
    await stampSteerPartMedia({ client: createClient(), user, payload, getFiles });
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('leaves the part text-only when its files are no longer authorized', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const steerPart = {
      type: 'steer',
      steer: 'orphaned',
      steerId: 's9',
      files: [{ file_id: 'gone' }],
    };
    const message = { role: 'assistant', content: [steerPart] };

    await stampSteerPartMedia({ client: createClient(), user, payload: [message], getFiles });

    expect((message.content as unknown[])[0]).toBe(steerPart);
    expect(steerPart).not.toHaveProperty('media');
  });

  it('propagates a missing attachment object instead of replaying text only', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const client = createClient();
    client.processAttachments = jest
      .fn()
      .mockRejectedValue(new AttachmentObjectNotFoundError('missing-object'));
    const steerPart = {
      type: 'steer',
      steer: 'read the missing file',
      steerId: 'missing-steer',
      files: [{ file_id: 'missing-object' }],
    };
    const message = { role: 'assistant', content: [steerPart] };

    await expect(
      stampSteerPartMedia({
        client,
        user,
        payload: [message],
        docsById: new Map([['missing-object', imageDoc]]),
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_OBJECT_NOT_FOUND',
      fileId: 'missing-object',
    });
    expect(steerPart).not.toHaveProperty('media');
  });

  it('stamps merged text media for a quote-bearing part without files', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const client = createClient();
    const steerPart = {
      type: 'steer',
      steer: 'and this part?',
      steerId: 's3',
      quotes: ['first excerpt', 'second excerpt'],
    };
    const message = { messageId: 'assistant-q', role: 'assistant', content: [steerPart] };

    const stamped = await stampSteerPartMedia({ client, user, payload: [message], getFiles });

    expect(getFiles).not.toHaveBeenCalled();
    expect(client.processAttachments).not.toHaveBeenCalled();
    const merged = '> first excerpt\n\n> second excerpt\n\nand this part?';
    expect((message.content as Array<Record<string, unknown>>)[0].media).toEqual([
      { type: 'text', text: merged },
    ]);
    expect(steerPart).not.toHaveProperty('media');
    expect(stamped).toEqual([
      {
        index: 0,
        sourceMessageId: 'assistant-q',
        fileIds: [],
        media: [{ type: 'text', text: merged }],
        steerText: 'and this part?',
      },
    ]);
  });

  it('merges quotes into the encoded text part of a files-carrying steer', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => [imageDoc]);
    const client = createClient({ image_urls: [imagePart] });
    const steerPart = {
      type: 'steer',
      steer: 'see attachment',
      steerId: 's4',
      files: [{ file_id: 'f1' }],
      quotes: ['quoted line'],
    };
    const message = { role: 'assistant', content: [steerPart] };

    const stamped = await stampSteerPartMedia({ client, user, payload: [message], getFiles });

    expect(stamped[0].media).toEqual([
      { type: 'text', text: '> quoted line\n\nsee attachment' },
      imagePart,
    ]);
    expect(stamped[0].steerText).toBe('see attachment');
  });

  it('still stamps merged text when a quote-bearing part loses its files', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const steerPart = {
      type: 'steer',
      steer: 'orphaned but quoted',
      steerId: 's5',
      files: [{ file_id: 'gone' }],
      quotes: ['the reference'],
    };
    const message = { role: 'assistant', content: [steerPart] };

    const stamped = await stampSteerPartMedia({
      client: createClient(),
      user,
      payload: [message],
      getFiles,
    });

    expect(stamped[0].fileIds).toEqual([]);
    expect(stamped[0].media).toEqual([
      { type: 'text', text: '> the reference\n\norphaned but quoted' },
    ]);
  });

  it('collects stamp targets synchronously so steer-free payloads skip the await', () => {
    const plain = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ];
    expect(collectSteerStampTargets(plain, true)).toHaveLength(0);

    const filesOnly = [
      { role: 'assistant', content: [{ type: 'steer', steer: 's', files: [{ file_id: 'f1' }] }] },
    ];
    expect(collectSteerStampTargets(filesOnly, true)).toHaveLength(1);
    expect(collectSteerStampTargets(filesOnly, false)).toHaveLength(0);

    const quoted = [{ role: 'assistant', content: [{ type: 'steer', steer: 's', quotes: ['q'] }] }];
    expect(collectSteerStampTargets(quoted, false)).toHaveLength(1);
  });

  it('consumes pre-collected targets without re-scanning the payload', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => []);
    const steerPart = { type: 'steer', steer: 'quoted turn', steerId: 's8', quotes: ['kept'] };
    const message = { role: 'assistant', content: [steerPart] };
    const targets = collectSteerStampTargets([message], false);

    const stamped = await stampSteerPartMedia({
      client: createClient(),
      user,
      payload: [message],
      targets,
      getFiles,
      resendFiles: false,
    });

    expect(stamped[0].media).toEqual([{ type: 'text', text: '> kept\n\nquoted turn' }]);
  });

  it('replays quotes without encoding files when resendFiles is off', async () => {
    const getFiles: SteerFileFetcher = jest.fn(async () => [imageDoc]);
    const client = createClient({ image_urls: [imagePart] });
    const quotedPart = {
      type: 'steer',
      steer: 'quoted turn',
      steerId: 's6',
      files: [{ file_id: 'f1' }],
      quotes: ['kept excerpt'],
    };
    const filesOnlyPart = {
      type: 'steer',
      steer: 'files only',
      steerId: 's7',
      files: [{ file_id: 'f1' }],
    };
    const message = { role: 'assistant', content: [quotedPart, filesOnlyPart] };

    const stamped = await stampSteerPartMedia({
      client,
      user,
      payload: [message],
      getFiles,
      resendFiles: false,
    });

    expect(getFiles).not.toHaveBeenCalled();
    expect(client.processAttachments).not.toHaveBeenCalled();
    expect(stamped).toHaveLength(1);
    expect(stamped[0].media).toEqual([{ type: 'text', text: '> kept excerpt\n\nquoted turn' }]);
    expect((message.content as Array<Record<string, unknown>>)[1]).toBe(filesOnlyPart);
  });
});

describe('buildSteerMedia file reading', () => {
  const steerText = 'use the sheet';
  const holdNote =
    '"quarterly.xlsx" is attached; Run Code can open it starting with your next message.';
  /** A workbook extracted at upload, so classic routing reads it as text. */
  const workbook = {
    file_id: 'xlsx',
    filename: 'quarterly.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    source: 'local',
    context: FileContext.message_attachment,
    bytes: 2048,
    text: 'SENTINEL-7F3A',
    llmDeliveryPath: 'text',
    metadata: { destinationChosen: false },
  } as Partial<IMongoFile> as IMongoFile;
  const routingFor = (fileConfig: AppConfig['fileConfig']) =>
    resolveTurnDeliveryRouting({ agent: { provider: 'openAI' }, config: { fileConfig } });
  const automatic = routingFor({ endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } });
  const classic = routingFor({});

  /**
   * The AgentClient surface over the real turn routing and text extraction: like BaseClient, it
   * applies the running agent's routing and exposes the agent only through `options`.
   */
  function createRoutedClient(
    agent: SteerReadingAgent | undefined,
  ): SteerMediaClient & { processAttachments: jest.Mock } {
    const req = { body: {}, config: {} } as ServerRequest;
    const routing = agent?.deliveryRouting;
    return {
      options: { agent },
      resolveTurnAttachments: (files, consumers = agent?.fileConsumers) =>
        applyTurnDelivery(files, { routing, consumers }),
      addFileContextToMessage: async (message, files, consumers = agent?.fileConsumers) => {
        const fileContext = await extractFileContext({
          attachments: files.filter((file) => {
            const path = resolveTurnLLMDeliveryPath(routing, file, consumers);
            return path == null || path === 'text';
          }),
          req,
          tokenCountFn: (text) => text.length,
        });
        if (fileContext) {
          message.fileContext = fileContext;
        }
      },
      processAttachments: jest.fn(
        async (_message: Record<string, unknown>, files: IMongoFile[]) => files,
      ),
    };
  }

  const steer = (client: SteerMediaClient) =>
    buildSteerMedia({
      client,
      user,
      item: steerItem([{ file_id: 'xlsx' }], steerText),
      getFiles: jest.fn(async () => [workbook]),
    });
  const textOf = (result: Awaited<ReturnType<typeof steer>>) =>
    (result?.content ?? []).map((part) => part.text).join('\n');

  it('holds a spreadsheet for Run Code under the automatic policy and says so', async () => {
    /* The run's code queue cannot take a mid-run file, so the workbook waits for the next
     * message's provisioning rather than reaching the prompt as text. */
    const client = createRoutedClient({
      deliveryRouting: automatic,
      fileConsumers: { executeCode: true, fileSearch: true },
    });

    const result = await steer(client);

    expect(result?.content).toEqual([{ type: 'text', text: `${steerText}\n\n${holdNote}` }]);
    expect(textOf(result)).not.toContain('SENTINEL-7F3A');
    expect(client.processAttachments).toHaveBeenCalledWith(
      expect.anything(),
      [{ ...workbook, llmDeliveryPath: 'none' }],
      { executeCode: true, fileSearch: false },
    );
  });

  it('notes a newly held Run Code file after native validation rejects it', async () => {
    const deliveryRouting = routingFor({
      endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } },
    });
    const reading = buildTurnReadingContext({
      routing: deliveryRouting,
      provider: 'openAI',
      fileTokenLimit: 100_000,
      configuredFileSizeLimit: undefined,
      countTokens: (text) => text.length,
    });
    deliveryRouting.reading = reading;
    const client = createRoutedClient({
      deliveryRouting,
      fileConsumers: { executeCode: true, fileSearch: true },
    });
    const file = asStoredFile({
      ...workbook,
      file_id: 'steered-pdf',
      filename: 'steered.pdf',
      type: 'application/pdf',
      llmDeliveryPath: 'provider',
    });
    client.processMessageAttachments = async (_message, files, consumers) => {
      expect(files[0].llmDeliveryPath).toBe('provider');
      reading?.recordRejections([{ file_id: file.file_id, reason: 'capacity' }]);
      return applyTurnDelivery(files, { routing: deliveryRouting, consumers });
    };

    const result = await buildSteerMedia({
      client,
      user,
      item: steerItem([{ file_id: file.file_id }], steerText),
      getFiles: jest.fn(async () => [file]),
    });

    expect(result?.content).toEqual([
      {
        type: 'text',
        text: `${steerText}\n\n"steered.pdf" is attached; Run Code can open it starting with your next message.`,
      },
    ]);
    expect(textOf(result)).not.toContain('SENTINEL-7F3A');
  });

  it('delivers the text of a spreadsheet when the automatic run has no Run Code', async () => {
    const client = createRoutedClient({
      deliveryRouting: automatic,
      fileConsumers: { executeCode: false, fileSearch: true },
    });

    const result = await steer(client);

    expect(textOf(result)).toContain('SENTINEL-7F3A');
    expect(textOf(result)).not.toContain(holdNote);
  });

  describe('a workbook whose upload deferred extraction', () => {
    const deferred = asStoredFile({
      ...workbook,
      text: undefined,
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
    });
    const derivedSentinel = 'DERIVED-7F3A';

    /** An automatic run without Run Code whose reading derives text through the given stub. */
    function deferredRun(deriveText: FileTextDeriver) {
      const deliveryRouting = routingFor({
        endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } },
      });
      const context = buildTurnReadingContext({
        routing: deliveryRouting,
        provider: 'openAI',
        fileTokenLimit: 100_000,
        configuredFileSizeLimit: undefined,
        countTokens: (text) => text.length,
        deriveText,
      });
      deliveryRouting.reading = context;
      return createRoutedClient({
        deliveryRouting,
        fileConsumers: { executeCode: false, fileSearch: true },
      });
    }
    const steerDeferred = (client: SteerMediaClient) =>
      buildSteerMedia({
        client,
        user,
        item: steerItem([{ file_id: 'xlsx' }], steerText),
        getFiles: jest.fn(async () => [deferred]),
      });
    const deriver = () =>
      jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(async () => ({
        status: 'derived',
        text: derivedSentinel,
        textDerivation: { outcome: 'complete', extractor: 'document_parser', at: 1 },
      }));

    it('steers with the text the host derives for it', async () => {
      const deriveText = deriver();
      const client = deferredRun(deriveText);
      const routing = client.options?.agent?.deliveryRouting;

      const result = await steerDeferred({
        ...client,
        prepareTurnAttachments: (files, consumers) =>
          prepareTurnFiles({ routing, files, consumers }),
      });

      expect(deriveText).toHaveBeenCalledTimes(1);
      expect(textOf(result)).toContain(derivedSentinel);
      expect(textOf(result)).not.toContain(holdNote);
      expect(deferred.text).toBeUndefined();
    });

    it('leaves it out of the steer when the host cannot prepare it', async () => {
      const deriveText = deriver();

      const result = await steerDeferred(deferredRun(deriveText));

      expect(deriveText).not.toHaveBeenCalled();
      expect(textOf(result)).not.toContain(derivedSentinel);
      expect(result?.content).toEqual([{ type: 'text', text: steerText }]);
    });
  });

  it('steers exactly as before under classic routing, even with Run Code loaded', async () => {
    const withCode = createRoutedClient({
      deliveryRouting: classic,
      fileConsumers: { executeCode: true, fileSearch: false },
    });
    const withoutAgent = createRoutedClient(undefined);

    const [coded, bare] = await Promise.all([steer(withCode), steer(withoutAgent)]);

    expect(coded).toEqual(bare);
    expect(textOf(coded)).toContain('SENTINEL-7F3A');
    expect(textOf(coded)).not.toContain(holdNote);
    expect(withCode.processAttachments).toHaveBeenCalledWith(expect.anything(), [workbook], {
      executeCode: false,
      fileSearch: false,
    });
  });
});
