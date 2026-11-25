import { Readable } from 'node:stream';
import { Constants, EModelEndpoint, EToolResources, Providers } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { resolveUploadEndpoint, resolveEffectiveToolResource } from './routing';
import { encodeAndFormatAudios } from '~/files/encode/audio';
import { UnsupportedProviderAudioError } from './errors';

describe('resolveUploadEndpoint', () => {
  const req = { user: { id: 'user-1' } } as unknown as ServerRequest;

  beforeEach(() => {
    delete (req as unknown as { _uploadAgentCache?: unknown })._uploadAgentCache;
  });

  it('reads the agent so its provider governs an agent upload', async () => {
    const getAgent = jest.fn().mockResolvedValue({ provider: 'Custom Provider' });

    const endpoint = await resolveUploadEndpoint({
      req,
      metadata: { endpoint: EModelEndpoint.agents, agent_id: 'agent_saved01' },
      getAgent,
    });

    expect(endpoint).toBe('Custom Provider');
    expect(getAgent).toHaveBeenCalled();
  });

  it('ignores an agent id on an assistants upload', async () => {
    /* Assistants have their own pipeline and skip the agent authorization gate, so
     * resolving the named agent here would let its provider shape the validation errors
     * an unauthorized caller sees. */
    const getAgent = jest.fn().mockResolvedValue({ provider: 'Custom Provider' });

    const endpoint = await resolveUploadEndpoint({
      req,
      metadata: { endpoint: EModelEndpoint.assistants, agent_id: 'agent_victim01' },
      getAgent,
    });

    expect(endpoint).toBe(EModelEndpoint.assistants);
    expect(getAgent).not.toHaveBeenCalled();
  });

  it.each(['openAI', 'azureOpenAI', 'MyGateway'])(
    'keeps the provider endpoint carried by an ephemeral conversation (%s)',
    async (endpoint) => {
      const getAgent = jest.fn().mockResolvedValue(null);
      await expect(
        resolveUploadEndpoint({
          req,
          metadata: { endpoint, agent_id: String(Constants.EPHEMERAL_AGENT_ID) },
          getAgent,
        }),
      ).resolves.toBe(endpoint);
    },
  );

  it('leaves an upload naming no agent alone', async () => {
    const getAgent = jest.fn();

    const endpoint = await resolveUploadEndpoint({
      req,
      metadata: { endpoint: EModelEndpoint.openAI },
      getAgent,
    });

    expect(endpoint).toBe(EModelEndpoint.openAI);
    expect(getAgent).not.toHaveBeenCalled();
  });
});

describe('resolveEffectiveToolResource Responses handling', () => {
  const makeReq = () =>
    ({
      user: { id: 'user-1' },
      file: { mimetype: 'application/pdf' },
      config: { fileConfig: undefined },
    }) as unknown as ServerRequest;

  it('treats the multipart string form of the Responses flag as set', async () => {
    /* Form data has no booleans, so the flag arrives as "true" and a strict comparison
     * would route an Azure PDF to extracted text on a deployment that carries it. */
    const withString = await resolveEffectiveToolResource({
      req: makeReq(),
      metadata: { endpoint: 'azureOpenAI', useResponsesApi: 'true' },
      getAgent: jest.fn(),
    });
    const withoutFlag = await resolveEffectiveToolResource({
      req: makeReq(),
      metadata: { endpoint: 'azureOpenAI' },
      getAgent: jest.fn(),
    });

    expect(withString).toBeUndefined();
    expect(withoutFlag).toBe('context');
  });

  it('does not classify audio as a context upload when no STT provider is usable', async () => {
    /* Transcription needs exactly one non-empty provider block. A schema holding only
     * allowedAddresses reports STT present while the service refuses it, so calling this
     * a context upload promises a transcript the preflight then waits on. */
    const makeAudioReq = (stt: Record<string, unknown>) =>
      ({
        user: { id: 'user-1' },
        file: { mimetype: 'audio/mpeg' },
        config: { fileConfig: undefined, speech: { stt } },
      }) as unknown as ServerRequest;

    const unusable = await resolveEffectiveToolResource({
      req: makeAudioReq({ allowedAddresses: ['127.0.0.1'] }),
      metadata: { endpoint: EModelEndpoint.openAI },
      getAgent: jest.fn(),
    });
    const usable = await resolveEffectiveToolResource({
      req: makeAudioReq({ openai: { apiKey: 'sk-test' } }),
      metadata: { endpoint: EModelEndpoint.openAI },
      getAgent: jest.fn(),
    });

    expect(unusable).not.toBe('context');
    expect(usable).toBe('context');
  });
});

