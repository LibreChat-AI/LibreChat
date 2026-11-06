import React from 'react';
import { RecoilRoot } from 'recoil';
import { request } from 'librechat-data-provider';
import userEvent from '@testing-library/user-event';
import { OGDialog, ThemeProvider } from '@librechat/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TMessage, TNearAIReceipt } from 'librechat-data-provider';
import { receipt, modelReport, gatewayReport, viewerUrl, replyMessage } from 'test/fixtures/nearai';
import { closeDialog, deferReports, receive, reportRequests } from 'test/attestation';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import Verification from '../Verification';
import Signature from '../Signature';
import Prefetch from '../Prefetch';

jest.mock('~/hooks', () => ({
  useLocalize: jest.requireActual('~/hooks/useLocalize').default,
}));

function setup(
  receipts: TNearAIReceipt[] = [receipt],
  darkMode = false,
  provenance: Partial<TMessage> = {},
  prefetch = false,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const message = { ...replyMessage(receipts), ...provenance };
  const result = render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ThemeProvider initialTheme={darkMode ? 'dark' : 'light'}>
          {prefetch && <Prefetch messages={[message]} isSubmitting={false} />}
          <Signature message={message} isLast={true} />
        </ThemeProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

async function openFrame() {
  fireEvent.click(screen.getByTestId('nearai-signature-button'));
  return (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
}

beforeEach(() => {
  // jsdom has no Web Animations API; exercise the no-animation browser path.
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  jest.spyOn(request, 'get').mockImplementation(async (url) => {
    if (String(url).includes('reports=1'))
      return {
        enabled: true,
        model: receipt.model,
        status: 'verified',
        checkedAt: gatewayReport.verifiedAt,
        reports: String(url).includes('scope=gateway')
          ? [gatewayReport]
          : [gatewayReport, modelReport],
      };
    return { appTitle: 'LibreChat', nearaiVerifyUrl: viewerUrl, nearaiEndpoints: ['NEAR AI'] };
  });
});

afterEach(() => {
  localStorage.clear();
});

it.each(['response', 'reply'])(
  'opens a saved %s report, sends response to the iframe, closes and restores focus',
  async (kind) => {
    setup([{ ...receipt, report: JSON.parse(JSON.stringify({ ...receipt.report, kind })) }]);
    expect(request.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const iframe = await openFrame();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(new URL(iframe.src).searchParams.get('model')).toBe(receipt.model);
    expect(new URL(iframe.src).searchParams.get('showHeader')).toBe('false');
    expect(new URL(iframe.src).searchParams.has('layout')).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Response verification' })).toBeVisible();
    const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
    receive(iframe, 'NEAR_AI_VERIFICATION_CENTER_READY');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ reports: [receipt.report, gatewayReport] }),
      'https://cloud-stg.near.ai',
    );
    receive(iframe, 'NEAR_AI_VERIFICATION_CLOSE');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('nearai-signature-button')).toHaveFocus());
  },
);

it('links old receipts to the standalone viewer', async () => {
  setup([{ ...receipt, report: undefined }]);
  fireEvent.click(screen.getByTestId('nearai-signature-button'));
  expect(await screen.findByText(receipt.completionId)).toBeVisible();
  expect(screen.getByText(/An embedded report is unavailable/)).toBeVisible();
  const link = await screen.findByRole('link', { name: 'View verification details on NEAR AI' });
  expect(link.getAttribute('href')).toContain('#receipt=');
  expect(screen.queryByTitle('NEAR AI Verification Center')).not.toBeInTheDocument();
});

it('reuses startup configuration while fetching current hardware only after opening', async () => {
  const { client } = setup();
  client.setQueryData(startupConfigKey(false), {
    nearaiVerifyUrl: viewerUrl,
    nearaiEndpoints: ['NEAR AI'],
  });
  await openFrame();
  expect(request.get).toHaveBeenCalledTimes(1);
  expect(jest.mocked(request.get).mock.calls[0][0]).toContain('reports=1');
  expect(jest.mocked(request.get).mock.calls[0][0]).not.toContain('refresh=1');
});

