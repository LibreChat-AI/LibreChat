import mongoose from 'mongoose';
import { Readable } from 'stream';
import { Providers } from '@librechat/agents';
import { createModels } from '@librechat/data-schemas';
import { megabyte, FileContext, FileSources, decideFileReading } from 'librechat-data-provider';
import type { TFile, FiltersConfig, TurnFileConsumers } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { DocumentBlock, ServerRequest, StrategyFunctions } from '~/types';
import {
  getTurnTextOptions,
  encodeNativeDocuments,
  recordNativeRejections,
  buildTurnReadingContext,
} from './turn';
import { assertAgentAttachmentLimits, isModelBoundAttachmentFile } from '~/agents/attachments';
import { resolveTurnDeliveryRouting, applyTurnDelivery } from '~/agents/files/delivery';
import { admitNativeFallbackAttachments, prepareMessageAttachments } from './native';
import { encodeAndFormatDocuments } from '~/files/encode/document';
import { ContentFilterError } from '~/middleware/contentFilter';
import { parseDocument } from '~/files/documents/crud';
import { extractFileContext } from '~/files/context';
import { createFileTextDeriver } from './derive';
import { parseTextNative } from '~/files/text';
import { prepareTurnFiles } from './settle';
import Tokenizer from '~/utils/tokenizer';

/* Bridge Jest's CommonJS loader to the real PDF.js ESM implementation, including its worker. */
jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const { createRequire } = process.getBuiltinModule('node:module');
  return createRequire(__filename)('pdfjs-dist/legacy/build/pdf.mjs');
});

const FileModel = createModels(mongoose).File;
const noTools: TurnFileConsumers = { executeCode: false, fileSearch: false };
const search: TurnFileConsumers = { executeCode: false, fileSearch: true };
const code: TurnFileConsumers = { executeCode: true, fileSearch: false };
let countTokens: (text: string) => number;

beforeAll(async () => {
  countTokens = await Tokenizer.createExactTokenCounter('o200k_base');
});

interface StoredPdf {
  file: TFile;
  original: Buffer;
}

interface Message {
  documents: DocumentBlock[];
  fileContext?: string;
}

/** An uncompressed PDF with a correct xref table, text on its first page and blank later pages. */
function pdfBytes(title: string, pages = 101): Buffer {
  const content = `BT /F1 12 Tf 20 100 Td (${title}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 6} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Length 0 >>\nstream\n\nendstream',
    ...Array.from(
      { length: pages },
      (_, i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${i === 0 ? 4 : 5} 0 R >>`,
    ),
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

function storedPdf(
  id: string,
  { text, pages = 101 }: { text?: string; pages?: number } = {},
): StoredPdf {
  const original = pdfBytes(id, pages);
  return {
    original,
    file: {
      file_id: id,
      filename: `${id}.pdf`,
      filepath: `/files/${id}.pdf`,
      user: 'user',
      object: 'file',
      usage: 0,
      embedded: false,
      type: 'application/pdf',
      bytes: original.length,
      source: FileSources.local,
      context: FileContext.message_attachment,
      llmDeliveryPath: 'provider',
      metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
      ...(text != null && { text }),
    },
  };
}

/**
 * File Search is loaded unless a test says otherwise, but has queued and registered none of the
 * files, as a failed provisioning leaves it: the walk passes search by, no code tool is loaded,
 * and a PDF the provider rejects falls back to its text. `queuedForSearch` makes the files
 * reachable, so the walk ends at File Search instead. Without any file tool the automatic
 * policy reads nothing and a provider rejection fails the turn as classic routing does.
 */
