import { z } from 'zod';
import { Readable } from 'node:stream';
import { mediaSubmissionRequestSchema, resolveMediaConfig } from 'librechat-data-provider';
import type { MediaProviderContext, MediaProviderInput } from '../provider';
import type { MediaTransport, MediaTransportRequest } from '../transport';
import { createRESTMediaAdapters } from './rest';

function fixture(api: 'openrouter.videos' | 'openai.videos', response: object) {
  const calls: MediaTransportRequest[] = [];
  const transport: MediaTransport = {
    async json<T>(request: MediaTransportRequest, schema: z.ZodType<T>) {
      calls.push(request);
      return schema.parse(response);
    },
    async stream(request) {
      calls.push(request);
      return Readable.from([Buffer.from('video')]);
    },
  };
  const adapter = createRESTMediaAdapters().find((entry) => entry.api === api);
  if (!adapter?.poll) throw new Error('Missing video adapter');
  const context: MediaProviderContext = {
    jobId: 'server-job',
    transport,
    config: resolveMediaConfig(),
    signal: new AbortController().signal,
    connection: {
      id: 'fixture',
      api,
      baseURL: 'https://provider.example/v1',
      headers: { Authorization: 'Bearer fixture' },
      binding: 'fixture-account',
    },
  };
  return { adapter, context, calls };
}

describe.each(['openrouter.videos', 'openai.videos'] as const)('%s job identity', (api) => {
  it.each(['queued', 'completed', 'failed'])(
    'rejects a %s response naming another job without replay or download',
    async (status) => {
      const { adapter, context, calls } = fixture(api, { id: 'other-job', status });
      await expect(adapter.poll!('original-job', context)).rejects.toMatchObject({
        certainty: 'uncertain',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://provider.example/v1/videos/original-job');
      expect(calls[0].method).not.toBe('POST');
    },
  );

  it('retains the requested job ID and safely encodes it in content URLs', async () => {
    const id = 'job/one?index=99#fragment';
    const { adapter, context, calls } = fixture(api, { id, status: 'completed' });
    const result = await adapter.poll!(id, context);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.parts[0].kind === 'text')
      throw new Error('Missing video output');
    const resultURL = new URL(result.parts[0].url ?? '');
    expect(resultURL.origin).toBe('https://provider.example');
    expect(resultURL.pathname).toBe(`/v1/videos/${encodeURIComponent(id)}/content`);
    expect(resultURL.hash).toBe('');
    expect(calls).toHaveLength(1);
  });
});

describe('OpenRouter native video request translation', () => {
  it('keeps source video, audio, references, and first/last frames in their documented fields', async () => {
    const { adapter, context, calls } = fixture('openrouter.videos', {
      id: 'job-1',
      status: 'queued',
    });
    context.providerTag = 'seed';
    const input = (role: MediaProviderInput['role'], type: string): MediaProviderInput => ({
      role,
      type,
      file_id: role,
      data: Buffer.from(role),
      ...(role === 'audio' || role === 'video'
        ? { sourceURL: `https://media.example/${role}` }
        : {}),
    });
    const result = await adapter.submit(
      mediaSubmissionRequestSchema.parse({
        clientRequestId: 'multimodal-video',
        operation: 'video.generate',
        prompt: 'Continue this scene',
        selection: {
          connectionId: 'fixture',
          modelId: 'bytedance/seedance-2.0',
          catalogVersion: 'catalog',
        },
        parameters: {
          durationSeconds: 5,
          resolution: '720p',
          providerOptions: { watermark: false },
        },
      }),
      [
        input('video', 'video/mp4'),
        input('audio', 'audio/wav'),
        input('reference', 'image/png'),
        input('start_frame', 'image/png'),
        input('end_frame', 'image/png'),
      ],
      context,
    );
    expect(result).toMatchObject({ status: 'running', operationId: 'job-1' });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].body));
    expect(body).toMatchObject({
      duration: 5,
      resolution: '720p',
      provider: { options: { seed: { watermark: false } } },
    });
    expect(body.input_references).toEqual([
      {
        type: 'video_url',
        video_url: { url: 'https://media.example/video' },
      },
      {
        type: 'audio_url',
        audio_url: { url: 'https://media.example/audio' },
      },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${Buffer.from('reference').toString('base64')}` },
      },
    ]);
    expect(body.frame_images.map((frame: { frame_type: string }) => frame.frame_type)).toEqual([
      'first_frame',
      'last_frame',
    ]);
    expect(body.provider).not.toHaveProperty('only');
  });
  it.each([
    undefined,
    'http://media.example/video',
    'https://user:secret@media.example/video',
    'https://media.example/video#fragment',
  ])(
    'rejects an unhosted or unsafe video reference before paid dispatch: %s',
    async (sourceURL) => {
      const { adapter, context, calls } = fixture('openrouter.videos', {
        id: 'job-1',
        status: 'queued',
      });
      await expect(
        adapter.submit(
          mediaSubmissionRequestSchema.parse({
            clientRequestId: 'invalid-hosted-video',
            operation: 'video.generate',
            prompt: 'Continue',
            selection: {
              connectionId: 'fixture',
              modelId: 'runway/aleph-2',
              catalogVersion: 'catalog',
            },
          }),
          [
            {
              role: 'video',
              file_id: 'video',
              type: 'video/mp4',
              data: Buffer.from('video'),
              sourceURL,
            },
          ],
          context,
        ),
      ).rejects.toMatchObject({ certainty: 'rejected' });
      expect(calls).toHaveLength(0);
    },
  );
});

describe('OpenRouter usage accounting', () => {
  it.each([
    ['a platform-billed request', { cost: 0.4 }, 0.4],
    [
      'a bring-your-own-key request',
      { cost: 0.02, is_byok: true, cost_details: { upstream_inference_cost: 0.4 } },
      0.42,
    ],
  ])('settles the full cost of %s', async (_label, usage, costUSD) => {
    const { adapter, context } = fixture('openrouter.videos', {
      id: 'job',
      status: 'completed',
      usage,
    });
    const result = await adapter.poll!('job', context);
    expect(result.status === 'completed' && result.usage?.costUSD).toBeCloseTo(costUSD);
  });
});
