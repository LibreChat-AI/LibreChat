import { FileContext, FileSources, decideFileReading } from 'librechat-data-provider';
import type { TFileConfig, TurnFileConsumers, TurnDeliveryRouting } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { TurnAttachmentsWithHistoryParams, HistoryAllocationFile } from './history';
import type { FileTextDeriver, TurnReadingContext } from './turn';
import {
  isModelBoundAttachmentFile,
  assertAgentAttachmentLimits,
  collectHistoricalAttachmentIds,
} from '~/agents/attachments';
import {
  allocateTurnAttachmentsWithHistory,
  allocateTurnAttachmentsWithRetainedContext,
} from './history';
import { applyTurnDelivery, resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { buildTurnReadingContext } from './turn';

type EndpointFileConfigInput = NonNullable<TFileConfig['endpoints']>[string];
type AllocationParams = TurnAttachmentsWithHistoryParams<HistoryAllocationFile>;

const MB = 1024 * 1024;
const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ENDPOINT = 'openAI';

const noReader: TurnFileConsumers = { executeCode: false, fileSearch: false };
const searchOnly: TurnFileConsumers = { executeCode: false, fileSearch: true };

const attachment = (
  overrides: Partial<HistoryAllocationFile> & Pick<HistoryAllocationFile, 'file_id'>,
): HistoryAllocationFile => ({
  type: PDF,
  bytes: 3 * MB,
  source: FileSources.local,
  context: FileContext.message_attachment,
  llmDeliveryPath: 'provider',
  metadata: { destinationChosen: false },
  ...overrides,
});

const workbook = (file_id: string, text: string): HistoryAllocationFile =>
  attachment({ file_id, type: XLSX, bytes: 1024, llmDeliveryPath: 'text', text });

interface Turn {
  agent: AllocationParams['agent'];
  req: NonNullable<AllocationParams['req']>;
  routing: TurnDeliveryRouting;
  context: TurnReadingContext;
}

function setup({
  endpointConfig = { llmDeliveryPolicy: 'automatic' },
  fileConfig = {},
  consumers = searchOnly,
  deriveText,
}: {
  endpointConfig?: EndpointFileConfigInput;
  fileConfig?: Omit<TFileConfig, 'endpoints'>;
  consumers?: TurnFileConsumers;
  deriveText?: FileTextDeriver;
} = {}): Turn {
  const appConfig: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    fileConfig: { ...fileConfig, endpoints: { [ENDPOINT]: endpointConfig } },
  };
  const routing = resolveTurnDeliveryRouting({
    agent: { provider: ENDPOINT, endpoint: ENDPOINT },
    config: appConfig,
  });
  const context = buildTurnReadingContext({
    routing,
    provider: ENDPOINT,
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
  return {
    agent: { id: 'agent_1', deliveryRouting: routing, fileConsumers: consumers },
    req: { config: appConfig },
    routing,
    context,
  };
}

const allocate = (
  { agent, req }: Turn,
  historical: readonly HistoryAllocationFile[],
  current: HistoryAllocationFile[],
): Promise<HistoryAllocationFile[]> =>
  allocateTurnAttachmentsWithHistory({ agent, req, historical, current, endpoint: ENDPOINT });

const pathsById = (
  files: readonly HistoryAllocationFile[],
): Record<string, string | null | undefined> =>
  Object.fromEntries(files.map((file) => [file.file_id, file.llmDeliveryPath]));

/** The check AgentClient's `assertTurnAttachmentLimits` runs on the shared set. */
const assertTurnLimits = (
  { req }: Turn,
  historical: readonly HistoryAllocationFile[],
  current: readonly HistoryAllocationFile[],
) =>
  assertAgentAttachmentLimits({
    attachments: [...historical, ...current.filter(isModelBoundAttachmentFile)],
    req,
    endpoint: ENDPOINT,
    countRepeatedExtractedText: true,
    enforceAttachmentCount: false,
    useGlobalContextSizeLimit: true,
  });

/** The check the topology assertion runs on the same set for the primary agent. */
const assertAgentLimits = (
  { req }: Turn,
  historical: readonly HistoryAllocationFile[],
  current: readonly HistoryAllocationFile[],
) =>
  assertAgentAttachmentLimits({
    attachments: [...historical, ...current.filter(isModelBoundAttachmentFile)],
    req,
    endpoint: ENDPOINT,
    countRepeatedExtractedText: true,
    historicalFileIds: collectHistoricalAttachmentIds(historical, current),
  });

describe('allocateTurnAttachmentsWithHistory', () => {
  describe('outside the automatic policy', () => {
    interface ClassicTurn {
      agent: AllocationParams['agent'];
      req?: AllocationParams['req'];
      context?: TurnReadingContext;
    }

    it.each<[string, () => ClassicTurn]>([
      [
        'the routing carries no reading context',
        () => {
          const routing = resolveTurnDeliveryRouting({
            agent: { provider: ENDPOINT, endpoint: ENDPOINT },
            config: {
              fileConfig: {
                fileContextSizeLimit: 1,
                endpoints: { [ENDPOINT]: { llmDeliveryPolicy: 'automatic' } },
              },
            },
          });
          return { agent: { deliveryRouting: routing, fileConsumers: searchOnly } };
        },
      ],
      [
        'the policy is classic',
        () => {
          const turn = setup({
            endpointConfig: {},
            fileConfig: { fileContextSizeLimit: 1 },
            deriveText: async () => ({ status: 'skipped', reason: 'no_extractor' }),
          });
          expect(turn.context.policy).toBe('classic');
          return turn;
        },
      ],
    ])(
      'returns the current files themselves when %s, asking its context nothing',
      async (_case, arrange) => {
        const { agent, req, context } = arrange();
        const methods = [
          'judge',
          'derive',
          'addOverflow',
          'markTextFailed',
          'flush',
          'knownTokenCount',
        ] as const;
        const spies = context == null ? [] : methods.map((method) => jest.spyOn(context, method));
        const current = [attachment({ file_id: 'a' }), attachment({ file_id: 'b' })];

        const allocated = await allocateTurnAttachmentsWithHistory({
          agent,
          req,
          historical: [attachment({ file_id: 'history', bytes: 6 * MB })],
          current,
          endpoint: ENDPOINT,
        });

        expect(allocated).toBe(current);
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe('under the automatic policy', () => {
    const history = attachment({ file_id: 'history', bytes: 6 * MB });
    const current = (): HistoryAllocationFile[] => [
      attachment({ file_id: 'a' }),
      attachment({ file_id: 'b' }),
    ];

    it('charges history first, so a current PDF that no longer fits moves to File Search', async () => {
      const turn = setup({ fileConfig: { fileContextSizeLimit: 10 } });
      const { routing, context } = turn;
      const historyBefore = structuredClone(history);
      const files = current();
      expect(() => assertTurnLimits(turn, [history], files)).toThrow(
        expect.objectContaining({ limitType: 'bytes' }),
      );

      const allocated = await allocate(turn, [history], files);

      expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'none' });
      expect(
        decideFileReading({ routing, file: allocated[1], consumers: searchOnly }),
      ).toMatchObject({ reader: 'search', reason: 'aggregate_overflow' });
      expect(allocated[0]).toBe(files[0]);
      expect(context.stats().overflow).toBe(1);
      expect(() => assertTurnLimits(turn, [history], allocated)).not.toThrow();
      expect(() => assertAgentLimits(turn, [history], allocated)).not.toThrow();
      expect(history).toEqual(historyBefore);
      expect(context.judge(history).overflow).toBeUndefined();
      expect(decideFileReading({ routing, file: history, consumers: searchOnly })).toMatchObject({
        reader: 'provider',
      });
    });

    it('admits the same request in full without the history in front of it', async () => {
      const turn = setup({ fileConfig: { fileContextSizeLimit: 10 } });
      const files = current();

      const allocated = await allocate(turn, [], files);

      expect(allocated).toBe(files);
      expect(turn.context.stats().overflow).toBe(0);
    });

    it('leaves the overflow unavailable rather than failing the turn when File Search cannot reach it', async () => {
      /* File Search queued and registered nothing, as a failed provisioning leaves it, and no
       * code tool is loaded, so no reader is left for the overflow. */
      const turn = setup({ fileConfig: { fileContextSizeLimit: 10 } });
      turn.context.setSearchEvidence({ queued: [], registered: [] });

      const allocated = await allocate(turn, [history], current());

      expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'none' });
      expect(
        decideFileReading({ routing: turn.routing, file: allocated[1], consumers: searchOnly }),
      ).toMatchObject({ reader: 'unavailable', reason: 'aggregate_overflow' });
      expect(() => assertTurnLimits(turn, [history], allocated)).not.toThrow();
    });

    it('keeps the current files on their classic route when no file tool is loaded, so the limit check still fails the turn', async () => {
      const turn = setup({ fileConfig: { fileContextSizeLimit: 10 }, consumers: noReader });
      const files = current();

      const allocated = await allocate(turn, [history], files);

      expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'provider' });
      expect(turn.context.stats().overflow).toBe(0);
      expect(
        decideFileReading({ routing: turn.routing, file: allocated[1], consumers: noReader }),
      ).toMatchObject({ reader: 'provider', reason: 'no_file_tools', automatic: false });
      expect(() => assertTurnLimits(turn, [history], allocated)).toThrow(
        expect.objectContaining({ limitType: 'bytes' }),
      );
    });

    it('moves a text reading that no longer fits the extracted-text budget', async () => {
      const turn = setup({ fileConfig: { fileContextCharLimit: 100 } });
      const replayed = workbook('replayed', 'r'.repeat(70));
      const sheet = workbook('sheet', 's'.repeat(40));
      expect(
        decideFileReading({ routing: turn.routing, file: sheet, consumers: searchOnly }),
      ).toMatchObject({ reader: 'text' });

      const allocated = await allocate(turn, [replayed], [sheet]);

      expect(pathsById(allocated)).toEqual({ sheet: 'none' });
      expect(
        decideFileReading({ routing: turn.routing, file: allocated[0], consumers: searchOnly }),
      ).toMatchObject({ reader: 'search', reason: 'aggregate_overflow' });
      expect(() => assertTurnLimits(turn, [replayed], allocated)).not.toThrow();
    });

    it.each([
      ['replayed', (file: HistoryAllocationFile) => ({ historical: [file], files: current() })],
      [
        'submitted',
        (file: HistoryAllocationFile) => ({ historical: [], files: [file, ...current()] }),
      ],
    ])('does not charge a %s file this endpoint refuses', async (_label, arrange) => {
      const turn = setup({
        endpointConfig: {
          llmDeliveryPolicy: 'automatic',
          supportedMimeTypes: ['^application/pdf$'],
        },
        fileConfig: { fileContextSizeLimit: 10 },
      });
      const screenshot = attachment({ file_id: 'screenshot', type: 'image/png', bytes: 6 * MB });
      const { historical, files } = arrange(screenshot);

      const allocated = await allocate(turn, historical, files);

      expect(allocated).toBe(files);
      expect(turn.context.stats().overflow).toBe(0);
    });

    it('does not charge replayed history that is no longer model-bound', async () => {
      const turn = setup({ fileConfig: { fileContextSizeLimit: 10 } });
      const searched = attachment({ file_id: 'searched', bytes: 6 * MB, llmDeliveryPath: 'none' });
      const files = current();

      expect(await allocate(turn, [searched], files)).toBe(files);
    });

    describe('count allowance', () => {
      const countLimited = () =>
        setup({ endpointConfig: { llmDeliveryPolicy: 'automatic', fileLimit: 2 } });
      const small = (file_id: string): HistoryAllocationFile =>
        attachment({ file_id, bytes: 1024 });

      it('spends no count allowance on replayed history', async () => {
        const turn = countLimited();
        const historical = ['h1', 'h2', 'h3'].map(small);
        const files = ['a', 'b', 'c'].map(small);

        const allocated = await allocate(turn, historical, files);

        expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'provider', c: 'none' });
        expect(() => assertAgentLimits(turn, historical, allocated)).not.toThrow();
        expect(() => assertAgentLimits(turn, historical, files)).toThrow(
          expect.objectContaining({ limitType: 'count' }),
        );
      });

      it('counts a replayed file submitted again once, as the current submission', async () => {
        const turn = countLimited();
        const historical = ['h1', 'a'].map(small);
        const files = ['a', 'b', 'c'].map(small);

        const allocated = await allocate(turn, historical, files);

        expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'provider', c: 'none' });
        expect(() => assertAgentLimits(turn, historical, allocated)).not.toThrow();
      });

      it('commits a resubmitted file with its history rather than moving it', async () => {
        const turn = countLimited();
        const historical = ['h1', 'c'].map(small);
        const files = ['a', 'b', 'c'].map(small);

        const allocated = await allocate(turn, historical, files);

        expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'none', c: 'provider' });
        expect(turn.context.stats().overflow).toBe(1);
        expect(() => assertAgentLimits(turn, historical, allocated)).not.toThrow();
        expect(
          decideFileReading({ routing: turn.routing, file: historical[1], consumers: searchOnly })
            .reader,
        ).toBe('provider');
      });
    });

    it('hands the moved files to the caller, and nothing when none moved', async () => {
      const turn = setup({ fileConfig: { fileContextSizeLimit: 4 } });
      const onAllocated = jest.fn();
      const files = current();

      const allocated = await allocateTurnAttachmentsWithHistory({
        ...turn,
        historical: [],
        current: files,
        endpoint: ENDPOINT,
        onAllocated,
      });
      const fitting = [attachment({ file_id: 'small', bytes: MB })];
      const unchanged = await allocateTurnAttachmentsWithHistory({
        ...setup(),
        historical: [],
        current: fitting,
        endpoint: ENDPOINT,
        onAllocated,
      });

      expect(onAllocated.mock.calls).toEqual([[allocated]]);
      expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'none' });
      expect(unchanged).toBe(fitting);
    });

    it('holds the shared set to a secondary agent endpoint with a tighter count', async () => {
      const appConfig: AppConfig = {
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'png',
        fileConfig: {
          endpoints: {
            [ENDPOINT]: { llmDeliveryPolicy: 'automatic', fileLimit: 10 },
            anthropic: { fileLimit: 1 },
          },
        },
      };
      const turn = setup();
      const req = { config: appConfig };
      const endpointsByAgentId = new Map([
        ['agent_1', { endpoint: ENDPOINT }],
        ['agent_2', { endpoint: 'anthropic' }],
      ]);
      const files = ['a', 'b'].map((file_id) => attachment({ file_id, bytes: 1024 }));
      /** The per-agent check the topology assertion runs for the secondary agent. */
      const assertSecondary = (shared: readonly HistoryAllocationFile[]) =>
        assertAgentAttachmentLimits({
          attachments: shared.filter(isModelBoundAttachmentFile),
          req,
          endpoint: 'anthropic',
          countRepeatedExtractedText: true,
        });

      const allocated = await allocateTurnAttachmentsWithHistory({
        agent: turn.agent,
        req,
        historical: [],
        current: files,
        endpoint: ENDPOINT,
        endpointsByAgentId,
      });

      expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'none' });
      expect(() => assertSecondary(allocated)).not.toThrow();
      expect(() => assertSecondary(files)).toThrow(expect.objectContaining({ limitType: 'count' }));
    });

    describe('against retained file contexts', () => {
      const retainedContext = (text: string): HistoryAllocationFile => ({
        file_id: 'retained-file-context:msg-1',
        source: FileSources.text,
        type: 'text/plain',
        text,
        bytes: Buffer.byteLength(text),
      });

      it('moves a text reading that no longer fits beside the retained text', async () => {
        const turn = setup({ fileConfig: { fileContextCharLimit: 1000 } });
        const retained = [retainedContext('r'.repeat(500))];
        const files = [workbook('sheet', 's'.repeat(600))];

        const allocated = await allocateTurnAttachmentsWithRetainedContext({
          ...turn,
          resendFiles: false,
          retained,
          current: files,
          endpoint: ENDPOINT,
        });

        expect(pathsById(allocated)).toEqual({ sheet: 'none' });
        expect(() => assertTurnLimits(turn, retained, allocated)).not.toThrow();
        expect(() => assertTurnLimits(turn, retained, files)).toThrow(
          expect.objectContaining({ limitType: 'extracted_text' }),
        );
      });

      it('leaves the request alone when the conversation resends files', async () => {
        const turn = setup({ fileConfig: { fileContextCharLimit: 1000 } });
        const files = [workbook('sheet', 's'.repeat(600))];

        await expect(
          allocateTurnAttachmentsWithRetainedContext({
            ...turn,
            resendFiles: true,
            retained: [retainedContext('r'.repeat(500))],
            current: files,
            endpoint: ENDPOINT,
          }),
        ).resolves.toBe(files);
        expect(turn.context.stats().overflow).toBe(0);
      });
    });

    it('depends on the current order alone, not on the order of the history', async () => {
      const historical = ['h1', 'h2', 'h3'].map((file_id) =>
        attachment({ file_id, bytes: 2 * MB }),
      );
      const run = async (
        replay: readonly HistoryAllocationFile[],
        files: HistoryAllocationFile[],
      ) => {
        const turn = setup({ fileConfig: { fileContextSizeLimit: 10 } });
        return pathsById(await allocate(turn, replay, files));
      };
      const [a, b] = current();

      const expected = { a: 'provider', b: 'none' };
      expect(await run(historical, [a, b])).toEqual(expected);
      expect(await run([...historical].reverse(), [a, b])).toEqual(expected);
      expect(await run([historical[1], historical[2], historical[0]], [a, b])).toEqual(expected);
      expect(await run(historical, [b, a])).toEqual({ a: 'none', b: 'provider' });
    });

    describe('limits', () => {
      it('holds the shared set to the global limits the turn check enforces', async () => {
        const turn = setup({
          endpointConfig: { llmDeliveryPolicy: 'automatic', fileLimit: 4 },
          fileConfig: { fileContextSizeLimit: 10, fileContextCharLimit: 500 },
        });
        const exact = 10 * MB - 7 * MB;
        const historical = [attachment({ file_id: 'history', bytes: 7 * MB })];
        const files = [
          attachment({ file_id: 'exact', bytes: exact }),
          attachment({ file_id: 'byte', bytes: 1 }),
        ];

        const allocated = await allocate(turn, historical, files);

        expect(pathsById(allocated)).toEqual({ exact: 'provider', byte: 'none' });
        expect(assertTurnLimits(turn, historical, allocated).totalKnownBytes).toBe(10 * MB);
        expect(() => assertTurnLimits(turn, historical, files)).toThrow(
          expect.objectContaining({ limitType: 'bytes', limit: 10 * MB }),
        );
      });

      it('holds the shared set to a tighter aggregate the agent endpoint configures', async () => {
        const turn = setup({
          endpointConfig: { llmDeliveryPolicy: 'automatic', totalSizeLimit: 8 },
          fileConfig: { fileContextSizeLimit: 10 },
        });
        const historical = [attachment({ file_id: 'history', bytes: 4 * MB })];
        const files = [attachment({ file_id: 'a' }), attachment({ file_id: 'b', bytes: 2 * MB })];

        const allocated = await allocate(turn, historical, files);

        expect(pathsById(allocated)).toEqual({ a: 'provider', b: 'none' });
        expect(() => assertAgentLimits(turn, historical, allocated)).not.toThrow();
        expect(() => assertAgentLimits(turn, historical, files)).toThrow(
          expect.objectContaining({ limitType: 'bytes', limit: 8 * MB }),
        );
      });
    });

    it('returns copies decided by the turn routing for files it did not move', async () => {
      const turn = setup({ fileConfig: { fileContextSizeLimit: 10 } });
      const stale = attachment({ file_id: 'stale', bytes: MB, llmDeliveryPath: 'text' });

      const allocated = await allocate(turn, [], [stale]);

      expect(allocated).toEqual(
        applyTurnDelivery([stale], { routing: turn.routing, consumers: searchOnly }),
      );
      expect(allocated[0].llmDeliveryPath).toBe('provider');
    });
  });
});
