import { z } from 'zod';
import { resolveMediaConfig, mediaSubmissionRequestSchema } from 'librechat-data-provider';
import type { MediaTransport, MediaTransportRequest } from '../transport';
import type { MediaProviderContext } from '../provider';
import { createMediaCatalog, validateMediaOffering } from '../catalog';
import { createVertexVideoAdapter } from './veo';
import { createRESTMediaAdapters } from './rest';

const model = 'veo-3.1-fast-generate-001';
const baseURL =
  'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/';
const operation = `projects/test-project/locations/us-central1/publishers/google/models/${model}/operations/job-1`;
const request = mediaSubmissionRequestSchema.parse({
  clientRequestId: 'request',
  operation: 'video.generate',
  prompt: 'A sailboat on calm water',
  selection: { connectionId: 'vertex', modelId: model, catalogVersion: 'catalog' },
  parameters: {
    count: 1,
    durationSeconds: 4,
    resolution: '720p',
    aspectRatio: '16:9',
    audio: false,
  },
});

function fixture(responses: unknown[] = []) {
  const calls: MediaTransportRequest[] = [];
  const transport: MediaTransport = {
    async json<T>(input: MediaTransportRequest, schema: z.ZodType<T>) {
      calls.push(input);
      return schema.parse(responses.shift());
    },
    async stream() {
      throw new Error('Unexpected external download');
    },
  };
  const context: MediaProviderContext = {
    jobId: 'server-job',
    transport,
    connection: {
      id: 'vertex',
      api: 'google.vertex.videos',
      baseURL,
      headers: { Authorization: 'Bearer access-token' },
      binding: 'service-account',
    },
    config: resolveMediaConfig(),
    signal: new AbortController().signal,
  };
  return { context, calls, transport };
}

