import { FileContext, FileSources, ImageDetail } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { RunFileEncodingAgent, RunFileMessageEncoderDeps } from './encode';
import type { FileTextDeriver } from '~/files/reading';
import type { ServerRequest } from '~/types';
import { AgentAttachmentLimitError, AgentAttachmentPolicyError } from '../attachments';
import { buildTurnReadingContext, getTurnReadingContext } from '~/files/reading';
import { resolveTurnDeliveryRouting } from './delivery';
import { createRunFileMessageEncoder } from './encode';

jest.mock('~/utils/tokenizer', () => ({ countTokens: (text: string) => text.length }));
import { extractFileContext } from '~/files/context';

const pdf: TFile = {
  file_id: 'input-pdf',
  filename: 'report.pdf',
  type: 'application/pdf',
  bytes: 20,
  user: 'user',
  embedded: false,
  filepath: '/files/report.pdf',
  object: 'file',
  usage: 0,
  source: FileSources.local,
  llmDeliveryPath: 'provider',
  text: 'Previously extracted text',
};
const nativeDocument = {
  type: 'file',
  file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,cGRm' },
};
const nativeImage = { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } };

/** A child as the host loads it, before initialization settles its delivery routing. */
type LoadedAgent = Omit<RunFileEncodingAgent, 'deliveryRouting'> & {
  endpoint?: string;
  useResponsesApi?: boolean;
};

function setup({
  fileConfig = {},
  agents = { child: { provider: 'openAI' } },
}: {
  fileConfig?: NonNullable<ServerRequest['config']>['fileConfig'];
  agents?: Record<string, LoadedAgent>;
} = {}) {
  const req = { body: {}, config: { fileConfig } } as ServerRequest;
  const initialized = Object.fromEntries(
    Object.entries(agents).map(([id, { endpoint, useResponsesApi, ...agent }]) => [
      id,
      {
        ...agent,
        deliveryRouting: resolveTurnDeliveryRouting({
          agent: { provider: agent.provider, endpoint, model_parameters: { useResponsesApi } },
          config: req.config,
        }),
      },
    ]),
  );
  const encodeImages = jest.fn(async () => ({ image_urls: [nativeImage] }));
  const encodeDocuments = jest.fn<
    ReturnType<RunFileMessageEncoderDeps['encodeDocuments']>,
    Parameters<RunFileMessageEncoderDeps['encodeDocuments']>
  >(async () => ({ documents: [nativeDocument] }));
  const encodeAudios = jest.fn(async () => ({ audios: [{ type: 'media', data: 'audio' }] }));
  const encodeVideos = jest.fn(async () => ({ videos: [{ type: 'media', data: 'video' }] }));
  const extractText = jest.fn<
    ReturnType<RunFileMessageEncoderDeps['extractText']>,
    Parameters<RunFileMessageEncoderDeps['extractText']>
  >(extractFileContext);
  const deps: RunFileMessageEncoderDeps = {
    req,
    getAgent: (id) => initialized[id],
    encodeImages,
    encodeDocuments,
    encodeAudios,
    encodeVideos,
    getStrategyFunctions: jest.fn(),
    extractText,
  };
  return { ...deps, encodeDocuments, ...createRunFileMessageEncoder(deps) };
}

