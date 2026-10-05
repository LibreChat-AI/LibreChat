import { z } from 'zod';
import axios from 'axios';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import {
  resolveMediaConfig,
  mediaCapabilitySchema,
  mediaSubmissionRequestSchema,
} from 'librechat-data-provider';
import type { MediaSubmissionRequest } from 'librechat-data-provider';
import type { Server } from 'node:http';
import type {
  MediaProviderAdapter,
  MediaProviderContext,
  MediaProviderInput,
  MediaProviderResult,
} from '../provider';
import type { MediaTransport, MediaTransportRequest } from '../transport';
import { decodeOperation, encodeOperation, nativeDownload, nativeRequest } from './native';
import { createSourcefulMediaAdapters } from './sourceful';
import { createRecraftMediaAdapters } from './recraft';
import { createRunwayMediaAdapters } from './runway';
import { createMediaTransport } from '../transport';
import { createKreaMediaAdapters } from './krea';
import { createBFLMediaAdapters } from './bfl';
import { createXAIMediaAdapters } from './xai';
import { MediaProviderError } from '../errors';

const adapters = [
  ...createBFLMediaAdapters(),
  ...createRecraftMediaAdapters(),
  ...createXAIMediaAdapters(),
  ...createRunwayMediaAdapters(),
  ...createKreaMediaAdapters(),
  ...createSourcefulMediaAdapters(),
];
const bytes = Buffer.from('complete-output');
const reference: MediaProviderInput = {
  role: 'reference',
  file_id: 'image',
  type: 'image/png',
  data: bytes,
};
const video: MediaProviderInput = {
  role: 'video',
  file_id: 'video',
  type: 'video/mp4',
  data: bytes,
};
const brandId = '12345678-1234-4234-8234-123456789012';
const jobId = '12345678-1234-4234-8234-123456789013';
const assetId = '12345678-1234-4234-8234-123456789014';

function fixture(api: MediaProviderAdapter['api'], responses: object[] = []) {
  const adapter = adapters.find((item) => item.api === api);
  if (!adapter?.configuration) throw new Error('Missing native adapter configuration');
  const calls: MediaTransportRequest[] = [];
  const transport: MediaTransport = {
    async json<T>(request: MediaTransportRequest, schema: z.ZodType<T>) {
      calls.push(request);
      return schema.parse(responses.shift());
    },
    async stream(request) {
      calls.push(request);
      return Readable.from([bytes]);
    },
  };
  const configuration = adapter.configuration;
  const context: MediaProviderContext = {
    jobId: 'server-job',
    transport,
    config: resolveMediaConfig(),
    signal: new AbortController().signal,
    connection: {
      id: api,
      api,
      baseURL: configuration.baseURL,
      binding: 'fixture-binding',
      headers: {
        ...configuration.headers,
        [configuration.keyHeader ?? 'Authorization']:
          `${configuration.keyPrefix ?? 'Bearer '}fixture-key`,
      },
      options: { brandId },
    },
  };
  return { adapter, context, calls };
}

function request(
  modelId: string,
  operation: MediaSubmissionRequest['operation'] = 'image.generate',
  parameters: Partial<MediaSubmissionRequest['parameters']> = {},
): MediaSubmissionRequest {
  return mediaSubmissionRequestSchema.parse({
    clientRequestId: 'native-contract-request',
    operation,
    prompt: 'A sailboat on calm water',
    selection: { connectionId: 'native', modelId, catalogVersion: 'catalog' },
    inputs: operation === 'image.edit' ? [{ role: 'reference', file_id: 'image' }] : [],
    parameters: { count: 1, ...parameters },
  });
}

function operationId(result: MediaProviderResult): string {
  if (result.status !== 'running') throw new Error('Expected a running job');
  return result.operationId;
}

