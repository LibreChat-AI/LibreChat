import React from 'react';
import axios from 'axios';
import { RecoilRoot } from 'recoil';
import { ThemeProvider } from '@librechat/client';
import { request, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TNearAIAttestationResponse } from 'librechat-data-provider';
import { report, receipt, modelReport, gatewayReport, viewerUrl } from 'test/fixtures/nearai';
import { prefetchReport, reportQueryOptions } from '../queries';
import { ModelShield } from '../Shield';
import Signature from '../Signature';

jest.mock('~/hooks', () => ({
  useLocalize: jest.requireActual('~/hooks/useLocalize').default,
}));

const status = {
  enabled: true,
  model: 'z-ai/glm-5.3-flash',
  status: 'verified',
  checkedAt: report.verifiedAt,
} satisfies TNearAIAttestationResponse;

function setup(model = 'z-ai/glm-5.3-flash', children?: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = (selected: string) => (
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ThemeProvider initialTheme="light">
          <ModelShield endpoint="NEAR AI" model={selected} />
          {children}
        </ThemeProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const rendered = render(host(model));
  return { ...rendered, client, select: (selected: string) => rendered.rerender(host(selected)) };
}

function reportRequests() {
  return jest.mocked(request.get).mock.calls.filter(([url]) => String(url).includes('reports=1'));
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  jest.spyOn(request, 'get').mockImplementation(async (url) => {
    if (String(url).includes('reports=1')) return { ...status, reports: [modelReport] };
    if (String(url).includes('/nearai/attestation')) return status;
    return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
  });
});

it('prefetches supported model reports before click, sends them to the iframe, and restores focus on close', async () => {
  setup();
  const shield = await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  await waitFor(() => expect(reportRequests()).toHaveLength(1));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(shield);
  const frame = (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
  await waitFor(() => expect(frame.src).toContain('cloud-stg.near.ai'));
  expect(new URL(frame.src).searchParams.has('layout')).toBe(false);
  expect(screen.getByRole('dialog', { name: 'Model verification' })).toBeVisible();
  const post = jest.spyOn(frame.contentWindow!, 'postMessage');
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://cloud-stg.near.ai',
        source: frame.contentWindow,
        data: { type: 'NEAR_AI_VERIFICATION_CENTER_READY', version: 1, requestId: 'model-1' },
      }),
    ),
  );
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ reports: [modelReport] }),
    'https://cloud-stg.near.ai',
  );
  expect(reportRequests()).toHaveLength(1);
  expect(reportRequests()[0][0]).not.toContain('refresh=1');
  expect(screen.getByText('Hardware checked at')).toBeVisible();
  expect(document.querySelector('time')).toHaveAttribute('datetime', modelReport.verifiedAt);
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://cloud-stg.near.ai',
        source: frame.contentWindow,
        data: { type: 'NEAR_AI_VERIFICATION_CLOSE', version: 1, requestId: 'model-1' },
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(shield).toHaveFocus());
});

it.each([
  'Qwen/Qwen3.6-35B-A3B-FP8',
  'z-ai/glm-5.3-flash',
  'openai/gpt-4.1-mini',
  'deepseek/deepseek-v3.2',
])(
  'warms %s on selection before status verification finishes and reuses it on return',
  async (model) => {
    let finishStatus!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishStatus = resolve;
    });
    jest.mocked(request.get).mockImplementation(async (url) => {
      if (!String(url).includes('/nearai/attestation')) {
        return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
      }
      const parsed = new URL(String(url), 'http://localhost');
      const selected = parsed.searchParams.get('model')!;
      const gateway = selected.startsWith('openai/') || selected.startsWith('deepseek/');
      const result = {
        ...status,
        model: selected,
        status: gateway ? ('partial' as const) : ('verified' as const),
      };
      if (parsed.searchParams.has('reports')) {
        return {
          ...result,
          reports: (gateway ? [gatewayReport] : [gatewayReport, modelReport]).map((entry) => ({
            ...entry,
            model: selected,
          })),
        };
      }
      await pending;
      return result;
    });
    const { client, select } = setup(model);
    await waitFor(() => expect(reportRequests()).toHaveLength(1));
    await waitFor(() => expect(client.isFetching()).toBe(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('header-nearai-shield'));
    await screen.findByTitle('NEAR AI Verification Center');
    expect(client.isFetching()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const other =
      model === 'z-ai/glm-5.3-flash' ? 'Qwen/Qwen3.6-35B-A3B-FP8' : 'z-ai/glm-5.3-flash';
    select(other);
    await waitFor(() => expect(reportRequests()).toHaveLength(2));
    select(model);
    await act(async () => finishStatus());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    fireEvent.click(screen.getByTestId('header-nearai-shield'));
    const frame = await screen.findByTitle('NEAR AI Verification Center');
    expect(new URL(frame.getAttribute('src')!).searchParams.get('model')).toBe(model);
    expect(reportRequests()).toHaveLength(2);
    expect(reportRequests().every(([url]) => !String(url).includes('refresh=1'))).toBe(true);
  },
);

