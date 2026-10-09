import { FileContext, FileSources } from 'librechat-data-provider';
import type {
  TurnReadingInputs,
  TurnFileConsumers,
  TurnDeliveryFile,
  ReadingEvidence,
  FiltersConfig,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type {
  DerivedText,
  FileTextDeriver,
  TurnReadingFile,
  TextDerivationPersister,
} from '~/files/reading/turn';
import {
  applyTurnDelivery as materializeTurnDelivery,
  prepareScopedTurnCandidates,
  resolveScopedTurnAttachments,
  resolveTurnDeliveryRouting,
  toClassicInspectionView,
  applyCheckpointDelivery,
} from './delivery';
import * as modelBoundContent from '~/middleware/modelBoundContent';
import { buildTurnReadingContext } from '~/files/reading/turn';
import { UninspectableFileError } from '~/protection/files';

function applyTurnDelivery<T extends TurnDeliveryFile>(
  files: T[],
  {
    agent,
    config,
    consumers,
  }: {
    agent?: Parameters<typeof resolveTurnDeliveryRouting>[0]['agent'];
    config?: Parameters<typeof resolveTurnDeliveryRouting>[0]['config'];
    consumers?: TurnFileConsumers;
  },
) {
  return materializeTurnDelivery(files, {
    routing: agent ? resolveTurnDeliveryRouting({ agent, config }) : undefined,
    consumers,
  });
}

const config = {
  fileConfig: {
    endpoints: {
      openAI: {
        defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' as const } },
        textFallbackWithoutTools: true,
      },
    },
  },
};
const noReader: TurnFileConsumers = { executeCode: false, fileSearch: false };
const runsCode: TurnFileConsumers = { executeCode: true, fileSearch: false };

/** A tool serves a file only once it holds it, so a record left to the sandbox needs the
 *  reference provisioning writes for that tool to count as its reader. */
const inSandbox = <T extends { metadata?: Record<string, unknown> }>(file: T): T => ({
  ...file,
  metadata: {
    ...file.metadata,
    codeEnvRef: {
      kind: 'user' as const,
      id: 'user_1',
      storage_session_id: 'session_1',
      file_id: 'sandbox_file_1',
    },
  },
});

describe('resolveTurnDeliveryRouting', () => {
  it('routes under the endpoint an agent names before its provider', () => {
    expect(resolveTurnDeliveryRouting({ agent: { provider: 'openAI' }, config }).endpoint).toBe(
      'openAI',
    );
    expect(
      resolveTurnDeliveryRouting({
        agent: { provider: 'openAI', endpoint: 'Azure Foundry' },
        config,
      }).endpoint,
    ).toBe('Azure Foundry');
  });

  it('reads a custom endpoint dialect as upload does, before and after the provider swap', () => {
    /* Initialization first stores the endpoint name in both fields and only later replaces the
     * provider with the backing client, so the dialect has to come from config either way. */
    const declared = {
      ...config,
      endpoints: {
        custom: [{ name: 'MyClaude', provider: 'anthropic' }],
      },
    } as Parameters<typeof resolveTurnDeliveryRouting>[0]['config'];
    const dialect = (agent: { provider: string; endpoint?: string }, routingConfig = declared) =>
      resolveTurnDeliveryRouting({ agent, config: routingConfig }).endpointProvider;

    expect(dialect({ provider: 'MyClaude', endpoint: 'MyClaude' })).toBe('anthropic');
    expect(dialect({ provider: 'anthropic', endpoint: 'MyClaude' })).toBe('anthropic');
    expect(dialect({ provider: 'MyGateway', endpoint: 'MyGateway' }, config)).toBeUndefined();
    expect(dialect({ provider: 'openAI', endpoint: 'MyGateway' }, config)).toBeUndefined();
  });

  it('carries the agent Responses API choice into routing', () => {
    expect(
      resolveTurnDeliveryRouting({
        agent: { provider: 'openAI', model_parameters: { useResponsesApi: true } },
        config,
      }).useResponsesApi,
    ).toBe(true);
  });
});

describe('applyTurnDelivery', () => {
  const agent = { provider: 'openAI' };
  const csv = {
    file_id: 'csv',
    type: 'text/csv',
    text: 'region,total\nwest,4',
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false },
  };
  const pdf = { file_id: 'pdf', type: 'application/pdf', llmDeliveryPath: 'provider' };

  it('marks a copy of each file this turn delivers as text, leaving the rest untouched', () => {
    const result = applyTurnDelivery([csv, pdf], { agent, config, consumers: noReader });

    expect(result[0]).toEqual({ ...csv, llmDeliveryPath: 'text' });
    expect(result[0]).not.toBe(csv);
    expect(result[1]).toBe(pdf);
    expect(csv.llmDeliveryPath).toBe('none');
  });

  it('returns the same array when a tool this turn runs holds every file', () => {
    const files = [inSandbox(csv), pdf];

    expect(applyTurnDelivery(files, { agent, config, consumers: runsCode })).toBe(files);
  });

  it('delivers text for a file File Search has yet to receive', () => {
    /* An upload that named no destination is filed under no tool, so an enabled search tool
     * alone is not what serves it: withholding the text on that basis left it readable by
     * nothing. */
    const searchesFiles: TurnFileConsumers = { executeCode: false, fileSearch: true };
    expect(applyTurnDelivery([csv], { agent, config, consumers: searchesFiles })).toEqual([
      { ...csv, llmDeliveryPath: 'text' },
    ]);
  });

  it('leaves a file Run Code can read with Run Code before the sandbox holds it', () => {
    /* Run Code uploads the file on its first call. Delivering the text instead would count it
     * toward the turn's limits until that call, and a refused turn never makes it. */
    const files = [csv];
    expect(applyTurnDelivery(files, { agent, config, consumers: runsCode })).toBe(files);
  });

  it('marks nothing where the endpoint has not enabled the fallback', () => {
    const files = [csv];
    const disabled = {
      fileConfig: {
        endpoints: {
          openAI: { defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' as const } } },
        },
      },
    };

    expect(applyTurnDelivery(files, { agent, config: disabled, consumers: noReader })).toBe(files);
  });

  it('reads the opt-in under the custom endpoint an initialized agent names', () => {
    /* After initialization the provider is the backing client and the endpoint keeps the name
     * the upload resolved, so a setting made only on that endpoint still applies. */
    const files = [csv];
    const customOnly = {
      fileConfig: {
        endpoints: {
          MyGateway: {
            defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' as const } },
            textFallbackWithoutTools: true,
          },
        },
      },
    };

    expect(
      applyTurnDelivery(files, {
        agent: { provider: 'openAI', endpoint: 'MyGateway' },
        config: customOnly,
        consumers: noReader,
      }),
    ).toEqual([{ ...csv, llmDeliveryPath: 'text' }]);
  });

  it('marks a stored tool-routed file the endpoint now routes to text, with the fallback off', () => {
    /* Only this mark lets the admission checks and `extractFileContext`, which read the stored
     * route, see the text the resolver now delivers. */
    const rerouted = {
      fileConfig: {
        endpoints: {
          openAI: { defaultLLMDeliveryPath: { overrides: { 'text/csv': 'text' as const } } },
        },
      },
    };

    expect(applyTurnDelivery([csv], { agent, config: rerouted, consumers: runsCode })).toEqual([
      { ...csv, llmDeliveryPath: 'text' },
    ]);
    expect(applyTurnDelivery([csv], { agent, config: rerouted })).toEqual([
      { ...csv, llmDeliveryPath: 'text' },
    ]);
  });

  it('falls back only for a turn whose tools are known', () => {
    const files = [csv];

    expect(applyTurnDelivery(files, { agent, config })).toBe(files);
  });

  it('marks nothing without an agent to route by', () => {
    const files = [csv];

    expect(applyTurnDelivery(files, { config, consumers: noReader })).toBe(files);
  });

  it('leaves a record predating routing to its legacy handling', () => {
    const files = [{ file_id: 'legacy', type: 'text/csv', text: 'region,total' }];

    expect(applyTurnDelivery(files, { agent, config, consumers: noReader })).toBe(files);
  });

  it('does not mark a tool-routed file that stored no text', () => {
    const files = [{ ...csv, text: undefined }];

    expect(applyTurnDelivery(files, { agent, config, consumers: noReader })).toBe(files);
  });

  it('gives a stored tool-routed file the provider route this turn sends it by', () => {
    /* Admission would otherwise skip a record the client then encodes for the provider. */
    const image = {
      file_id: 'image',
      type: 'image/png',
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false },
    };

    expect(applyTurnDelivery([image], { agent, config, consumers: noReader })).toEqual([
      { ...image, llmDeliveryPath: 'provider' },
    ]);
  });

  it('removes a record this turn leaves to tools from model admission', () => {
    /* Over-admitting cannot pass a limit; dropping a record the client still sends would. */
    const held = inSandbox(csv);
    const files = [{ ...held, llmDeliveryPath: 'text' }];

    expect(applyTurnDelivery(files, { agent, config, consumers: runsCode })).toEqual([
      { ...held, llmDeliveryPath: 'none' },
    ]);
  });

  it('materializes a final text route even without stored text', () => {
    const files = [{ ...pdf, metadata: { destinationChosen: false } }];
    const pdfToText = {
      fileConfig: {
        endpoints: {
          openAI: { defaultLLMDeliveryPath: { overrides: { 'application/pdf': 'text' as const } } },
        },
      },
    };

    expect(applyTurnDelivery(files, { agent, config: pdfToText, consumers: noReader })).toEqual(
      files.map((file) => ({ ...file, llmDeliveryPath: 'text' })),
    );
  });

  it('does not mark a destination the user chose', () => {
    const files = [{ ...csv, metadata: { destinationChosen: true } }];

    expect(applyTurnDelivery(files, { agent, config, consumers: noReader })).toBe(files);
  });
});

