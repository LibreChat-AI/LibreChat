import { FileContext, FileSources, ImageDetail } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { RunFileEncodingAgent, RunFileMessageEncoderDeps } from './encode';
import type { ServerRequest } from '~/types';
import { AgentAttachmentLimitError, AgentAttachmentPolicyError } from '../attachments';
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
  const encodeDocuments = jest.fn(async () => ({ documents: [nativeDocument] }));
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
  return { ...deps, ...createRunFileMessageEncoder(deps) };
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
});