it('recovers verification after a user saves a missing provider key without reloading the page', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const saveKeyLabel = 'Save key';
  let saved = false;
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest.mocked(request.get).mockImplementation(async (url, ...args) => {
    if (String(url).includes('/nearai/attestation') && !saved) throw new Error('unavailable');
    return original(url, ...args);
  });
  jest.spyOn(axios, 'put').mockImplementation(async () => {
    saved = true;
    return { data: {} };
  });
  function SaveKey() {
    const mutation = useUpdateUserKeysMutation();
    return (
      <button onClick={() => mutation.mutate({ name: 'NEAR AI', value: 'new-key', expiresAt: '' })}>
        {saveKeyLabel}
      </button>
    );
  }
  const { client } = setup(status.model, <SaveKey />);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
    'NEAR AI attestation failed',
  );
  fireEvent.click(screen.getByRole('button', { name: saveKeyLabel }));
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(2);
});

it('requests fresh evidence when Verify again is clicked', async () => {
  let resolve!: (value: TNearAIAttestationResponse) => void;
  const pending = new Promise<TNearAIAttestationResponse>((done) => {
    resolve = done;
  });
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest
    .mocked(request.get)
    .mockImplementation((url, ...args) =>
      String(url).includes('refresh=1') ? pending : original(url, ...args),
    );
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() => expect(reportRequests()).toHaveLength(2));
  expect(reportRequests()[0][0]).not.toContain('refresh=1');
  expect(reportRequests()[1][0]).toContain('refresh=1');
  expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
    'Checking NEAR AI attestation…',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByTestId('header-nearai-shield'));
  expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
    'Checking NEAR AI attestation…',
  );
  expect(screen.getByText('Verifying hardware…')).toBeVisible();
  expect(reportRequests()).toHaveLength(2);
  await act(async () => resolve({ ...status, reports: [modelReport] }));
  await screen.findByTitle('NEAR AI Verification Center');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByTestId('header-nearai-shield'));
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(2);
});

it.each(['verified', 'partial'] as const)(
  'refreshes status only after explicit re-verification and keeps the %s shield during that refresh',
  async (verdict) => {
    const model = verdict === 'partial' ? 'openai/gpt-4.1-mini' : status.model;
    const current = { ...status, model, status: verdict };
    const reports = [{ ...(verdict === 'partial' ? gatewayReport : modelReport), model }];
    let resolve!: (value: TNearAIAttestationResponse) => void;
    let statusRequests = 0;
    const refresh = new Promise<TNearAIAttestationResponse>((done) => {
      resolve = done;
    });
    jest.mocked(request.get).mockImplementation(async (url) => {
      if (String(url).includes('reports=1')) return { ...current, reports };
      if (String(url).includes('/nearai/attestation')) {
        return ++statusRequests === 1 ? current : refresh;
      }
      return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
    });
    const { client } = setup(model);
    const label =
      verdict === 'partial'
        ? 'NEAR AI Gateway verified; model execution is not attested'
        : 'NEAR AI attestation verified';
    const shield = await screen.findByRole('button', { name: label });
    fireEvent.click(shield);
    const frame = (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
    await waitFor(() => expect(frame.src).toContain('cloud-stg.near.ai'));
    expect(statusRequests).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
    await waitFor(() => expect(statusRequests).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      client.isFetching({ queryKey: [QueryKeys.nearaiAttestation, 'NEAR AI', model], exact: true }),
    ).toBe(1);
    expect(shield).toHaveAccessibleName(label);
    await act(async () => resolve({ ...current, status: 'failed' }));
    await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation failed'));
  },
);

it('shows loading in the first dialog commit before a report arrives', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observed: string[] = [];
  const current = jest.mocked(request.get).getMockImplementation()!;
  let resolve!: (value: TNearAIAttestationResponse) => void;
  const delayed = new Promise<TNearAIAttestationResponse>((done) => {
    resolve = done;
  });
  jest
    .mocked(request.get)
    .mockImplementation((url, ...args) =>
      String(url).includes('reports=1') ? delayed : current(url, ...args),
    );
  render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ThemeProvider initialTheme="light">
          <React.Profiler
            id="verification"
            onRender={() => {
              const dialog = document.querySelector('[role="dialog"]');
              if (dialog) observed.push(dialog.textContent ?? '');
            }}
          >
            <ModelShield endpoint="NEAR AI" model="z-ai/glm-5.3-flash" />
          </React.Profiler>
        </ThemeProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
    'NEAR AI attestation verified',
  );
  expect(observed.length).toBeGreaterThan(0);
  expect(observed[0]).toContain('Verifying hardware');
  expect(observed.every((text) => !text.includes('viewer is unavailable'))).toBe(true);
  await act(async () => resolve({ ...status, reports: [modelReport] }));
  await screen.findByTitle('NEAR AI Verification Center');
});