describe('direct provider audio preflight', () => {
  const makeReq = (legacyFileUploadUX = false, mimetype = 'audio/wma', originalname = 'clip.wma') =>
    Object.assign({} as ServerRequest, {
      file: {
        mimetype,
        originalname,
        fieldname: 'file',
        encoding: '7bit',
        size: 16,
        destination: '/uploads',
        filename: originalname,
        path: '/uploads/audio-1',
        stream: Readable.from(Buffer.alloc(16)),
        buffer: Buffer.alloc(16),
      },
      config: {
        fileConfig: {
          endpoints: { MyGateway: { supportedMimeTypes: ['audio/.*'], legacyFileUploadUX } },
        },
      },
    });

  it.each([false, true])(
    'rejects unsupported audio before processing (legacy=%s)',
    async (legacy) => {
      await expect(
        resolveEffectiveToolResource({
          req: makeReq(legacy),
          metadata: { endpoint: 'MyGateway' },
          getAgent: jest.fn(),
        }),
      ).rejects.toMatchObject({
        message: 'com_error_files_provider_audio_format',
        userErrorStatusCode: 415,
      });
    },
  );

  it('uses the resolved agent endpoint and reuses the agent read', async () => {
    const req = makeReq();
    const getAgent = jest.fn().mockResolvedValue({ provider: 'MyGateway' });
    const metadata = { endpoint: EModelEndpoint.agents, agent_id: 'agent_saved01' };
    await resolveUploadEndpoint({ req, metadata, getAgent });
    await expect(resolveEffectiveToolResource({ req, metadata, getAgent })).rejects.toBeInstanceOf(
      UnsupportedProviderAudioError,
    );
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it.each([EToolResources.context, EToolResources.ocr, EToolResources.execute_code])(
    'preserves explicit %s uploads',
    async (tool_resource) => {
      await expect(
        resolveEffectiveToolResource({
          req: makeReq(true),
          metadata: { endpoint: 'MyGateway', tool_resource },
          getAgent: jest.fn(),
        }),
      ).resolves.toBe(
        tool_resource === EToolResources.ocr ? EToolResources.context : tool_resource,
      );
    },
  );

  it('preserves audio explicitly routed to transcription', async () => {
    const req = makeReq();
    req.config!.fileConfig!.defaultLLMDeliveryPath = { overrides: { 'audio/*': 'text' } };
    await expect(
      resolveEffectiveToolResource({
        req,
        metadata: { endpoint: 'MyGateway' },
        getAgent: jest.fn(),
      }),
    ).resolves.toBe(EToolResources.context);
  });

  it.each([EModelEndpoint.google, Providers.VERTEXAI])(
    'does not apply input_audio rules to %s',
    async (endpoint) => {
      await expect(
        resolveEffectiveToolResource({
          req: makeReq(),
          metadata: { endpoint },
          getAgent: jest.fn(),
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('also rejects unsupported OpenRouter audio', async () => {
    await expect(
      resolveEffectiveToolResource({
        req: makeReq(),
        metadata: { endpoint: Providers.OPENROUTER },
        getAgent: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(UnsupportedProviderAudioError);
  });

  it.each([
    ['audio/wave', 'clip.wave', 'wav'],
    ['audio/mpeg', 'recording', 'mp3'],
    ['audio/unknown', 'clip.pcm16', 'pcm16'],
  ])(
    'delivers an accepted %s upload through the real encoder',
    async (mimetype, originalname, format) => {
      const req = makeReq(false, mimetype, originalname);
      await expect(
        resolveEffectiveToolResource({
          req,
          metadata: { endpoint: 'MyGateway' },
          getAgent: jest.fn(),
        }),
      ).resolves.toBeUndefined();
      const file = {
        file_id: 'audio-1',
        filename: originalname,
        filepath: '/uploads/audio-1',
        type: mimetype,
        bytes: 16,
        source: 'local',
      } as IMongoFile;
      const result = await encodeAndFormatAudios(
        req,
        [file],
        { provider: Providers.OPENAI, endpoint: 'MyGateway' },
        () => ({ getDownloadStream: async () => Readable.from(Buffer.alloc(16)) }),
      );
      expect(result.audios).toEqual([
        {
          type: 'input_audio',
          input_audio: { data: Buffer.alloc(16).toString('base64'), format },
        },
      ]);
    },
  );
});