it('opens a reply using the hardware report prefetched by the message list', async () => {
  setup([receipt], false, {}, true);
  await waitFor(() => expect(request.get).toHaveBeenCalledTimes(1));
  const iframe = await openFrame();
  receive(iframe, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(reportRequests()).toHaveLength(1);
});

it('joins an unfinished message-list prefetch when the reply shield is clicked', async () => {
  const { resolve } = deferReports();
  setup([receipt], false, {}, true);
  await waitFor(() => expect(request.get).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByTestId('nearai-signature-button'));
  expect(screen.getByText('Verifying hardware…')).toBeVisible();
  const accessibleModels = screen
    .getAllByText(receipt.model)
    .filter((node) => !node.closest('[aria-hidden="true"]'));
  expect(accessibleModels).toHaveLength(1);
  expect(accessibleModels[0].closest('[role="status"]')).not.toBeNull();
  await act(async () =>
    resolve({
      enabled: true,
      model: receipt.model,
      status: 'verified',
      checkedAt: modelReport.verifiedAt,
      reports: [modelReport, gatewayReport],
    }),
  );
  await screen.findByTitle('NEAR AI Verification Center');
  expect(reportRequests()).toHaveLength(1);
});

it('reuses reply hardware for five minutes and fetches once after expiry', async () => {
  setup();
  await openFrame();
  expect(reportRequests()).toHaveLength(1);
  await closeDialog();
  await openFrame();
  expect(reportRequests()).toHaveLength(1);
  await closeDialog();
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001);
  await openFrame();
  expect(reportRequests()).toHaveLength(2);
});

it('displays the earliest hardware time rather than the saved signature time after the viewer is ready', async () => {
  const checkedAt = '2026-10-28T12:00:00.000Z';
  const original = jest.mocked(request.get).getMockImplementation()!;
  jest.mocked(request.get).mockImplementation(async (url, ...args) =>
    String(url).includes('reports=1')
      ? {
          enabled: true,
          model: receipt.model,
          status: 'verified',
          checkedAt: '2026-10-28T14:00:00.000Z',
          reports: [
            { ...gatewayReport, verifiedAt: '2026-10-28T13:00:00.000Z' },
            { ...modelReport, verifiedAt: checkedAt },
          ],
        }
      : original(url, ...args),
  );
  setup();
  const frame = await openFrame();
  expect(document.querySelector('time')).not.toBeInTheDocument();
  receive(frame, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(document.querySelector('time')).toHaveAttribute('datetime', checkedAt);
  expect(document.querySelector('time')).not.toHaveAttribute('datetime', receipt.verifiedAt);
});

it('connects when the dialog portal mounts after the report and config are ready', async () => {
  const client = new QueryClient();
  client.setQueryData(startupConfigKey(false), {
    nearaiVerifyUrl: viewerUrl,
    nearaiEndpoints: ['NEAR AI'],
  });
  const onClose = jest.fn();
  const content = (open: boolean) => (
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <OGDialog open={open}>
          <Verification receipts={[receipt]} onClose={onClose} />
        </OGDialog>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const { rerender } = render(content(false));
  expect(screen.queryByTitle('NEAR AI Verification Center')).not.toBeInTheDocument();
  rerender(content(true));
  const iframe = await screen.findByTitle('NEAR AI Verification Center');
  await waitFor(() =>
    expect(iframe).toHaveAttribute('src', expect.stringContaining('cloud-stg.near.ai')),
  );
  expect(request.get).not.toHaveBeenCalled();
});

it('shows an unavailable message when the viewer is unconfigured', async () => {
  jest.mocked(request.get).mockResolvedValue({ appTitle: 'LibreChat' });
  setup();
  fireEvent.click(screen.getByTestId('nearai-signature-button'));
  expect(await screen.findByText(/The verification viewer is unavailable/)).toBeVisible();
  expect(screen.getByText(receipt.completionId)).toBeVisible();
});

it('reconnects after a correlated viewer error without claiming to reverify', async () => {
  setup();
  const iframe = await openFrame();
  receive(iframe, 'NEAR_AI_VERIFICATION_CENTER_READY');
  receive(iframe, 'NEAR_AI_VERIFICATION_ERROR');
  expect(screen.getByRole('alert')).toHaveTextContent('could not load or display');
  expect(screen.getByText(receipt.completionId)).toBeVisible();
  expect(iframe).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Reload viewer' }));
  const next = screen.getByTitle('NEAR AI Verification Center');
  expect(next).not.toBe(iframe);
  expect(iframe).not.toHaveAttribute('src');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(request.get).toHaveBeenCalledTimes(2);
});

it('sends only the selected completion and disconnects the previous frame', async () => {
  if (!receipt.report) {
    throw new Error('Missing fixture report');
  }
  const second: TNearAIReceipt = {
    ...receipt,
    completionId: 'completion-2',
    report: { ...receipt.report, completionId: 'completion-2' },
  };
  setup([receipt, second]);
  const iframe = await openFrame();
  await userEvent.click(screen.getByTestId('dropdown-menu'));
  fireEvent.click(await screen.findByRole('option', { name: 'completion-2' }));
  const next = screen.getByTitle('NEAR AI Verification Center') as HTMLIFrameElement;
  expect(next).not.toBe(iframe);
  expect(iframe).not.toHaveAttribute('src');
  const post = jest.spyOn(next.contentWindow!, 'postMessage');
  receive(next, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ reports: [second.report, gatewayReport] }),
    'https://cloud-stg.near.ai',
  );
});