it('recovers from a report request failure without displaying stale verification', async () => {
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const get = jest.mocked(request.get);
  const implementation = get.getMockImplementation()!;
  let failed = false;
  get.mockImplementation(async (url, ...args) => {
    if (String(url).includes('reports=1') && !failed) {
      throw new Error('offline');
    }
    return implementation(url, ...args);
  });
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not reach the verification service',
  );
  expect(screen.queryByTitle('NEAR AI Verification Center')).not.toBeInTheDocument();
  expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
  failed = true;
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await screen.findByTitle('NEAR AI Verification Center');
});

it('hides the model shield when the endpoint does not support verification', async () => {
  jest.mocked(request.get).mockResolvedValue({ enabled: false });
  setup();
  await waitFor(() => expect(screen.queryByTestId('header-nearai-shield')).not.toBeInTheDocument());
  expect(reportRequests()).toHaveLength(0);
});

it('reuses successful reports for five minutes and fetches once after expiry', async () => {
  setup();
  const shield = await screen.findByTestId('header-nearai-shield');
  await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation verified'));
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001);
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(2);
});

it.each(['failed', 'unverifiable'] as const)(
  'refetches %s reports when reopened',
  async (verdict) => {
    const original = jest.mocked(request.get).getMockImplementation()!;
    jest
      .mocked(request.get)
      .mockImplementation(async (url, ...args) =>
        String(url).includes('reports=1')
          ? { ...status, reports: [{ ...modelReport, status: verdict }] }
          : original(url, ...args),
      );
    const { client } = setup();
    const shield = await screen.findByTestId('header-nearai-shield');
    await waitFor(() => expect(reportRequests()).toHaveLength(1));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    fireEvent.click(shield);
    await screen.findByTitle('NEAR AI Verification Center');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(shield);
    await waitFor(() => expect(reportRequests()).toHaveLength(3));
  },
);

it('invalidates old successful reports after a re-verification request fails and retries on reopen', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest.mocked(request.get).mockImplementation(async (url, ...args) => {
    if (String(url).includes('refresh=1')) throw new Error('offline');
    return original(url, ...args);
  });
  const { client } = setup();
  const shield = await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach');
  expect(screen.queryByTitle('NEAR AI Verification Center')).not.toBeInTheDocument();
  expect(
    client.getQueryState([QueryKeys.nearaiAttestation, 'NEAR AI', status.model, 'reports']),
  ).toMatchObject({ isInvalidated: true, data: { ...status, reports: [modelReport] } });
  expect(reportRequests()).toHaveLength(2);
  expect(shield).toHaveAccessibleName('NEAR AI attestation verified');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(3);
});

