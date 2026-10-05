import { z } from 'zod';
import sharp from 'sharp';
import { Readable } from 'node:stream';
import { mediaSubmissionRequestSchema, resolveMediaConfig } from 'librechat-data-provider';
import type { MediaProviderContext, MediaProviderInput } from '../provider';
import type { MediaTransport, MediaTransportRequest } from '../transport';
import { createOpenAIMediaAdapters, openAIImageCapabilities } from './openai';
import { createGoogleMediaAdapters, googleImageCapabilities } from './google';
import { createMediaCatalog, validateMediaOffering } from '../catalog';
import { createMicrosoftImageAdapter } from './microsoft';

function fixture(api: MediaProviderContext['connection']['api'], responses: unknown[] = []) {
  const calls: MediaTransportRequest[] = [];
  const downloads: MediaTransportRequest[] = [];
  const transport: MediaTransport = {
    async json<T>(input: MediaTransportRequest, schema: z.ZodType<T>) {
      calls.push(input);
      return schema.parse(responses.shift());
    },
    async stream(input) {
      downloads.push(input);
      return Readable.from(Buffer.from('video'));
    },
  };
  const context: MediaProviderContext = {
    jobId: 'server-job',
    transport,
    connection: {
      id: 'native',
      api,
      baseURL: 'https://provider.example/v1/',
      headers: { Authorization: 'Bearer fixture' },
      binding: 'account',
    },
    config: resolveMediaConfig(),
    signal: new AbortController().signal,
  };
  return { calls, downloads, context };
}

function request(
  modelId: string,
  operation: 'image.generate' | 'image.edit' | 'video.generate' = 'image.generate',
  parameters = {},
) {
  return mediaSubmissionRequestSchema.parse({
    clientRequestId: 'request',
    operation,
    prompt: 'A red ceramic teapot',
    inputs: operation === 'image.edit' ? [{ role: 'reference', file_id: 'original' }] : [],
    selection: { connectionId: 'native', modelId, catalogVersion: 'catalog' },
    parameters,
  });
}

const reference: MediaProviderInput = {
  role: 'reference',
  file_id: 'original',
  type: 'image/png',
  data: Buffer.from('original-image'),
};
const imageResponse = { data: [{ b64_json: Buffer.from('complete-image').toString('base64') }] };