describe('resolveScopedTurnAttachments', () => {
  const file = {
    file_id: 'csv',
    type: 'text/csv',
    text: 'sales,total',
    llmDeliveryPath: 'none' as const,
    metadata: { destinationChosen: false },
  };
  const routing = resolveTurnDeliveryRouting({ agent: { provider: 'openAI' }, config });
  const receiver = {
    agentId: 'handoff',
    agent: { deliveryRouting: routing, fileConsumers: noReader },
  };

  it.each([
    ['explicit destination', { ...file, metadata: { destinationChosen: true } }, routing],
    ['legacy destination', { ...file, llmDeliveryPath: undefined, metadata: undefined }, routing],
    [
      'disabled fallback',
      file,
      resolveTurnDeliveryRouting({
        agent: { provider: 'openAI' },
        config: {
          fileConfig: {
            endpoints: {
              openAI: { ...config.fileConfig.endpoints.openAI, textFallbackWithoutTools: false },
            },
          },
        },
      }),
    ],
  ])('preserves %s when a receiver has no reader', (_name, candidate, deliveryRouting) => {
    expect(
      resolveScopedTurnAttachments({
        agents: [{ ...receiver, agent: { ...receiver.agent, deliveryRouting } }],
        sharedConversationAgentIds: ['handoff'],
        messages: [],
        requestAttachments: [candidate],
        sharedRunAttachmentIds: new Set(),
      }).get('handoff'),
    ).toEqual([]);
  });

  it('ignores unhydrated and no-longer-retained history and deduplicates shared prompt files', () => {
    const stale = { ...file, file_id: 'stale' };
    const unhydrated = { file_id: 'unhydrated', text: 'untrusted' };
    expect(
      resolveScopedTurnAttachments({
        agents: [receiver],
        sharedConversationAgentIds: ['handoff'],
        messages: [{ files: [unhydrated, { file_id: 'csv' }] }],
        historicalFiles: new Map([
          [file.file_id, file],
          [stale.file_id, stale],
        ]),
        requestAttachments: [file],
        sharedRunAttachmentIds: new Set(['csv']),
      }).get('handoff'),
    ).toEqual([]);
  });
});