it('passes the resolved dark theme to the iframe', async () => {
  setup([receipt], true);
  const iframe = await openFrame();
  expect(new URL(iframe.src).searchParams.get('darkMode')).toBe('true');
});

it('does not show a shield for messages without receipts', () => {
  setup([]);
  expect(screen.queryByTestId('nearai-signature-button')).not.toBeInTheDocument();
});

it.each([
  { isUserSubmitted: true },
  { userSubmittedPaths: ['/text'] },
  { userSubmittedMessageFieldPaths: [{ path: '/content/0/tool_call', field: 'answer' as const }] },
])('does not display verification for imported or edited messages: %j', (provenance) => {
  setup([receipt], false, provenance);
  expect(screen.queryByTestId('nearai-signature-button')).not.toBeInTheDocument();
  expect(screen.queryByTitle('NEAR AI Verification Center')).not.toBeInTheDocument();
});

it('keeps reports on untouched native copies', async () => {
  setup([receipt], false, {
    isUserSubmitted: false,
    userSubmittedPaths: [],
    userSubmittedMessageFieldPaths: [],
  });
  expect(await openFrame()).toBeVisible();
});

it('preserves the signature when current hardware cannot be reached and retries the hardware check', async () => {
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const get = jest.mocked(request.get);
  const current = get.getMockImplementation()!;
  let failed = false;
  get.mockImplementation(async (url, ...args) => {
    if (String(url).includes('reports=1') && !failed) {
      failed = true;
      throw new Error('offline');
    }
    return current(url, ...args);
  });
  setup();
  const iframe = await openFrame();
  const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
  receive(iframe, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      reports: [
        receipt.report,
        expect.objectContaining({ kind: 'model', scope: 'unknown', status: 'unverifiable' }),
      ],
    }),
    'https://cloud-stg.near.ai',
  );
  expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }));
  expect(screen.getByTestId('nearai-signature-button')).toHaveAttribute(
    'aria-label',
    'Reply signed by the model TEE',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() =>
    expect(get.mock.calls.filter(([url]) => String(url).includes('reports=1'))).toHaveLength(2),
  );
  expect(get.mock.calls.some(([url]) => String(url).includes('force=1'))).toBe(true);
  expect(get.mock.calls.every(([url]) => !String(url).includes('refresh=1'))).toBe(true);
  const restored = (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
  const refreshed = jest.spyOn(restored.contentWindow!, 'postMessage');
  receive(restored, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(refreshed).toHaveBeenCalledWith(
    expect.objectContaining({ reports: [receipt.report, gatewayReport] }),
    'https://cloud-stg.near.ai',
  );
});

it('replaces previously successful hardware reports with unavailable reports when a refresh fails', async () => {
  const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  setup();
  const iframe = await openFrame();
  receive(iframe, 'NEAR_AI_VERIFICATION_CENTER_READY');
  const get = jest.mocked(request.get);
  const current = get.getMockImplementation()!;
  get.mockImplementation(async (url, ...args) => {
    if (String(url).includes('reports=1')) throw new Error('offline');
    return current(url, ...args);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify again' }));
  await waitFor(() =>
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' })),
  );
  const next = (await screen.findByTitle('NEAR AI Verification Center')) as HTMLIFrameElement;
  const post = jest.spyOn(next.contentWindow!, 'postMessage');
  receive(next, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      reports: [
        receipt.report,
        expect.objectContaining({ scope: 'unknown', status: 'unverifiable' }),
      ],
    }),
    'https://cloud-stg.near.ai',
  );
  expect(get.mock.calls.every(([url]) => !String(url).includes('refresh=1'))).toBe(true);
  const sent = post.mock.calls[0][0].reports;
  expect(sent[1]).not.toHaveProperty('attestation');
  expect(sent).toHaveLength(2);
  expect(document.querySelector('time')).not.toBeInTheDocument();
  await closeDialog();
  const reopened = await openFrame();
  expect(get.mock.calls.filter(([url]) => String(url).includes('reports=1'))).toHaveLength(3);
  expect(get.mock.calls.filter(([url]) => String(url).includes('reports=1'))[2][0]).toContain(
    'force=1',
  );
  const reopenedPost = jest.spyOn(reopened.contentWindow!, 'postMessage');
  receive(reopened, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(reopenedPost.mock.calls[0][0].reports[1].status).toBe('unverifiable');
});

it('requests Gateway evidence only for a Gateway-signed reply and keeps it partial', async () => {
  if (!receipt.report || receipt.report.kind !== 'response' || !gatewayReport.attestation)
    throw new Error('Missing report fixture');
  const saved = {
    ...receipt.report,
    scope: 'gateway' as const,
    status: 'partial' as const,
    model: undefined,
    attestation: gatewayReport.attestation,
    signature: {
      kind: 'gateway' as const,
      signer: gatewayReport.attestation.signer,
      signedText: `${'2'.repeat(64)}:${'3'.repeat(64)}`,
      signature: '4'.repeat(128),
    },
  };
  setup([{ ...receipt, signatureKind: 'gateway', report: saved }]);
  const iframe = await openFrame();
  expect(
    jest.mocked(request.get).mock.calls.some(([url]) => String(url).includes('scope=gateway')),
  ).toBe(true);
  const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
  receive(iframe, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('Model and Gateway');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ reports: [saved] }),
    'https://cloud-stg.near.ai',
  );
});