describe('native OpenAI model mappings', () => {
  const [images, videos] = createOpenAIMediaAdapters();

  it('preserves bounded Responses failure and incomplete reasons', async () => {
    const { context } = fixture('openai.images', [
      {
        status: 'failed',
        output: [],
        error: { code: 'invalid_parameter', message: 'Unsupported quality. fixture' },
      },
      {
        status: 'incomplete',
        output: [],
        error: null,
        incomplete_details: { reason: 'max_output_tokens' },
      },
      { status: 'incomplete', output: [], incomplete_details: {} },
    ]);
    expect(await images.submit(request('openai/gpt-5-image'), [], context)).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'invalid_parameter', message: 'Unsupported quality. [redacted]' },
    });
    expect(await images.submit(request('openai/gpt-5-image'), [], context)).toMatchObject({
      status: 'failed',
      diagnostic: { code: 'max_output_tokens' },
    });
    expect(await images.submit(request('openai/gpt-5-image'), [], context)).toEqual({
      status: 'failed',
      diagnostic: undefined,
    });
  });

  it('preserves terminal video error details without creating another generation', async () => {
    const { context, calls } = fixture('openai.videos', [
      {
        id: 'video-job',
        status: 'failed',
        error: { code: 'moderation_blocked', message: 'The input video was rejected. fixture' },
      },
    ]);
    expect(await videos.poll!('video-job', context)).toMatchObject({
      status: 'failed',
      diagnostic: {
        code: 'moderation_blocked',
        message: 'The input video was rejected. [redacted]',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it.each(['dall-e-3', 'FLUX.1-Kontext-pro'])(
    'uses a reduced Images profile for a configured compatible deployment %s',
    async (model) => {
      const { context, calls } = fixture('openai.images', [imageResponse]);
      context.connection.baseURL = 'https://resource.openai.azure.com/openai/v1';
      const capabilities = openAIImageCapabilities(model, context.config);
      expect(capabilities).toHaveLength(1);
      expect(capabilities[0].controls).not.toHaveProperty('format');
      expect(capabilities[0].controls).not.toHaveProperty('background');
      expect(capabilities[0].controls).not.toHaveProperty('outputCompression');
      await images.submit(request(model), [], context);
      expect(JSON.parse(calls[0].body as string)).toEqual({
        model,
        prompt: 'A red ceramic teapot',
        n: 1,
      });
      expect(calls[0].url).toBe('https://resource.openai.azure.com/openai/v1/images/generations');
    },
  );

  it('rejects unsupported compatible controls and edits before dispatch', async () => {
    const { context, calls } = fixture('openai.images');
    for (const parameters of [{ quality: 'auto' }, { background: 'transparent' }, { count: 2 }]) {
      await expect(
        images.submit(request('dall-e-3', 'image.generate', parameters), [], context),
      ).rejects.toThrow();
    }
    await expect(
      images.submit(request('dall-e-3', 'image.edit'), [reference], context),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('keeps the DALL-E 2 single-image edit field and explicit DALL-E 3 quality', async () => {
    const { context, calls } = fixture('openai.images', [imageResponse, imageResponse]);
    await images.submit(request('dall-e-2', 'image.edit'), [reference], context);
    const form = calls[0].body as FormData;
    expect(form.has('image')).toBe(true);
    expect(form.has('image[]')).toBe(false);
    expect(form.has('output_format')).toBe(false);
    expect(form.has('quality')).toBe(false);
    await images.submit(request('dall-e-3', 'image.generate', { quality: 'hd' }), [], context);
    expect(JSON.parse(calls[1].body as string).quality).toBe('hd');
  });

  it('preserves text, image and cached input counters for exact image pricing', async () => {
    const { context } = fixture('openai.images', [
      {
        ...imageResponse,
        usage: {
          input_tokens: 130,
          output_tokens: 250,
          input_tokens_details: {
            text_tokens: 30,
            image_tokens: 100,
            cached_tokens: 25,
            cached_tokens_details: { text_tokens: 5, image_tokens: 20 },
          },
        },
      },
    ]);
    expect(await images.submit(request('gpt-image-1'), [], context)).toMatchObject({
      usage: {
        inputTokens: 130,
        outputTokens: 250,
        textInputTokens: 30,
        imageInputTokens: 100,
        cachedInputTokens: 25,
        cachedTextInputTokens: 5,
        cachedImageInputTokens: 20,
      },
    });
  });

  it('uses Azure OpenAI v1 with a media deployment mapping and no legacy api-version query', async () => {
    const { context, calls } = fixture('openai.images', [imageResponse]);
    context.connection.baseURL = 'https://resource.openai.azure.com/openai/v1';
    context.connection.headers = { 'api-key': 'azure-key' };
    context.connection.options = { deployments: { 'gpt-image-1': 'studio-image' } };
    await images.submit(request('gpt-image-1'), [], context);
    expect(calls[0].url).toBe('https://resource.openai.azure.com/openai/v1/images/generations');
    expect(calls[0].headers).toMatchObject({ 'api-key': 'azure-key' });
    expect(JSON.parse(calls[0].body as string).model).toBe('studio-image');
  });

  it.each(['sora-2', 'openai/sora-2'])(
    'admits configured Azure %s and uses v1 submit, poll, and content routes',
    async (modelId) => {
      const { context, calls, downloads } = fixture('openai.videos', [
        { id: 'azure-video', status: 'queued' },
        { id: 'azure-video', status: 'in_progress', progress: 50 },
        { id: 'azure-video', status: 'completed' },
      ]);
      context.connection.baseURL = 'https://resource.openai.azure.com/openai/v1/';
      context.connection.headers = { 'api-key': 'azure-key' };
      context.connection.options = { deployments: { 'sora-2': 'studio-video' } };
      context.config = resolveMediaConfig({
        enabled: true,
        integrations: [
          {
            id: 'native',
            api: 'openai.videos',
            endpointRef: {
              kind: 'direct',
              apiKey: 'azure-key',
              baseURL: context.connection.baseURL,
              headers: context.connection.headers,
              options: context.connection.options,
            },
            catalog: { kind: 'configured', models: [modelId] },
            operations: ['video.generate'],
          },
        ],
      });
      const catalog = await createMediaCatalog({
        transport: context.transport,
        adapters: [videos],
        now: () => 0,
      }).read(context.config, async () => context.connection, { ownerId: 'owner', tenantId: null });
      const submission = request(modelId, 'video.generate', {
        durationSeconds: 8,
        resolution: '1280x720',
      });
      expect(catalog.catalog.offerings).toHaveLength(1);
      expect(validateMediaOffering(submission, catalog.catalog.offerings[0])).toMatchObject({
        operation: 'video.generate',
      });
      expect(calls).toHaveLength(0);

      await expect(videos.submit(submission, [], context)).resolves.toMatchObject({
        status: 'running',
        operationId: 'azure-video',
      });
      expect(Object.fromEntries((calls[0].body as FormData).entries())).toEqual({
        model: 'studio-video',
        prompt: 'A red ceramic teapot',
        seconds: '8',
        size: '1280x720',
      });
      await expect(videos.poll!('azure-video', context)).resolves.toMatchObject({
        status: 'running',
        operationId: 'azure-video',
        progress: 50,
      });
      const completed = await videos.poll!('azure-video', context);
      if (completed.status !== 'completed' || completed.parts[0].kind !== 'video')
        throw new Error('Expected completed Azure video');
      const output = await videos.download(completed.parts[0], context);
      const chunks = [];
      for await (const chunk of output) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('video');
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: 'POST', url: 'https://resource.openai.azure.com/openai/v1/videos' },
        { method: 'GET', url: 'https://resource.openai.azure.com/openai/v1/videos/azure-video' },
        { method: 'GET', url: 'https://resource.openai.azure.com/openai/v1/videos/azure-video' },
      ]);
      expect(downloads[0].url).toBe(
        'https://resource.openai.azure.com/openai/v1/videos/azure-video/content',
      );
      for (const call of [...calls, ...downloads]) {
        expect(call.headers).toEqual({ 'api-key': 'azure-key' });
        expect(call.signal).toBe(context.signal);
        expect(new URL(call.url).search).toBe('');
      }
    },
  );

  it.each(['openai/gpt-image-2.5-flare', 'gpt-image-2.5-flare', 'gpt-image-1.5'])(
    'uses the Image API for %s and preserves output controls',
    async (model) => {
      const { context, calls } = fixture('openai.images', [imageResponse]);
      const result = await images.submit(
        request(model, 'image.generate', {
          count: 1,
          format: 'webp',
          outputCompression: 70,
          quality: 'high',
        }),
        [],
        context,
      );
      expect(result.status).toBe('completed');
      expect(calls[0].url).toBe('https://provider.example/v1/images/generations');
      expect(JSON.parse(calls[0].body as string)).toMatchObject({
        model: model.replace('openai/', ''),
        output_format: 'webp',
        output_compression: 70,
        quality: 'high',
      });
      expect(calls[0].signal).toBe(context.signal);
    },
  );

  it('keeps image edits multipart with references and a separate mask', async () => {
    const { context, calls } = fixture('openai.images', [imageResponse]);
    await images.submit(
      request('openai/gpt-image-2.5-sunburst', 'image.edit'),
      [reference, { ...reference, role: 'mask', file_id: 'mask' }],
      context,
    );
    expect(calls[0].url).toContain('/images/edits');
    const body = calls[0].body as FormData;
    expect(body.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(body.getAll('image[]')).toHaveLength(1);
    expect(body.get('mask')).toBeInstanceOf(Blob);
    expect(calls[0].headers?.['Content-Type']).toBeUndefined();
  });

  it.each([
    ['openai/gpt-5-image', 'gpt-5', 'gpt-image-1'],
    ['openai/gpt-5.4-image-2', 'gpt-5.4', 'gpt-image-2'],
  ])('maps %s to the documented Responses tool composition', async (id, model, image) => {
    const { context, calls } = fixture('openai.images', [
      {
        status: 'completed',
        output: [
          { type: 'reasoning' },
          { type: 'image_generation_call', result: imageResponse.data[0].b64_json },
        ],
        usage: { input_tokens: 12, output_tokens: 24 },
      },
    ]);
    const result = await images.submit(request(id, 'image.edit'), [reference], context);
    expect(calls[0].url).toBe('https://provider.example/v1/responses');
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      model,
      store: false,
      tool_choice: { type: 'image_generation' },
      max_tool_calls: 1,
      tools: [{ type: 'image_generation', model: image }],
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text' },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${reference.data.toString('base64')}`,
            },
          ],
        },
      ],
    });
    expect(result).toMatchObject({
      status: 'completed',
      parts: [{ kind: 'image', data: Buffer.from('complete-image') }],
      usage: { inputTokens: 12, outputTokens: 24 },
    });
  });

  it('exposes verified canonical profiles and leaves the undocumented Mini composition unavailable', () => {
    const profiles = images.catalog!(resolveMediaConfig());
    expect(profiles).toHaveLength(8);
    expect(new Set(profiles.map((model) => model.modelId)).size).toBe(8);
    expect(profiles.find((model) => model.modelId === 'openai/gpt-5-image-mini')).toMatchObject({
      unavailableReason: 'unsupported',
      capabilities: [],
    });
    expect(openAIImageCapabilities('gpt-image-2.5-flare', resolveMediaConfig())).toEqual(
      openAIImageCapabilities('openai/gpt-image-2.5-flare', resolveMediaConfig()),
    );
  });

  it('restores existing Sora jobs and authenticates only the bound content endpoint', async () => {
    const { context, calls, downloads } = fixture('openai.videos', [
      { id: 'video-1', status: 'queued' },
      { id: 'video-1', status: 'completed' },
    ]);
    await expect(
      videos.submit(
        request('openai/sora-2-pro', 'video.generate', {
          durationSeconds: 20,
          resolution: '1920x1080',
        }),
        [],
        context,
      ),
    ).resolves.toMatchObject({ status: 'running', operationId: 'video-1' });
    const completed = await videos.poll!('video-1', context);
    expect((calls[0].body as FormData).get('seconds')).toBe('20');
    if (completed.status !== 'completed' || completed.parts[0].kind === 'text')
      throw new Error('Expected video');
    await videos.download(completed.parts[0], context);
    expect(downloads[0].headers).toEqual(context.connection.headers);
    await expect(
      videos.download(
        { kind: 'video', ordinal: 0, type: 'video/mp4', url: 'https://other.example/video' },
        context,
      ),
    ).rejects.toThrow();
    expect(downloads).toHaveLength(1);
  });
});