describe('the automatic policy', () => {
  const agent = { provider: 'openAI' };
  const automatic = {
    fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' as const } } },
  };
  /** The turn's evidence seam, answering every file with the same verdicts. */
  const withEvidence = (evidence: ReadingEvidence) => ({
    ...resolveTurnDeliveryRouting({ agent, config: automatic }),
    reading: { judge: () => evidence, canDerive: false } satisfies TurnReadingInputs,
  });
  const attachment = {
    source: FileSources.local,
    context: FileContext.message_attachment,
    metadata: { destinationChosen: false },
  };
  /** A PDF too large for the provider, with complete extracted text that fits the prompt. */
  const largePdf = {
    ...attachment,
    file_id: 'large-pdf',
    type: 'application/pdf',
    bytes: 40 * 1024 * 1024,
    text: 'quarterly totals',
    llmDeliveryPath: 'provider',
  };
  /** A spreadsheet extracted at upload under classic routing. */
  const csv = {
    ...attachment,
    file_id: 'csv',
    type: 'text/csv',
    bytes: 20,
    text: 'region,total\nwest,4',
    llmDeliveryPath: 'text',
  };

  describe('applyTurnDelivery', () => {
    it('gives a classic-era spreadsheet to Run Code and back to text without changing it', () => {
      const routing = withEvidence({});
      const files = [csv];

      expect(materializeTurnDelivery(files, { routing, consumers: runsCode })).toEqual([
        { ...csv, llmDeliveryPath: 'none' },
      ]);
      expect(materializeTurnDelivery(files, { routing, consumers: noReader })).toBe(files);
    });
  });

  describe('toClassicInspectionView', () => {
    const routing = withEvidence({});
    const strictContent = {
      files: { pii: { fields: ['content'], starterPatterns: [], uninspectable: 'block' } },
    } as FiltersConfig;

    it('shows a spreadsheet Run Code reads with the text route classic routing gives it', () => {
      const copies = materializeTurnDelivery([csv], { routing, consumers: runsCode });

      const view = toClassicInspectionView(copies, routing, runsCode);

      expect(view).toEqual([{ ...csv, llmDeliveryPath: 'text' }]);
      expect(view).not.toBe(copies);
      expect(copies).toEqual([{ ...csv, llmDeliveryPath: 'none' }]);
    });

    it('keeps the inspected content of a rerouted file under a fail-closed content filter', () => {
      /* Coverage reads the text route, so the code-routed copy alone would read as
       * uninspectable although classic routing inspects and delivers the same text. */
      const copies = materializeTurnDelivery([csv], { routing, consumers: runsCode });

      expect(() =>
        modelBoundContent.assertModelBoundContent({ filters: strictContent, files: copies }),
      ).toThrow(UninspectableFileError);
      expect(() =>
        modelBoundContent.assertModelBoundContent({
          filters: strictContent,
          files: toClassicInspectionView(copies, routing, runsCode),
        }),
      ).not.toThrow();
    });

    it('returns its input when no copy differs from its classic route', () => {
      const pdf = { ...largePdf, bytes: 20 };
      const copies = materializeTurnDelivery([pdf, csv], { routing, consumers: noReader });

      expect(toClassicInspectionView(copies, routing, noReader)).toBe(copies);
    });

    it('returns its input under classic routing', () => {
      const classic = resolveTurnDeliveryRouting({ agent, config });
      const copies = [{ ...csv, llmDeliveryPath: 'none' }];

      expect(toClassicInspectionView(copies, classic, runsCode)).toBe(copies);
      expect(toClassicInspectionView(copies, undefined, runsCode)).toBe(copies);
    });
  });
});