describe('createRunFileMessageEncoder', () => {
  it('sends PDF and image provider blocks to the child without duplicating extracted text', async () => {
    const harness = setup({
      agents: {
        child: {
          provider: 'openAI',
          endpoint: 'child-provider',
          model: 'child-model',
          useResponsesApi: true,
          imageDetail: ImageDetail.high,
        },
      },
    });
    const image: TFile = {
      ...pdf,
      file_id: 'image',
      filename: 'figure.png',
      type: 'image/png',
      embedded: true,
      metadata: { fileIdentifier: 'already-provisioned' },
    };

    const messages = await harness.encode([pdf, image], 'child');

    expect(messages).toHaveLength(1);
    expect(messages[0]._getType()).toBe('human');
    expect(messages[0].content).toEqual(expect.arrayContaining([nativeDocument, nativeImage]));
    expect(JSON.stringify(messages[0].content)).not.toContain(pdf.text);
    expect(harness.extractText).not.toHaveBeenCalled();
    expect(harness.encodeDocuments).toHaveBeenCalledWith(
      harness.req,
      [pdf],
      expect.objectContaining({
        provider: 'openAI',
        endpoint: 'child-provider',
        model: 'child-model',
        useResponsesApi: true,
        imageDetail: 'high',
      }),
      harness.getStrategyFunctions,
    );
    expect(harness.encodeImages).toHaveBeenCalledWith(
      harness.req,
      [image],
      expect.any(Object),
      harness.getStrategyFunctions,
    );
  });

  it('resolves one inferred input independently for provider, text and tool-only children', async () => {
    const harness = setup({
      agents: {
        native: { provider: 'openAI', endpoint: 'native' },
        text: { provider: 'openAI', endpoint: 'text' },
        tools: { provider: 'openAI', endpoint: 'tools' },
      },
      fileConfig: {
        endpoints: {
          native: { defaultLLMDeliveryPath: { fallback: 'provider' } },
          text: { defaultLLMDeliveryPath: { fallback: 'text' } },
          tools: { defaultLLMDeliveryPath: { fallback: 'none' } },
        },
      },
    });
    const [native, text, tools] = await Promise.all([
      harness.encode([pdf], 'native'),
      harness.encode([pdf], 'text'),
      harness.encode([pdf], 'tools'),
    ]);

    expect(native[0].content).toEqual(expect.arrayContaining([nativeDocument]));
    expect(JSON.stringify(text[0].content)).toContain(pdf.text);
    expect(JSON.stringify(text[0].content)).not.toContain('data:application/pdf');
    expect(tools).toEqual([]);
    expect(harness.encodeDocuments).toHaveBeenCalledTimes(1);
    expect(harness.extractText).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ ...pdf, llmDeliveryPath: 'text' }] }),
    );
    expect(pdf.llmDeliveryPath).toBe('provider');
  });

  it('delivers stored text only to a child that runs no tool able to read a tool-routed file', async () => {
    const csv: TFile = {
      ...pdf,
      file_id: 'input-csv',
      filename: 'sales.csv',
      filepath: '/files/sales.csv',
      type: 'text/csv',
      text: 'region,total\nwest,4',
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false },
    };
    const harness = setup({
      agents: {
        noReader: { provider: 'openAI', fileConsumers: { executeCode: false, fileSearch: false } },
        runsCode: { provider: 'openAI', fileConsumers: { executeCode: true, fileSearch: false } },
        searches: { provider: 'openAI', fileConsumers: { executeCode: false, fileSearch: true } },
        unknown: { provider: 'openAI' },
      },
      fileConfig: {
        endpoints: {
          openAI: {
            defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' } },
            textFallbackWithoutTools: true,
          },
        },
      },
    });

    /* Run Code uploads the file on its first call, so the child that runs code keeps it off the
     * prompt whether or not its sandbox holds a copy yet. File search serves only what its
     * store holds, so the searching child receives the text for a file never embedded. */
    const sandboxCsv: TFile = {
      ...csv,
      metadata: {
        destinationChosen: false,
        codeEnvRef: {
          kind: 'user',
          id: 'user-1',
          storage_session_id: 'session-1',
          file_id: 'sandbox-input-csv',
        },
      },
    };

    const [noReader, runsCode, unprovisioned, searches, unknown] = await Promise.all([
      harness.encode([csv], 'noReader'),
      harness.encode([sandboxCsv], 'runsCode'),
      harness.encode([csv], 'runsCode'),
      harness.encode([csv], 'searches'),
      harness.encode([csv], 'unknown'),
    ]);

    expect(JSON.stringify(noReader[0].content)).toContain('region,total');
    expect(runsCode).toEqual([]);
    expect(unprovisioned).toEqual([]);
    expect(JSON.stringify(searches[0].content)).toContain('region,total');
    expect(unknown).toEqual([]);
    expect(harness.extractText).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ ...csv, llmDeliveryPath: 'text' }] }),
    );
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
    expect(csv.llmDeliveryPath).toBe('none');
  });

  it('honors an explicit tool destination even when the receiving endpoint supports native files', async () => {
    const harness = setup();
    const file: TFile = {
      ...pdf,
      source: FileSources.text,
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: true },
    };
    await expect(harness.encode([file], 'child')).resolves.toEqual([]);
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
    expect(harness.extractText).not.toHaveBeenCalled();
  });

  it.each([
    {
      route: 'explicit tool destination',
      file: { llmDeliveryPath: 'none', metadata: { destinationChosen: true } },
    },
    {
      route: 'explicit tool destination on a text source',
      file: {
        source: FileSources.text,
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: true },
      },
    },
    { route: 'inferred tool destination', file: { llmDeliveryPath: 'provider' } },
  ] satisfies { route: string; file: Partial<TFile> }[])(
    'excludes $route files from model count, bytes and text budgets',
    async ({ file }) => {
      const harness = setup({
        fileConfig: {
          fileContextSizeLimit: 1,
          fileContextCharLimit: 5,
          endpoints: {
            openAI: { fileLimit: 1, defaultLLMDeliveryPath: { fallback: 'none' } },
          },
        },
      });
      const input: TFile = { ...pdf, ...file, bytes: 2 * 1024 * 1024 };

      await expect(
        harness.encode([input, { ...input, file_id: 'second' }], 'child'),
      ).resolves.toEqual([]);
      expect(harness.encodeDocuments).not.toHaveBeenCalled();
      expect(harness.extractText).not.toHaveBeenCalled();
    },
  );

  it.each(['provider', 'text'] as const)(
    'counts an inferred tool-only input when the child resolves it to %s delivery',
    async (fallback) => {
      const harness = setup({
        fileConfig: {
          fileContextSizeLimit: 1,
          endpoints: { openAI: { defaultLLMDeliveryPath: { fallback } } },
        },
      });
      await expect(
        harness.encode([{ ...pdf, llmDeliveryPath: 'none', bytes: 2 * 1024 * 1024 }], 'child'),
      ).rejects.toMatchObject({ limitType: 'bytes' });
      expect(harness.encodeDocuments).not.toHaveBeenCalled();
      expect(harness.extractText).not.toHaveBeenCalled();
    },
  );

  it('rejects a child text route without extracted text before reading any files', async () => {
    const harness = setup({
      fileConfig: {
        endpoints: { openAI: { defaultLLMDeliveryPath: { fallback: 'text' } } },
      },
    });
    await expect(harness.encode([{ ...pdf, text: undefined }], 'child')).rejects.toThrow(
      'requires extracted text for this agent',
    );
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
    expect(harness.extractText).not.toHaveBeenCalled();
  });

  it('keeps legacy extracted text while excluding legacy tool-provisioned native bytes', async () => {
    const harness = setup({
      fileConfig: {
        fileContextSizeLimit: 1,
        endpoints: { openAI: { fileLimit: 1 } },
      },
    });
    const files: TFile[] = [
      { ...pdf, file_id: 'legacy-text', source: FileSources.text, llmDeliveryPath: undefined },
      {
        ...pdf,
        file_id: 'legacy-tool',
        embedded: true,
        llmDeliveryPath: undefined,
        bytes: 2 * 1024 * 1024,
      },
    ];
    const messages = await harness.encode(files, 'child');
    expect(JSON.stringify(messages[0].content)).toContain(pdf.text);
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
  });

  it('uses the upload MIME type for policy after image conversion', async () => {
    const harness = setup({
      fileConfig: { endpoints: { openAI: { supportedMimeTypes: ['image/heic'] } } },
    });
    const image: TFile = {
      ...pdf,
      type: 'image/webp',
      metadata: { routingMimeType: 'image/heic' },
    };
    const messages = await harness.encode([image], 'child');
    expect(messages[0].content).toEqual(expect.arrayContaining([nativeImage]));
  });

  it('passes audio and video to the receiving provider encoders', async () => {
    const harness = setup({ agents: { child: { provider: 'google' } } });
    await harness.encode(
      [
        { ...pdf, file_id: 'audio', type: 'audio/mpeg' },
        { ...pdf, file_id: 'video', type: 'video/mp4' },
      ],
      'child',
    );
    expect(harness.encodeAudios).toHaveBeenCalledTimes(1);
    expect(harness.encodeVideos).toHaveBeenCalledTimes(1);
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
  });

  it.each([{ disabled: true }, { supportedMimeTypes: ['image/png'] }, { fileSizeLimit: 0.000001 }])(
    'rejects incompatible child policy before reading bytes: %j',
    async (policy) => {
      const harness = setup({ fileConfig: { endpoints: { openAI: policy } } });
      await expect(harness.encode([pdf], 'child')).rejects.toBeInstanceOf(
        AgentAttachmentPolicyError,
      );
      await expect(
        harness.encode(
          [{ ...pdf, llmDeliveryPath: 'none', metadata: { destinationChosen: true } }],
          'child',
        ),
      ).rejects.toBeInstanceOf(AgentAttachmentPolicyError);
      expect(harness.encodeDocuments).not.toHaveBeenCalled();
      expect(harness.extractText).not.toHaveBeenCalled();
    },
  );

  it('leaves code outputs with cleared sandbox references out of the child prompt and its count budget', async () => {
    /* Priming clears a dead reference on the turn's copy so the output is re-provisioned; the
     * output still belongs to the sandbox, so it neither reaches the prompt nor spends the
     * one-file budget. */
    const harness = setup({ fileConfig: { endpoints: { openAI: { fileLimit: 1 } } } });
    const output = (file_id: string): TFile => ({
      ...pdf,
      file_id,
      filename: `${file_id}.png`,
      type: 'image/png',
      text: undefined,
      llmDeliveryPath: undefined,
      context: FileContext.execute_code,
      metadata: {},
    });

    await expect(harness.encode([output('chart-a'), output('chart-b')], 'child')).resolves.toEqual(
      [],
    );
    expect(harness.encodeImages).not.toHaveBeenCalled();
  });

  it('includes permanent child context in the count budget before encoding shared files', async () => {
    const harness = setup({
      agents: {
        child: {
          provider: 'openAI',
          agentContextAttachments: [{ ...pdf, file_id: 'permanent' }],
        },
      },
      fileConfig: { endpoints: { openAI: { fileLimit: 1 } } },
    });
    await expect(harness.encode([pdf], 'child')).rejects.toMatchObject({ limitType: 'count' });
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
  });

  it('budgets mixed inputs with permanent model context once and excludes permanent tool files', async () => {
    const permanent: TFile = { ...pdf, file_id: 'permanent' };
    const tool: TFile = {
      ...pdf,
      file_id: 'tool',
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: true },
      bytes: 2 * 1024 * 1024,
    };
    const harness = setup({
      agents: {
        child: {
          provider: 'openAI',
          agentContextAttachments: [permanent, { ...tool, file_id: 'permanent-tool' }],
        },
      },
      fileConfig: {
        fileContextSizeLimit: 1,
        endpoints: { openAI: { fileLimit: 2 } },
      },
    });

    const messages = await harness.encode([permanent, pdf, tool], 'child');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual(expect.arrayContaining([nativeDocument]));
    expect(harness.encodeDocuments).toHaveBeenCalledWith(
      harness.req,
      [permanent, pdf],
      expect.any(Object),
      harness.getStrategyFunctions,
    );
    expect(harness.extractText).not.toHaveBeenCalled();
  });

  it('rejects aggregate file bytes before encoding', async () => {
    const harness = setup({ fileConfig: { endpoints: { openAI: { totalSizeLimit: 1 } } } });
    await expect(
      harness.encode(
        [
          { ...pdf, bytes: 600_000 },
          { ...pdf, file_id: 'second', bytes: 600_000 },
        ],
        'child',
      ),
    ).rejects.toMatchObject({ limitType: 'bytes' });
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
  });

  it('enforces the extracted-text budget before formatting the child prompt', async () => {
    const harness = setup({ fileConfig: { fileContextCharLimit: 5 } });
    await expect(
      harness.encode(
        [{ ...pdf, llmDeliveryPath: 'text', metadata: { destinationChosen: true } }],
        'child',
      ),
    ).rejects.toBeInstanceOf(AgentAttachmentLimitError);
    expect(harness.extractText).not.toHaveBeenCalled();
  });

  it('propagates encoder failures rather than silently dropping a shared input', async () => {
    const harness = setup();
    const failure = new Error('The input is no longer in storage');
    jest.mocked(harness.encodeDocuments).mockRejectedValueOnce(failure);
    await expect(harness.encode([pdf], 'child')).rejects.toBe(failure);
  });

  it.each(['provider', 'none'] as const)(
    'screens %s file content with the deployment policy before encoding',
    async (llmDeliveryPath) => {
      const harness = setup();
      harness.req.config!.filters = {
        files: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      };
      await expect(
        harness.encode(
          [
            {
              ...pdf,
              filename: 'PRIVATE-DOC.pdf',
              llmDeliveryPath,
              metadata: { destinationChosen: true },
            },
          ],
          'child',
        ),
      ).rejects.toThrow('Submitted content contains a private value');
      expect(harness.encodeDocuments).not.toHaveBeenCalled();
    },
  );

  it('returns no extra message or storage access when no files are shared', async () => {
    const harness = setup();
    await expect(harness.encode([], 'child')).resolves.toEqual([]);
    expect(harness.encodeDocuments).not.toHaveBeenCalled();
    expect(harness.extractText).not.toHaveBeenCalled();
  });

  describe('under the automatic policy', () => {
    const runsCode = { executeCode: true, fileSearch: false };
    const searches = { executeCode: false, fileSearch: true };
    const noReader = { executeCode: false, fileSearch: false };
    const attachment = {
      context: FileContext.message_attachment,
      metadata: { destinationChosen: false },
    };
    /**
     * File Search is loaded but queued and registered none of the child's files, as a failed
     * provisioning leaves it: the walk passes search by, no code tool is loaded, and a document
     * the provider rejects falls back to its text or, without any, to unavailable.
     */
    const withoutSearchFiles = (
      context: ReturnType<typeof buildTurnReadingContext>,
    ): ReturnType<typeof buildTurnReadingContext> => {
      context?.setSearchEvidence({ queued: [], registered: [] });
      return context;
    };

    it('admits an oversized file the child reads with Run Code and never counts it', async () => {
      /* The endpoint size limit is the provider's capacity for a file the policy reads, and a
       * file left to Run Code never reaches the provider, so it passes the limit and spends none
       * of the count, byte or text budgets. Classic routing still refuses the same file. */
      const workbook: TFile = {
        ...pdf,
        ...attachment,
        file_id: 'input-xlsx',
        filename: 'quarterly.xlsx',
        filepath: '/files/quarterly.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: 2 * 1024 * 1024,
        text: 'quarter,total\nQ1,4',
        llmDeliveryPath: 'text',
      };
      const limits = { fileSizeLimit: 1, fileLimit: 1 };
      const harness = setup({
        agents: {
          automatic: { provider: 'openAI', endpoint: 'automatic', fileConsumers: runsCode },
          classic: { provider: 'openAI', endpoint: 'classic', fileConsumers: runsCode },
        },
        fileConfig: {
          fileContextSizeLimit: 1,
          fileContextCharLimit: 5,
          endpoints: {
            automatic: { ...limits, llmDeliveryPolicy: 'automatic' },
            classic: limits,
          },
        },
      });

      await expect(
        harness.encode([workbook, { ...workbook, file_id: 'second-xlsx' }], 'automatic'),
      ).resolves.toEqual([]);
      await expect(harness.encode([workbook], 'classic')).rejects.toBeInstanceOf(
        AgentAttachmentPolicyError,
      );
      expect(harness.encodeDocuments).not.toHaveBeenCalled();
      expect(harness.extractText).not.toHaveBeenCalled();
      expect(workbook.llmDeliveryPath).toBe('text');
    });

    it('inspects a file the child reads with Run Code as classic routing would deliver it', async () => {
      const csv: TFile = {
        ...pdf,
        ...attachment,
        file_id: 'input-csv',
        filename: 'sales.csv',
        filepath: '/files/sales.csv',
        type: 'text/csv',
        text: 'region,total\nwest,4',
        llmDeliveryPath: 'text',
      };
      const harness = setup({
        agents: { child: { provider: 'openAI', fileConsumers: runsCode } },
        fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } },
      });
      harness.req.config!.filters = {
        files: { pii: { fields: ['content'], starterPatterns: [], uninspectable: 'block' } },
      };

      await expect(harness.encode([csv], 'child')).resolves.toEqual([]);
      expect(harness.extractText).not.toHaveBeenCalled();
    });

    it('leaves out a document the child cannot accept and records it for the next decision', async () => {
      const brief: TFile = { ...pdf, ...attachment, text: undefined };
      const harness = setup({
        agents: {
          automatic: { provider: 'openAI', endpoint: 'automatic', fileConsumers: searches },
          classic: { provider: 'openAI', endpoint: 'classic', fileConsumers: searches },
        },
        fileConfig: { endpoints: { automatic: { llmDeliveryPolicy: 'automatic' } } },
      });
      const child = harness.getAgent('automatic');
      const context =
        child &&
        withoutSearchFiles(
          buildTurnReadingContext({
            routing: child.deliveryRouting,
            provider: 'openAI',
            fileTokenLimit: 100_000,
            configuredFileSizeLimit: undefined,
            countTokens: (text) => text.length,
          }),
        );
      if (child == null || context == null) {
        throw new Error('expected an automatic reading context');
      }
      child.deliveryRouting.reading = context;
      harness.encodeDocuments.mockResolvedValueOnce({
        documents: [],
        rejected: [{ file_id: brief.file_id, reason: 'capacity' }],
      });

      const [message] = await harness.encode([brief], 'automatic');
      await harness.encode([brief], 'classic');

      expect(harness.encodeDocuments.mock.calls.map(([, , params]) => params)).toEqual([
        expect.objectContaining({ endpoint: 'automatic', onValidationFailure: 'skip' }),
        expect.objectContaining({ endpoint: 'classic', onValidationFailure: 'throw' }),
      ]);
      expect(context.judge(brief).rejected).toBe('capacity');
      expect(context.stats().rejected).toBe(1);
      expect(getTurnReadingContext(harness.getAgent('classic')?.deliveryRouting)).toBeUndefined();
      expect(message.content).toBe(
        [
          '- Shared files left out of this message (file contents are not listed here):',
          '\t- "report.pdf" (PDF): cannot be read on this turn (too large to send directly). Say so if asked; do not claim to have read it.',
        ].join('\n'),
      );
    });

    const capacityHarness = ({
      fileConfig = {},
      deriveText,
    }: {
      fileConfig?: NonNullable<ServerRequest['config']>['fileConfig'];
      deriveText?: FileTextDeriver;
    } = {}) => {
      const harness = setup({
        agents: { child: { provider: 'anthropic', fileConsumers: searches } },
        fileConfig: {
          ...fileConfig,
          endpoints: {
            ...fileConfig.endpoints,
            anthropic: { ...fileConfig.endpoints?.anthropic, llmDeliveryPolicy: 'automatic' },
          },
        },
      });
      const child = harness.getAgent('child');
      if (child == null) {
        throw new Error('expected a child agent');
      }
      const context = withoutSearchFiles(
        buildTurnReadingContext({
          routing: child.deliveryRouting,
          provider: 'anthropic',
          fileTokenLimit: 100_000,
          configuredFileSizeLimit: undefined,
          countTokens: (text) => text.length,
          deriveText,
        }),
      );
      child.deliveryRouting.reading = context;
      return { ...harness, context, child };
    };

    it('actually includes cached text after encode-time capacity rejection, once', async () => {
      const harness = capacityHarness();
      const file: TFile = { ...pdf, ...attachment, text: 'Complete cached PDF text.' };
      harness.encodeDocuments.mockResolvedValueOnce({
        documents: [],
        rejected: [{ file_id: file.file_id, reason: 'capacity' }],
      });

      const [message] = await harness.encode([file], 'child');

      const content = JSON.stringify(message.content);
      expect(content.match(/Complete cached PDF text\./g)).toHaveLength(1);
      expect(content).not.toContain('file_data');
      expect(content).not.toContain('left out');
      expect(harness.extractText).toHaveBeenCalledTimes(1);
      expect(harness.context?.judge(file).rejected).toBe('capacity');
      expect(file.llmDeliveryPath).toBe('provider');
    });

    it('charges a fallback shared with permanent agent context once', async () => {
      const harness = capacityHarness({
        fileConfig: { endpoints: { anthropic: { fileLimit: 1 } } },
      });
      const file: TFile = { ...pdf, ...attachment, text: 'Complete overlapping PDF text.' };
      harness.child.agentContextAttachments = [file];
      harness.encodeDocuments.mockResolvedValueOnce({
        documents: [],
        rejected: [{ file_id: file.file_id, reason: 'capacity' }],
      });

      const [message] = await harness.encode([file], 'child');

      expect(
        JSON.stringify(message.content).match(/Complete overlapping PDF text\./g),
      ).toHaveLength(1);
      expect(harness.context?.judge(file).overflow).not.toBe(true);
      expect(harness.extractText).toHaveBeenCalledTimes(1);
    });

    it('derives the capacity fallback after native validation and sends the complete result', async () => {
      const deriveText = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>();
      deriveText.mockResolvedValue({
        status: 'derived',
        text: 'Complete derived PDF text.',
        textDerivation: { outcome: 'complete', extractor: 'document_parser', at: 2 },
      });
      const harness = capacityHarness({ deriveText });
      const file: TFile = {
        ...pdf,
        ...attachment,
        text: undefined,
        metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred', at: 1 } },
      };
      harness.encodeDocuments.mockResolvedValueOnce({
        documents: [],
        rejected: [{ file_id: file.file_id, reason: 'capacity' }],
      });

      const [message] = await harness.encode([file], 'child');

      expect(deriveText).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(message.content).match(/Complete derived PDF text\./g)).toHaveLength(1);
      expect(harness.extractText).toHaveBeenCalledTimes(1);
      expect(file.text).toBeUndefined();
    });

    it('omits complete text after an integrity rejection', async () => {
      const harness = capacityHarness();
      const file: TFile = { ...pdf, ...attachment, text: 'Cached text must not bypass integrity.' };
      harness.encodeDocuments.mockResolvedValueOnce({
        documents: [],
        rejected: [{ file_id: file.file_id, reason: 'integrity' }],
      });

      const [message] = await harness.encode([file], 'child');

      expect(JSON.stringify(message.content)).not.toContain(file.text);
      expect(harness.extractText).not.toHaveBeenCalled();
      expect(message.content).toEqual(expect.stringContaining('could not accept it'));
    });

    it('moves an aggregate-overflowed derived fallback to unavailable before extraction', async () => {
      const harness = capacityHarness({
        fileConfig: { fileContextCharLimit: 8 },
        deriveText: async () => ({
          status: 'derived',
          text: 'This complete text fits per-file but exceeds the aggregate.',
          textDerivation: { outcome: 'complete', extractor: 'document_parser' },
        }),
      });
      const file: TFile = { ...pdf, ...attachment, text: undefined };
      harness.encodeDocuments.mockResolvedValueOnce({
        documents: [],
        rejected: [{ file_id: file.file_id, reason: 'capacity' }],
      });

      const [message] = await harness.encode([file], 'child');

      expect(harness.extractText).not.toHaveBeenCalled();
      expect(harness.context?.judge(file).overflow).toBe(true);
      expect(JSON.stringify(message.content)).not.toContain('This complete text fits');
    });

    it('derives the text a file needs inside encode, and validates it without the text', async () => {
      /* No file tool is loaded, so the deferred workbook keeps its classic text route, which
       * has no text yet and needs it derived. Validation stays synchronous: the copy is not
       * model-bound until its text exists, so nothing is counted. */
      const workbook: TFile = {
        ...pdf,
        ...attachment,
        file_id: 'input-xlsx',
        filename: 'quarterly.xlsx',
        filepath: '/files/quarterly.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        text: undefined,
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false, textDerivation: { outcome: 'deferred' } },
      };
      const harness = setup({
        agents: { child: { provider: 'openAI', fileConsumers: noReader } },
        fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } },
      });
      const deriveText = jest.fn<ReturnType<FileTextDeriver>, Parameters<FileTextDeriver>>(
        async () => ({
          status: 'derived',
          text: 'quarter,total\nQ1,42',
          textDerivation: { outcome: 'complete', extractor: 'document_parser', at: 1 },
        }),
      );
      const child = harness.getAgent('child');
      const context =
        child &&
        buildTurnReadingContext({
          routing: child.deliveryRouting,
          provider: 'openAI',
          fileTokenLimit: 100_000,
          configuredFileSizeLimit: undefined,
          countTokens: (text) => text.length,
          deriveText,
        });
      if (child == null || context == null) {
        throw new Error('expected an automatic reading context');
      }
      child.deliveryRouting.reading = context;

      expect(() => harness.validate([workbook], 'child')).not.toThrow();
      expect(deriveText).not.toHaveBeenCalled();

      const [message] = await harness.encode([workbook], 'child');

      expect(deriveText).toHaveBeenCalledTimes(1);
      expect(deriveText).toHaveBeenCalledWith(
        expect.objectContaining({ file_id: 'input-xlsx' }),
        undefined,
      );
      expect(harness.extractText).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            expect.objectContaining({ file_id: 'input-xlsx', text: 'quarter,total\nQ1,42' }),
          ],
        }),
      );
      expect(message.content).toEqual(expect.stringContaining('Q1,42'));
      expect(workbook.text).toBeUndefined();
    });

    it('reuses the token count the reading judged and marks any truncation', async () => {
      /* The byte length exceeds the 10-token limit, so the judge counts (3 tokens) and the
       * text fits. Recounting with the host tokenizer (one per character) would truncate it. */
      const csv: TFile = {
        ...pdf,
        ...attachment,
        file_id: 'input-csv',
        filename: 'sales.csv',
        filepath: '/files/sales.csv',
        type: 'text/csv',
        text: 'region,total\nwest,4',
        llmDeliveryPath: 'text',
      };
      const harness = setup({
        agents: { child: { provider: 'openAI', fileConsumers: searches } },
        fileConfig: { endpoints: { openAI: { llmDeliveryPolicy: 'automatic' } } },
      });
      harness.req.body = { fileTokenLimit: 10 };
      const child = harness.getAgent('child');
      const countTokens = jest.fn(() => 3);
      const context =
        child &&
        buildTurnReadingContext({
          routing: child.deliveryRouting,
          provider: 'openAI',
          fileTokenLimit: 10,
          configuredFileSizeLimit: undefined,
          countTokens,
        });
      if (child == null || context == null) {
        throw new Error('expected an automatic reading context');
      }
      child.deliveryRouting.reading = context;

      const [message] = await harness.encode([csv], 'child');

      expect(harness.extractText).toHaveBeenCalledWith(
        expect.objectContaining({ markTruncation: true, knownTokenCount: context.knownTokenCount }),
      );
      expect(countTokens).toHaveBeenCalledTimes(1);
      expect(context.knownTokenCount(csv)).toBe(3);
      expect(message.content).toEqual(expect.stringContaining('west,4'));
      expect(message.content).toEqual(expect.not.stringContaining('[Truncated'));
    });
  });
});