it.each(['failed', 'unverifiable'] as const)(
  'keeps a delayed %s re-verification result without automatically requesting another report',
  async (verdict) => {
    let resolve!: (value: TNearAIAttestationResponse) => void;
    const pending = new Promise<TNearAIAttestationResponse>((done) => {
      resolve = done;
    });
    const original = jest.mocked(request.get).getMockImplementation()!;
    jest
      .mocked(request.get)
      .mockImplementation((url, ...args) =>
        String(url).includes('refresh=1') ? pending : original(url, ...args),
      );
    const { client } = setup();
    const shield = await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
    fireEvent.click(shield);
    await screen.findByTitle('NEAR AI Verification Center');
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
    await waitFor(() => expect(shield).toHaveAccessibleName('Checking NEAR AI attestation…'));
    await act(async () =>
      resolve({
        ...status,
        status: 'failed',
        reports: [{ ...modelReport, status: verdict }],
      }),
    );
    await waitFor(() => expect(client.isMutating()).toBe(0));
    const frame = (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
    // Drain the scheduled query notifications so an unintended follow-up request is counted.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(reportRequests()).toHaveLength(2);
    // Only rejected evidence turns the shield red; unverifiable stays on the chat status.
    expect(shield).toHaveAccessibleName(
      verdict === 'failed' ? 'NEAR AI attestation failed' : 'NEAR AI attestation verified',
    );
    const post = jest.spyOn(frame.contentWindow!, 'postMessage');
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://cloud-stg.near.ai',
          source: frame.contentWindow,
          data: {
            type: 'NEAR_AI_VERIFICATION_CENTER_READY',
            version: 1,
            requestId: 'failed-refresh',
          },
        }),
      ),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ reports: [expect.objectContaining({ status: verdict })] }),
      'https://cloud-stg.near.ai',
    );
  },
);