describe('applyCheckpointDelivery', () => {
  const agent = { provider: 'openAI' };
  const routing = resolveTurnDeliveryRouting({
    agent,
    config: { fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } } },
  });
  const csv = {
    file_id: 'csv',
    type: 'text/csv',
    bytes: 20,
    source: FileSources.local,
    context: FileContext.message_attachment,
    text: 'region,total\nwest,4',
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false },
  };
  /** A record written before uploads marked whether a destination was chosen. */
  const unmarked = { ...csv, file_id: 'unmarked', metadata: {} };

  it('charges retained fallback text for every inferred tool file under classic routing', () => {
    const classic = resolveTurnDeliveryRouting({ agent, config });

    expect(applyCheckpointDelivery([csv, unmarked])).toEqual([
      { ...csv, llmDeliveryPath: 'text' },
      { ...unmarked, llmDeliveryPath: 'text' },
    ]);
    expect(applyCheckpointDelivery([csv], { routing: classic, consumers: runsCode })).toEqual([
      { ...csv, llmDeliveryPath: 'text' },
    ]);
  });

  it('charges the automatic decision for files it reads and the fallback for the rest', () => {
    /* Text the policy withheld for Run Code never reached the checkpoint, so charging it would
     * spend the resumed turn's budget on content the model never received. */
    const charged = applyCheckpointDelivery([csv, unmarked], { routing, consumers: runsCode });

    expect(charged[0]).toBe(csv);
    expect(charged[1]).toEqual({ ...unmarked, llmDeliveryPath: 'text' });
    expect(applyCheckpointDelivery([csv], { routing, consumers: noReader })).toEqual([
      { ...csv, llmDeliveryPath: 'text' },
    ]);
    expect(csv.llmDeliveryPath).toBe('none');
  });
});