it('does not request current hardware when the saved response signature could not be verified', async () => {
  const failed: TNearAIReceipt = {
    ...receipt,
    status: 'failed',
    report: {
      schemaVersion: 1,
      kind: 'response',
      model: receipt.model,
      completionId: receipt.completionId,
      verifiedAt: receipt.verifiedAt,
      scope: 'unknown',
      status: 'failed',
      error: { code: 'signature.invalid', message: 'Rejected signature' },
    },
  };
  setup([failed]);
  await openFrame();
  expect(
    jest.mocked(request.get).mock.calls.every(([url]) => !String(url).includes('reports=1')),
  ).toBe(true);
});

it('accepts restored Gateway reports whose absent model was stored as BSON null', async () => {
  if (!receipt.report || receipt.report.kind !== 'response' || !gatewayReport.attestation)
    throw new Error('Missing fixture');
  const saved = {
    ...receipt.report,
    scope: 'gateway' as const,
    status: 'partial' as const,
    model: undefined,
    attestation: gatewayReport.attestation,
    signature: {
      kind: 'gateway' as const,
      signer: gatewayReport.attestation.signer,
      signedText: '2'.repeat(64) + ':' + '3'.repeat(64),
      signature: '4'.repeat(128),
    },
  };
  const restored = JSON.parse(JSON.stringify({ ...saved, model: null }));
  setup([{ ...receipt, signatureKind: 'gateway', report: restored }]);
  const frame = await openFrame();
  const post = jest.spyOn(frame.contentWindow!, 'postMessage');
  receive(frame, 'NEAR_AI_VERIFICATION_CENTER_READY');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      reports: [
        expect.objectContaining({
          kind: 'response',
          scope: 'gateway',
          status: 'partial',
          model: undefined,
        }),
      ],
    }),
    'https://cloud-stg.near.ai',
  );
});

it('shows an unverifiable reply signature as unverified rather than rejected', async () => {
  const timedOut: TNearAIReceipt = {
    completionId: receipt.completionId,
    model: receipt.model,
    status: 'failed',
    verifiedAt: receipt.verifiedAt,
    errorCode: 'nearai_verification_timeout',
    report: {
      schemaVersion: 1,
      kind: 'response',
      completionId: receipt.completionId,
      model: receipt.model,
      scope: 'unknown',
      status: 'unverifiable',
      verifiedAt: receipt.verifiedAt,
      error: { code: 'nearai_verification_timeout', message: 'Timed out.' },
    },
  };
  const { rerender, client } = setup([timedOut]);
  expect(
    screen.getByRole('button', { name: 'Reply signature could not be verified' }),
  ).toBeInTheDocument();
  rerender(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ThemeProvider initialTheme="light">
          <Signature
            message={{
              messageId: 'message-2',
              conversationId: 'conversation-1',
              parentMessageId: 'parent-1',
              endpoint: 'NEAR AI',
              sender: 'NEAR AI',
              text: 'Reply',
              isCreatedByUser: false,
              metadata: {
                nearai: {
                  receipts: [
                    timedOut,
                    { ...timedOut, report: { ...timedOut.report!, status: 'failed' } },
                  ],
                },
              },
            }}
            isLast={true}
          />
        </ThemeProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Reply signature check failed' })).toBeInTheDocument();
});