it('retains an explicit hardware failure across a delayed network failure until a successful report replaces it', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  let reject!: (error: Error) => void;
  const pending = new Promise<TNearAIAttestationResponse>((_resolve, fail) => {
    reject = fail;
  });
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest.mocked(request.get).mockImplementation((url, ...args) => {
    if (String(url).includes('refresh=1')) return pending;
    if (String(url).includes('reports=1'))
      return Promise.resolve({
        ...status,
        status: 'failed',
        reports: [{ ...modelReport, status: 'failed' }],
      });
    return original(url, ...args);
  });
  const { client } = setup();
  const shield = await screen.findByTestId('header-nearai-shield');
  await waitFor(() => expect(reportRequests()).toHaveLength(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  fireEvent.click(shield);
  await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation failed'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Verify again' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() => expect(shield).toHaveAccessibleName('Checking NEAR AI attestation…'));
  await act(async () => reject(new Error('offline')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach');
  expect(shield).toHaveAccessibleName('NEAR AI attestation failed');
  expect(reportRequests()).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  let resolve!: (value: TNearAIAttestationResponse) => void;
  const retry = new Promise<TNearAIAttestationResponse>((done) => {
    resolve = done;
  });
  jest
    .mocked(request.get)
    .mockImplementation((url, ...args) =>
      String(url).includes('reports=1') ? retry : original(url, ...args),
    );
  fireEvent.click(shield);
  await waitFor(() => expect(reportRequests()).toHaveLength(4));
  expect(shield).toHaveAccessibleName('NEAR AI attestation failed');
  await act(async () => resolve({ ...status, reports: [modelReport] }));
  await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation verified'));
});

it('recovers a failed status after successful re-verification', async () => {
  let refreshed = false;
  jest.mocked(request.get).mockImplementation(async (url) => {
    if (!String(url).includes('/nearai/attestation'))
      return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
    if (String(url).includes('refresh=1')) refreshed = true;
    return {
      ...status,
      status: refreshed ? 'verified' : 'failed',
      ...(String(url).includes('reports=1') ? { reports: [modelReport] } : {}),
    };
  });
  setup();
  const shield = await screen.findByRole('button', { name: 'NEAR AI attestation failed' });
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation verified'));
});

it('prevents a late ordinary request from overwriting explicit re-verification', async () => {
  let resolve!: (value: TNearAIAttestationResponse) => void;
  const pending = new Promise<TNearAIAttestationResponse>((done) => {
    resolve = done;
  });
  const { client } = setup();
  const shield = await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest.mocked(request.get).mockImplementation(async (url, ...args) => {
    if (String(url).includes('refresh=1')) {
      return { ...status, status: 'failed', reports: [{ ...modelReport, status: 'failed' }] };
    }
    return String(url).includes('reports=1') ? pending : original(url, ...args);
  });
  act(() => {
    void client.refetchQueries({
      queryKey: [QueryKeys.nearaiAttestation, 'NEAR AI', status.model, 'reports'],
      exact: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  });
  await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation failed'));
  await act(async () => resolve({ ...status, reports: [modelReport] }));
  expect(shield).toHaveAccessibleName('NEAR AI attestation failed');
  expect(reportRequests()).toHaveLength(3);
});

it('keeps model report caches separate when switching models and reuses each on return', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = (model: string) => (
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ThemeProvider initialTheme="light">
          <ModelShield endpoint="NEAR AI" model={model} />
        </ThemeProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  jest.mocked(request.get).mockImplementation(async (url) => {
    if (!String(url).includes('/nearai/attestation'))
      return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
    const model = new URL(String(url), 'http://localhost').searchParams.get('model');
    return {
      ...status,
      model,
      ...(String(url).includes('reports=1') ? { reports: [{ ...modelReport, model }] } : {}),
    };
  });
  const { rerender } = render(host(status.model));
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  rerender(host('Qwen/Qwen3.6-35B-A3B-FP8'));
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  const frame = await screen.findByTitle('NEAR AI Verification Center');
  expect(frame).toHaveAttribute('src', expect.stringContaining('model=Qwen'));
  expect(reportRequests()).toHaveLength(2);
  rerender(host(status.model));
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  const restored = await screen.findByTitle('NEAR AI Verification Center');
  expect(restored).toHaveAttribute('src', expect.stringContaining('model=z-ai'));
  expect(reportRequests()).toHaveLength(2);
});

it('retains a failed re-verification across closing and reopening despite a successful status poll', async () => {
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest
    .mocked(request.get)
    .mockImplementation(async (url, ...args) =>
      String(url).includes('refresh=1')
        ? { ...status, status: 'failed', reports: [{ ...modelReport, status: 'failed' }] }
        : original(url, ...args),
    );
  setup();
  const shield = await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  // Leave the next report pending: reopening must not fall back to the green status.
  jest
    .mocked(request.get)
    .mockImplementation(async (url, ...args) =>
      String(url).includes('reports=1') ? new Promise(() => {}) : original(url, ...args),
    );
  fireEvent.click(shield);
  await waitFor(() => expect(reportRequests()).toHaveLength(3));
  expect(shield).toHaveAccessibleName('NEAR AI attestation failed');
});

it('does not offer verification before the server confirms support', async () => {
  let resolve!: (value: { enabled: false }) => void;
  jest.mocked(request.get).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  setup();
  expect(screen.queryByTestId('header-nearai-shield')).not.toBeInTheDocument();
  await act(async () => resolve({ enabled: false }));
  expect(screen.queryByTestId('header-nearai-shield')).not.toBeInTheDocument();
  expect(reportRequests()).toHaveLength(0);
});

it('does not offer verification when endpoint support cannot be determined', async () => {
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.mocked(request.get).mockRejectedValue(new Error('offline'));
  setup();
  await waitFor(() => expect(logged).toHaveBeenCalled());
  expect(screen.queryByTestId('header-nearai-shield')).not.toBeInTheDocument();
  expect(reportRequests()).toHaveLength(0);
});

it('keeps a failed fresh report visible after a successful cached status poll', async () => {
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest
    .mocked(request.get)
    .mockImplementation(async (url, ...args) =>
      String(url).includes('reports=1')
        ? { ...status, status: 'failed', reports: [{ ...modelReport, status: 'failed' }] }
        : original(url, ...args),
    );
  const { client } = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation failed' }));
  await screen.findByTitle('NEAR AI Verification Center');
  await waitFor(() =>
    expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
      'NEAR AI attestation failed',
    ),
  );
  await act(async () => {
    await client.refetchQueries({
      queryKey: [QueryKeys.nearaiAttestation, 'NEAR AI', status.model],
      exact: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
    'NEAR AI attestation failed',
  );
});

it('recovers from simultaneous status and report failures with one retry', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const original = jest.mocked(request.get).getMockImplementation()!;
  const { client } = setup();
  const shield = await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  jest.mocked(request.get).mockImplementation(async (url, ...args) => {
    if (String(url).includes('/nearai/attestation')) throw new Error('offline');
    return original(url, ...args);
  });
  await act(async () => {
    await client.refetchQueries({
      queryKey: [QueryKeys.nearaiAttestation, 'NEAR AI', status.model],
      exact: true,
    });
  });
  fireEvent.click(shield);
  await screen.findByRole('alert');
  jest.mocked(request.get).mockImplementation(original);
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await screen.findByTitle('NEAR AI Verification Center');
  await waitFor(() =>
    expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
      'NEAR AI attestation verified',
    ),
  );
  expect(reportRequests()).toHaveLength(2);
});

it.each([
  ['Qwen/Qwen3.6-35B-A3B-FP8', 'verified'],
  ['z-ai/glm-5.3-flash', 'verified'],
  ['openai/gpt-4.1-mini', 'partial'],
  ['deepseek/deepseek-v3.2', 'partial'],
] as const)('displays the appropriate hardware scope for %s', async (model, verdict) => {
  const reports = (verdict === 'verified' ? [modelReport, gatewayReport] : [gatewayReport]).map(
    (entry) => ({ ...entry, model }),
  );
  jest.mocked(request.get).mockImplementation(async (url) =>
    String(url).includes('/nearai/attestation')
      ? {
          ...status,
          model,
          status: verdict,
          ...(String(url).includes('reports=1') ? { reports } : {}),
        }
      : { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] },
  );
  setup(model);
  const label =
    verdict === 'verified'
      ? 'NEAR AI attestation verified'
      : 'NEAR AI Gateway verified; model execution is not attested';
  fireEvent.click(await screen.findByRole('button', { name: label }));
  const frame = (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
  const post = jest.spyOn(frame.contentWindow!, 'postMessage');
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://cloud-stg.near.ai',
        source: frame.contentWindow,
        data: { type: 'NEAR_AI_VERIFICATION_CENTER_READY', version: 1, requestId: 'scope' },
      }),
    ),
  );
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ reports }),
    'https://cloud-stg.near.ai',
  );
  expect(new URL(frame.src).searchParams.get('model')).toBe(model);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByTestId('header-nearai-shield'));
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(1);
});

