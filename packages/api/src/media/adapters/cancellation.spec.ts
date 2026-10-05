import axios from 'axios';
import { resolveMediaConfig } from 'librechat-data-provider';
import type { InternalAxiosRequestConfig } from 'axios';
import type { MediaProviderAdapter, MediaProviderContext } from '../provider';
import { createRunwayMediaAdapters } from './runway';
import { createMediaTransport } from '../transport';
import { createKreaMediaAdapters } from './krea';
import { encodeOperation } from './native';

function fixture(
  adapter: MediaProviderAdapter,
  responses: Array<{ status: number; body: string }>,
) {
  const calls: InternalAxiosRequestConfig[] = [];
  const context: MediaProviderContext = {
    jobId: 'server-job',
    connection: {
      id: 'provider',
      api: adapter.api,
      baseURL: adapter.configuration!.baseURL,
      headers: { Authorization: 'Bearer fixture', ...adapter.configuration!.headers },
      binding: 'owner-account',
    },
    config: resolveMediaConfig(),
    signal: new AbortController().signal,
    transport: createMediaTransport({
      http: axios.create({
        adapter: async (config) => {
          calls.push(config);
          const response = responses.shift();
          if (!response) throw new Error('Unexpected request');
          return {
            config,
            status: response.status,
            statusText: '',
            headers: {},
            data: response.body,
          };
        },
      }),
    }),
  };
  const operationId = encodeOperation(
    {
      id: 'owned-operation',
      modelId: adapter.api === 'runway.videos' ? 'runway/gen-4.5' : 'krea/krea-2-large',
    },
    context,
  );
  return { context, operationId, calls };
}

describe('verified provider cancellation contracts', () => {
  const runway = createRunwayMediaAdapters()[0];
  const krea = createKreaMediaAdapters()[0];

  it('uses Runway DELETE 204 without claiming that cancellation refunds the task', async () => {
    const { context, operationId, calls } = fixture(runway, [
      { status: 200, body: JSON.stringify({ id: 'owned-operation', status: 'RUNNING' }) },
      { status: 204, body: '' },
    ]);
    expect(await runway.cancel!.request(operationId, context, async () => undefined)).toEqual({
      status: 'cancelled',
    });
    expect(calls.map((call) => call.method)).toEqual(['get', 'delete']);
    expect(calls[1]).toMatchObject({
      url: 'https://api.dev.runwayml.com/v1/tasks/owned-operation',
      timeout: context.config.timeouts.pollRequestMs,
    });
    expect(calls[1].headers.get('X-Runway-Version')).toBe('2024-11-06');
  });

  it('recovers Runway cancellation after lost acknowledgment using its documented idempotent 404', async () => {
    const { context, operationId } = fixture(runway, [
      { status: 404, body: '{}' },
      { status: 404, body: '{}' },
    ]);
    expect(await runway.cancel!.request(operationId, context, async () => undefined)).toEqual({
      status: 'cancelled',
    });
  });

  it('keeps an already-completed Runway result and its actual cost instead of deleting it', async () => {
    const { context, operationId, calls } = fixture(runway, [
      {
        status: 200,
        body: JSON.stringify({
          id: 'owned-operation',
          status: 'SUCCEEDED',
          output: ['https://cdn.example/result.mp4'],
          cost: { credits: 60 },
        }),
      },
    ]);
    expect(await runway.cancel!.request(operationId, context, async () => undefined)).toMatchObject(
      {
        status: 'completed',
        usage: { costUSD: 0.6 },
      },
    );
    expect(calls).toHaveLength(1);
  });

  it('does not treat an unexpected Runway 202 response as terminal cancellation', async () => {
    const { context, operationId } = fixture(runway, [
      { status: 200, body: JSON.stringify({ id: 'owned-operation', status: 'RUNNING' }) },
      { status: 202, body: '{}' },
    ]);
    await expect(
      runway.cancel!.request(operationId, context, async () => undefined),
    ).rejects.toMatchObject({
      certainty: 'uncertain',
      status: 202,
    });
  });

  it('waits for Krea terminal confirmation before reporting cancellation or a zero cost', async () => {
    const { context, operationId, calls } = fixture(krea, [
      { status: 200, body: JSON.stringify({ job_id: 'owned-operation', status: 'processing' }) },
      { status: 200, body: '' },
      { status: 200, body: JSON.stringify({ job_id: 'owned-operation', status: 'cancelled' }) },
    ]);
    expect(await krea.cancel!.request(operationId, context, async () => undefined)).toEqual({
      status: 'cancellation_requested',
    });
    expect(await krea.poll!(operationId, context)).toEqual({
      status: 'cancelled',
      usage: { costUSD: 0 },
    });
    expect(calls.map((call) => call.method)).toEqual(['get', 'delete', 'get']);
    expect(krea.cancel!.retry).toBe('never');
  });

  it('defers Krea cancellation outside its documented queued/processing states', async () => {
    const { context, operationId, calls } = fixture(krea, [
      { status: 200, body: JSON.stringify({ job_id: 'owned-operation', status: 'backlogged' }) },
    ]);
    expect(await krea.cancel!.request(operationId, context, async () => undefined)).toEqual({
      status: 'cancellation_deferred',
    });
    expect(calls).toHaveLength(1);
  });

  it('does not interpret Krea missing-or-unauthorized 404 as proof of cancellation', async () => {
    const { context, operationId } = fixture(krea, [{ status: 404, body: '{}' }]);
    await expect(
      krea.cancel!.request(operationId, context, async () => undefined),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([runway, krea])(
    'checks the frozen account binding before cancelling $api',
    async (adapter) => {
      const { context, operationId, calls } = fixture(adapter, []);
      context.connection.binding = 'another-account';
      await expect(
        adapter.cancel!.request(operationId, context, async () => undefined),
      ).rejects.toBeDefined();
      expect(calls).toHaveLength(0);
    },
  );

  it.each([runway, krea])(
    'fences the persisted attempt immediately before mutating $api',
    async (adapter) => {
      const { context, operationId, calls } = fixture(adapter, [
        {
          status: 200,
          body: JSON.stringify(
            adapter.api === 'runway.videos'
              ? { id: 'owned-operation', status: 'RUNNING' }
              : { job_id: 'owned-operation', status: 'processing' },
          ),
        },
      ]);
      await expect(
        adapter.cancel!.request(operationId, context, async () => {
          expect(calls.map((call) => call.method)).toEqual(['get']);
          throw new Error('The worker lease changed.');
        }),
      ).rejects.toThrow('The worker lease changed.');
      expect(calls.map((call) => call.method)).toEqual(['get']);
    },
  );

  it.each([runway, krea])(
    'allows operators to disable cancellation for new $api jobs',
    (adapter) => {
      const config = resolveMediaConfig({ cancellation: { enabled: false } });
      expect(
        adapter.catalog!(config).every((model) =>
          model.capabilities.every(
            (capability) =>
              capability.execution.kind === 'remote-job' &&
              capability.execution.cancellation === 'unsupported',
          ),
        ),
      ).toBe(true);
    },
  );
});