function setup({
  current = [],
  historical = [],
  consumers = search,
  queuedForSearch = false,
  fileTokenLimit = 10_000,
  fileContextCharLimit = 100_000,
  fileLimit,
  fileContextSizeLimit,
  endpointTotalSizeLimit,
  abortController,
  filters,
}: {
  current?: StoredPdf[];
  historical?: StoredPdf[];
  consumers?: TurnFileConsumers;
  queuedForSearch?: boolean;
  fileTokenLimit?: number;
  fileContextCharLimit?: number;
  fileLimit?: number;
  fileContextSizeLimit?: number;
  endpointTotalSizeLimit?: number;
  abortController?: AbortController;
  filters?: FiltersConfig;
} = {}) {
  const fileConfig: NonNullable<ServerRequest['config']>['fileConfig'] = {
    fileContextCharLimit,
    fileContextSizeLimit,
    endpoints: {
      anthropic: {
        llmDeliveryPolicy: 'automatic',
        fileLimit,
        totalSizeLimit: endpointTotalSizeLimit,
      },
    },
  };
  const req = {
    body: { fileTokenLimit },
    config: {
      filters,
      fileConfig,
    },
  } as ServerRequest;
  const originals = new Map(
    [...historical, ...current].map(({ file, original }) => [file.filepath, original]),
  );
  const openStoredFile = jest.fn(async (file: { filepath?: string }) => {
    const original = originals.get(file.filepath ?? '');
    return original == null ? null : Readable.from([original]);
  });
  const storage: StrategyFunctions = {
    getDownloadStream: jest.fn(async (_req, filepath) => {
      const original = originals.get(filepath);
      if (original == null) throw Object.assign(new Error('Missing original'), { code: 'ENOENT' });
      return Readable.from([original]);
    }),
  };
  const extractors = { parseDocument: jest.fn(parseDocument), parseTextNative };
  const deriveText = jest.fn(createFileTextDeriver({ req, openStoredFile, filters, extractors }));
  const persistDerivation = jest.fn(async () => true);
  const routing = resolveTurnDeliveryRouting({
    agent: { provider: Providers.ANTHROPIC },
    config: req.config,
  });
  const context = buildTurnReadingContext({
    routing,
    provider: Providers.ANTHROPIC,
    fileTokenLimit,
    configuredFileSizeLimit: undefined,
    countTokens,
    deriveText,
    persistDerivation,
  });
  if (context == null) throw new Error('Expected automatic reading context');
  routing.reading = context;
  context.setSearchEvidence({
    queued: queuedForSearch ? [...historical, ...current].map(({ file }) => file.file_id) : [],
    registered: [],
  });
  const primary = {
    id: 'primary',
    endpoint: Providers.ANTHROPIC,
    deliveryRouting: routing,
    fileConsumers: consumers,
    currentRequestAttachments: current.map(({ file }) => file),
    requestAttachments: current.map(({ file }) => file),
    attachments: current.map(({ file }) => file),
  };
  const extractText = jest.fn(extractFileContext<TFile>);
  const addFileContextToMessage = jest.fn(async (message: Message, files: TFile[]) => {
    const textFiles = applyTurnDelivery(files, { routing, consumers }).filter(
      (file) => file.llmDeliveryPath === 'text',
    );
    if (textFiles.length > 0) {
      message.fileContext = await extractText({
        attachments: textFiles,
        req,
        tokenCountFn: countTokens,
        ...getTurnTextOptions(routing),
      });
    }
  });
  const admitPreparedAttachments = (files: TFile[]): Promise<TFile[]> =>
    admitNativeFallbackAttachments(client, files);
  const client = {
    options: {
      req,
      agent: primary,
      abortController,
      attachments: Promise.resolve(current.map(({ file }) => file)),
    },
    authorizedHistoricalFiles: new Map(historical.map(({ file }) => [file.file_id, file])),
    authorizedHistoricalReplayFiles: new Map(historical.map(({ file }) => [file.file_id, file])),
    message_file_map: {} as Record<string, TFile[]>,
    modelBoundCurrentFiles: current.map(({ file }) => file),
    modelBoundHistoricalSteerFiles: historical.map(({ file }) => file),
    turnSharedAttachmentFiles: [...historical, ...current].map(({ file }) => file),
    turnScopedAttachmentsByAgentId: new Map<string, TFile[]>(),
    turnAttachmentEndpointsByAgentId: new Map<string, { endpoint: string }>([
      ['primary', { endpoint: Providers.ANTHROPIC }],
    ]),
    getConversationAgents: () => [primary],
    assertTurnAttachmentLimits: (shared: TFile[], scoped: TFile[]) => {
      assertAgentAttachmentLimits({
        attachments: [...shared, ...scoped],
        req,
        endpoint: Providers.ANTHROPIC,
        historicalFileIds: new Set(historical.map(({ file }) => file.file_id)),
        countRepeatedExtractedText: true,
        enforceAttachmentCount: false,
        useGlobalContextSizeLimit: true,
      });
    },
    processAttachments: jest.fn(async (message: Message, files: TFile[]) => {
      const processed = applyTurnDelivery(files, { routing, consumers });
      const result = await encodeNativeDocuments(
        processed.filter((file) => file.llmDeliveryPath === 'provider'),
        primary,
        (nativeFiles, onValidationFailure) =>
          encodeAndFormatDocuments(
            req,
            nativeFiles.map((file) => FileModel.hydrate(file).toObject<IMongoFile>()),
            { provider: Providers.ANTHROPIC, onValidationFailure },
            () => storage,
          ),
      );
      recordNativeRejections([primary], result.rejected);
      message.documents.push(...result.documents);
      return processed;
    }),
    prepareTurnAttachments: jest.fn((files: TFile[]) =>
      prepareTurnFiles({ routing, consumers, files }),
    ),
    addFileContextToMessage,
    admitPreparedAttachments,
  };
  const prepare = async (files: TFile[]) => {
    const message: Message = { documents: [] };
    const prepared = await prepareMessageAttachments({ client, message, files });
    return { message, prepared };
  };
  return {
    client,
    context,
    primary,
    prepare,
    storage,
    deriveText,
    persistDerivation,
    extractText,
    extractors,
  };
}

