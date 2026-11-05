import React from 'react';
import { RecoilRoot } from 'recoil';
import { request } from 'librechat-data-provider';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage, TNearAIReceipt, TNearAIAttestationResponse } from 'librechat-data-provider';
import { receipt, modelReport, gatewayReport } from 'test/fixtures/nearai';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import { prefetchReport, reportQueryOptions } from '../queries';
import Prefetch from '../Prefetch';

function message(
  id: string,
  model = receipt.model,
  scope: 'model' | 'gateway' = 'model',
  endpoint = 'NEAR AI',
): TMessage {
  const saved: TNearAIReceipt = {
    ...receipt,
    model,
    completionId: id,
    report: {
      ...receipt.report!,
      kind: 'reply',
      model,
      completionId: id,
      scope,
      ...(scope === 'gateway'
        ? {
            status: 'partial',
            attestation: gatewayReport.attestation,
            signature: { ...receipt.report!.signature!, kind: 'gateway' },
          }
        : {}),
    },
  };
  return {
    messageId: id,
    conversationId: 'chat',
    parentMessageId: 'parent',
    sender: 'NEAR AI',
    text: 'OK',
    isCreatedByUser: false,
    endpoint,
    metadata: { nearai: { receipts: [saved] } },
  };
}

function setup(messages: TMessage[], isSubmitting = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
  const content = (items: TMessage[], submitting: boolean) => (
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <Prefetch messages={items} isSubmitting={submitting} />
      </RecoilRoot>
    </QueryClientProvider>
  );
  const rendered = render(content(messages, isSubmitting));
  return {
    client,
    update: (items: TMessage[], submitting = false) =>
      rendered.rerender(content(items, submitting)),
  };
}

beforeEach(() => {
  jest.spyOn(request, 'get').mockImplementation(async (url) => {
    const parsed = new URL(String(url), 'http://localhost');
    const model = parsed.searchParams.get('model');
    return {
      enabled: true,
      model,
      status: 'verified',
      checkedAt: modelReport.verifiedAt,
      reports: [{ ...modelReport, model }],
    };
  });
});

it('prefetches once per endpoint/model/scope across a loaded message list', async () => {
  const messages = [
    message('qwen', 'Qwen/Qwen3.6-35B-A3B-FP8'),
    message('glm'),
    message('external', 'openai/gpt-4.1-mini', 'gateway'),
    message('chutes', 'deepseek/deepseek-v3.2', 'gateway'),
    message('duplicate'),
    message('gateway-scope', receipt.model, 'gateway'),
    message('other-endpoint', receipt.model, 'model', 'NEAR AI 2'),
  ];
  const { client, update } = setup(messages);
  await waitFor(() => expect(request.get).toHaveBeenCalledTimes(6));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const urls = jest
    .mocked(request.get)
    .mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
  expect(
    urls.every(
      (url) => url.searchParams.get('reports') === '1' && !url.searchParams.has('refresh'),
    ),
  ).toBe(true);
  expect(urls.filter((url) => url.searchParams.get('scope') === 'gateway')).toHaveLength(3);
  expect(urls.some((url) => url.searchParams.get('endpoint') === 'NEAR AI 2')).toBe(true);
  await act(async () => update([...messages, message('new-reply')]));
  expect(request.get).toHaveBeenCalledTimes(6);
});

it('warms restored history during generation, skips token updates, then prefetches completed reply models', async () => {
  const initial = [message('old')];
  const { client, update } = setup(initial, true);
  await waitFor(() => expect(request.get).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const next = [...initial, message('new', 'Qwen/Qwen3.6-35B-A3B-FP8')];
  update(next, true);
  expect(request.get).toHaveBeenCalledTimes(1);
  update(next);
  await waitFor(() => expect(request.get).toHaveBeenCalledTimes(2));
  update(
    [{ ...message('restored', 'deepseek/deepseek-v3.2', 'gateway'), conversationId: 'other-chat' }],
    true,
  );
  await waitFor(() => expect(request.get).toHaveBeenCalledTimes(3));
});

it('skips messages without usable server-owned verification reports', async () => {
  const base = message('base');
  const invalid = { ...receipt, report: { ...receipt.report!, completionId: 'wrong-completion' } };
  setup([
    { ...base, endpoint: 'OpenAI', metadata: {} },
    { ...base, isCreatedByUser: true },
    { ...base, isUserSubmitted: true },
    { ...base, userSubmittedPaths: ['/text'] },
    { ...base, userSubmittedMessageFieldPaths: [{ path: '/content/0', field: 'answer' }] },
    { ...base, endpoint: undefined },
    { ...base, metadata: { nearai: { receipts: [{ ...receipt, report: undefined }, invalid] } } },
  ]);
  await act(async () => {});
  expect(request.get).not.toHaveBeenCalled();
});

it.each(['failed', 'unverifiable', 'network'] as const)(
  'does not automatically retry a %s prefetch on later message updates',
  async (failure) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(request.get).mockImplementation(async () => {
      if (failure === 'network') throw new Error('offline');
      return {
        enabled: true,
        model: receipt.model,
        status: 'failed',
        checkedAt: modelReport.verifiedAt,
        reports: [{ ...modelReport, status: failure }],
      };
    });
    const messages = [message('old')];
    const { client, update } = setup(messages);
    await waitFor(() => expect(request.get).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await act(async () => update([...messages, message('new')]));
    expect(request.get).toHaveBeenCalledTimes(1);
  },
);

it('preserves invalidated evidence and refreshes only expired successful reports in the background', async () => {
  const client = new QueryClient();
  const params = { endpoint: 'NEAR AI', model: receipt.model };
  const key = reportQueryOptions(client, params).queryKey;
  await prefetchReport(client, params);
  expect(request.get).toHaveBeenCalledTimes(1);
  await client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
  await prefetchReport(client, params);
  expect(request.get).toHaveBeenCalledTimes(1);
  client.removeQueries({ queryKey: key, exact: true });
  await prefetchReport(client, params);
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001);
  await prefetchReport(client, params);
  expect(request.get).toHaveBeenCalledTimes(3);
});