it('closes the model dialog when its endpoint or model changes', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = (endpoint: string, model = status.model) => (
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ThemeProvider initialTheme="light">
          <ModelShield endpoint={endpoint} model={model} />
        </ThemeProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const current = jest.mocked(request.get).getMockImplementation()!;
  jest
    .mocked(request.get)
    .mockImplementation(async (url, ...args) =>
      String(url).includes('endpoint=Other') ? { enabled: false } : current(url, ...args),
    );
  const { rerender } = render(host('NEAR AI'));
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  rerender(host('Other'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  rerender(host('NEAR AI'));
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  rerender(host('NEAR AI', 'other/model'));
  await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each(['model', 'gateway'] as const)(
  'invalidates warmed %s reply evidence when header re-verification fails',
  async (scope) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const saved = { ...receipt, report: { ...report, scope } };
    const message = {
      messageId: 'reply',
      conversationId: 'chat',
      parentMessageId: 'parent',
      endpoint: 'NEAR AI',
      sender: 'NEAR AI',
      text: 'OK',
      isCreatedByUser: false,
      metadata: { nearai: { receipts: [saved] } },
    };
    const { client } = setup(status.model, <Signature message={message} isLast={true} />);
    const shield = await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
    const params = {
      endpoint: 'NEAR AI',
      model: status.model,
      ...(scope === 'gateway' ? { scope: 'gateway' as const } : {}),
    };
    await prefetchReport(client, params);
    fireEvent.click(shield);
    await screen.findByTitle('NEAR AI Verification Center');
    const original = jest.mocked(request.get).getMockImplementation()!;
    jest.mocked(request.get).mockImplementation(async (url, ...args) => {
      if (String(url).includes('refresh=1')) throw new Error('offline');
      return original(url, ...args);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
    await screen.findByRole('alert');
    expect(client.getQueryState(reportQueryOptions(client, params).queryKey)?.isInvalidated).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const before = reportRequests().length;
    let resolve!: (data: TNearAIAttestationResponse) => void;
    const pending = new Promise<TNearAIAttestationResponse>((done) => {
      resolve = done;
    });
    jest
      .mocked(request.get)
      .mockImplementation((url, ...args) =>
        String(url).includes('reports=1') ? pending : original(url, ...args),
      );
    fireEvent.click(screen.getByTestId('nearai-signature-button'));
    await waitFor(() => expect(reportRequests()).toHaveLength(before + 1));
    expect(screen.queryByTitle('NEAR AI Verification Center')).not.toBeInTheDocument();
    await act(async () => resolve({ ...status, reports: [modelReport, gatewayReport] }));
    await screen.findByTitle('NEAR AI Verification Center');
  },
);

it.each(['failed', 'network'] as const)(
  'preserves an in-progress re-verification across model switches and its %s result',
  async (outcome) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let resolve!: (data: TNearAIAttestationResponse) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<TNearAIAttestationResponse>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const original = jest.mocked(request.get).getMockImplementation()!;
    jest
      .mocked(request.get)
      .mockImplementation((url, ...args) =>
        String(url).includes('refresh=1') ? pending : original(url, ...args),
      );
    const { client, select } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
    await screen.findByTitle('NEAR AI Verification Center');
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
    await waitFor(() => expect(client.isMutating()).toBe(1));
    select('Qwen/Qwen3.6-35B-A3B-FP8');
    await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
    await waitFor(() => expect(reportRequests()).toHaveLength(3));
    select(status.model);
    const shield = await screen.findByTestId('header-nearai-shield');
    await waitFor(() => expect(shield).toHaveAccessibleName('Checking NEAR AI attestation…'));
    fireEvent.click(shield);
    expect(screen.getByText('Verifying hardware…')).toBeVisible();
    expect(reportRequests()).toHaveLength(3);
    await act(async () => {
      if (outcome === 'network') reject(new Error('offline'));
      else
        resolve({ ...status, status: 'failed', reports: [{ ...modelReport, status: 'failed' }] });
    });
    await waitFor(() => expect(client.isMutating()).toBe(0));
    if (outcome === 'network') await screen.findByRole('alert');
    else {
      await screen.findByTitle('NEAR AI Verification Center');
      expect(shield).toHaveAccessibleName('NEAR AI attestation failed');
    }
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(reportRequests()).toHaveLength(3);
  },
);

it.each([
  ['Qwen/Qwen3.6-35B-A3B-FP8', 'model'],
  ['z-ai/glm-5.3-flash', 'model'],
  ['openai/gpt-4.1-mini', 'gateway'],
  ['deepseek/deepseek-v3.2', 'gateway'],
] as const)('shares warmed %s reports with the reply entry', async (model, scope) => {
  const verdict = scope === 'gateway' ? 'partial' : 'verified';
  const saved = { ...receipt, model, report: { ...report, model, scope } };
  const message = {
    messageId: 'reply',
    conversationId: 'chat',
    parentMessageId: 'parent',
    endpoint: 'NEAR AI',
    sender: 'NEAR AI',
    text: 'OK',
    isCreatedByUser: false,
    metadata: { nearai: { receipts: [saved] } },
  };
  jest.mocked(request.get).mockImplementation(async (url) => {
    if (!String(url).includes('/nearai/attestation'))
      return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
    return {
      ...status,
      model,
      scope,
      status: verdict,
      ...(String(url).includes('reports=1')
        ? { reports: [{ ...(scope === 'gateway' ? gatewayReport : modelReport), model }] }
        : {}),
    };
  });
  const { client } = setup(model, <Signature message={message} isLast={true} />);
  await screen.findByTestId('header-nearai-shield');
  await waitFor(() => expect(reportRequests()).toHaveLength(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  fireEvent.click(screen.getByTestId('nearai-signature-button'));
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(1);
  expect(reportRequests()[0][0]).not.toContain('refresh=1');
  expect(reportRequests()[0][0]).not.toContain('scope=gateway');
});

it('shares an in-progress refresh with a reply opened after switching models', async () => {
  let resolve!: (data: TNearAIAttestationResponse) => void;
  const pending = new Promise<TNearAIAttestationResponse>((done) => {
    resolve = done;
  });
  const message = {
    messageId: 'reply',
    conversationId: 'chat',
    parentMessageId: 'parent',
    endpoint: 'NEAR AI',
    sender: 'NEAR AI',
    text: 'OK',
    isCreatedByUser: false,
    metadata: { nearai: { receipts: [receipt] } },
  };
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest
    .mocked(request.get)
    .mockImplementation((url, ...args) =>
      String(url).includes('refresh=1') ? pending : original(url, ...args),
    );
  const { client, select } = setup(status.model, <Signature message={message} isLast={true} />);
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() => expect(reportRequests()).toHaveLength(2));
  select('Qwen/Qwen3.6-35B-A3B-FP8');
  await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  await waitFor(() => expect(reportRequests()).toHaveLength(3));
  fireEvent.click(screen.getByTestId('nearai-signature-button'));
  expect(screen.getByText('Verifying hardware…')).toBeVisible();
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(reportRequests()).toHaveLength(3);
  await act(async () =>
    resolve({ ...status, status: 'failed', reports: [{ ...modelReport, status: 'failed' }] }),
  );
  const frame = (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
  const post = jest.spyOn(frame.contentWindow!, 'postMessage');
  act(() =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://cloud-stg.near.ai',
        source: frame.contentWindow,
        data: {
          type: 'NEAR_AI_VERIFICATION_CENTER_READY',
          version: 1,
          requestId: 'shared-refresh',
        },
      }),
    ),
  );
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      reports: expect.arrayContaining([
        expect.objectContaining({ kind: 'reply', status: 'verified' }),
        expect.objectContaining({ kind: 'model', status: 'failed' }),
      ]),
    }),
    'https://cloud-stg.near.ai',
  );
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(reportRequests()).toHaveLength(3);
});

