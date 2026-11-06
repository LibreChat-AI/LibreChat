import React from 'react';
import axios from 'axios';
import { RecoilRoot } from 'recoil';
import { ThemeProvider } from '@librechat/client';
import { request, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TNearAIAttestationResponse } from 'librechat-data-provider';
import {
  report,
  receipt,
  modelReport,
  gatewayReport,
  viewerUrl,
  replyMessage,
} from 'test/fixtures/nearai';
import { closeDialog, deferReports, receive, reportRequests } from 'test/attestation';
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

function setup(model = 'z-ai/glm-5.3-flash', children?: React.ReactNode, endpoint = 'NEAR AI') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = (selected: string, configuredEndpoint = endpoint) => (
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ThemeProvider initialTheme="light">
          <ModelShield endpoint={configuredEndpoint} model={selected} />
          {children}
        </ThemeProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const rendered = render(host(model));
  return {
    ...rendered,
    client,
    select: (selected: string, configuredEndpoint = endpoint) =>
      rendered.rerender(host(selected, configuredEndpoint)),
  };
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
  receive(frame, 'NEAR_AI_VERIFICATION_CENTER_READY', 'model-1');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ reports: [modelReport] }),
    'https://cloud-stg.near.ai',
  );
  expect(reportRequests()).toHaveLength(1);
  expect(reportRequests()[0][0]).not.toContain('refresh=1');
  expect(screen.getByText('Hardware checked at')).toBeVisible();
  expect(document.querySelector('time')).toHaveAttribute('datetime', modelReport.verifiedAt);
  receive(frame, 'NEAR_AI_VERIFICATION_CLOSE', 'model-1');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(shield).toHaveFocus());
});

it.each([
  'Qwen/Qwen3.6-35B-A3B-FP8',
  'z-ai/glm-5.3-flash',
  'openai/gpt-4.1-mini',
  'deepseek/deepseek-v3.2',
])(
  'prefetches %s before status completes, displays its scope and reuses it on return',
  async (model) => {
    const { promise: pending, resolve: finishStatus } = Promise.withResolvers<void>();
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
    const initialFrame = (await screen.findByTitle(
      'NEAR AI Verification Center',
    )) as HTMLIFrameElement;
    const post = jest.spyOn(initialFrame.contentWindow!, 'postMessage');
    receive(initialFrame, 'NEAR_AI_VERIFICATION_CENTER_READY');
    const gateway = model.startsWith('openai/') || model.startsWith('deepseek/');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        reports: (gateway ? [gatewayReport] : [gatewayReport, modelReport]).map((entry) => ({
          ...entry,
          model,
        })),
      }),
      new URL(viewerUrl).origin,
    );
    expect(new URL(initialFrame.src).searchParams.get('model')).toBe(model);
    expect(client.isFetching()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const other =
      model === 'z-ai/glm-5.3-flash' ? 'Qwen/Qwen3.6-35B-A3B-FP8' : 'z-ai/glm-5.3-flash';
    select(other);
    await waitFor(() => expect(reportRequests()).toHaveLength(2));
    select(model);
    await act(async () => finishStatus());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
      gateway
        ? 'NEAR AI Gateway verified; model execution is not attested'
        : 'NEAR AI attestation verified',
    );
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
  const { resolve } = deferReports('refresh=1');
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
  await closeDialog();
  fireEvent.click(screen.getByTestId('header-nearai-shield'));
  expect(screen.getByTestId('header-nearai-shield')).toHaveAccessibleName(
    'Checking NEAR AI attestation…',
  );
  expect(screen.getByText('Verifying hardware…')).toBeVisible();
  expect(reportRequests()).toHaveLength(2);
  await act(async () => resolve({ ...status, reports: [modelReport] }));
  await screen.findByTitle('NEAR AI Verification Center');
  await closeDialog();
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
    await closeDialog();
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
  const { promise: delayed, resolve } = Promise.withResolvers<TNearAIAttestationResponse>();
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
  await closeDialog();
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(1);
  await closeDialog();
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
    await closeDialog();
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
  await closeDialog();
  fireEvent.click(shield);
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(3);
});

it.each(['failed', 'unverifiable'] as const)(
  'keeps a delayed %s re-verification result without automatically requesting another report',
  async (verdict) => {
    const { resolve } = deferReports('refresh=1');
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
    receive(frame, 'NEAR_AI_VERIFICATION_CENTER_READY', 'failed-refresh');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ reports: [expect.objectContaining({ status: verdict })] }),
      'https://cloud-stg.near.ai',
    );
  },
);

it('retains an explicit hardware failure across a delayed network failure until a successful report replaces it', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const { promise: pending, reject } = Promise.withResolvers<TNearAIAttestationResponse>();
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
  await closeDialog();
  const { promise: retry, resolve } = Promise.withResolvers<TNearAIAttestationResponse>();
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
  const { promise: pending, resolve } = Promise.withResolvers<TNearAIAttestationResponse>();
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
  await closeDialog();
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

it('closes the model dialog when its endpoint or model changes', async () => {
  const current = jest.mocked(request.get).getMockImplementation()!;
  jest
    .mocked(request.get)
    .mockImplementation(async (url, ...args) =>
      String(url).includes('endpoint=Other') ? { enabled: false } : current(url, ...args),
    );
  const { select } = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  select(status.model, 'Other');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  select(status.model);
  fireEvent.click(await screen.findByRole('button', { name: 'NEAR AI attestation verified' }));
  await screen.findByTitle('NEAR AI Verification Center');
  select('other/model');
  await screen.findByRole('button', { name: 'NEAR AI attestation verified' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each(['model', 'gateway'] as const)(
  'invalidates warmed %s reply evidence when header re-verification fails',
  async (scope) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const saved = { ...receipt, report: { ...report, scope } };
    const message = replyMessage([saved]);
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
    await closeDialog();
    const before = reportRequests().length;
    const { promise: pending, resolve } = Promise.withResolvers<TNearAIAttestationResponse>();
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
    const {
      promise: pending,
      resolve,
      reject,
    } = Promise.withResolvers<TNearAIAttestationResponse>();
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
  const message = replyMessage([saved]);
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
  const { promise: pending, resolve } = Promise.withResolvers<TNearAIAttestationResponse>();
  const message = replyMessage([receipt]);
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
  receive(frame, 'NEAR_AI_VERIFICATION_CENTER_READY', 'shared-refresh');
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
    const { promise: pending, resolve } = Promise.withResolvers<TNearAIAttestationResponse>();
    jest.mocked(request.get).mockImplementation(async (url) => {
      if (String(url).includes('reports=1')) return { ...status, reports: [modelReport] };
      if (String(url).includes('/nearai/attestation')) return pending;
      return { nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
    });
    const { client } = setup(status.model, undefined, endpoint);
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
