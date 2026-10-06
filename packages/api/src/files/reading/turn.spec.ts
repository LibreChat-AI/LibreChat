import { logger } from '@librechat/data-schemas';
import { FileContext, FileSources, decideFileReading } from 'librechat-data-provider';
import type { TFileConfig, TurnFileConsumers, TurnDeliveryRouting } from 'librechat-data-provider';
import type {
  DerivedText,
  FileTextDeriver,
  TurnReadingFile,
  EncodedDocuments,
  NativeDeliveryAgent,
  TextDerivationPersister,
  TextDerivationSave,
  BuildTurnReadingContextParams,
} from './turn';
import type { NativeValidationMode } from '~/types';
import {
  needsDerivedText,
  getTurnTextOptions,
  deriveRequestedText,
  getTurnReadingContext,
  encodeNativeDocuments,
  recordNativeRejections,
  buildTurnReadingContext,
  getNativeValidationPolicy,
  createDerivationPersister,
} from './turn';
import { resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { UninspectableFileError } from '~/protection/files';

type EndpointFileConfigInput = NonNullable<TFileConfig['endpoints']>[string];

const MB = 1024 * 1024;
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const routingFor = (
  endpoint: string,
  endpointConfig: EndpointFileConfigInput = { llmDeliveryPolicy: 'automatic' },
): TurnDeliveryRouting =>
  resolveTurnDeliveryRouting({
    agent: { provider: endpoint, endpoint },
    config: { fileConfig: { endpoints: { [endpoint]: endpointConfig } } },
  });

const attachment = (
  overrides: Partial<TurnReadingFile> & Pick<TurnReadingFile, 'file_id'>,
): TurnReadingFile => ({
  type: PDF,
  bytes: MB,
  source: FileSources.local,
  context: FileContext.message_attachment,
  llmDeliveryPath: 'provider',
  metadata: { destinationChosen: false },
  ...overrides,
});

const countByLength = (text: string): number => text.length;

function contextFor(overrides: Partial<BuildTurnReadingContextParams> = {}) {
  const params: BuildTurnReadingContextParams = {
    routing: routingFor('openAI'),
    provider: 'openAI',
    model: 'gpt-4o',
    fileTokenLimit: 100_000,
    configuredFileSizeLimit: undefined,
    countTokens: countByLength,
    ...overrides,
  };
  const context = buildTurnReadingContext(params);
  if (context == null) {
    throw new Error('expected a reading context');
  }
  return context;
}

const nativeVerdict = (
  provider: string,
  file: TurnReadingFile,
  overrides: Partial<BuildTurnReadingContextParams> = {},
) => contextFor({ routing: routingFor(provider), provider, ...overrides }).judge(file).native;

describe('buildTurnReadingContext', () => {
  it('builds nothing under the classic policy without a text deriver', () => {
    const params = {
      provider: 'openAI',
      fileTokenLimit: 100_000,
      configuredFileSizeLimit: undefined,
      countTokens: countByLength,
    };
    expect(buildTurnReadingContext({ ...params, routing: routingFor('openAI', {}) })).toBe(
      undefined,
    );
    expect(
      buildTurnReadingContext({
        ...params,
        routing: routingFor('openAI', { llmDeliveryPolicy: 'classic' }),
      }),
    ).toBe(undefined);
    expect(
      buildTurnReadingContext({
        ...params,
        routing: routingFor('openAI', { llmDeliveryPolicy: 'automatic', legacyFileUploadUX: true }),
      }),
    ).toBe(undefined);
  });

  it('builds a derive-only context under the classic policy when a deriver is wired', () => {
    const deriveText: FileTextDeriver = jest.fn();
    const context = contextFor({ routing: routingFor('openAI', {}), deriveText });
    const file = attachment({ file_id: 'pdf', text: 'x'.repeat(10), bytes: 500 * MB });

    expect(context.policy).toBe('classic');
    expect(context.canDerive).toBe(true);
    expect(context.judge(file)).toEqual({});

    context.addOverflow(['pdf']);
    context.recordRejections([{ file_id: 'pdf', reason: 'capacity' }]);
    context.markTextFailed('pdf');
    expect(context.judge(file)).toEqual({ textFailed: true });
  });

  it('cannot derive under the automatic policy without a deriver', () => {
    const context = contextFor();
    expect(context.policy).toBe('automatic');
    expect(context.canDerive).toBe(false);
  });

  it('is found again through the routing it is attached to, and through a copy of it', () => {
    const routing = routingFor('openAI');
    const context = contextFor({ routing });
    expect(getTurnReadingContext(routing)).toBe(undefined);

    routing.reading = context;
    expect(getTurnReadingContext(routing)).toBe(context);
    expect(getTurnReadingContext({ ...routing })).toBe(context);
    expect(getTurnReadingContext({ reading: { judge: () => ({}), canDerive: false } })).toBe(
      undefined,
    );
    expect(getTurnReadingContext(undefined)).toBe(undefined);
  });
});

describe('getTurnTextOptions', () => {
  it('supplies nothing without a reading context', () => {
    expect(getTurnTextOptions(undefined)).toEqual({});
    expect(getTurnTextOptions(routingFor('openAI'))).toEqual({});
  });

  it('reuses judged counts and marks truncation under the automatic policy', () => {
    const routing = routingFor('openAI');
    const context = contextFor({ routing, fileTokenLimit: 10, countTokens: () => 4 });
    routing.reading = context;
    const file = attachment({ file_id: 'notes', text: 'x'.repeat(40), llmDeliveryPath: 'text' });
    expect(context.judge(file).text).toBe('fits');

    const options = getTurnTextOptions(routing);

    expect(options.markTruncation).toBe(true);
    expect(options.knownTokenCount?.(file)).toBe(4);
  });

  it('reuses counts without marking truncation in a derive-only classic context', () => {
    const routing = routingFor('openAI', {});
    routing.reading = contextFor({ routing, deriveText: jest.fn() });

    expect(getTurnTextOptions(routing)).toMatchObject({ markTruncation: false });
  });
});

describe('native validation', () => {
  const searchOnly: TurnFileConsumers = { executeCode: false, fileSearch: true };
  const rejectedPdf = attachment({ file_id: 'rejected-pdf' });
  const chosenPdf = attachment({
    file_id: 'chosen-pdf',
    metadata: { destinationChosen: true },
  });
  const unmarkedPdf = attachment({ file_id: 'unmarked-pdf', metadata: {} });

  const automaticAgent = (overrides: Partial<NativeDeliveryAgent> = {}): NativeDeliveryAgent => {
    const routing = routingFor('openAI');
    routing.reading = contextFor({ routing });
    return {
      id: 'agent-1',
      deliveryRouting: routing,
      fileConsumers: searchOnly,
      currentRequestAttachments: [rejectedPdf, chosenPdf, unmarkedPdf],
      ...overrides,
    };
  };

  describe('getNativeValidationPolicy', () => {
    it('leaves out only a file the automatic policy reads', () => {
      const modeOf = getNativeValidationPolicy(automaticAgent());

      expect(modeOf(rejectedPdf)).toBe('skip');
      expect(modeOf(chosenPdf)).toBe('throw');
      expect(modeOf(unmarkedPdf)).toBe('throw');
      expect(modeOf(attachment({ file_id: 'agent-file', context: FileContext.agents }))).toBe(
        'throw',
      );
    });

    it('keeps a type the operator routed to a fixed path failing as classic', () => {
      const routing = routingFor('openAI', {
        llmDeliveryPolicy: 'automatic',
        defaultLLMDeliveryPath: { overrides: { [PDF]: 'provider' } },
      });
      routing.reading = contextFor({ routing });

      expect(
        getNativeValidationPolicy(automaticAgent({ deliveryRouting: routing }))(rejectedPdf),
      ).toBe('throw');
    });

    it('fails every file outside an automatic reading, without known consumers or without a file tool', () => {
      const derivingClassic = routingFor('openAI', {});
      derivingClassic.reading = contextFor({
        routing: derivingClassic,
        deriveText: async () => ({ status: 'skipped', reason: 'no_extractor' }),
      });
      const agents = [
        automaticAgent({ deliveryRouting: derivingClassic }),
        automaticAgent({ deliveryRouting: routingFor('openAI') }),
        automaticAgent({ fileConsumers: undefined }),
        automaticAgent({ fileConsumers: { executeCode: false, fileSearch: false } }),
        undefined,
      ];

      expect(agents.map((agent) => getNativeValidationPolicy(agent)(rejectedPdf))).toEqual([
        'throw',
        'throw',
        'throw',
        'throw',
        'throw',
      ]);
      expect(
        getNativeValidationPolicy(
          automaticAgent({ fileConsumers: { executeCode: true, fileSearch: false } }),
        )(rejectedPdf),
      ).toBe('skip');
    });

    it('allows an automatic historical attachment to use the same fallback as a request file', () => {
      const replayed = attachment({ file_id: 'replayed-pdf' });
      const agent = automaticAgent({ currentRequestAttachments: [] });
      const modeOf = getNativeValidationPolicy(agent);

      expect(modeOf(rejectedPdf)).toBe('skip');
      expect(modeOf(replayed)).toBe('skip');
      expect(modeOf({ ...replayed, metadata: { destinationChosen: true } })).toBe('throw');
    });
  });

  describe('encodeNativeDocuments', () => {
    type Encoded = EncodedDocuments<string, string>;
    const isInvalid = ({ file_id }: TurnReadingFile): boolean =>
      file_id.startsWith('rejected') || file_id.startsWith('chosen');
    /** Encodes every file but the rejected and chosen PDFs, which fail validation. */
    const encoder = () =>
      jest.fn(async (files: TurnReadingFile[], mode: NativeValidationMode): Promise<Encoded> => {
        const invalid = files.filter(isInvalid);
        if (mode === 'throw' && invalid.length > 0) {
          throw new Error('PDF validation failed');
        }
        const valid = files.filter((file) => !isInvalid(file));
        return {
          documents: valid.map(({ file_id }) => `block:${file_id}`),
          files: valid.map(({ file_id }) => file_id),
          ...(mode === 'skip' && {
            rejected: invalid.map(({ file_id }) => ({ file_id, reason: 'integrity' as const })),
          }),
        };
      });
    const callsOf = (encode: ReturnType<typeof encoder>) =>
      encode.mock.calls.map(([files, mode]) => [files.map(({ file_id }) => file_id), mode]);

    it('encodes a batch that shares one mode in a single call', async () => {
      const encode = encoder();
      const fits = attachment({ file_id: 'fits-pdf' });

      const result = await encodeNativeDocuments([rejectedPdf, fits], automaticAgent(), encode);

      expect(callsOf(encode)).toEqual([[['rejected-pdf', 'fits-pdf'], 'skip']]);
      expect(result).toEqual({
        documents: ['block:fits-pdf'],
        files: ['fits-pdf'],
        rejected: [{ file_id: 'rejected-pdf', reason: 'integrity' }],
      });
    });

    it('still fails the turn on a classic record that fails beside an automatic one', async () => {
      const encode = encoder();

      await expect(
        encodeNativeDocuments([rejectedPdf, chosenPdf], automaticAgent(), encode),
      ).rejects.toThrow('PDF validation failed');
      expect(callsOf(encode)).toEqual([
        [['rejected-pdf'], 'skip'],
        [['chosen-pdf'], 'throw'],
      ]);
    });

    it('merges a split encode and lists only the files it left out', async () => {
      const encode = encoder();

      const result = await encodeNativeDocuments(
        [rejectedPdf, unmarkedPdf],
        automaticAgent(),
        encode,
      );

      expect(result).toEqual({
        documents: ['block:unmarked-pdf'],
        files: ['unmarked-pdf'],
        rejected: [{ file_id: 'rejected-pdf', reason: 'integrity' }],
      });
    });

    it('encodes in throw mode under classic routing', async () => {
      const encode = encoder();

      await expect(
        encodeNativeDocuments([rejectedPdf], { deliveryRouting: routingFor('openAI', {}) }, encode),
      ).rejects.toThrow('PDF validation failed');
      expect(callsOf(encode)).toEqual([[['rejected-pdf'], 'throw']]);
    });
  });

  describe('recordNativeRejections', () => {
    it('records the rejections on each agent carrying the payload, once per reading', () => {
      const primary = automaticAgent();
      const handoff = automaticAgent({ id: 'agent-2' });
      const sharing = { ...primary, id: 'agent-3' };
      const levelSpy = jest.spyOn(logger, 'isDebugEnabled').mockReturnValue(true);
      const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => logger);

      recordNativeRejections(
        [primary, handoff, sharing, undefined],
        [{ file_id: rejectedPdf.file_id, reason: 'capacity' }],
      );

      expect(
        [primary, handoff].map((agent) => {
          const context = getTurnReadingContext(agent.deliveryRouting);
          return [context?.judge(rejectedPdf).rejected, context?.stats().rejected];
        }),
      ).toEqual([
        ['capacity', 1],
        ['capacity', 1],
      ]);
      expect(debugSpy.mock.calls.map(([line]) => line)).toEqual([
        '[nativeDelivery] agent=agent-1 file_id=rejected-pdf provider=openAI rejected=capacity mode=skip next=search',
        '[nativeDelivery] agent=agent-2 file_id=rejected-pdf provider=openAI rejected=capacity mode=skip next=search',
      ]);
      debugSpy.mockRestore();
      levelSpy.mockRestore();
    });

    it('ignores rejections without a reading context or without rejections', () => {
      const classic = automaticAgent({ deliveryRouting: routingFor('openAI') });
      expect(() =>
        recordNativeRejections([classic], [{ file_id: rejectedPdf.file_id, reason: 'integrity' }]),
      ).not.toThrow();
      const agent = automaticAgent();

      recordNativeRejections([agent], undefined);
      recordNativeRejections([agent], []);

      expect(getTurnReadingContext(agent.deliveryRouting)?.stats().rejected).toBe(0);
    });
  });
});

