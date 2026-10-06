import { FileContext, FileSources, decideFileReading } from 'librechat-data-provider';
import type { TurnFileConsumers, TFileConfig, TurnDeliveryRouting } from 'librechat-data-provider';
import type { FileTextDeriver, TurnReadingContext, TurnReadingFile, DerivedText } from './turn';
import type { DirectContentAllocation } from './settle';
import { applyTurnDelivery, resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { measureAttachment, measureModelBoundAttachment } from '~/agents/attachments';
import { settleTurnFiles, prepareTurnFiles } from './settle';
import { buildTurnReadingContext } from './turn';

type EndpointFileConfigInput = NonNullable<TFileConfig['endpoints']>[string];

/** The module object settle reads through, so a spy on it sees every decision settle asks for. */
const dataProvider =
  jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');

const MB = 1024 * 1024;
const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const noReader: TurnFileConsumers = { executeCode: false, fileSearch: false };
const searchOnly: TurnFileConsumers = { executeCode: false, fileSearch: true };

const derivedText: DerivedText = {
  status: 'derived',
  text: 'quarter,total\nQ1,42',
  textDerivation: { outcome: 'complete', extractor: 'document_parser', at: 1 },
};

const attachment = (
  overrides: Partial<TurnReadingFile> & Pick<TurnReadingFile, 'file_id'>,
): TurnReadingFile => ({
  type: PDF,
  bytes: 4 * MB,
  source: FileSources.local,
  context: FileContext.message_attachment,
  llmDeliveryPath: 'provider',
  metadata: { destinationChosen: false },
  ...overrides,
});

const deferredWorkbook = attachment({
  file_id: 'xlsx',
  type: XLSX,
  bytes: 64 * 1024,
  llmDeliveryPath: 'none',
  metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
});

function setup({
  endpointConfig = { llmDeliveryPolicy: 'automatic' },
  deriveText,
}: {
  endpointConfig?: EndpointFileConfigInput;
  deriveText?: FileTextDeriver;
} = {}): { routing: TurnDeliveryRouting; context: TurnReadingContext } {
  const routing = resolveTurnDeliveryRouting({
    agent: { provider: 'openAI', endpoint: 'openAI' },
    config: { fileConfig: { endpoints: { openAI: endpointConfig } } },
  });
  const context = buildTurnReadingContext({
    routing,
    provider: 'openAI',
    model: 'gpt-4o',
    fileTokenLimit: 100_000,
    configuredFileSizeLimit: undefined,
    countTokens: (text) => text.length,
    deriveText,
  });
  if (context == null) {
    throw new Error('expected a reading context');
  }
  routing.reading = context;
  return { routing, context };
}

const byteBudget = (
  requestFileIds: readonly string[],
  bytes: number,
  committedExtra?: readonly TurnReadingFile[],
): DirectContentAllocation<TurnReadingFile> => ({
  requestFileIds,
  limits: { bytes },
  measure: measureModelBoundAttachment,
  committedExtra,
});

const pathsById = (files: readonly TurnReadingFile[]): Record<string, string | null | undefined> =>
  Object.fromEntries(files.map((file) => [file.file_id, file.llmDeliveryPath]));

describe('settleTurnFiles', () => {
  describe('text derivation', () => {
    it.each<[string, TurnFileConsumers, string, boolean]>([
      ['File Search', searchOnly, 'code_unavailable', true],
      /* Without Run Code or File Search the policy decides nothing, but a deferred workbook's
       * classic text route still has no text, so settle derives it as a no-tools turn reads it. */
      ['no file tool', noReader, 'no_file_tools', false],
    ])(
      'derives the text a reading needs with %s loaded, then decides again on the derived copy',
      async (_name, consumers, reason, automatic) => {
        const deriveText = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(
          async () => derivedText,
        );
        const { routing } = setup({ deriveText });
        const files = [deferredWorkbook];

        expect(decideFileReading({ routing, file: deferredWorkbook, consumers })).toMatchObject({
          reader: 'text',
          reason,
          needsText: true,
          automatic,
        });

        const [settled] = await settleTurnFiles({ routing, consumers, files });

        expect(settled).toMatchObject({
          file_id: 'xlsx',
          llmDeliveryPath: 'text',
          text: derivedText.text,
          metadata: { destinationChosen: false, textDerivation: derivedText.textDerivation },
        });
        expect(decideFileReading({ routing, file: settled, consumers })).toMatchObject({
          reader: 'text',
          reason,
          needsText: false,
          automatic,
        });
        expect(deferredWorkbook.text).toBeUndefined();
        expect(deferredWorkbook.metadata?.textDerivation).toEqual({ outcome: 'deferred' });

        await settleTurnFiles({ routing, consumers, files });
        expect(deriveText).toHaveBeenCalledTimes(1);
        expect(deriveText).toHaveBeenCalledWith(
          expect.objectContaining({ file_id: 'xlsx', llmDeliveryPath: 'text' }),
          undefined,
        );
      },
    );

    const parserFailure: DerivedText = {
      status: 'failed',
      textDerivation: { outcome: 'failed', reason: 'parser' },
      persist: true,
    };
    const movedToSearch = {
      reader: 'search',
      needsText: false,
      skipped: expect.arrayContaining([{ reader: 'text', reason: 'text_unavailable' }]),
    };

    it.each<[string, TurnFileConsumers, DerivedText, Record<string, unknown>]>([
      ['a failed derivation, with File Search loaded', searchOnly, parserFailure, movedToSearch],
      [
        'a failed derivation, with no file tool loaded',
        noReader,
        parserFailure,
        { reader: 'unavailable', reason: 'no_file_tools', needsText: false, automatic: false },
      ],
      [
        'a skipped derivation, with File Search loaded',
        searchOnly,
        { status: 'skipped', reason: 'storage_unavailable' },
        movedToSearch,
      ],
    ])(
      'treats %s as unavailable text for the rest of the request',
      async (_name, consumers, outcome, decision) => {
        const { routing, context } = setup({ deriveText: async () => outcome });

        const [settled] = await settleTurnFiles({ routing, consumers, files: [deferredWorkbook] });

        expect(settled.llmDeliveryPath).toBe('none');
        expect(settled.text).toBeUndefined();
        expect(context.judge(deferredWorkbook).textFailed).toBe(true);
        expect(decideFileReading({ routing, file: settled, consumers })).toMatchObject(decision);
      },
    );

    it('never decides or derives an unmarked record in a classic derive-only context', async () => {
      const { routing, context } = setup({
        endpointConfig: {},
        deriveText: async () => derivedText,
      });
      const deriveSpy = jest.spyOn(context, 'derive');
      const decideSpy = jest.spyOn(dataProvider, 'decideFileReading');
      const unmarked = [
        attachment({ file_id: 'pdf' }),
        attachment({ file_id: 'plain-xlsx', type: XLSX, llmDeliveryPath: 'none' }),
        attachment({ file_id: 'legacy-xlsx', type: XLSX, llmDeliveryPath: undefined }),
      ];
      try {
        const settled = await settleTurnFiles({
          routing,
          consumers: noReader,
          files: [...unmarked, deferredWorkbook],
        });

        expect(deriveSpy).toHaveBeenCalledTimes(1);
        expect(deriveSpy).toHaveBeenCalledWith(
          expect.objectContaining({ file_id: 'xlsx' }),
          undefined,
        );
        expect(decideSpy.mock.calls.map(([input]) => input.file.file_id)).toEqual(['xlsx']);
        expect(settled.slice(0, unmarked.length)).toEqual(
          applyTurnDelivery(unmarked, { routing, consumers: noReader }),
        );
        expect(settled[unmarked.length]).toMatchObject({ file_id: 'xlsx', text: derivedText.text });
      } finally {
        decideSpy.mockRestore();
      }
    });

    it('stops before deriving once the request is aborted', async () => {
      const deriveText = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(
        async () => derivedText,
      );
      const { routing } = setup({ deriveText });
      const controller = new AbortController();
      controller.abort();

      await expect(
        settleTurnFiles({
          routing,
          consumers: noReader,
          files: [deferredWorkbook],
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(deriveText).not.toHaveBeenCalled();
    });
  });

  describe('allocation', () => {
    const pdfs = ['a', 'b', 'c'].map((file_id) => attachment({ file_id }));

    it('admits direct content first-fit in request order and moves the overflow to File Search', async () => {
      const { routing, context } = setup();

      const settled = await settleTurnFiles({
        routing,
        consumers: searchOnly,
        files: pdfs,
        allocation: byteBudget(['a', 'b', 'c'], 10 * MB),
      });

      expect(pathsById(settled)).toEqual({ a: 'provider', b: 'provider', c: 'none' });
      expect(context.judge(pdfs[2]).overflow).toBe(true);
      expect(decideFileReading({ routing, file: settled[2], consumers: searchOnly })).toMatchObject(
        { reader: 'search', reason: 'aggregate_overflow' },
      );
    });

    it('leaves the overflow unavailable when File Search is loaded but cannot reach it', async () => {
      /* File Search queued and registered nothing, as a failed provisioning leaves it, and no
       * code tool is loaded, so the walk past the overflow finds no reader. */
      const { routing, context } = setup();
      context.setSearchEvidence({ queued: [], registered: [] });

      const settled = await settleTurnFiles({
        routing,
        consumers: searchOnly,
        files: pdfs,
        allocation: byteBudget(['a', 'b', 'c'], 10 * MB),
      });

      expect(settled[2].llmDeliveryPath).toBe('none');
      expect(decideFileReading({ routing, file: settled[2], consumers: searchOnly })).toMatchObject(
        { reader: 'unavailable', reason: 'aggregate_overflow' },
      );
    });

    it('allocates nothing when no file tool is loaded, keeping every file on its classic route', async () => {
      const { routing, context } = setup();

      const settled = await settleTurnFiles({
        routing,
        consumers: noReader,
        files: pdfs,
        allocation: byteBudget(['a', 'b', 'c'], 10 * MB),
      });

      expect(pathsById(settled)).toEqual({ a: 'provider', b: 'provider', c: 'provider' });
      expect(context.stats().overflow).toBe(0);
      expect(decideFileReading({ routing, file: settled[2], consumers: noReader })).toMatchObject({
        reader: 'provider',
        reason: 'no_file_tools',
        automatic: false,
      });
    });

    it('depends on the request order alone, not on the order of the files', async () => {
      const settle = async (files: TurnReadingFile[], requestFileIds: string[]) => {
        const { routing } = setup();
        const settled = await settleTurnFiles({
          routing,
          consumers: searchOnly,
          files,
          allocation: byteBudget(requestFileIds, 10 * MB),
        });
        return pathsById(settled);
      };
      const [a, b, c] = pdfs;

      const expected = { a: 'provider', b: 'provider', c: 'none' };
      expect(await settle([a, b, c], ['a', 'b', 'c'])).toEqual(expected);
      expect(await settle([c, a, b], ['a', 'b', 'c'])).toEqual(expected);
      expect(await settle([b, c, a], ['a', 'a', 'b', 'c'])).toEqual(expected);
      expect(await settle([a, b, c], ['c', 'a', 'b'])).toEqual({
        a: 'provider',
        b: 'none',
        c: 'provider',
      });
    });

    it('charges committed content before candidates, whatever order it arrives in', async () => {
      const chosen = attachment({
        file_id: 'chosen',
        bytes: 3 * MB,
        metadata: { destinationChosen: true },
      });
      const history = attachment({ file_id: 'history', bytes: MB });
      const settle = async (requestFileIds: string[], extra: TurnReadingFile[]) => {
        const { routing } = setup();
        const settled = await settleTurnFiles({
          routing,
          consumers: searchOnly,
          files: [...pdfs, chosen],
          allocation: byteBudget(requestFileIds, 12 * MB, extra),
        });
        return pathsById(settled);
      };

      const expected = { a: 'provider', b: 'provider', c: 'none', chosen: 'provider' };
      expect(await settle(['chosen', 'a', 'b', 'c'], [history])).toEqual(expected);
      expect(await settle(['a', 'b', 'chosen', 'c'], [history])).toEqual(expected);
      expect(await settle(['a', 'b', 'c', 'chosen'], [history])).toEqual(expected);
    });

    it('charges committed entries the caller measured beside the committed files', async () => {
      const history = attachment({ file_id: 'history', bytes: MB });
      const settle = async (
        allocation: Pick<
          DirectContentAllocation<TurnReadingFile>,
          'committedExtra' | 'committedEntries'
        >,
      ) => {
        const { routing } = setup();
        const settled = await settleTurnFiles({
          routing,
          consumers: searchOnly,
          files: pdfs,
          allocation: {
            requestFileIds: ['a', 'b', 'c'],
            limits: { count: 3 },
            measure: measureModelBoundAttachment,
            ...allocation,
          },
        });
        return pathsById(settled);
      };
      const historicalFileIds = new Set(['history']);

      expect(await settle({ committedExtra: [history] })).toEqual({
        a: 'provider',
        b: 'provider',
        c: 'none',
      });
      expect(
        await settle({ committedEntries: [measureAttachment(history, { historicalFileIds })] }),
      ).toEqual({ a: 'provider', b: 'provider', c: 'provider' });
    });

    it('does not charge files left to tools', async () => {
      const { routing } = setup();
      const toolFile = attachment({
        file_id: 'tool',
        bytes: 50 * MB,
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: true },
      });

      const settled = await settleTurnFiles({
        routing,
        consumers: searchOnly,
        files: [toolFile, ...pdfs],
        allocation: byteBudget(['tool', 'a', 'b', 'c'], 12 * MB),
      });

      expect(pathsById(settled)).toEqual({
        tool: 'none',
        a: 'provider',
        b: 'provider',
        c: 'provider',
      });
    });

    it('charges a text-source request file as admission does, whatever its route', async () => {
      const { routing } = setup();
      const pasted = attachment({
        file_id: 'pasted',
        type: 'text/plain',
        bytes: 3 * MB,
        source: FileSources.text,
        text: 'pasted notes',
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: true },
      });

      const settled = await settleTurnFiles({
        routing,
        consumers: searchOnly,
        files: [pasted, ...pdfs],
        allocation: byteBudget(['pasted', 'a', 'b', 'c'], 12 * MB),
      });

      expect(pathsById(settled)).toEqual({
        pasted: 'none',
        a: 'provider',
        b: 'provider',
        c: 'none',
      });
    });

    it('returns the same array when nothing changes', async () => {
      const { routing } = setup();

      const settled = await settleTurnFiles({
        routing,
        consumers: searchOnly,
        files: pdfs,
        allocation: byteBudget(['a', 'b', 'c'], 100 * MB),
      });

      expect(settled).toBe(pdfs);
    });

    it('never allocates under the classic policy', async () => {
      const { routing, context } = setup({
        endpointConfig: {},
        deriveText: async () => derivedText,
      });
      const measureSpy = jest.fn(measureModelBoundAttachment);

      const settled = await settleTurnFiles({
        routing,
        consumers: searchOnly,
        files: pdfs,
        allocation: { requestFileIds: ['a', 'b', 'c'], limits: { bytes: MB }, measure: measureSpy },
      });

      expect(settled).toBe(pdfs);
      expect(measureSpy).not.toHaveBeenCalled();
      expect(context.stats().overflow).toBe(0);
    });
  });

  it('is exactly applyTurnDelivery when the routing carries no reading context', async () => {
    const routing = resolveTurnDeliveryRouting({
      agent: { provider: 'openAI', endpoint: 'openAI' },
      config: { fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } } },
    });
    const files = [deferredWorkbook, ...['a', 'b'].map((file_id) => attachment({ file_id }))];

    const settled = await settleTurnFiles({
      routing,
      consumers: noReader,
      files,
      allocation: byteBudget(['a', 'b'], MB),
    });

    expect(settled).toEqual(applyTurnDelivery(files, { routing, consumers: noReader }));
    expect(pathsById(settled)).toEqual({ xlsx: 'none', a: 'provider', b: 'provider' });
    expect(await settleTurnFiles({ consumers: noReader, files })).toBe(files);
  });

  describe('flush', () => {
    it('defers flushing to the caller by default', async () => {
      const { routing, context } = setup({ deriveText: async () => derivedText });
      const flushSpy = jest.spyOn(context, 'flush');

      await settleTurnFiles({ routing, consumers: noReader, files: [deferredWorkbook] });
      expect(flushSpy).not.toHaveBeenCalled();

      await settleTurnFiles({
        routing,
        consumers: noReader,
        files: [deferredWorkbook],
        flush: true,
      });
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('flushes before returning when files are prepared outside initialization', async () => {
      const { routing, context } = setup({ deriveText: async () => derivedText });
      const flushSpy = jest.spyOn(context, 'flush');

      const [prepared] = await prepareTurnFiles({
        routing,
        consumers: noReader,
        files: [deferredWorkbook],
      });
      expect(prepared.text).toBe(derivedText.text);
      expect(flushSpy).toHaveBeenCalledTimes(1);

      await prepareTurnFiles({
        routing,
        consumers: noReader,
        files: [deferredWorkbook],
        flush: false,
      });
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });
  });
});