describe('prepareScopedTurnCandidates', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const automatic = {
    fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' as const } } },
  };
  const derived: DerivedText = {
    status: 'derived',
    text: 'quarter,total\nQ1,42',
    textDerivation: { outcome: 'complete', extractor: 'document_parser', at: 1 },
  };
  /** A workbook uploaded under the automatic policy with extraction left for a later turn. */
  const workbook = (file_id: string): TurnReadingFile => ({
    file_id,
    filename: `${file_id}.xlsx`,
    type: XLSX,
    bytes: 2048,
    source: FileSources.local,
    context: FileContext.message_attachment,
    llmDeliveryPath: 'none',
    metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
  });
  const historical = workbook('history-xlsx');
  const requested = workbook('request-xlsx');
  const messages = [{ files: [{ file_id: historical.file_id }] }];

  /** A receiver whose turn carries a reading context over the given deriver. */
  function receiver(
    agentId: string,
    {
      consumers = noReader,
      deriveText,
      persistDerivation,
      endpoint = 'openAI',
      config = automatic,
    }: {
      consumers?: TurnFileConsumers;
      deriveText?: FileTextDeriver;
      persistDerivation?: TextDerivationPersister;
      endpoint?: string;
      config?: Pick<AppConfig, 'fileConfig'>;
    } = {},
  ) {
    const deliveryRouting = resolveTurnDeliveryRouting({
      agent: { provider: endpoint },
      config,
    });
    const context = buildTurnReadingContext({
      routing: deliveryRouting,
      provider: endpoint,
      fileTokenLimit: 100_000,
      configuredFileSizeLimit: undefined,
      countTokens: (text) => text.length,
      deriveText,
      persistDerivation,
    });
    if (context == null) {
      throw new Error('expected a reading context');
    }
    deliveryRouting.reading = context;
    return { agentId, agent: { deliveryRouting, fileConsumers: consumers }, context };
  }

  const deriver = () =>
    jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(async () => derived);

  /** The app config a receiver's endpoint file policy is read from. */
  const appConfigWith = (fileConfig: AppConfig['fileConfig']): AppConfig => ({
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    fileConfig,
  });

  it('collects nothing when no receiver has a reading context', async () => {
    const historicalFiles = new Map([[historical.file_id, historical]]);
    const requestAttachments = [requested];
    const routing = resolveTurnDeliveryRouting({
      agent: { provider: 'openAI' },
      config: automatic,
    });

    const prepared = await prepareScopedTurnCandidates({
      agents: [
        { agentId: 'handoff', agent: { deliveryRouting: routing, fileConsumers: noReader } },
      ],
      historicalFiles,
      requestAttachments,
    });

    expect(prepared).toEqual({});
  });

  it('derives each candidate once for every receiver that needs its text', async () => {
    const firstDeriver = deriver();
    const secondDeriver = deriver();
    const persistDerivation = jest.fn<
      ReturnType<TextDerivationPersister>,
      Parameters<TextDerivationPersister>
    >(async () => true);
    const first = receiver('first', { deriveText: firstDeriver, persistDerivation });
    const second = receiver('second', { deriveText: secondDeriver });
    const flushSpy = jest.spyOn(first.context, 'flush');
    const inputs = {
      agents: [first, second],
      sharedConversationAgentIds: ['first', 'second'],
      messages,
      historicalFiles: new Map([[historical.file_id, historical]]),
      requestAttachments: [requested],
      sharedRunAttachmentIds: new Set<string>(),
    };

    const prepared = await prepareScopedTurnCandidates(inputs);

    expect(firstDeriver).toHaveBeenCalledTimes(2);
    expect(secondDeriver).not.toHaveBeenCalled();
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(persistDerivation.mock.calls.map(([update]) => update.file_id).sort()).toEqual([
      historical.file_id,
      requested.file_id,
    ]);
    expect(prepared.candidates?.get(historical.file_id)).toMatchObject({
      text: derived.text,
      metadata: { textDerivation: derived.textDerivation },
    });
    expect(prepared.candidates?.get(requested.file_id)).toMatchObject({ text: derived.text });
    expect(historical.text).toBeUndefined();
    expect(requested.text).toBeUndefined();

    const historyWalk = jest.spyOn(modelBoundContent, 'collectModelBoundHistoricalFileIdState');
    const scoped = resolveScopedTurnAttachments({ ...inputs, ...prepared });
    expect(historyWalk).not.toHaveBeenCalled();
    historyWalk.mockRestore();
    for (const agentId of ['first', 'second']) {
      expect(scoped.get(agentId)?.map((file) => [file.file_id, file.llmDeliveryPath])).toEqual([
        [historical.file_id, 'text'],
        [requested.file_id, 'text'],
      ]);
    }
  });

  it('derives nothing for a receiver that reads the candidates with Run Code', async () => {
    const deriveText = deriver();
    const historicalFiles = new Map([[historical.file_id, historical]]);
    const requestAttachments = [requested];

    const prepared = await prepareScopedTurnCandidates({
      agents: [receiver('handoff', { consumers: runsCode, deriveText })],
      historicalFiles,
      requestAttachments,
    });

    expect(deriveText).not.toHaveBeenCalled();
    expect(prepared.candidates?.get(historical.file_id)).toBe(historical);
    expect(prepared.candidates?.get(requested.file_id)).toBe(requested);
  });

  it('derives the workbook once for a parallel text reader while the primary uses code', async () => {
    const deriveText = deriver();
    const persistDerivation = jest.fn<
      ReturnType<TextDerivationPersister>,
      Parameters<TextDerivationPersister>
    >(async () => true);
    const primary = receiver('primary', { consumers: runsCode, deriveText, persistDerivation });
    const parallel = receiver('parallel', { deriveText, persistDerivation });
    const secondParallel = receiver('second-parallel', { deriveText, persistDerivation });
    const inputs = {
      agents: [primary, parallel, secondParallel],
      sharedConversationAgentIds: ['primary', 'parallel', 'second-parallel'],
      messages: [],
      requestAttachments: [requested],
      sharedRunAttachmentIds: new Set<string>(),
    };
    const prepared = await prepareScopedTurnCandidates(inputs);
    const scoped = resolveScopedTurnAttachments({ ...inputs, ...prepared });

    expect(scoped.get('primary')).toEqual([]);
    for (const agentId of ['parallel', 'second-parallel']) {
      expect(scoped.get(agentId)).toEqual([
        expect.objectContaining({
          file_id: requested.file_id,
          llmDeliveryPath: 'text',
          text: derived.text,
        }),
      ]);
    }
    expect(deriveText).toHaveBeenCalledTimes(1);
    expect(persistDerivation).toHaveBeenCalledTimes(1);
    expect(persistDerivation).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: requested.file_id,
        text: derived.text,
        textDerivation: derived.textDerivation,
      }),
    );
    expect(requested.text).toBeUndefined();
    expect(requested.metadata?.textDerivation?.outcome).toBe('deferred');
  });

  it('decides only what each receiver can be offered', async () => {
    const deriveText = deriver();
    const outsideDeriver = deriver();
    const scopedFile = workbook('scoped-xlsx');
    const stale = workbook('stale-xlsx');

    const prepared = await prepareScopedTurnCandidates({
      agents: [
        receiver('handoff', { deriveText }),
        receiver('subagent', { deriveText: outsideDeriver }),
      ],
      sharedConversationAgentIds: ['handoff'],
      messages,
      historicalFiles: new Map([
        [historical.file_id, historical],
        [stale.file_id, stale],
      ]),
      requestAttachments: [requested, scopedFile],
      sharedRunAttachmentIds: new Set([historical.file_id]),
      attachmentsByAgentId: { handoff: [scopedFile] },
    });

    expect(outsideDeriver).not.toHaveBeenCalled();
    expect(deriveText.mock.calls.map(([file]) => file.file_id)).toEqual([requested.file_id]);
    expect(prepared.candidates?.get(requested.file_id)?.text).toBe(derived.text);
    expect(prepared.candidates?.get(scopedFile.file_id)).toBe(scopedFile);
  });

  it('derives nothing for a receiver whose endpoint refuses the candidate', async () => {
    const fileConfig = {
      endpoints: {
        openAI: { llmDeliveryPolicy: 'automatic' as const, disabled: true },
        anthropic: {
          llmDeliveryPolicy: 'automatic' as const,
          supportedMimeTypes: ['^application/pdf$'],
        },
      },
    };
    const appConfig = appConfigWith(fileConfig);
    const disabledDeriver = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(
      async () => ({ status: 'blocked', error: new UninspectableFileError('extracted_text') }),
    );
    const allowlistDeriver = deriver();

    const prepared = await prepareScopedTurnCandidates({
      agents: [
        receiver('disabled', { deriveText: disabledDeriver, config: { fileConfig } }),
        receiver('allowlist', {
          deriveText: allowlistDeriver,
          endpoint: 'anthropic',
          config: { fileConfig },
        }),
      ],
      appConfig,
      endpointsByAgentId: new Map([['allowlist', { endpointType: null }]]),
      requestAttachments: [requested],
    });

    expect(disabledDeriver).not.toHaveBeenCalled();
    expect(allowlistDeriver).not.toHaveBeenCalled();
    expect(prepared.candidates?.get(requested.file_id)).toBe(requested);
  });

  it('still derives for a receiver whose endpoint accepts the candidate', async () => {
    const fileConfig = {
      endpoints: {
        openAI: {
          llmDeliveryPolicy: 'automatic' as const,
          supportedMimeTypes: [`^${XLSX}$`],
        },
      },
    };
    const deriveText = deriver();

    const prepared = await prepareScopedTurnCandidates({
      agents: [receiver('handoff', { deriveText, config: { fileConfig } })],
      appConfig: appConfigWith(fileConfig),
      requestAttachments: [requested],
    });

    expect(deriveText).toHaveBeenCalledTimes(1);
    expect(prepared.candidates?.get(requested.file_id)?.text).toBe(derived.text);
  });

  it('marks the text failed on every receiver that needed it, so each moves on', async () => {
    const first = receiver('first', {
      deriveText: async () => ({
        status: 'failed',
        textDerivation: { outcome: 'failed', reason: 'parser' },
        persist: true,
      }),
    });
    const second = receiver('second', { deriveText: deriver() });
    const inputs = {
      agents: [first, second],
      sharedConversationAgentIds: ['first', 'second'],
      messages: [],
      requestAttachments: [requested],
      sharedRunAttachmentIds: new Set<string>(),
    };

    const prepared = await prepareScopedTurnCandidates(inputs);

    expect(prepared.candidates?.get(requested.file_id)).toBe(requested);
    expect(first.context.judge(requested).textFailed).toBe(true);
    expect(second.context.judge(requested).textFailed).toBe(true);
    const scoped = resolveScopedTurnAttachments({ ...inputs, ...prepared });
    expect(scoped.get('first')).toEqual([]);
    expect(scoped.get('second')).toEqual([]);
  });
});