describe('native attachment fallback', () => {
  it.each([
    ['File Search', search, true, 'search', 'none'],
    ['Run Code', code, false, 'code', 'none'],
    ['File Search it cannot reach', search, false, 'text', 'text'],
  ] as const)(
    'recovers a real 101-page PDF initially and in a fresh history turn with %s',
    async (_name, consumers, queuedForSearch, reader, path) => {
      const fixture = storedPdf('CACHED-SENTINEL', { text: 'Complete cached attachment text' });
      for (const historical of [false, true]) {
        const harness = setup({
          [historical ? 'historical' : 'current']: [fixture],
          consumers,
          queuedForSearch,
        });
        expect(harness.context.judge(fixture.file).native).toBe('fits');

        const { message, prepared } = await harness.prepare([fixture.file]);

        expect(harness.context.judge(fixture.file).rejected).toBe('capacity');
        expect(prepared?.[0].llmDeliveryPath).toBe(path);
        expect(
          decideFileReading({
            routing: harness.primary.deliveryRouting,
            file: prepared![0],
            consumers,
          }).reader,
        ).toBe(reader);
        expect(message.documents).toEqual([]);
        expect(harness.storage.getDownloadStream).toHaveBeenCalledTimes(1);
        expect(harness.deriveText).not.toHaveBeenCalled();
        if (reader === 'text') {
          expect(message.fileContext?.split(fixture.file.text!).length).toBe(2);
          expect(message.fileContext).not.toContain('Truncated');
          if (historical) {
            expect(harness.client.authorizedHistoricalFiles.get(fixture.file.file_id)).toBe(
              prepared![0],
            );
            expect(harness.client.modelBoundHistoricalSteerFiles[0]).toBe(prepared![0]);
          } else {
            expect((await harness.client.options.attachments)[0]).toBe(prepared![0]);
            expect(harness.primary.currentRequestAttachments[0]).toBe(prepared![0]);
          }
        } else {
          expect(message.fileContext).toBeUndefined();
          expect(harness.extractText).not.toHaveBeenCalled();
        }
      }
      expect(fixture.file.llmDeliveryPath).toBe('provider');
    },
  );

  it.each([
    [
      'a 101-page PDF',
      () => storedPdf('NO-TOOLS', { text: 'Complete cached attachment text' }),
      /100-page limit/,
    ],
    [
      'a corrupt PDF',
      () => {
        const fixture = storedPdf('NO-TOOLS-INTEGRITY', { text: 'Cached text' });
        fixture.original = Buffer.from('not a PDF');
        fixture.file.bytes = fixture.original.length;
        return fixture;
      },
      /missing PDF header/,
    ],
  ])(
    'fails the turn on %s as classic routing does when no file tool is loaded',
    async (_name, fixtureOf, error) => {
      const fixture = fixtureOf();
      for (const historical of [false, true]) {
        const harness = setup({
          [historical ? 'historical' : 'current']: [fixture],
          consumers: noTools,
        });

        await expect(harness.prepare([fixture.file])).rejects.toThrow(error);

        expect(harness.context.judge(fixture.file).rejected).toBeUndefined();
        expect(harness.client.prepareTurnAttachments).not.toHaveBeenCalled();
        expect(harness.extractText).not.toHaveBeenCalled();
        expect(harness.deriveText).not.toHaveBeenCalled();
      }
      expect(fixture.file.llmDeliveryPath).toBe('provider');
    },
  );

  it('keeps a fitting native PDF as a real provider block without duplicating its cached text', async () => {
    const fixture = storedPdf('NATIVE-SENTINEL', { pages: 1, text: 'Do not duplicate this text' });
    const harness = setup({ current: [fixture] });

    const { message } = await harness.prepare([fixture.file]);

    expect(message.documents).toEqual([
      expect.objectContaining({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: fixture.original.toString('base64'),
        },
      }),
    ]);
    expect(message.fileContext).toBeUndefined();
    expect(harness.extractText).not.toHaveBeenCalled();
    expect(harness.context.judge(fixture.file).rejected).toBeUndefined();
  });

  it('derives complete PDF text once, then sends the same body from its restored cache', async () => {
    const fixture = storedPdf('DERIVED-SENTINEL');
    const harness = setup({ current: [fixture] });

    const first = await harness.prepare([fixture.file]);

    expect(first.prepared?.[0]).toMatchObject({
      llmDeliveryPath: 'text',
      text: `DERIVED-SENTINEL${'\n'.repeat(101)}`,
    });
    expect(first.message.documents).toEqual([]);
    expect(first.message.fileContext?.split('DERIVED-SENTINEL').length).toBe(3); // filename and text
    expect(harness.deriveText).toHaveBeenCalledTimes(1);
    expect(harness.persistDerivation).toHaveBeenCalledTimes(1);
    expect(fixture.file.text).toBeUndefined();
    const restored = { ...fixture, file: first.prepared![0] };
    const history = setup({ historical: [restored] });

    const next = await history.prepare([restored.file]);

    expect(next.message.fileContext).toBe(first.message.fileContext);
    expect(next.message.documents).toEqual([]);
    expect(history.deriveText).not.toHaveBeenCalled();
  });

  it('leaves excessive cached text unavailable instead of sending a truncated fallback', async () => {
    const fixture = storedPdf('TOKEN-LIMIT', {
      text: 'A long sentence with many distinct tokens. '.repeat(50),
    });
    const harness = setup({ current: [fixture], fileTokenLimit: 5 });

    const { message, prepared } = await harness.prepare([fixture.file]);

    expect(prepared?.[0].llmDeliveryPath).toBe('none');
    expect(message.documents).toEqual([]);
    expect(message.fileContext).toBeUndefined();
    expect(harness.extractText).not.toHaveBeenCalled();
    expect(harness.deriveText).not.toHaveBeenCalled();
  });

  it.each([
    [search, true],
    [search, false],
    [code, false],
  ])(
    'never substitutes text for an integrity rejection (%j, queued for search: %s)',
    async (consumers, queuedForSearch) => {
      const fixture = storedPdf('INTEGRITY', { text: 'Cached text must not bypass corruption' });
      fixture.original = Buffer.from('not a PDF');
      fixture.file.bytes = fixture.original.length;
      const harness = setup({ current: [fixture], consumers, queuedForSearch });

      const { message, prepared } = await harness.prepare([fixture.file]);

      expect(harness.context.judge(fixture.file).rejected).toBe('integrity');
      expect(prepared?.[0].llmDeliveryPath).toBe('none');
      expect(message.documents).toEqual([]);
      expect(message.fileContext).toBeUndefined();
      expect(harness.extractText).not.toHaveBeenCalled();
      expect(harness.deriveText).not.toHaveBeenCalled();
    },
  );

  it('allocates newly derived fallback text against other admitted files before text injection', async () => {
    const candidate = storedPdf('AGGREGATE-FALLBACK');
    const committed = storedPdf('COMMITTED', { pages: 1, text: 'Existing context' });
    committed.file.llmDeliveryPath = 'text';
    committed.file.metadata = { destinationChosen: true };
    const harness = setup({ current: [candidate, committed], fileContextCharLimit: 120 });

    const { message, prepared } = await harness.prepare([candidate.file]);

    expect(harness.deriveText).toHaveBeenCalledTimes(1);
    expect(prepared?.[0].llmDeliveryPath).toBe('none');
    expect(harness.context.judge(candidate.file).overflow).toBe(true);
    expect(message.documents).toEqual([]);
    expect(message.fileContext).toBeUndefined();
    expect(harness.extractText).not.toHaveBeenCalled();
    expect((await harness.client.options.attachments)[1]).toBe(committed.file);
  });

  it('serializes concurrent historical fallback allocation against one shared text budget', async () => {
    const first = storedPdf('FIRST');
    const second = storedPdf('SECOND');
    const harness = setup({ historical: [first, second], fileContextCharLimit: 150 });

    const outcomes = await Promise.all([
      harness.prepare([first.file]),
      harness.prepare([second.file]),
    ]);

    expect(outcomes.map(({ prepared }) => prepared?.[0].llmDeliveryPath).sort()).toEqual([
      'none',
      'text',
    ]);
    expect(outcomes.filter(({ message }) => message.fileContext != null)).toHaveLength(1);
    expect(harness.extractText).toHaveBeenCalledTimes(1);
    expect(
      harness.client.turnSharedAttachmentFiles.filter(isModelBoundAttachmentFile),
    ).toHaveLength(1);
  });

  it.each([
    ['a current attachment beside one scoped agent', false, 1, ['primary'], 'none'],
    ['a historical attachment beside one scoped agent', true, 1, ['primary'], 'text'],
    ['a current attachment beside two scoped agents', false, 2, ['primary', 'parallel'], 'text'],
  ] as const)(
    "charges each agent's own scoped count allowance, exempting history, for %s",
    async (_name, historical, fileLimit, agentIds, path) => {
      const fixture = storedPdf('SHARED', { text: 'Fits the text budget' });
      const harness = setup({ [historical ? 'historical' : 'current']: [fixture], fileLimit });
      for (const id of agentIds) {
        const scoped = storedPdf(`${id}-SCOPED`, { pages: 1, text: 'Scoped text' }).file;
        scoped.llmDeliveryPath = 'text';
        harness.client.turnScopedAttachmentsByAgentId.set(id, [scoped]);
        harness.client.turnAttachmentEndpointsByAgentId.set(id, { endpoint: Providers.ANTHROPIC });
      }

      const { message, prepared } = await harness.prepare([fixture.file]);

      expect(prepared?.[0].llmDeliveryPath).toBe(path);
      if (path === 'text') {
        expect(message.fileContext).toContain(fixture.file.text);
      } else {
        expect(message.fileContext).toBeUndefined();
      }
    },
  );

  it.each([
    ['equal endpoint budgets', false, 'text'],
    ['a tighter parallel endpoint', true, 'none'],
  ] as const)(
    'reserves scoped bytes separately for %s and the combined global budget',
    async (_name, tighterParallel, path) => {
      const fixture = storedPdf('SHARED-BYTES', { text: 'Complete fallback text' });
      const unit = fixture.file.bytes;
      const harness = setup({
        current: [fixture],
        fileContextSizeLimit: (3 * unit) / megabyte,
        endpointTotalSizeLimit: (2 * unit) / megabyte,
      });
      harness.client.options.req.config!.fileConfig!.endpoints!.parallel = {
        totalSizeLimit: ((tighterParallel ? 1.5 : 2) * unit) / megabyte,
      };
      for (const id of ['primary', 'parallel']) {
        const scoped = storedPdf(`${id}-SCOPED`, { pages: 1, text: 'Scoped text' }).file;
        scoped.bytes = unit;
        scoped.llmDeliveryPath = 'text';
        harness.client.turnScopedAttachmentsByAgentId.set(id, [scoped]);
        harness.client.turnAttachmentEndpointsByAgentId.set(id, {
          endpoint: id === 'primary' ? Providers.ANTHROPIC : 'parallel',
        });
      }

      const { message, prepared } = await harness.prepare([fixture.file]);

      expect(prepared?.[0].llmDeliveryPath).toBe(path);
      expect(message.fileContext != null).toBe(path === 'text');
      expect(harness.context.judge(fixture.file).overflow).toBe(tighterParallel ? true : undefined);
    },
  );

  it('charges the full text of a current attachment replayed in history twice', async () => {
    const fixture = storedPdf('REPEATED', { text: 'r'.repeat(90) });
    const harness = setup({ current: [fixture], historical: [fixture], fileContextCharLimit: 100 });

    const { message, prepared } = await harness.prepare([fixture.file]);

    expect(prepared?.[0].llmDeliveryPath).toBe('none');
    expect(harness.context.judge(fixture.file).overflow).toBe(true);
    expect(message.fileContext).toBeUndefined();
    expect(harness.extractText).not.toHaveBeenCalled();
  });

  it('allows a later admission after the same host rejected sensitive fallback', async () => {
    const blocked = storedPdf('BLOCKED', { text: 'PRIVATE-SENTINEL' });
    const safe = storedPdf('SAFE', { text: 'Safe complete text' });
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private token', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };
    const harness = setup({ current: [blocked, safe], filters });
    harness.context.recordRejections(
      [blocked, safe].map(({ file }) => ({ file_id: file.file_id, reason: 'capacity' })),
    );
    const blockedFiles = await harness.client.prepareTurnAttachments([blocked.file]);
    const safeFiles = await harness.client.prepareTurnAttachments([safe.file]);

    const rejected = admitNativeFallbackAttachments(harness.client, blockedFiles);
    const recovered = admitNativeFallbackAttachments(harness.client, safeFiles);

    await expect(rejected).rejects.toBeInstanceOf(ContentFilterError);
    await expect(recovered).resolves.toEqual(safeFiles);
    expect((await harness.client.options.attachments)[1]).toBe(safeFiles[0]);
    expect((await harness.client.options.attachments)[0]).toBe(blocked.file);
  });

  it('waits for admission when another message already recorded the native rejection', async () => {
    const fixture = storedPdf('KNOWN-REJECTION', { text: 'Complete cached fallback' });
    const harness = setup({ current: [fixture] });
    harness.context.recordRejections([{ file_id: fixture.file.file_id, reason: 'capacity' }]);
    const entered = Promise.withResolvers<void>();
    const allowed = Promise.withResolvers<void>();
    const admit = harness.client.admitPreparedAttachments;
    harness.client.admitPreparedAttachments = async (files) => {
      entered.resolve();
      await allowed.promise;
      return admit(files);
    };

    const pending = harness.prepare([fixture.file]);
    await entered.promise;

    expect(harness.client.addFileContextToMessage).not.toHaveBeenCalled();
    expect(harness.extractText).not.toHaveBeenCalled();
    allowed.resolve();
    const { message, prepared } = await pending;
    expect(prepared?.[0].llmDeliveryPath).toBe('text');
    expect(message.fileContext).toContain(fixture.file.text);
  });

  it('stops after real validation if the request aborts before cached fallback injection', async () => {
    const fixture = storedPdf('ABORTED', { text: 'Complete text never injected' });
    const controller = new AbortController();
    const aborted = new Error('Canceled request');
    const harness = setup({ current: [fixture], abortController: controller });
    const process = harness.client.processAttachments.getMockImplementation()!;
    harness.client.processAttachments.mockImplementation(async (message, files) => {
      const processed = await process(message, files);
      controller.abort(aborted);
      return processed;
    });

    await expect(harness.prepare([fixture.file])).rejects.toBe(aborted);

    expect(harness.context.judge(fixture.file).rejected).toBe('capacity');
    expect(harness.client.prepareTurnAttachments).not.toHaveBeenCalled();
    expect(harness.client.addFileContextToMessage).not.toHaveBeenCalled();
    expect(harness.extractText).not.toHaveBeenCalled();
  });

  it.each([
    ['cached', { text: 'PRIVATE-SENTINEL' }, false],
    ['derived', {}, false],
    ['already rejected cached', { text: 'PRIVATE-SENTINEL' }, true],
  ] as const)(
    'blocks sensitive %s fallback before injection or persistence',
    async (_kind, stored, rejectedBefore) => {
      const filters: FiltersConfig = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private token', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      };
      const fixture = storedPdf('PRIVATE-SENTINEL', stored);
      const harness = setup({ current: [fixture], filters });
      if (rejectedBefore) {
        harness.context.recordRejections([{ file_id: fixture.file.file_id, reason: 'capacity' }]);
      }

      await expect(harness.prepare([fixture.file])).rejects.toBeInstanceOf(ContentFilterError);

      expect(harness.client.addFileContextToMessage).not.toHaveBeenCalled();
      expect(harness.extractText).not.toHaveBeenCalled();
      expect(harness.persistDerivation).not.toHaveBeenCalled();
      expect(fixture.file.llmDeliveryPath).toBe('provider');
    },
  );
});