describe('Vertex Veo adapter', () => {
  const adapter = createVertexVideoAdapter();

  it('uses the advertised conditional default of eight seconds for reference images', async () => {
    const { context, calls } = fixture([{ name: operation }]);
    await adapter.submit(
      { ...request, parameters: { count: 1 } },
      [{ role: 'reference', file_id: 'reference', type: 'image/png', data: Buffer.from('image') }],
      context,
    );
    expect(JSON.parse(calls[0].body as string).parameters.durationSeconds).toBe(8);
  });

  it('submits once to Vertex and retains the complete operation resource for recovery', async () => {
    const { context, calls } = fixture([{ name: operation }]);
    expect(await adapter.submit(request, [], context)).toEqual({
      status: 'running',
      operationId: operation,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${baseURL}models/${model}:predictLongRunning`);
    expect(calls[0].headers).toEqual({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(calls[0].body as string)).toEqual({
      instances: [{ prompt: request.prompt }],
      parameters: {
        sampleCount: 1,
        durationSeconds: 4,
        resolution: '720p',
        aspectRatio: '16:9',
        generateAudio: false,
      },
    });
  });

  it.each(['veo-3.1-fast-generate-001', 'veo-3.1-generate-001', 'veo-3.1-lite-generate-001'])(
    'extends a previous video through the native video field for %s',
    async (modelId) => {
      const operationId = operation.replace(model, modelId);
      const { context, calls } = fixture([{ name: operationId }]);
      const data = Buffer.from('previous-generation');
      expect(
        await adapter.submit(
          {
            ...request,
            threadId: 'thread',
            parentTurnId: 'previous-turn',
            selection: { ...request.selection, modelId },
            inputs: [{ role: 'video', file_id: 'previous-video' }],
            parameters: { count: 1 },
          },
          [{ role: 'video', file_id: 'previous-video', type: 'video/mp4', data }],
          context,
        ),
      ).toEqual({ status: 'running', operationId });
      const body = JSON.parse(calls[0].body as string);
      expect(body.instances).toEqual([
        {
          prompt: request.prompt,
          video: { mimeType: 'video/mp4', bytesBase64Encoded: data.toString('base64') },
        },
      ]);
      expect(body.parameters).toEqual({
        sampleCount: 1,
        aspectRatio: '16:9',
        resolution: '720p',
        generateAudio: false,
      });
      expect(calls).toHaveLength(1);
    },
  );

  it('rejects incompatible video references before sending a provider request', async () => {
    const { context, calls } = fixture();
    const video = {
      role: 'video' as const,
      file_id: 'previous',
      type: 'video/mp4',
      data: Buffer.from('video'),
    };
    const extension = { ...request, parameters: { count: 1, durationSeconds: 7 } };
    for (const inputs of [
      [video, { ...video, file_id: 'second' }],
      [
        video,
        {
          role: 'start_frame' as const,
          file_id: 'image',
          type: 'image/png',
          data: Buffer.from('image'),
        },
      ],
      [{ ...video, type: 'video/webm' }],
    ]) {
      await expect(adapter.submit(extension, inputs, context)).rejects.toMatchObject({
        certainty: 'rejected',
      });
    }
    await expect(adapter.submit(request, [video], context)).rejects.toMatchObject({
      certainty: 'rejected',
    });
    await expect(adapter.submit(extension, [], context)).rejects.toMatchObject({
      certainty: 'rejected',
    });
    context.config.transfers.maxVideoBytes = 1;
    await expect(adapter.submit(extension, [video], context)).rejects.toMatchObject({
      certainty: 'rejected',
    });
    expect(calls).toHaveLength(0);
  });

  it('polls the original operation and decodes all complete video bytes', async () => {
    const bytes = Buffer.from('complete-video-fixture');
    const { context, calls } = fixture([
      { name: operation },
      {
        name: operation,
        done: true,
        response: {
          videos: [{ bytesBase64Encoded: bytes.toString('base64'), mimeType: 'video/mp4' }],
        },
      },
    ]);
    expect(await adapter.poll!(operation, context)).toEqual({
      status: 'running',
      operationId: operation,
    });
    const result = await adapter.poll!(operation, context);
    expect(result).toEqual({
      status: 'completed',
      parts: [{ kind: 'video', ordinal: 0, type: 'video/mp4', data: bytes }],
    });
    expect(
      calls.every((call) => call.url === `${baseURL}models/${model}:fetchPredictOperation`),
    ).toBe(true);
    expect(calls.every((call) => JSON.parse(call.body as string).operationName === operation)).toBe(
      true,
    );
    expect(calls[1].timeoutMs).toBe(context.config.timeouts.pollRequestMs);
  });

  it.each([
    operation.replace('test-project', 'another-project'),
    operation.replace('us-central1', 'europe-west1'),
    operation.replace(model, 'unconfigured-model'),
    operation.replace('job-1', '../elsewhere'),
    'https://untrusted.example/operation',
  ])(
    'rejects an operation outside the original Vertex scope before making a request: %s',
    async (id) => {
      const { context, calls } = fixture();
      await expect(adapter.poll!(id, context)).rejects.toMatchObject({ certainty: 'uncertain' });
      expect(calls).toHaveLength(0);
    },
  );

  it('does not accept a response naming another operation', async () => {
    const { context } = fixture([{ name: operation.replace('job-1', 'job-2'), done: false }]);
    await expect(adapter.poll!(operation, context)).rejects.toMatchObject({
      certainty: 'uncertain',
    });
  });

  it.each([
    {
      result: { error: { code: 8, message: 'Quota exceeded' } },
      diagnostic: { code: '8', message: 'Quota exceeded' },
    },
    {
      result: {
        response: {
          raiMediaFilteredCount: 1,
          raiMediaFilteredReasons: ['Safety filter'],
          videos: [],
        },
      },
      diagnostic: { code: 'CONTENT_FILTERED', message: 'Safety filter' },
    },
  ])(
    'records confirmed terminal provider failures without re-submitting',
    async ({ result, diagnostic }) => {
      const { context, calls } = fixture([{ name: operation, done: true, ...result }]);
      expect(await adapter.poll!(operation, context)).toEqual({ status: 'failed', diagnostic });
      expect(calls).toHaveLength(1);
    },
  );

  it('redacts provider credentials and bounds a terminal failure message', async () => {
    const { context } = fixture([
      {
        name: operation,
        done: true,
        error: { code: 3, message: 'Bad input for Bearer access-token. ' + 'x'.repeat(100) },
      },
    ]);
    context.config.recovery.maxDiagnosticMessageChars = 48;
    const result = await adapter.poll!(operation, context);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected a terminal failure');
    expect(result.diagnostic?.message).toContain('[redacted]');
    expect(result.diagnostic?.message).not.toContain('access-token');
    expect(result.diagnostic?.message?.length).toBeLessThanOrEqual(48);
  });

  it.each(['not base64', 'YWJj'])(
    'rejects malformed or oversized inline video output: %s',
    async (encoded) => {
      const { context } = fixture([
        {
          name: operation,
          done: true,
          response: { videos: [{ bytesBase64Encoded: encoded, mimeType: 'video/mp4' }] },
        },
      ]);
      context.config.transfers.maxVideoBytes = 2;
      await expect(adapter.poll!(operation, context)).rejects.toThrow();
    },
  );

  it('sends first and last frame bytes through the native Vertex image fields', async () => {
    const { context, calls } = fixture([{ name: operation }]);
    await adapter.submit(
      request,
      [
        { role: 'start_frame', file_id: 'first', type: 'image/png', data: Buffer.from('first') },
        { role: 'end_frame', file_id: 'last', type: 'image/jpeg', data: Buffer.from('last') },
      ],
      context,
    );
    expect(JSON.parse(calls[0].body as string).instances[0]).toMatchObject({
      image: { mimeType: 'image/png', bytesBase64Encoded: Buffer.from('first').toString('base64') },
      lastFrame: {
        mimeType: 'image/jpeg',
        bytesBase64Encoded: Buffer.from('last').toString('base64'),
      },
    });
  });

  it('maps the canonical Lite model while preserving scoped native operation recovery', async () => {
    const native = 'veo-3.1-lite-generate-001';
    const id = operation.replace(model, native);
    const { context, calls } = fixture([{ name: id }]);
    const selected = {
      ...request,
      selection: { ...request.selection, modelId: 'google/veo-3.1-lite' },
    };
    await expect(adapter.submit(selected, [], context)).resolves.toEqual({
      status: 'running',
      operationId: id,
    });
    expect(calls[0].url).toContain(`models/${native}:predictLongRunning`);
    await expect(
      adapter.submit(
        selected,
        [{ role: 'reference', file_id: 'ref', type: 'image/png', data: Buffer.from('reference') }],
        context,
      ),
    ).rejects.toMatchObject({ certainty: 'rejected' });
    expect(calls).toHaveLength(1);
  });

  it('sends asset references only for eight-second reference-to-video requests', async () => {
    const { context, calls } = fixture([{ name: operation }]);
    const input = {
      role: 'reference' as const,
      file_id: 'ref',
      type: 'image/png',
      data: Buffer.from('reference'),
    };
    await expect(adapter.submit(request, [input], context)).rejects.toMatchObject({
      certainty: 'rejected',
    });
    await adapter.submit(
      mediaSubmissionRequestSchema.parse({
        ...request,
        parameters: { ...request.parameters, durationSeconds: 8 },
      }),
      [input],
      context,
    );
    expect(JSON.parse(calls[0].body as string).instances[0].referenceImages).toEqual([
      {
        image: { mimeType: 'image/png', bytesBase64Encoded: input.data.toString('base64') },
        referenceType: 'asset',
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('never forwards Vertex credentials to a supplied download URL', async () => {
    const { context, calls } = fixture();
    await expect(
      adapter.download(
        { kind: 'video', ordinal: 0, type: 'video/mp4', url: 'https://untrusted.example/video' },
        context,
      ),
    ).rejects.toMatchObject({ certainty: 'uncertain' });
    expect(calls).toHaveLength(0);
  });

  it('exposes native Vertex video controls in the catalog without exposing credentials', async () => {
    const { context, calls, transport } = fixture();
    const config = resolveMediaConfig({
      enabled: true,
      limits: { maxOutputs: 2 },
      integrations: [
        {
          id: 'vertex',
          label: 'Google (Vertex AI)',
          api: 'google.vertex.videos',
          endpointRef: { kind: 'vertex', keyFile: '/secret/auth.json' },
          catalog: {
            kind: 'configured',
            models: [model, 'veo-3.1-generate-001', 'unimplemented-model'],
          },
          operations: ['video.generate'],
        },
      ],
    });
    const catalog = createMediaCatalog({
      transport,
      adapters: createRESTMediaAdapters(),
      now: () => 0,
    });
    const snapshot = await catalog.read(config, async () => context.connection, {
      ownerId: 'owner',
      tenantId: null,
    });
    expect(
      snapshot.catalog.offerings.map((o) => ({ name: o.modelName, available: o.available })),
    ).toEqual([
      { name: 'Veo 3.1 Fast', available: true },
      { name: 'Veo 3.1', available: true },
      { name: 'unimplemented-model', available: false },
    ]);
    const offering = snapshot.catalog.offerings[0];
    expect(offering.connectionName).toBe('Google (Vertex AI)');
    expect(offering.capabilities[0].controls.count).toEqual({ min: 1, max: 2 });
    expect(() => validateMediaOffering(request, offering)).not.toThrow();
    expect(() =>
      validateMediaOffering({ ...request, parameters: { count: 3 } }, offering),
    ).toThrow();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(snapshot.catalog)).not.toMatch(
      /auth\.json|access-token|service-account|test-project/,
    );
  });
});