describe('text verdicts', () => {
  it('settles text within the limit by its byte length without counting tokens', () => {
    const countTokens = jest.fn(countByLength);
    const context = contextFor({ fileTokenLimit: 10, countTokens });

    expect(context.judge(attachment({ file_id: 'short', text: 'tiny' })).text).toBe('fits');
    expect(countTokens).not.toHaveBeenCalled();
    expect(context.knownTokenCount(attachment({ file_id: 'short', text: 'tiny' }))).toBe(undefined);
  });

  it('counts tokens once when the byte length exceeds the limit', () => {
    const countTokens = jest.fn((text: string) => Math.ceil(text.length / 4));
    const context = contextFor({ fileTokenLimit: 10, countTokens });
    const file = attachment({ file_id: 'long', text: 'x'.repeat(40) });

    expect(context.judge(file).text).toBe('fits');
    expect(context.judge({ ...file }).text).toBe('fits');
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(context.knownTokenCount(file)).toBe(10);
  });

  it('exceeds when the complete text has more tokens than the limit', () => {
    const context = contextFor({ fileTokenLimit: 10 });
    const file = attachment({ file_id: 'long', text: 'x'.repeat(11) });

    expect(context.judge(file).text).toBe('exceeds');
    expect(context.knownTokenCount(file)).toBe(11);
  });

  it.each([0, undefined])('exceeds when the token limit is %p', (fileTokenLimit) => {
    const countTokens = jest.fn(countByLength);
    const context = contextFor({ fileTokenLimit, countTokens });

    expect(context.judge(attachment({ file_id: 'text', text: 'a' })).text).toBe('exceeds');
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('judges the text again once its length changes', () => {
    const countTokens = jest.fn(countByLength);
    const context = contextFor({ fileTokenLimit: 10, countTokens });

    expect(context.judge(attachment({ file_id: 'grows', text: 'x'.repeat(12) })).text).toBe(
      'exceeds',
    );
    expect(context.judge(attachment({ file_id: 'grows', text: 'x'.repeat(11) })).text).toBe(
      'exceeds',
    );
    expect(countTokens).toHaveBeenCalledTimes(2);
  });

  it('never counts a stored text the reading walk gives to Run Code', () => {
    const countTokens = jest.fn(countByLength);
    const routing = routingFor('openAI');
    const context = contextFor({ routing, fileTokenLimit: 100_000, countTokens });
    routing.reading = context;
    const csv = attachment({
      file_id: 'large-csv',
      type: 'text/csv',
      llmDeliveryPath: 'text',
      text: 'x'.repeat(700_000),
    });

    const reading = decideFileReading({
      routing,
      file: csv,
      consumers: { executeCode: true, fileSearch: false },
    });

    expect(reading.reader).toBe('code');
    expect(countTokens).not.toHaveBeenCalled();
    expect(context.knownTokenCount(csv)).toBe(undefined);

    expect(context.judge(csv).text).toBe('exceeds');
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(context.knownTokenCount(csv)).toBe(700_000);
  });

  it('judges no text verdict for a record without text', () => {
    const context = contextFor();
    expect(context.judge(attachment({ file_id: 'empty', text: '' }))).not.toHaveProperty('text');
    expect(context.judge(attachment({ file_id: 'none' }))).not.toHaveProperty('text');
  });
});

describe('native verdicts', () => {
  it.each<{
    why: string;
    provider: string;
    model?: string;
    type: string;
    bytes: number;
    configuredFileSizeLimit?: number;
    verdict: 'fits' | 'capacity' | 'unsupported';
  }>([
    {
      why: 'a PDF on Azure OpenAI, where the encoder emits nothing',
      provider: 'azureOpenAI',
      type: PDF,
      bytes: MB,
      verdict: 'unsupported',
    },
    {
      why: 'a Word document on Anthropic',
      provider: 'anthropic',
      type: DOCX,
      bytes: MB,
      verdict: 'unsupported',
    },
    { why: 'a PDF on Anthropic', provider: 'anthropic', type: PDF, bytes: MB, verdict: 'fits' },
    {
      why: 'a Word document for a Claude model behind an OpenAI-compatible gateway',
      provider: 'openAI',
      model: 'claude-sonnet-4-5',
      type: DOCX,
      bytes: MB,
      verdict: 'unsupported',
    },
    {
      why: 'a Word document for an OpenAI model',
      provider: 'openAI',
      model: 'gpt-4o',
      type: DOCX,
      bytes: MB,
      verdict: 'fits',
    },
    {
      why: 'a 20 MB PDF for Claude 4 on Bedrock, exempt from the 4.5 MB document limit',
      provider: 'bedrock',
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      type: PDF,
      bytes: 20 * MB,
      verdict: 'fits',
    },
    {
      why: 'a 20 MB PDF for Claude 3.5 on Bedrock',
      provider: 'bedrock',
      model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      type: PDF,
      bytes: 20 * MB,
      verdict: 'capacity',
    },
    {
      why: 'a presentation on Bedrock',
      provider: 'bedrock',
      type: PPTX,
      bytes: MB,
      verdict: 'unsupported',
    },
    {
      why: 'a PDF above the configured limit',
      provider: 'openAI',
      type: PDF,
      bytes: 2 * MB,
      configuredFileSizeLimit: MB,
      verdict: 'capacity',
    },
    {
      why: 'a Word document above the configured limit',
      provider: 'openAI',
      type: DOCX,
      bytes: 2 * MB,
      configuredFileSizeLimit: MB,
      verdict: 'capacity',
    },
    {
      why: 'a PDF at the configured limit',
      provider: 'openAI',
      type: PDF,
      bytes: MB,
      configuredFileSizeLimit: MB,
      verdict: 'fits',
    },
    {
      why: 'a PDF above the provider limit when none is configured',
      provider: 'openAI',
      type: PDF,
      bytes: 11 * MB,
      verdict: 'capacity',
    },
    {
      why: 'a PDF at the provider limit when none is configured',
      provider: 'openAI',
      type: PDF,
      bytes: 10 * MB,
      verdict: 'fits',
    },
  ])(
    'judges $why as $verdict',
    ({ provider, model, type, bytes, configuredFileSizeLimit, verdict }) => {
      const overrides = {
        ...(model != null && { model }),
        ...(configuredFileSizeLimit != null && { configuredFileSizeLimit }),
      };
      expect(nativeVerdict(provider, attachment({ file_id: 'file', type, bytes }), overrides)).toBe(
        verdict,
      );
    },
  );

  it('does not judge images, audio or video', () => {
    expect(
      contextFor().judge(attachment({ file_id: 'image', type: 'image/png' })),
    ).not.toHaveProperty('native');
  });

  it('memoizes the verdict per file', () => {
    const context = contextFor();
    expect(context.judge(attachment({ file_id: 'pdf', bytes: MB })).native).toBe('fits');
    expect(context.judge(attachment({ file_id: 'pdf', bytes: 50 * MB })).native).toBe('fits');
    expect(context.judge(attachment({ file_id: 'other', bytes: 50 * MB })).native).toBe('capacity');
  });
});

describe('request evidence', () => {
  it('reports overflow, encode-time rejections and derivation failures per file', () => {
    const context = contextFor();
    const file = attachment({ file_id: 'pdf' });
    expect(context.judge(file)).toEqual({ native: 'fits' });

    context.addOverflow(new Set(['pdf']));
    context.recordRejections([
      { file_id: 'pdf', reason: 'integrity' },
      { file_id: 'pdf', reason: 'capacity' },
    ]);
    context.markTextFailed('pdf');

    expect(context.judge(file)).toEqual({
      native: 'fits',
      overflow: true,
      rejected: 'integrity',
      textFailed: true,
    });
    expect(context.judge(attachment({ file_id: 'other' }))).toEqual({ native: 'fits' });
  });

  it('judges File Search reachability only once search evidence is set', () => {
    const context = contextFor();
    const queued = attachment({ file_id: 'queued' });
    const registered = attachment({ file_id: 'registered' });
    const missing = attachment({ file_id: 'missing' });
    const unsearchable = attachment({ file_id: 'zip', type: 'application/zip' });
    const chosen = attachment({ file_id: 'chosen', metadata: { destinationChosen: true } });

    expect(context.judge(missing)).not.toHaveProperty('search');

    context.setSearchEvidence({ queued: ['queued'], registered: ['registered'] });

    expect(context.judge(queued).search).toBe('reachable');
    expect(context.judge(registered).search).toBe('reachable');
    expect(context.judge(missing).search).toBe('unreachable');
    expect(context.judge(unsearchable).search).toBe('reachable');
    expect(context.judge(chosen).search).toBe('reachable');
  });

  it('reads shared preparation outcomes without rerouting already-sent attachments', () => {
    const context = contextFor();
    const queued = attachment({ file_id: 'queued' });
    const preparation = new Map<string, 'queued' | 'ready' | 'failed'>();
    context.setSearchEvidence({ queued: ['queued'], registered: ['indexed'], preparation });

    expect(context.searchState('queued')).toBe('queued');
    expect(context.searchState('indexed')).toBe('ready');
    expect(context.searchState('missing')).toBeUndefined();

    preparation.set('queued', 'failed');
    expect(context.searchState('queued')).toBe('failed');
    expect(context.judge(queued).search).toBe('reachable');

    preparation.set('queued', 'ready');
    expect(context.searchState('queued')).toBe('ready');
    expect(context.judge(queued).search).toBe('reachable');
    expect(contextFor().searchState('queued')).toBeUndefined();
  });

  it('keeps each dropped request file once', () => {
    const context = contextFor();
    const first = attachment({ file_id: 'a', bytes: 1 });
    context.recordDropped([first, attachment({ file_id: 'b' })]);
    context.recordDropped([attachment({ file_id: 'a', bytes: 2 })]);

    expect(context.dropped().map((file) => file.file_id)).toEqual(['a', 'b']);
    expect(context.dropped()[0]).toBe(first);
    expect(context.stats()).toEqual({
      overflow: 0,
      rejected: 0,
      textFailed: 0,
      derived: 0,
      dropped: 2,
    });
  });
});

describe('derive', () => {
  const xlsx = attachment({
    file_id: 'xlsx',
    type: XLSX,
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
  });

  it('derives each file once per request with the request signal', async () => {
    const controller = new AbortController();
    const deriveText = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(
      async () => ({
        status: 'derived',
        text: 'a,b',
        textDerivation: { outcome: 'complete', extractor: 'document_parser' },
      }),
    );
    const context = contextFor({ deriveText, signal: controller.signal });

    const [first, second] = await Promise.all([context.derive(xlsx), context.derive({ ...xlsx })]);

    expect(first).toBe(second);
    expect(first).toMatchObject({ status: 'derived', text: 'a,b' });
    expect(deriveText).toHaveBeenCalledTimes(1);
    expect(deriveText).toHaveBeenCalledWith(xlsx, controller.signal);
    expect(context.stats().derived).toBe(1);
  });

  it('skips without a deriver', async () => {
    await expect(contextFor().derive(xlsx)).resolves.toEqual({
      status: 'skipped',
      reason: 'no_extractor',
    });
  });

  it('turns a deriver error into a skipped derivation and logs only safe metadata', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const context = contextFor({
        deriveText: async () => {
          throw new Error('secret path /data/report.xlsx');
        },
      });

      await expect(context.derive(xlsx)).resolves.toEqual({
        status: 'skipped',
        reason: 'storage_unavailable',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        '[readingText] file_id=xlsx outcome=skipped reason=derivation_error',
        { type: 'Error' },
      );
      expect(context.stats().derived).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe('persistence', () => {
    const derived: DerivedText = {
      status: 'derived',
      text: 'quarter,total\nQ1,42',
      textDerivation: { outcome: 'complete', extractor: 'document_parser', at: 1 },
    };
    const persister = () =>
      jest.fn<ReturnType<TextDerivationPersister>, Parameters<TextDerivationPersister>>(
        async () => true,
      );

    it.each([
      ['automatic', { llmDeliveryPolicy: 'automatic' as const }],
      ['classic', {}],
    ])(
      'saves text derived for a marked record once, under the %s policy',
      async (_policy, endpointConfig) => {
        const persistDerivation = persister();
        const context = contextFor({
          routing: routingFor('openAI', endpointConfig),
          deriveText: async () => derived,
          persistDerivation,
        });

        await Promise.all([context.derive(xlsx), context.derive({ ...xlsx })]);
        await context.flush();

        expect(persistDerivation).toHaveBeenCalledTimes(1);
        expect(persistDerivation).toHaveBeenCalledWith({
          file_id: 'xlsx',
          text: derived.text,
          textDerivation: derived.textDerivation,
        });
      },
    );

    it('saves a deterministic failure as a marker alone, and nothing it may not keep', async () => {
      const outcomes: Record<string, DerivedText> = {
        parser: {
          status: 'failed',
          textDerivation: { outcome: 'failed', reason: 'parser' },
          persist: true,
        },
        transient: {
          status: 'failed',
          textDerivation: { outcome: 'failed', reason: 'extractor_unavailable' },
          persist: false,
        },
        skipped: { status: 'skipped', reason: 'storage_unavailable' },
      };
      const persistDerivation = persister();
      const context = contextFor({
        deriveText: async (file) => outcomes[file.file_id],
        persistDerivation,
      });

      await Promise.all(
        Object.keys(outcomes).map((file_id) => context.derive({ ...xlsx, file_id })),
      );
      await context.flush();

      expect(persistDerivation).toHaveBeenCalledTimes(1);
      const [[update]] = persistDerivation.mock.calls;
      expect(update).toEqual({
        file_id: 'parser',
        textDerivation: { outcome: 'failed', reason: 'parser' },
      });
      expect(update).not.toHaveProperty('text');
    });

    it('caches text derived for an unmarked original and never for a settled record', async () => {
      const persistDerivation = persister();
      const context = contextFor({ deriveText: async () => derived, persistDerivation });
      const unmarked = attachment({ file_id: 'pdf' });
      const settled = {
        ...xlsx,
        file_id: 'settled',
        metadata: { textDerivation: derived.textDerivation },
      };

      await Promise.all([context.derive(unmarked), context.derive(settled)]);
      await context.flush();

      expect(persistDerivation).toHaveBeenCalledTimes(1);
      expect(persistDerivation).toHaveBeenCalledWith({
        file_id: 'pdf',
        text: derived.text,
        textDerivation: derived.textDerivation,
      });
    });

    it('keeps a failed marker only on a record the automatic policy deferred', async () => {
      const persistDerivation = persister();
      const failure: DerivedText = {
        status: 'failed',
        textDerivation: { outcome: 'failed', reason: 'parser' },
        persist: true,
      };
      const context = contextFor({ deriveText: async () => failure, persistDerivation });

      await context.derive(attachment({ file_id: 'pdf' }));
      await context.flush();

      expect(persistDerivation).not.toHaveBeenCalled();
    });

    it('forgets an aborted derivation so a later caller derives again', async () => {
      const deriveText = jest
        .fn(async (): Promise<DerivedText> => derived)
        .mockResolvedValueOnce({ status: 'skipped', reason: 'aborted' });
      const context = contextFor({ deriveText });

      await expect(context.derive(xlsx)).resolves.toEqual({ status: 'skipped', reason: 'aborted' });
      await expect(context.derive(xlsx)).resolves.toBe(derived);
      expect(deriveText).toHaveBeenCalledTimes(2);
    });

    it('writes nothing until the flush, so a caller saves only files that passed its checks', async () => {
      const persistDerivation = persister();
      const context = contextFor({ deriveText: async () => derived, persistDerivation });

      await context.derive(xlsx);
      await new Promise((resolve) => setImmediate(resolve));
      expect(persistDerivation).not.toHaveBeenCalled();

      await context.flush();
      expect(persistDerivation).toHaveBeenCalledTimes(1);
      await context.flush();
      expect(persistDerivation).toHaveBeenCalledTimes(1);
    });

    it('settles the flush only after pending derivations and their queued writes', async () => {
      let finishDerive: (() => void) | undefined;
      let finishWrite: ((saved: boolean) => void) | undefined;
      const context = contextFor({
        deriveText: () =>
          new Promise((resolve) => {
            finishDerive = () => resolve(derived);
          }),
        persistDerivation: () =>
          new Promise<boolean>((resolve) => {
            finishWrite = resolve;
          }),
      });
      void context.derive(xlsx);

      let flushed = false;
      const flushing = context.flush().then(() => {
        flushed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(finishDerive).toBeDefined();
      expect(finishWrite).toBeUndefined();
      expect(flushed).toBe(false);

      finishDerive?.();
      await new Promise((resolve) => setImmediate(resolve));
      expect(finishWrite).toBeDefined();
      expect(flushed).toBe(false);

      finishWrite?.(true);
      await flushing;
      expect(flushed).toBe(true);
      await expect(context.flush()).resolves.toBeUndefined();
    });

    it('logs a failed write with safe metadata and still settles the flush', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      try {
        const context = contextFor({
          deriveText: async () => derived,
          persistDerivation: async () => {
            throw new Error('mongodb://user:secret@db/files');
          },
        });

        await expect(context.derive(xlsx)).resolves.toBe(derived);
        await expect(context.flush()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
          '[readingText] file_id=xlsx outcome=complete persisted=failed',
          { type: 'Error' },
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('createDerivationPersister', () => {
    const update = {
      file_id: 'xlsx',
      text: 'quarter,total',
      textDerivation: { outcome: 'complete' as const, extractor: 'document_parser' as const },
    };
    const scope = { user: 'user-1', tenantId: 'tenant-1' };

    it('writes a file once for every agent context sharing it', async () => {
      const save = jest.fn<ReturnType<TextDerivationSave>, Parameters<TextDerivationSave>>(
        async () => true,
      );
      const persistDerivation = createDerivationPersister(save, scope);
      const deriveText: FileTextDeriver = async () => ({
        status: 'derived',
        text: update.text,
        textDerivation: update.textDerivation,
      });
      const primary = contextFor({ deriveText, persistDerivation });
      const handoff = contextFor({ deriveText, persistDerivation });

      await Promise.all([primary.derive(xlsx), handoff.derive({ ...xlsx })]);
      await Promise.all([primary.flush(), handoff.flush()]);

      expect(save).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledWith(update, scope);
    });

    it('forgets a failed write, so a later context tries again', async () => {
      const save = jest
        .fn<ReturnType<TextDerivationSave>, Parameters<TextDerivationSave>>()
        .mockRejectedValueOnce(new Error('write conflict'))
        .mockResolvedValueOnce(true);
      const persistDerivation = createDerivationPersister(save, scope);

      await expect(persistDerivation(update)).rejects.toThrow('write conflict');
      await expect(persistDerivation(update)).resolves.toBe(true);
      await expect(persistDerivation(update)).resolves.toBe(true);
      expect(save).toHaveBeenCalledTimes(2);
    });
  });
});

describe('deriveRequestedText', () => {
  const workbook = attachment({
    file_id: 'xlsx',
    type: XLSX,
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
  });

  it('derives once through the first context that asked and returns the text by file id', async () => {
    const firstDeriver = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(
      async () => ({
        status: 'derived',
        text: 'a,b',
        textDerivation: { outcome: 'complete', extractor: 'document_parser' },
      }),
    );
    const secondDeriver = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>();
    const first = contextFor({ deriveText: firstDeriver });
    const second = contextFor({ deriveText: secondDeriver });

    const texts = await deriveRequestedText([{ file: workbook, contexts: [first, second] }]);

    expect(texts.get('xlsx')).toMatchObject({ status: 'derived', text: 'a,b' });
    expect(firstDeriver).toHaveBeenCalledTimes(1);
    expect(secondDeriver).not.toHaveBeenCalled();
    expect(second.judge(workbook).textFailed).toBeUndefined();
  });

  it('throws the policy error of derived text a content policy refuses', async () => {
    const error = new UninspectableFileError('extracted_text');
    const context = contextFor({ deriveText: async () => ({ status: 'blocked', error }) });

    await expect(deriveRequestedText([{ file: workbook, contexts: [context] }])).rejects.toBe(
      error,
    );
  });

  it('marks a file left without text failed on every context that asked', async () => {
    const first = contextFor({
      deriveText: async () => ({ status: 'skipped', reason: 'storage_unavailable' }),
    });
    const second = contextFor({ routing: routingFor('openAI', {}), deriveText: jest.fn() });

    const texts = await deriveRequestedText([{ file: workbook, contexts: [first, second] }]);

    expect(texts.size).toBe(0);
    expect(first.judge(workbook).textFailed).toBe(true);
    expect(second.judge(workbook).textFailed).toBe(true);
  });
});

describe('needsDerivedText', () => {
  it('decides only marked records for a derive-only classic context', () => {
    const routing = routingFor('openAI', {});
    const context = contextFor({ routing, deriveText: jest.fn() });
    routing.reading = context;
    const consumers = { executeCode: false, fileSearch: false };
    const marked = attachment({
      file_id: 'marked',
      type: XLSX,
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
    });
    const unmarked = { ...marked, file_id: 'unmarked', metadata: { destinationChosen: false } };

    expect(needsDerivedText(marked, { routing, consumers, context })).toBe(true);
    expect(needsDerivedText(unmarked, { routing, consumers, context })).toBe(false);
  });
});