it('keeps the Gateway report after a failed status refresh without requesting a second report', async () => {
  const model = 'openai/gpt-4.1-mini';
  let refreshed = false;
  jest.mocked(request.get).mockImplementation(async (url) => {
    if (!String(url).includes('/nearai/attestation'))
      return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
    if (String(url).includes('reports=1')) {
      if (String(url).includes('refresh=1')) refreshed = true;
      return {
        ...status,
        model,
        status: refreshed ? 'failed' : 'partial',
        reports: [{ ...gatewayReport, model, status: refreshed ? 'failed' : 'partial' }],
      };
    }
    return { ...status, model, status: refreshed ? 'failed' : 'partial' };
  });
  const { client, select } = setup(model);
  fireEvent.click(await screen.findByTestId('header-nearai-shield'));
  await screen.findByTitle('NEAR AI Verification Center');
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() =>
    expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
      'NEAR AI attestation failed',
    ),
  );
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(reportRequests()).toHaveLength(2);
  expect(client.getQueryData([QueryKeys.nearaiAttestation, 'NEAR AI', model])).toMatchObject({
    status: 'failed',
  });
  expect(
    client.getQueryData(reportQueryOptions(client, { endpoint: 'NEAR AI', model }).queryKey),
  ).toMatchObject({ reports: [expect.objectContaining({ scope: 'gateway', status: 'failed' })] });
  select(status.model);
  await screen.findByTestId('header-nearai-shield');
  select(model);
  await waitFor(() =>
    expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
      'NEAR AI attestation failed',
    ),
  );
  expect(reportRequests().filter(([url]) => String(url).includes('model=openai'))).toHaveLength(2);
});