it('shares one report request between the model shield and full-scope replies of the same model', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
  const shield = prefetchReport(client, { endpoint: 'NEAR AI', model: receipt.model });
  render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <Prefetch messages={[message('model-scope')]} isSubmitting={false} />
      </RecoilRoot>
    </QueryClientProvider>,
  );
  await shield;
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(request.get).toHaveBeenCalledTimes(1);
  const gatewayKey = reportQueryOptions(client, {
    endpoint: 'NEAR AI',
    model: receipt.model,
    scope: 'gateway',
  }).queryKey;
  expect(gatewayKey).not.toEqual(
    reportQueryOptions(client, { endpoint: 'NEAR AI', model: receipt.model }).queryKey,
  );
});

it.each(['gateway', 'model'] as const)(
  'shares pending automatic reports with Gateway replies only when the result is %s scoped',
  async (scope) => {
    let resolve!: (data: TNearAIAttestationResponse) => void;
    const pending = new Promise<TNearAIAttestationResponse>((done) => {
      resolve = done;
    });
    jest
      .mocked(request.get)
      .mockImplementation(async (url) =>
        String(url).includes('scope=gateway')
          ? { enabled: true, status: 'partial', reports: [gatewayReport] }
          : pending,
      );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
    const params = { endpoint: 'NEAR AI', model: receipt.model };
    const automatic = client.fetchQuery(reportQueryOptions(client, params));
    const gateway = client.fetchQuery(reportQueryOptions(client, { ...params, scope: 'gateway' }));
    expect(request.get).toHaveBeenCalledTimes(1);
    resolve({
      enabled: true,
      model: receipt.model,
      checkedAt: gatewayReport.verifiedAt,
      status: scope === 'gateway' ? 'partial' : 'verified',
      reports: scope === 'gateway' ? [gatewayReport] : [gatewayReport, modelReport],
    });
    await automatic;
    expect(await gateway).toMatchObject({ enabled: true, reports: [gatewayReport] });
    expect(request.get).toHaveBeenCalledTimes(scope === 'gateway' ? 1 : 2);
  },
);

