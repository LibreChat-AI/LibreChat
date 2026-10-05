import { z } from 'zod';
import { Readable } from 'node:stream';
import {
  mediaCapabilitySchema,
  mediaSubmissionRequestSchema,
  resolveMediaConfig,
} from 'librechat-data-provider';
import type { MediaSubmissionRequest } from 'librechat-data-provider';
import type { MediaProviderAdapter, MediaProviderContext, MediaProviderInput } from '../provider';
import type { MediaTransportRequest } from '../transport';
import { decodeOperation, encodeOperation } from './native';
import { createAlibabaMediaAdapters } from './alibaba';
import { createMinimaxMediaAdapters } from './minimax';
import { createHeygenMediaAdapters } from './heygen';
import { createAtlasMediaAdapters } from './atlas';
import { validateMediaOffering } from '../catalog';
import { createSeedMediaAdapters } from './seed';

const adapters = [
  ...createAlibabaMediaAdapters(),
  ...createMinimaxMediaAdapters(),
  ...createHeygenMediaAdapters(),
  ...createAtlasMediaAdapters(),
  ...createSeedMediaAdapters(),
];
type Parameters = NonNullable<MediaSubmissionRequest['parameters']['providerOptions']>;
const input = (role: MediaProviderInput['role'], file_id: string = role): MediaProviderInput => {
  let type = 'image/png';
  if (role === 'audio') type = 'audio/mpeg';
  else if (role === 'video') type = 'video/mp4';
  return { role, file_id, type, data: Buffer.from(`original-${file_id}`) };
};
const uploadPolicy = JSON.stringify({
  data: {
    upload_host: 'https://dashscope-file-fixture.oss-cn-beijing.aliyuncs.com',
    upload_dir: 'dashscope-instant/account/task',
    policy: 'signed-policy',
    signature: 'signature',
    oss_access_key_id: 'temporary-key',
    x_oss_object_acl: 'private',
    x_oss_forbid_overwrite: 'true',
    max_file_size_mb: 100,
  },
});

function fixture(api: MediaProviderAdapter['api'], responses: string[] = []) {
  const adapter = adapters.find((candidate) => candidate.api === api)!;
  const calls: MediaTransportRequest[] = [];
  const downloads: MediaTransportRequest[] = [];
  const context: MediaProviderContext = {
    jobId: 'server-job',
    connection: {
      id: 'native',
      api,
      baseURL: adapter.configuration!.baseURL,
      headers: { Authorization: 'Bearer fixture' },
      binding: 'account-one',
    },
    config: resolveMediaConfig(),
    signal: new AbortController().signal,
    transport: {
      async json<T>(call: MediaTransportRequest, schema: z.ZodType<T>): Promise<T> {
        calls.push(call);
        const response = responses.shift();
        if (response === undefined) throw new Error('Unexpected provider request');
        return schema.parse(JSON.parse(response));
      },
      async stream(call: MediaTransportRequest) {
        downloads.push(call);
        return Readable.from([Buffer.from('original-content')]);
      },
    },
  };
  return { adapter, context, calls, downloads };
}
function request(
  modelId: string,
  parameters: Parameters = {},
  inputs: MediaProviderInput[] = [],
  operation: MediaSubmissionRequest['operation'] = 'video.generate',
): MediaSubmissionRequest {
  return mediaSubmissionRequestSchema.parse({
    clientRequestId: 'request-1',
    operation,
    prompt: 'Change the sky to blue',
    parameters,
    inputs: inputs.map(({ role, file_id, sourceURL }) => ({ role, file_id, sourceURL })),
    selection: { connectionId: 'native', modelId, catalogVersion: 'fixture' },
  });
}
function body(call: MediaTransportRequest): Parameters {
  return JSON.parse(String(call.body)) as Parameters;
}