it.each([
  ['NEAR AI', true],
  ['OpenAI', false],
] as const)(
  'lets %s open prefetched reports before the SDK status finishes only when configured as NEAR AI',
  async (endpoint, configured) => {
    let resolve!: (value: TNearAIAttestationResponse) => void;
    const pending = new Promise<TNearAIAttestationResponse>((done) => {
      resolve = done;
    });
    jest.mocked(request.get).mockImplementation(async (url) => {
      if (String(url).includes('reports=1')) return { ...status, reports: [modelReport] };
      if (String(url).includes('/nearai/attestation')) return pending;
      return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RecoilRoot>
          <ThemeProvider initialTheme="light">
            <ModelShield endpoint={endpoint} model="z-ai/glm-5.3-flash" />
          </ThemeProvider>
        </RecoilRoot>
      </QueryClientProvider>,
    );
    if (!configured) {
      await waitFor(() => expect(client.isFetching()).toBe(1));
      expect(screen.queryByTestId('header-nearai-shield')).not.toBeInTheDocument();
      return;
    }
    const shield = await screen.findByRole('button', { name: 'Checking NEAR AI attestation…' });
    expect(shield).toBeEnabled();
    fireEvent.click(shield);
    await screen.findByTitle('NEAR AI Verification Center');
    await act(async () => resolve(status));
    await waitFor(() => expect(shield).toHaveAccessibleName('NEAR AI attestation verified'));
    expect(shield).toBeEnabled();
  },
);