it('uses one cache for normalized Gateway reports and still requests fresh evidence on refetch', async () => {
  jest.mocked(request.get).mockResolvedValue({
    enabled: true,
    model: receipt.model,
    status: 'partial',
    reports: [gatewayReport],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
  const params = { endpoint: 'NEAR AI', model: receipt.model };
  await prefetchReport(client, params);
  const options = reportQueryOptions(client, { ...params, scope: 'gateway' });
  expect(options.queryKey).toEqual(reportQueryOptions(client, params).queryKey);
  await prefetchReport(client, { ...params, scope: 'gateway' });
  expect(request.get).toHaveBeenCalledTimes(1);
  await client.fetchQuery({ ...options, staleTime: 0 });
  expect(request.get).toHaveBeenCalledTimes(2);
  expect(jest.mocked(request.get).mock.calls[1][0]).not.toContain('refresh=1');
  expect(jest.mocked(request.get).mock.calls[1][0]).toContain('scope=gateway');
});

it('cancels a Gateway consumer without cancelling the shared automatic report', async () => {
  let resolve!: (data: TNearAIAttestationResponse) => void;
  jest.mocked(request.get).mockImplementation(
    () =>
      new Promise<TNearAIAttestationResponse>((done) => {
        resolve = done;
      }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
  const params = { endpoint: 'NEAR AI', model: receipt.model };
  const automatic = client.fetchQuery(reportQueryOptions(client, params));
  const options = reportQueryOptions(client, { ...params, scope: 'gateway' });
  const gateway = client.fetchQuery(options);
  await Promise.all([
    expect(gateway).rejects.toMatchObject({ revert: true }),
    client.cancelQueries({ queryKey: options.queryKey, exact: true }),
  ]);
  resolve({
    enabled: true,
    model: receipt.model,
    checkedAt: gatewayReport.verifiedAt,
    status: 'partial',
    reports: [gatewayReport],
  });
  expect(await automatic).toMatchObject({ enabled: true, reports: [gatewayReport] });
  expect(request.get).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'falls back to its own Gateway request after a shared request fails (Gateway failure: %s)',
  async (gatewayFails) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let reject!: (error: Error) => void;
    const pending = new Promise<TNearAIAttestationResponse>((_resolve, fail) => {
      reject = fail;
    });
    const gatewayError = new Error('Gateway request failed');
    jest.mocked(request.get).mockImplementation(async (url) => {
      if (!String(url).includes('scope=gateway')) return pending;
      if (gatewayFails) throw gatewayError;
      return {
        enabled: true,
        model: receipt.model,
        status: 'partial',
        checkedAt: gatewayReport.verifiedAt,
        reports: [gatewayReport],
      };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
    const params = { endpoint: 'NEAR AI', model: receipt.model };
    const automatic = prefetchReport(client, params);
    const options = reportQueryOptions(client, { ...params, scope: 'gateway' });
    const gateway = client.fetchQuery(options);
    const outcome = gateway.catch((error: Error) => error);
    reject(new Error('Full request failed'));
    await automatic;
    if (gatewayFails) expect(await outcome).toBe(gatewayError);
    else expect(await outcome).toMatchObject({ enabled: true, reports: [gatewayReport] });
    expect(request.get).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(options.queryKey)?.status).toBe(gatewayFails ? 'error' : 'success');
    await prefetchReport(client, { ...params, scope: 'gateway' });
    expect(request.get).toHaveBeenCalledTimes(2);
  },
);

it('does not start a Gateway fallback after its consumer is cancelled and the shared request fails', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  let reject!: (error: Error) => void;
  jest.mocked(request.get).mockImplementation(
    () =>
      new Promise<TNearAIAttestationResponse>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
  const params = { endpoint: 'NEAR AI', model: receipt.model };
  const automatic = prefetchReport(client, params);
  const options = reportQueryOptions(client, { ...params, scope: 'gateway' });
  const gateway = client.fetchQuery(options);
  await Promise.all([
    expect(gateway).rejects.toMatchObject({ revert: true }),
    client.cancelQueries({ queryKey: options.queryKey, exact: true }),
  ]);
  reject(new Error('Full request failed'));
  await automatic;
  expect(request.get).toHaveBeenCalledTimes(1);
});

it('continues a live Gateway consumer when only the shared request is cancelled', async () => {
  let resolve!: (data: TNearAIAttestationResponse) => void;
  const pending = new Promise<TNearAIAttestationResponse>((done) => {
    resolve = done;
  });
  jest
    .mocked(request.get)
    .mockImplementation(async (url) =>
      String(url).includes('scope=gateway')
        ? { enabled: true, status: 'partial', reports: [gatewayReport] }
        : pending,
    );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
  const params = { endpoint: 'NEAR AI', model: receipt.model };
  const options = reportQueryOptions(client, params);
  const automatic = prefetchReport(client, params);
  const gateway = client.fetchQuery(reportQueryOptions(client, { ...params, scope: 'gateway' }));
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  expect(await gateway).toMatchObject({ enabled: true, reports: [gatewayReport] });
  resolve({
    enabled: true,
    model: receipt.model,
    checkedAt: gatewayReport.verifiedAt,
    status: 'partial',
    reports: [gatewayReport],
  });
  await automatic;
  expect(request.get).toHaveBeenCalledTimes(2);
});

it.each(['failed', 'unverifiable'] as const)(
  'keeps a shared Gateway %s verdict instead of retrying it as a request error',
  async (status) => {
    let resolve!: (data: TNearAIAttestationResponse) => void;
    jest.mocked(request.get).mockImplementation(
      () =>
        new Promise<TNearAIAttestationResponse>((done) => {
          resolve = done;
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(startupConfigKey(false), { nearaiEndpoints: ['NEAR AI', 'NEAR AI 2'] });
    const params = { endpoint: 'NEAR AI', model: receipt.model };
    const automatic = prefetchReport(client, params);
    const gateway = client.fetchQuery(reportQueryOptions(client, { ...params, scope: 'gateway' }));
    resolve({
      enabled: true,
      model: receipt.model,
      checkedAt: gatewayReport.verifiedAt,
      status: 'failed',
      reports: [{ ...gatewayReport, status }],
    });
    await automatic;
    expect(await gateway).toMatchObject({
      status: 'failed',
      reports: [expect.objectContaining({ status })],
    });
    await prefetchReport(client, { ...params, scope: 'gateway' });
    expect(request.get).toHaveBeenCalledTimes(1);
  },
);