describe('native Gemini models and continuation', () => {
  const [adapter] = createGoogleMediaAdapters();
  it('preserves ordered empty signed text in the next provider history', async () => {
    const { context, calls } = fixture('google.generateContent', [
      {
        candidates: [
          {
            content: {
              parts: [
                { text: '', thoughtSignature: 'empty-text-signature' },
                { inlineData: { mimeType: 'image/png', data: imageResponse.data[0].b64_json } },
              ],
            },
          },
        ],
      },
      { candidates: [{ content: { parts: [{ text: 'continued' }] } }] },
    ]);
    const submission = request('gemini-3.1-flash-image');
    const result = await adapter.submit(submission, [], context);
    if (result.status !== 'completed') throw new Error('Expected completed output');
    expect(result.parts[0]).toEqual({
      kind: 'text',
      ordinal: 0,
      text: '',
      thoughtSignature: 'empty-text-signature',
    });
    expect(result.parts).toHaveLength(2);
    await adapter.submit(submission, [], {
      ...context,
      continuation: { prompt: submission.prompt, inputs: [], parts: result.parts },
    });
    expect(JSON.parse(calls[1].body as string).contents[1].parts[0]).toEqual({
      text: '',
      thoughtSignature: 'empty-text-signature',
    });
  });
  it('bills thinking tokens as output and keeps usage on a response without parts', async () => {
    const usageMetadata = {
      promptTokenCount: 40,
      candidatesTokenCount: 1290,
      thoughtsTokenCount: 210,
    };
    const { context } = fixture('google.generateContent', [
      {
        candidates: [
          {
            content: {
              parts: [
                { text: 'plan', thought: true },
                { inlineData: { mimeType: 'image/png', data: imageResponse.data[0].b64_json } },
              ],
            },
          },
        ],
        usageMetadata,
      },
      { candidates: [], usageMetadata: { promptTokenCount: 40 } },
      { candidates: [] },
    ]);
    const submission = request('gemini-3.1-flash-image');
    await expect(adapter.submit(submission, [], context)).resolves.toMatchObject({
      status: 'completed',
      usage: { inputTokens: 40, outputTokens: 1500 },
    });
    await expect(adapter.submit(submission, [], context)).resolves.toEqual({
      status: 'failed',
      usage: { inputTokens: 40, outputTokens: undefined },
    });
    await expect(adapter.submit(submission, [], context)).resolves.toEqual({ status: 'failed' });
  });
  it.each([
    'google/gemini-3.1-flash-lite-image',
    'gemini-3.1-flash-image',
    'gemini-3-pro-image-preview',
  ])('sends resolution and image references to %s', async (model) => {
    const { context, calls } = fixture('google.generateContent', [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: { mimeType: 'image/png', data: imageResponse.data[0].b64_json },
                  thoughtSignature: 'next-signature',
                },
              ],
            },
          },
        ],
      },
    ]);
    context.continuation = {
      prompt: 'Original image',
      inputs: [],
      parts: [
        {
          kind: 'image',
          ordinal: 0,
          type: 'image/png',
          data: reference.data,
          thoughtSignature: 'original-signature',
        },
      ],
    };
    await adapter.submit(
      request(model, 'image.edit', { resolution: '1K', aspectRatio: '3:2' }),
      [reference],
      context,
    );
    expect(calls[0].url).toBe(
      `https://provider.example/v1/models/${model.replace('google/', '')}:generateContent`,
    );
    const body = JSON.parse(calls[0].body as string);
    expect(body.generationConfig).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { imageSize: '1K', aspectRatio: '3:2' },
    });
    expect(body.contents[1]).toMatchObject({
      role: 'model',
      parts: [{ thoughtSignature: 'original-signature' }],
    });
    expect(body.contents[2]).toMatchObject({
      role: 'user',
      parts: [{ text: 'A red ceramic teapot' }, { inlineData: { mimeType: 'image/png' } }],
    });
  });

  it('advertises the native model reference counts and Lite resolution limit', () => {
    const config = resolveMediaConfig();
    expect(googleImageCapabilities('google/gemini-3.1-flash-lite-image', config)[1]).toMatchObject({
      inputs: { max: 14 },
      controls: { resolution: { values: ['1K'] } },
    });
    expect(googleImageCapabilities('gemini-2.5-flash-image', config)[1].inputs.max).toBe(3);
    expect(adapter.catalog!(config)).toHaveLength(6);
  });
});