describe('native media catalogs and transport boundaries', () => {
  it.each([
    {
      api: 'runway.videos' as const,
      modelId: 'runway/gen-4.5',
      response: {
        id: 'job-1',
        status: 'FAILED',
        failureCode: 'INVALID_DURATION',
        failure: 'Unsupported duration. fixture-key',
      },
    },
    {
      api: 'xai.videos' as const,
      modelId: 'x-ai/grok-imagine-video',
      response: {
        status: 'failed',
        error: { code: 'INVALID_DURATION', message: 'Unsupported duration. fixture-key' },
      },
    },
  ])(
    'preserves sanitized terminal $api provider error fields',
    async ({ api, modelId, response }) => {
      const { adapter, context, calls } = fixture(api, [response]);
      const token = encodeOperation({ id: 'job-1', modelId }, context);
      expect(await adapter.poll!(token, context)).toMatchObject({
        status: 'failed',
        diagnostic: { code: 'INVALID_DURATION', message: 'Unsupported duration. [redacted]' },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('GET');
    },
  );

  it('transmits all permitted multipart references when their aggregate exceeds each file limit', async () => {
    const { context } = fixture('krea.images');
    context.config = resolveMediaConfig({
      catalog: { maxResponseBytes: 1024 },
      limits: { maxInputs: 16, maxOutputs: 1 },
      transfers: { maxImageBytes: 2048, maxVideoBytes: 2048, maxAudioBytes: 2048 },
    });
    const body = new FormData();
    const file = new Blob([Buffer.alloc(2048)], { type: 'image/png' });
    for (let index = 0; index < 16; index++) body.append('reference', file, `image-${index}.png`);
    const prompt = '海'.repeat(512);
    body.append('prompt', prompt);
    let receivedBytes = 0;
    const server = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"uploaded":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No listener');
      context.connection.baseURL = `http://127.0.0.1:${address.port}`;
      context.transport = createMediaTransport({
        http: axios.create({ proxy: false }),
        allowedAddresses: [new URL(context.connection.baseURL).host],
      });
      const upload = nativeRequest(context, 'assets', body);
      expect(upload.maxBytes).toBe((file.size * 16 + Buffer.byteLength(prompt)) * 2);
      await expect(
        context.transport.json(upload, z.object({ uploaded: z.literal(true) })),
      ).resolves.toEqual({ uploaded: true });
      expect(receivedBytes).toBeGreaterThan(file.size * 16);
      expect(receivedBytes).toBeLessThanOrEqual(upload.maxBytes);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('describes all 35 matching catalog models, including explicit unavailable Sourceful Fast models', () => {
    const config = resolveMediaConfig({ limits: { maxInputs: 2, maxOutputs: 2 } });
    const profiles = adapters.flatMap((adapter) => adapter.catalog?.(config) ?? []);
    expect(profiles).toHaveLength(35);
    expect(new Set(profiles.map((profile) => profile.modelId)).size).toBe(35);
    for (const profile of profiles) {
      for (const capability of profile.capabilities) {
        expect(() => mediaCapabilitySchema.parse(capability)).not.toThrow();
        expect(capability.inputs.max).toBeLessThanOrEqual(2);
        expect(capability.controls.count?.max).toBeLessThanOrEqual(2);
      }
    }
    expect(
      profiles
        .filter((profile) => profile.unavailableReason)
        .map((profile) => profile.modelId)
        .sort(),
    ).toEqual(['sourceful/riverflow-v2-fast', 'sourceful/riverflow-v2.5-fast']);
  });

  it('binds recoverable operation envelopes to the originating connection and provider', () => {
    const { context } = fixture('bfl.images');
    const token = encodeOperation({ id: 'job-1', modelId: 'model' }, context);
    expect(decodeOperation(token, context)).toMatchObject({ id: 'job-1', modelId: 'model' });
    expect(() =>
      decodeOperation(token, {
        ...context,
        connection: { ...context.connection, binding: 'other-account' },
      }),
    ).toThrow(MediaProviderError);
    expect(() => decodeOperation(token, fixture('xai.images').context)).toThrow(MediaProviderError);
  });

  it.each(['https://cdn.example/image.png', 'https://api.bfl.ai/output.png'])(
    'downloads %s without forwarding account credentials',
    async (url) => {
      const { context, calls } = fixture('bfl.images');
      const stream = await nativeDownload(
        { kind: 'image', ordinal: 0, type: 'image/png', url },
        context,
      );
      stream.resume();
      expect(calls[0]).toMatchObject({
        url,
        headers: {},
        maxBytes: context.config.transfers.maxImageBytes,
      });
    },
  );

  it.each(['http://cdn.example/image.png', 'https://user:password@cdn.example/image.png'])(
    'rejects unsafe result URL %s before transport',
    async (url) => {
      const { context, calls } = fixture('bfl.images');
      await expect(
        nativeDownload({ kind: 'image', ordinal: 0, type: 'image/png', url }, context),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    },
  );
});

describe('Black Forest Labs native protocols', () => {
  it.each([
    ['flux.2-max', 'flux-2-max'],
    ['flux.2-pro', 'flux-2-pro'],
    ['flux.2-flex', 'flux-2-flex'],
    ['flux.2-klein-4b', 'flux-2-klein-4b'],
  ])('maps %s and resumes the provider-returned regional polling URL', async (id, native) => {
    const pollingURL = 'https://api.us1.bfl.ai/v1/get_result?id=job-1';
    const { adapter, context, calls } = fixture('bfl.images', [
      { id: 'job-1', polling_url: pollingURL },
      { id: 'job-1', status: 'Ready', result: { sample: 'https://cdn.example/result.png' } },
    ]);
    const job = await adapter.submit(
      request(`black-forest-labs/${id}`, 'image.edit', { size: '1024x1536', format: 'png' }),
      [reference],
      context,
    );
    expect(calls[0].url).toBe(`https://api.bfl.ai/v1/${native}`);
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      width: 1024,
      height: 1536,
      input_image: bytes.toString('base64'),
      output_format: 'png',
    });
    const restored = createBFLMediaAdapters()[0];
    expect(await restored.poll!(operationId(job), context)).toMatchObject({
      status: 'completed',
      parts: [{ type: 'image/png' }],
    });
    expect(calls[1]).toMatchObject({ url: pollingURL, headers: { 'x-key': 'fixture-key' } });
  });

  it.each([
    'https://evil.example/v1/get_result?id=job-1',
    'https://api.us1.bfl.ai/v1/get_result?id=another-job',
  ])(
    'rejects an untrusted receipt %s without polling or replaying the paid submit',
    async (polling_url) => {
      const { adapter, context, calls } = fixture('bfl.images', [{ id: 'job-1', polling_url }]);
      await expect(
        adapter.submit(request('black-forest-labs/flux.2-pro'), [], context),
      ).rejects.toMatchObject({ certainty: 'uncertain' });
      expect(calls).toHaveLength(1);
    },
  );

  it.each([
    ['flux-video-edit', 'flux-tools/video-edit-v1', 'video'],
    ['flux-video-upscale', 'flux-tools/video-upscale-v1', 'input_video'],
  ])('uses the documented %s workflow and requires the source video', async (id, path, field) => {
    const { adapter, context, calls } = fixture('bfl.videos', [
      { id: 'job-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-1' },
    ]);
    const input = request(`black-forest-labs/${id}`, 'video.generate', {
      upscaleFactor: 2,
      creativity: 0,
    });
    await expect(adapter.submit(input, [], context)).rejects.toMatchObject({
      certainty: 'rejected',
    });
    expect(calls).toHaveLength(0);
    await adapter.submit(input, [video], context);
    expect(calls[0].url).toBe(`https://api.bfl.ai/v1/${path}`);
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      [field]: bytes.toString('base64'),
    });
  });

  it('preserves frame ordering and terminal moderation without generating another video', async () => {
    const { adapter, context, calls } = fixture('bfl.videos', [
      { id: 'job-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=job-1' },
      { id: 'job-1', status: 'Content Moderated' },
    ]);
    const job = await adapter.submit(
      request('black-forest-labs/flux-3-video', 'video.generate', {
        resolution: '1080p',
        durationSeconds: 5,
      }),
      [
        { ...reference, role: 'end_frame', data: Buffer.from('last') },
        { ...reference, role: 'start_frame', data: Buffer.from('first') },
      ],
      context,
    );
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      mode: 'i2v',
      resolution: 'fhd',
      keyframes: [Buffer.from('first').toString('base64'), Buffer.from('last').toString('base64')],
    });
    expect(await adapter.poll!(operationId(job), context)).toEqual({ status: 'failed' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('Recraft and xAI native images', () => {
  it('sends Recraft Styles references to the generation contract and preserves vector MIME', async () => {
    const { adapter, context, calls } = fixture('recraft.images', [
      { data: [{ b64_json: bytes.toString('base64') }] },
    ]);
    const input = request('recraft/recraft-v4-styles-pro-vector');
    await expect(adapter.submit(input, [], context)).rejects.toMatchObject({
      certainty: 'rejected',
    });
    const result = await adapter.submit(input, [reference], context);
    expect(calls[0].url).toBe('https://external.api.recraft.ai/v1/images/generations');
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      model: 'recraftv4_styles_pro_vector',
      style_reference_urls: [`data:image/png;base64,${bytes.toString('base64')}`],
    });
    expect(result).toMatchObject({
      status: 'completed',
      parts: [{ type: 'image/svg+xml', data: bytes }],
    });
  });

  it('uses Recraft imageToImage for content edits and rejects style-only models for edits', async () => {
    const { adapter, context, calls } = fixture('recraft.images', [
      { data: [{ url: 'https://cdn.example/edited.webp' }] },
    ]);
    await expect(
      adapter.submit(request('recraft/recraft-v4-styles', 'image.edit'), [reference], context),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    await adapter.submit(
      request('recraft/recraft-v4.1', 'image.edit', { strength: 0.5, format: 'webp' }),
      [reference],
      context,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://external.api.recraft.ai/v1/images/imageToImage');
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      model: 'recraftv4_1',
      strength: 0.5,
      image_url: expect.stringMatching(/^data:image\/png;base64,/),
    });
  });

  it('sends a single xAI edit using image.url without overriding its source aspect ratio', async () => {
    const { adapter, context, calls } = fixture('xai.images', [
      {
        data: [{ b64_json: bytes.toString('base64'), mime_type: 'image/jpeg' }],
        usage: { cost_in_usd_ticks: 1_000_000_000 },
      },
    ]);
    const result = await adapter.submit(
      request('x-ai/grok-imagine-image-2.0', 'image.edit', { aspectRatio: '16:9' }),
      [reference],
      context,
    );
    const body = JSON.parse(calls[0].body as string);
    expect(body).toMatchObject({
      model: 'grok-imagine-image-2.0',
      image: { url: expect.stringMatching(/^data:/) },
    });
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body).not.toHaveProperty('images');
    expect(result).toMatchObject({ status: 'completed', usage: { costUSD: 0.1 } });
  });

  it('uses the multi-image xAI edit field for multiple references', async () => {
    const { adapter, context, calls } = fixture('xai.images', [
      { data: [{ url: 'https://cdn.example/image.jpeg' }] },
    ]);
    await adapter.submit(
      request('x-ai/grok-imagine-image-quality', 'image.edit'),
      [reference, reference],
      context,
    );
    expect(JSON.parse(calls[0].body as string).images).toHaveLength(2);
  });
});

describe('xAI native video submissions', () => {
  it('maps Grok 1.5 frame pins and preset voices to the documented REST fields', async () => {
    const { adapter, context, calls } = fixture('xai.videos', [{ request_id: 'job-1' }]);
    const job = await adapter.submit(
      request('x-ai/grok-imagine-video-1.5', 'video.generate', {
        durationSeconds: 8,
        resolution: '720p',
        aspectRatio: '16:9',
        providerOptions: { reference_audios: [{ voice_id: 'eve' }] },
      }),
      [{ ...reference, role: 'start_frame' }, { ...reference, role: 'end_frame' }, reference],
      context,
    );
    expect(calls[0].url).toBe('https://api.x.ai/v1/videos/generations');
    const body = JSON.parse(calls[0].body as string);
    expect(body).toMatchObject({
      model: 'grok-imagine-video-1.5',
      duration: 8,
      resolution: '720p',
      image: { url: expect.stringMatching(/^data:/) },
      last_frame: { url: expect.stringMatching(/^data:/) },
      reference_images: [{ url: expect.stringMatching(/^data:/) }],
      reference_audios: [{ voice_id: 'eve' }],
    });
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(decodeOperation(operationId(job), context)).toMatchObject({
      id: 'job-1',
      modelId: 'x-ai/grok-imagine-video-1.5',
    });
  });

  it('rejects classic frame pins, unsupported 1080p reference generation, and uploaded voice clips before submission', async () => {
    const { adapter, context, calls } = fixture('xai.videos');
    await expect(
      adapter.submit(
        request('x-ai/grok-imagine-video', 'video.generate'),
        [{ ...reference, role: 'end_frame' }],
        context,
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    await expect(
      adapter.submit(
        request('x-ai/grok-imagine-video-1.5', 'video.generate', { resolution: '1080p' }),
        [reference],
        context,
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    await expect(
      adapter.submit(
        request('x-ai/grok-imagine-video-1.5', 'video.generate', {
          providerOptions: { reference_audios: [{ url: 'https://cdn.example/voice.wav' }] },
        }),
        [],
        context,
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect(calls).toHaveLength(0);
  });
});

describe('Runway and Krea native jobs', () => {
  it('rejects an overlong Aleph edit prompt before uploading the source video', async () => {
    const { adapter, context, calls } = fixture('runway.videos');
    const submission = { ...request('runway/aleph-2', 'video.generate'), prompt: 'x'.repeat(1001) };
    await expect(
      adapter.submit(submission, [{ ...video, data: Buffer.alloc(4_000_000) }], context),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('uses Runway version headers and native pixel dimensions', async () => {
    const { adapter, context, calls } = fixture('runway.videos', [
      { id: 'job-1' },
      { id: 'job-1', status: 'SUCCEEDED', output: ['https://cdn.example/video.mp4'] },
    ]);
    const job = await adapter.submit(
      request('runway/gen-4.5', 'video.generate', { aspectRatio: '9:16', durationSeconds: 6 }),
      [],
      context,
    );
    expect(calls[0]).toMatchObject({
      url: 'https://api.dev.runwayml.com/v1/text_to_video',
      headers: { 'X-Runway-Version': '2024-11-06' },
    });
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      model: 'gen4.5',
      ratio: '720:1280',
      duration: 6,
    });
    expect(await adapter.poll!(operationId(job), context)).toMatchObject({
      status: 'completed',
      parts: [{ kind: 'video' }],
    });
  });

  it('uploads large Aleph source video through signed multipart without account credentials', async () => {
    const { adapter, context, calls } = fixture('runway.videos', [
      {
        uploadUrl: 'https://uploads.example/runway',
        fields: { token: 'signed-upload-field' },
        runwayUri: 'runway://asset',
      },
      { id: 'job-1' },
    ]);
    const input = request('runway/aleph-2', 'video.generate');
    await expect(adapter.submit(input, [], context)).rejects.toMatchObject({
      certainty: 'rejected',
    });
    await adapter.submit(
      input,
      [{ ...video, data: Buffer.alloc(4 * 1024 * 1024) }, reference],
      context,
    );
    expect(calls[1]).toMatchObject({
      url: 'https://uploads.example/runway',
      headers: {},
      method: 'POST',
    });
    expect(calls[1].body).toBeInstanceOf(FormData);
    expect(calls[2].url).toBe('https://api.dev.runwayml.com/v1/video_to_video');
    expect(JSON.parse(calls[2].body as string)).toMatchObject({
      model: 'aleph2',
      videoUri: 'runway://asset',
      keyframes: [{ at: 0, uri: expect.stringMatching(/^data:/) }],
    });
  });

  it.each(['large', 'medium', 'medium-turbo'])(
    'uploads a Krea reference before submitting %s and resumes its persisted job',
    async (variant) => {
      const { adapter, context, calls } = fixture('krea.images', [
        { image_url: 'https://assets.krea.ai/image.png' },
        { job_id: 'job-1' },
        { job_id: 'job-1', status: 'processing' },
        {
          job_id: 'job-1',
          status: 'completed',
          result: { urls: ['https://cdn.example/image.webp'] },
        },
      ]);
      const job = await adapter.submit(
        request(`krea/krea-2-${variant}`, 'image.edit', { strength: 0.6 }),
        [reference],
        context,
      );
      expect(calls[0].url).toBe('https://api.krea.ai/assets');
      expect(calls[0].body).toBeInstanceOf(FormData);
      expect(calls[1].url).toBe(`https://api.krea.ai/generate/image/krea/krea-2/${variant}`);
      expect(JSON.parse(calls[1].body as string)).toMatchObject({
        image_url: 'https://assets.krea.ai/image.png',
        strength: 0.6,
      });
      expect(await adapter.poll!(operationId(job), context)).toMatchObject({ status: 'running' });
      expect(await adapter.poll!(operationId(job), context)).toMatchObject({
        status: 'completed',
        parts: [{ type: 'image/webp' }],
      });
      expect(calls.filter((call) => call.url.includes('/generate/'))).toHaveLength(1);
    },
  );
});

describe('Sourceful native brand-scoped image API', () => {
  it('namespaces upstream idempotency by the durable job while retaining same-job replay', async () => {
    const response = {
      data: {
        freestyle_image: {
          freestyle_image_id: jobId,
          brand_id: brandId,
          status: 'queued',
          image_url: null,
        },
      },
      error: null,
    };
    const { adapter, context, calls } = fixture('sourceful.images', [response, response, response]);
    const submission = request('sourceful/riverflow-v2-pro');
    await adapter.submit(submission, [], context);
    await adapter.submit(submission, [], context);
    await adapter.submit({ ...submission, prompt: 'Another owner or retry' }, [], {
      ...context,
      jobId: 'another-server-job',
    });
    expect(calls[0].headers?.['Idempotency-Key']).toBe(calls[1].headers?.['Idempotency-Key']);
    expect(calls[0].headers?.['Idempotency-Key']).not.toBe(calls[2].headers?.['Idempotency-Key']);
  });
  it.each([
    ['sourceful/riverflow-v2.5-pro', undefined, brandId],
    ['sourceful/riverflow-v2.5-fast', 'high', brandId],
    ['sourceful/riverflow-v2-fast', 'high', brandId],
    ['sourceful/riverflow-v2-pro', undefined, undefined],
  ])(
    'rejects missing prerequisites or undocumented model %s before uploads',
    async (model, quality, brand) => {
      const { adapter, context, calls } = fixture('sourceful.images');
      context.connection.options = brand ? { brandId: brand } : {};
      await expect(
        adapter.submit(request(model, 'image.edit', { quality }), [reference], context),
      ).rejects.toMatchObject({ certainty: 'rejected' });
      expect(calls).toHaveLength(0);
    },
  );

  it('selects explicit Riverflow 2.5 quality with required auth and stable idempotency', async () => {
    const { adapter, context, calls } = fixture('sourceful.images', [
      {
        data: {
          freestyle_image: {
            freestyle_image_id: jobId,
            brand_id: brandId,
            status: 'queued',
            image_url: null,
          },
        },
        error: null,
      },
      {
        data: {
          freestyle_image: {
            freestyle_image_id: jobId,
            brand_id: brandId,
            status: 'completed',
            image_url: 'https://cdn.example/image.png',
          },
        },
        error: null,
      },
    ]);
    const job = await adapter.submit(
      request('sourceful/riverflow-v2.5-pro', 'image.generate', { quality: 'high' }),
      [],
      context,
    );
    expect(calls[0]).toMatchObject({
      url: 'https://www.riverflow.ai/api/photoshoot/freestyle/generate',
      headers: {
        Authorization: 'Riverflow-Key fixture-key',
        'Idempotency-Key': expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      brand_id: brandId,
      model_key: 'riverflow-2.5-pro-high',
    });
    expect(await adapter.poll!(operationId(job), context)).toMatchObject({ status: 'completed' });
    expect(calls[1].url).toBe(
      `https://www.riverflow.ai/api/photoshoot/freestyle/generate/${jobId}`,
    );
  });

  it('finalizes uploaded generic assets before editing and polls the matching brand asset', async () => {
    const { adapter, context, calls } = fixture('sourceful.images', [
      {
        data: {
          upload_url: 'https://uploads.example/sourceful',
          upload_fields: { key: 'signed-key' },
          storage_path: 'uploads/input.png',
          upload_session_id: jobId,
        },
        error: null,
      },
      {
        data: { item: { asset_id: assetId, asset_type: 'image', source_type: 'USER_UPLOAD' } },
        error: null,
      },
      { data: { edit_id: jobId, status: 'queued', image_url: null }, error: null },
      {
        data: {
          id: jobId,
          brand_id: brandId,
          asset_type: 'edit',
          status: 'completed',
          image_url: 'https://cdn.example/edit.jpeg',
        },
        error: null,
      },
    ]);
    const job = await adapter.submit(
      request('sourceful/riverflow-v2-pro', 'image.edit'),
      [reference],
      context,
    );
    expect(calls[1]).toMatchObject({ url: 'https://uploads.example/sourceful', headers: {} });
    expect(calls[2].url).toContain('/user-uploads/finalize');
    expect(calls[3].url).toBe('https://www.riverflow.ai/api/images/edit/uploaded-asset');
    expect(JSON.parse(calls[3].body as string)).toMatchObject({
      source_asset_id: assetId,
      model_key: 'riverflow-2-pro',
      reference_asset_ids: [],
    });
    expect(await adapter.poll!(operationId(job), context)).toMatchObject({
      status: 'completed',
      parts: [{ type: 'image/jpeg' }],
    });
    expect(calls[4].url).toBe(
      `https://www.riverflow.ai/api/brands/${brandId}/assets/edit/${jobId}`,
    );
  });
});

describe('xAI empty pending responses through actual HTTP transport', () => {
  let server: Server;
  let baseURL: string;
  let status = 202;
  let body = '';
  let calls = 0;
  beforeAll(async () => {
    server = createServer((_request, response) => {
      calls++;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    baseURL = `http://127.0.0.1:${address.port}/v1`;
  });
  afterAll(
    async () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  beforeEach(() => {
    status = 202;
    body = '';
    calls = 0;
  });

  it.each(['', ' \n\t'])(
    'treats exactly an empty HTTP 202 as pending: %j',
    async (responseBody) => {
      const { adapter, context } = fixture('xai.videos');
      body = responseBody;
      context.connection.baseURL = baseURL;
      context.transport = createMediaTransport({
        http: axios.create({ proxy: false }),
        allowedAddresses: [new URL(baseURL).host],
      });
      const token = encodeOperation(
        { id: 'job-1', modelId: 'x-ai/grok-imagine-video-1.5' },
        context,
      );
      expect(await adapter.poll!(token, context)).toMatchObject({
        status: 'running',
        operationId: token,
      });
      expect(calls).toBe(1);
    },
  );

  it.each([200, 204, 500])(
    'does not convert an empty HTTP %s into pending or resubmit',
    async (responseStatus) => {
      const { adapter, context } = fixture('xai.videos');
      status = responseStatus;
      context.connection.baseURL = baseURL;
      context.transport = createMediaTransport({
        http: axios.create({ proxy: false }),
        allowedAddresses: [new URL(baseURL).host],
      });
      const token = encodeOperation({ id: 'job-1', modelId: 'x-ai/grok-imagine-video' }, context);
      await expect(adapter.poll!(token, context)).rejects.toMatchObject({ certainty: 'uncertain' });
      expect(calls).toBe(1);
    },
  );

  it('parses nonempty terminal HTTP 202 content instead of replacing it with pending', async () => {
    const { adapter, context } = fixture('xai.videos');
    body = JSON.stringify({
      status: 'done',
      video: { respect_moderation: false, url: 'https://cdn.example/video.mp4' },
    });
    context.connection.baseURL = baseURL;
    context.transport = createMediaTransport({
      http: axios.create({ proxy: false }),
      allowedAddresses: [new URL(baseURL).host],
    });
    const token = encodeOperation({ id: 'job-1', modelId: 'x-ai/grok-imagine-video' }, context);
    expect(await adapter.poll!(token, context)).toEqual({ status: 'failed' });
    expect(calls).toBe(1);
  });
});