describe('direct media provider contracts', () => {
  it('publishes validated native profiles with deployment limits and an unavailable retired model', () => {
    const config = resolveMediaConfig({ limits: { maxInputs: 3, maxOutputs: 2 } });
    const models = adapters.flatMap((adapter) => adapter.catalog!(config));
    expect(models).toHaveLength(23);
    for (const model of models) {
      for (const capability of model.capabilities) {
        expect(mediaCapabilitySchema.parse(capability)).toEqual(capability);
        expect(capability.inputs.max).toBeLessThanOrEqual(3);
        expect(capability.controls.count?.max).toBeLessThanOrEqual(2);
      }
    }
    expect(models.find((model) => model.modelId === 'bytedance/seedance-1-5-pro')).toMatchObject({
      capabilities: [],
      unavailableReason: 'unsupported',
    });
  });

  it('edits Qwen images through JSON generations using the exact native model and all reference originals', async () => {
    const { adapter, context, calls } = fixture('alibaba.images', [
      '{"data":[{"url":"https://results.example/qwen.png"}]}',
    ]);
    const references = [input('reference', 'one'), input('reference', 'two')];
    const result = await adapter.submit(
      request(
        'qwen/qwen-image-3-pro',
        {
          count: 2,
          size: '1536x1024',
          negativePrompt: 'clouds',
          providerOptions: { enable_thinking: false },
        },
        references,
        'image.edit',
      ),
      references,
      context,
    );
    expect(calls[0].url).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/images/generations',
    );
    expect(body(calls[0])).toMatchObject({
      model: 'qwen-image-3.0-pro',
      image: references.map((item) => `data:image/png;base64,${item.data.toString('base64')}`),
      n: 2,
      negative_prompt: 'clouds',
      enable_thinking: false,
    });
    expect(result).toMatchObject({
      status: 'completed',
      parts: [{ type: 'image/png', url: 'https://results.example/qwen.png' }],
    });
  });

  it('rejects Qwen agent rewriting for editing before contacting the provider', async () => {
    const { adapter, context, calls } = fixture('alibaba.images');
    const refs = [input('reference')];
    await expect(
      adapter.submit(
        request(
          'qwen/qwen-image-3',
          { providerOptions: { prompt_extend_mode: 'agent' } },
          refs,
          'image.edit',
        ),
        refs,
        context,
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['bytedance-seed/seedream-5-0-pro', 'dola-seedream-5-0-pro-260628'],
    ['bytedance-seed/seedream-5-0-lite', 'seedream-5-0-260128'],
    ['bytedance-seed/seedream-4.5', 'seedream-4-5-251128'],
  ])('preserves direct image editing and original bytes for %s', async (modelId, nativeId) => {
    const bytes = Buffer.from('generated-original');
    const { adapter, context, calls } = fixture('seed.images', [
      JSON.stringify({
        data: [{ b64_json: bytes.toString('base64') }],
        usage: { output_tokens: 123 },
      }),
    ]);
    const refs = [input('reference')];
    const result = await adapter.submit(
      request(modelId, { resolution: '2K' }, refs, 'image.edit'),
      refs,
      context,
    );
    expect(body(calls[0])).toMatchObject({
      model: nativeId,
      size: '2K',
      response_format: 'b64_json',
      image: [expect.stringMatching(/^data:image\/png;base64,/)],
    });
    expect(result).toMatchObject({
      status: 'completed',
      parts: [{ data: bytes, type: 'image/jpeg' }],
      usage: { outputTokens: 123 },
    });
  });

  it('enforces Seedream combined input/output limits and never substitutes the retired Seedance model', async () => {
    const image = fixture('seed.images');
    const refs = Array.from({ length: 14 }, (_, index) => input('reference', String(index)));
    await expect(
      image.adapter.submit(
        request('bytedance-seed/seedream-4.5', { count: 2 }, refs, 'image.edit'),
        refs,
        image.context,
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    const video = fixture('seed.videos');
    await expect(
      video.adapter.submit(request('bytedance/seedance-1-5-pro'), [], video.context),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect([...image.calls, ...video.calls]).toHaveLength(0);
  });

  it('submits Wan 3 native multimodal content and resumes the saved provider task', async () => {
    const { adapter, context, calls } = fixture('alibaba.videos', [
      uploadPolicy,
      uploadPolicy,
      '{}',
      '{}',
      '{"output":{"task_id":"wan-task"}}',
      '{"output":{"task_id":"wan-task","task_status":"SUCCEEDED","video_url":"https://results.example/wan.mp4"}}',
    ]);
    const refs = [input('reference'), input('video'), input('audio')];
    const accepted = await adapter.submit(
      request('alibaba/wan-3.0-prime', { durationSeconds: 5, audio: true }, refs),
      refs,
      context,
    );
    expect(calls[0].url).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/uploads?action=getPolicy&model=wan3.0-video-prime',
    );
    expect(calls[2].headers).toEqual({});
    const uploadedVideo = (calls[2].body as FormData).get('file') as File;
    expect(Buffer.from(await uploadedVideo.arrayBuffer())).toEqual(refs[1].data);
    expect(calls[4].headers).toMatchObject({
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    });
    expect(body(calls[4])).toMatchObject({
      model: 'wan3.0-video-prime',
      input: {
        media: [
          { type: 'reference_image' },
          { type: 'reference_video', url: 'oss://dashscope-instant/account/task/video.mp4' },
          { type: 'reference_audio', url: 'oss://dashscope-instant/account/task/audio.mp3' },
        ],
      },
      parameters: { duration: 5, audio: true },
    });
    if (accepted.status !== 'running') throw new Error('Expected a durable operation');
    const fresh = createAlibabaMediaAdapters().find((item) => item.api === 'alibaba.videos')!;
    expect(await fresh.poll!(accepted.operationId, context)).toMatchObject({
      status: 'completed',
      parts: [{ url: 'https://results.example/wan.mp4' }],
    });
    expect(calls[5]).toMatchObject({
      method: 'GET',
      url: 'https://dashscope-intl.aliyuncs.com/api/v1/tasks/wan-task',
    });
  });

  it('refuses an untrusted DashScope upload host before sending media or generating', async () => {
    const { adapter, context, calls } = fixture('alibaba.videos', [
      uploadPolicy.replace(
        'dashscope-file-fixture.oss-cn-beijing.aliyuncs.com',
        'credentials.example',
      ),
    ]);
    const refs = [input('audio')];
    await expect(
      adapter.submit(request('alibaba/wan-3.0', {}, refs), refs, context),
    ).rejects.toMatchObject({ certainty: 'uncertain' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it.each([false, true])(
    'selects HappyHorse t2v/i2v based on its frame (%s)',
    async (withFrame) => {
      const { adapter, context, calls } = fixture('alibaba.videos', [
        '{"output":{"task_id":"happy-task"}}',
      ]);
      const refs = withFrame ? [input('start_frame')] : [];
      await adapter.submit(
        request('alibaba/happyhorse-1.1', { aspectRatio: '16:9', durationSeconds: 5 }, refs),
        refs,
        context,
      );
      expect(body(calls[0])).toMatchObject({
        model: `happyhorse-1.1-${withFrame ? 'i2v' : 't2v'}`,
      });
      expect(body(calls[0]).parameters).toEqual(
        withFrame ? { duration: 5 } : { ratio: '16:9', duration: 5 },
      );
    },
  );

  it('uses Seedance 2.5 native editing constraints and polls its original handle', async () => {
    const { adapter, context, calls } = fixture('seed.videos', [
      '{"id":"seed-task"}',
      '{"id":"seed-task","status":"succeeded","content":{"video_url":"https://results.example/seed.mp4"}}',
    ]);
    const refs = [{ ...input('video'), sourceURL: 'https://media.example/original.mp4' }];
    const result = await adapter.submit(
      request(
        'bytedance/seedance-2.5',
        { durationSeconds: 5, providerOptions: { omni_reference_task_type: 'edit' } },
        refs,
      ),
      refs,
      context,
    );
    expect(body(calls[0])).toMatchObject({
      model: 'dreamina-seedance-2-5-260628',
      duration: -1,
      ratio: 'adaptive',
      omni_reference_task_type: 'edit',
      content: [
        { type: 'text' },
        {
          type: 'video_url',
          role: 'reference_video',
          video_url: { url: refs[0].sourceURL },
        },
      ],
    });
    if (result.status !== 'running') throw new Error('Expected operation');
    expect(await adapter.poll!(result.operationId, context)).toMatchObject({ status: 'completed' });
    expect(calls[1].url).toContain('/contents/generations/tasks/seed-task');
  });

  it.each([
    'bytedance/seedance-2.5',
    'bytedance/seedance-2.0',
    'bytedance/seedance-2.0-fast',
    'bytedance/seedance-2.0-mini',
  ])(
    'requires hosted video but preserves local image and audio references for %s',
    async (modelId) => {
      const { adapter, context, calls } = fixture('seed.videos', ['{"id":"seed-task"}']);
      const profile = adapter.catalog?.(context.config).find((entry) => entry.modelId === modelId);
      if (!profile) throw new Error('Missing native profile');
      expect(profile.capabilities[0].inputs.hostedRoles).toEqual(['video']);
      const offering = {
        connectionId: 'native',
        connectionName: 'Native',
        api: adapter.api,
        available: true,
        ...profile,
      };
      expect(() =>
        validateMediaOffering(request(modelId, {}, [input('video')]), offering),
      ).toThrow();
      const refs = [
        input('reference'),
        input('audio'),
        { ...input('video'), sourceURL: 'https://media.example/original.mp4?version=1' },
      ];
      const submission = request(modelId, {}, refs);
      expect(() => validateMediaOffering(submission, offering)).not.toThrow();
      await adapter.submit(submission, refs, context);
      expect(body(calls[0]).content).toEqual([
        { type: 'text', text: submission.prompt },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${refs[0].data.toString('base64')}` },
          role: 'reference_image',
        },
        {
          type: 'audio_url',
          audio_url: { url: `data:audio/mpeg;base64,${refs[1].data.toString('base64')}` },
          role: 'reference_audio',
        },
        {
          type: 'video_url',
          video_url: { url: refs[2].sourceURL },
          role: 'reference_video',
        },
      ]);
    },
  );

  it.each([
    undefined,
    'data:video/mp4;base64,dmlkZW8=',
    'http://media.example/original.mp4',
    'https://user:secret@media.example/original.mp4',
    'https://media.example/original.mp4#fragment',
  ])(
    'rejects an unhosted or unsafe native Seedance video before dispatch: %s',
    async (sourceURL) => {
      const { adapter, context, calls } = fixture('seed.videos');
      await expect(
        adapter.submit(
          request('bytedance/seedance-2.5', {}, [input('video')]),
          [{ ...input('video'), sourceURL }],
          context,
        ),
      ).rejects.toMatchObject({ certainty: 'rejected' });
      expect(calls).toHaveLength(0);
    },
  );

  it('maps MiniMax H3 Max references into V2 and reads task-wrapped results', async () => {
    const { adapter, context, calls } = fixture('minimax.videos', [
      '{"task_id":"h3-task"}',
      '{"task":{"id":"h3-task","status":"succeeded","content":{"url":"https://results.example/h3.mp4"},"usage":{"prompt_tokens":12,"completion_tokens":24}}}',
    ]);
    const refs = [input('reference'), input('audio')];
    const result = await adapter.submit(
      request(
        'minimax/hailuo-3-max',
        {
          resolution: '768P',
          durationSeconds: 5,
          providerOptions: { extra: { prompt_expansion_mode: 'quality' } },
        },
        refs,
      ),
      refs,
      context,
    );
    expect(body(calls[0])).toMatchObject({
      model: 'MiniMax-H3-Max',
      extra: { prompt_expansion_mode: 'quality' },
      content: [{ type: 'text' }, { role: 'reference_image' }, { role: 'reference_audio' }],
    });
    if (result.status !== 'running') throw new Error('Expected operation');
    expect(await adapter.poll!(result.operationId, context)).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 12, outputTokens: 24 },
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.minimax.io/v2/video_generation',
      'https://api.minimax.io/v2/query/video_generation/h3-task',
    ]);
  });

  it('retrieves Hailuo 2.3 files after V1 polling without generating again', async () => {
    const { adapter, context, calls } = fixture('minimax.videos', [
      '{"task_id":"legacy-task","base_resp":{"status_code":0}}',
      '{"task_id":"legacy-task","status":"Success","file_id":"998877","base_resp":{"status_code":0}}',
      '{"file":{"download_url":"https://results.example/hailuo.mp4"},"base_resp":{"status_code":0}}',
    ]);
    const result = await adapter.submit(
      request('minimax/hailuo-2.3', { durationSeconds: 6, resolution: '1080P' }),
      [],
      context,
    );
    if (result.status !== 'running') throw new Error('Expected operation');
    expect(await adapter.poll!(result.operationId, context)).toMatchObject({
      status: 'completed',
      parts: [{ url: 'https://results.example/hailuo.mp4' }],
    });
    expect(calls[2].url).toBe('https://api.minimax.io/v1/files/retrieve?file_id=998877');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('uploads HeyGen audio and animates the original image without inventing a voice', async () => {
    const { adapter, context, calls } = fixture('heygen.videos', [
      '{"data":{"asset_id":"audio-asset"}}',
      '{"data":{"video_id":"heygen-task","status":"waiting"}}',
      '{"data":{"id":"heygen-task","status":"completed","video_url":"https://results.example/avatar.mp4"}}',
    ]);
    const refs = [input('reference'), input('audio')];
    const result = await adapter.submit(request('heygen/avatar-iv', {}, refs), refs, context);
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect(body(calls[1])).toMatchObject({
      type: 'image',
      audio_asset_id: 'audio-asset',
      image: { type: 'base64', media_type: 'image/png', data: refs[0].data.toString('base64') },
      motion_prompt: 'Change the sky to blue',
    });
    expect(body(calls[1])).not.toHaveProperty('voice_id');
    if (result.status !== 'running') throw new Error('Expected operation');
    expect(await adapter.poll!(result.operationId, context)).toMatchObject({ status: 'completed' });
  });

  it.each([
    ['heygen.videos', 'heygen/avatar-iv', 'audio/ogg'],
    ['heygen.videos', 'heygen/avatar-iv', 'audio/mp4'],
    ['minimax.videos', 'minimax/hailuo-3', 'audio/ogg'],
    ['minimax.videos', 'minimax/hailuo-3-max', 'audio/mp4'],
    ['seed.videos', 'bytedance/seedance-2.5', 'audio/ogg'],
    ['seed.videos', 'bytedance/seedance-2.0', 'audio/mp4'],
  ] as const)(
    'rejects unsupported native %s %s %s audio before any upload or paid call',
    async (api, modelId, type) => {
      const { adapter, context, calls } = fixture(api);
      const refs = [input('reference'), { ...input('audio'), type }];
      await expect(adapter.submit(request(modelId, {}, refs), refs, context)).rejects.toMatchObject(
        { certainty: 'rejected' },
      );
      expect(calls).toHaveLength(0);
    },
  );

  it('uses the supplied HeyGen voice for a script without an upload', async () => {
    const { adapter, context, calls } = fixture('heygen.videos', [
      '{"data":{"video_id":"script-task"}}',
    ]);
    const refs = [input('reference')];
    await adapter.submit(
      request('heygen/avatar-iv', { providerOptions: { voice_id: 'chosen-voice' } }, refs),
      refs,
      context,
    );
    expect(calls).toHaveLength(1);
    expect(body(calls[0])).toMatchObject({
      script: 'Change the sky to blue',
      voice_id: 'chosen-voice',
    });
  });

  it('uploads Kling frame originals to Atlas and pins the concrete native variant', async () => {
    const { adapter, context, calls } = fixture('atlas.videos', [
      '{"url":"https://uploads.example/first.png"}',
      '{"url":"https://uploads.example/last.png"}',
      '{"data":{"id":"atlas-task","status":"processing"}}',
      '{"data":{"id":"atlas-task","status":"completed","outputs":["https://results.example/kling.mp4"]}}',
    ]);
    const refs = [input('start_frame'), input('end_frame')];
    const result = await adapter.submit(
      request('kwaivgi/kling-v3.0-pro', { durationSeconds: 5, audio: false }, refs),
      refs,
      context,
    );
    expect(body(calls[2])).toMatchObject({
      model: 'kwaivgi/kling-v3.0-pro/image-to-video',
      image: 'https://uploads.example/first.png',
      end_image: 'https://uploads.example/last.png',
      sound: false,
    });
    if (result.status !== 'running') throw new Error('Expected operation');
    expect(await adapter.poll!(result.operationId, context)).toMatchObject({ status: 'completed' });
    expect(calls[3].url).toBe('https://api.atlascloud.ai/api/v1/model/prediction/atlas-task');
  });

  it.each([
    ['alibaba/wan-2.6', { resolution: '1080p', aspectRatio: '9:16' }, { size: '1080*1920' }],
    [
      'alibaba/wan-2.7',
      { resolution: '1080P', aspectRatio: '9:16' },
      { resolution: '1080P', ratio: '9:16' },
    ],
    ['kwaivgi/kling-v3.0-std', { audio: true }, { sound: true }],
    ['kwaivgi/kling-video-o1', { durationSeconds: 10 }, { duration: 10 }],
  ])(
    'maps the native Atlas text-to-video contract for %s',
    async (modelId, parameters, expected) => {
      const { adapter, context, calls } = fixture('atlas.videos', ['{"id":"bare-prediction"}']);
      await adapter.submit(request(modelId, parameters), [], context);
      expect(body(calls[0])).toMatchObject({ model: `${modelId}/text-to-video`, ...expected });
    },
  );

  it('rejects incompatible Kling storyboards before uploading references', async () => {
    const { adapter, context, calls } = fixture('atlas.videos');
    const refs = [input('start_frame')];
    await expect(
      adapter.submit(
        request(
          'kwaivgi/kling-v3.0-pro',
          {
            durationSeconds: 5,
            providerOptions: {
              multi_shot: true,
              shot_type: 'customize',
              multi_prompt: [{ index: 1, prompt: 'one', duration: '3' }],
            },
          },
          refs,
        ),
        refs,
        context,
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    {
      api: 'alibaba.videos' as const,
      running: 'PENDING',
      failed: 'FAILED',
      response: (status: string) => ({ output: { task_id: 'saved-id', task_status: status } }),
    },
    {
      api: 'seed.videos' as const,
      running: 'queued',
      failed: 'failed',
      response: (status: string) => ({ id: 'saved-id', status }),
    },
    {
      api: 'minimax.videos' as const,
      running: 'queued',
      failed: 'failed',
      response: (status: string) => ({ task: { id: 'saved-id', status } }),
    },
    {
      api: 'heygen.videos' as const,
      running: 'waiting',
      failed: 'failed',
      response: (status: string) => ({ data: { id: 'saved-id', status, video_url: null } }),
    },
    {
      api: 'atlas.videos' as const,
      running: 'created',
      failed: 'failed',
      response: (status: string) => ({ data: { id: 'saved-id', status } }),
    },
  ])(
    'retains $api running jobs, records failure, and never resubmits unknown jobs',
    async ({ api, running, failed, response }) => {
      const { adapter, context, calls } = fixture(
        api,
        [running, failed, 'UNRECOGNIZED'].map((status) => JSON.stringify(response(status))),
      );
      const modelId = adapter.catalog!(context.config)[0].modelId;
      const token = encodeOperation({ id: 'saved-id', modelId }, context);
      expect(await adapter.poll!(token, context)).toEqual({
        status: 'running',
        operationId: token,
      });
      expect(await adapter.poll!(token, context)).toEqual({ status: 'failed' });
      await expect(adapter.poll!(token, context)).rejects.toMatchObject({ certainty: 'uncertain' });
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
    },
  );

  it.each([
    ['alibaba.videos', { output: { task_id: 'saved-id', task_status: 'CANCELED' } }],
    ['seed.videos', { id: 'saved-id', status: 'cancelled' }],
    ['minimax.videos', { task: { id: 'saved-id', status: 'cancelled' } }],
  ] as const)('preserves upstream cancellation for %s', async (api, response) => {
    const { adapter, context } = fixture(api, [JSON.stringify(response)]);
    const modelId = adapter.catalog!(context.config)[0].modelId;
    const token = encodeOperation({ id: 'saved-id', modelId }, context);
    expect(await adapter.poll!(token, context)).toEqual({ status: 'cancelled' });
  });

  it.each([
    'alibaba.videos',
    'seed.videos',
    'minimax.videos',
    'heygen.videos',
    'atlas.videos',
  ] as const)('refuses recovered %s handles under a different account', async (api) => {
    const { adapter, context, calls } = fixture(api);
    const modelId = adapter.catalog!(context.config)[0].modelId;
    const token = encodeOperation({ id: 'saved-id', modelId }, context);
    expect(decodeOperation(token, context)).toMatchObject({ id: 'saved-id', modelId });
    await expect(
      adapter.poll!(token, {
        ...context,
        connection: { ...context.connection, binding: 'different-account' },
      }),
    ).rejects.toMatchObject({ certainty: 'uncertain' });
    expect(calls).toHaveLength(0);
  });

  it('downloads original provider bytes without leaking credentials to the CDN', async () => {
    const { adapter, context, downloads } = fixture('minimax.videos');
    const stream = await adapter.download(
      { kind: 'video', ordinal: 0, type: 'video/mp4', url: 'https://results.example/download.mp4' },
      context,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('original-content');
    expect(downloads[0]).toMatchObject({
      headers: {},
      maxBytes: context.config.transfers.maxVideoBytes,
    });
  });
});