describe('Microsoft MAI native API', () => {
  const adapter = createMicrosoftImageAdapter();
  it('uses the resource-specific MAI route and documented generation parameters', async () => {
    const { context, calls } = fixture('microsoft.images', [imageResponse]);
    context.connection.baseURL = 'https://resource.services.ai.azure.com/mai/v1/';
    context.connection.headers = { 'api-key': 'fixture' };
    context.connection.options = { deployments: { 'MAI-Image-2.6': 'production-image' } };
    await adapter.submit(
      request('microsoft/mai-image-2.6', 'image.generate', {
        aspectRatio: '16:9',
        providerOptions: { web_grounding: true },
      }),
      [],
      context,
    );
    expect(calls[0].url).toBe('https://resource.services.ai.azure.com/mai/v1/images/generations');
    const body = JSON.parse(calls[0].body as string);
    expect(body).toMatchObject({
      model: 'production-image',
      width: 1365,
      height: 768,
      web_grounding: true,
    });
    expect(body.width * body.height).toBeLessThanOrEqual(1_048_576);
    expect(calls[0].headers?.['api-key']).toBe('fixture');
    expect(adapter.configuration!.baseURL).toBe('');
  });

  it('converts WebP references to the documented PNG multipart image format', async () => {
    const { context, calls } = fixture('microsoft.images', [imageResponse]);
    const data = await sharp({ create: { width: 24, height: 16, channels: 3, background: 'red' } })
      .webp()
      .toBuffer();
    await adapter.submit(
      request('microsoft/mai-image-2.5', 'image.edit'),
      [{ ...reference, type: 'image/webp', data }],
      context,
    );
    const image = (calls[0].body as FormData).get('image') as Blob;
    expect(image.type).toBe('image/png');
    expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({
      format: 'png',
      width: 24,
      height: 16,
    });
  });
});
