/* eslint-disable i18next/no-literal-string */
import React from 'react';
import { AxiosError } from 'axios';
import { RecoilRoot } from 'recoil';
import { ToastProvider } from '@librechat/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  dataService,
  DynamicQueryKeys,
  QueryKeys,
  TERMS_NOT_ACCEPTED_CODE,
} from 'librechat-data-provider';
import type { CodeSetupAttempt } from 'librechat-data-provider';
import type { AxiosResponse } from 'axios';
import mockTranslations from '~/locales/en/translation.json';
import { codeSetupRoute } from '~/routes/CodeSetup';
import store from '~/store';

let mockAuth = {
  isAuthReady: true,
  isAuthenticated: true,
  user: { id: 'user-1', email: 'owner@example.com' },
  logout: jest.fn(),
};

jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => mockAuth }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockTranslations, options?: { 0?: string }) =>
    mockTranslations[key]?.replace('{{0}}', options?.[0] ?? ''),
}));
// Markdown rendering is unrelated to setup consent. Keep the real terms acceptance modal.
jest.mock(
  '~/components/Chat/Messages/Content/MarkdownLite',
  () =>
    ({ content }: { content: string }) => <p>{content}</p>,
);
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getStartupConfig: jest.fn(),
      getUserTerms: jest.fn(),
      acceptTerms: jest.fn(),
      getCodeSetupAttempt: jest.fn(),
      approveCodeSetupAttempt: jest.fn(),
      denyCodeSetupAttempt: jest.fn(),
    },
  };
});

const initialAttempt: CodeSetupAttempt = {
  version: 1,
  attemptId: 'attempt-1',
  status: 'pending',
  expiresAt: '2030-01-01T00:00:00.000Z',
  verificationCode: '123456',
  machineName: 'Development laptop',
  workspace: { type: 'directory' },
  allowWorkspaceWrites: false,
  allowWorkspaceCommands: true,
  keyFingerprint: 'a'.repeat(64),
  controlPlanes: [
    { id: 'plane-1', name: 'My control plane' },
    { id: 'plane-2', name: 'Second plane' },
  ],
};

function httpError(status: number, code?: string) {
  return new AxiosError(
    'private server details must not be rendered',
    undefined,
    undefined,
    undefined,
    {
      status,
      data: { code },
    } as AxiosResponse,
  );
}

function setup({ basename = '/', path = '/code/setup/attempt-1' } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 }, mutations: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => undefined },
  });
  const router = createMemoryRouter(
    [
      codeSetupRoute,
      { path: 'login', element: <p>Sign-in page</p> },
      { path: '*', element: <p>Not found</p> },
    ],
    { basename, initialEntries: [`${basename === '/' ? '' : basename}${path}`] },
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.queriesEnabled, true);
          set(store.user, mockAuth.user as never);
        }}
      >
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = {
    isAuthReady: true,
    isAuthenticated: true,
    user: { id: 'user-1', email: 'owner@example.com' },
    logout: jest.fn(),
  };
  jest.mocked(dataService.getStartupConfig).mockResolvedValue({ interface: {} } as never);
  jest.mocked(dataService.getCodeSetupAttempt).mockResolvedValue(initialAttempt);
});

it('shows an accessible loading state without starting a decision', () => {
  jest.mocked(dataService.getCodeSetupAttempt).mockReturnValue(new Promise(() => undefined));
  setup();
  expect(screen.getByRole('status')).toHaveTextContent(mockTranslations.com_ui_code_setup_loading);
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
  expect(dataService.denyCodeSetupAttempt).not.toHaveBeenCalled();
});

it('shows the signed-in account and immutable consent details without automatically approving', async () => {
  setup();
  expect(await screen.findByText(initialAttempt.machineName)).toBeInTheDocument();
  expect(screen.getByText('Signed in as owner@example.com')).toBeInTheDocument();
  expect(screen.getByText(initialAttempt.verificationCode)).toBeInTheDocument();
  expect(screen.getByText(initialAttempt.keyFingerprint)).toBeInTheDocument();
  expect(screen.getByText(mockTranslations.com_ui_code_setup_directory)).toBeInTheDocument();
  expect(document.querySelector('time')).toHaveAttribute('datetime', initialAttempt.expiresAt);
  expect(screen.getByText(mockTranslations.com_ui_code_setup_command_warning)).toBeInTheDocument();
  expect(screen.getByText(mockTranslations.com_ui_code_setup_trust_warning)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).toBeDisabled();
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
  expect(dataService.denyCodeSetupAttempt).not.toHaveBeenCalled();
});

it('only approves the chosen authorized plane after an explicit click and reconciles the result', async () => {
  const approved: CodeSetupAttempt = {
    ...initialAttempt,
    status: 'provisioning',
    controlPlaneId: 'plane-2',
  };
  jest.mocked(dataService.approveCodeSetupAttempt).mockImplementation(async () => {
    jest.mocked(dataService.getCodeSetupAttempt).mockResolvedValue(approved);
    return approved;
  });
  const { queryClient } = setup();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  fireEvent.click(await screen.findByRole('radio', { name: 'Second plane' }));
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }));
  await waitFor(() =>
    expect(dataService.approveCodeSetupAttempt).toHaveBeenCalledWith('attempt-1', {
      controlPlaneId: 'plane-2',
    }),
  );
  expect(
    await screen.findByText(mockTranslations.com_ui_code_setup_provisioning),
  ).toBeInTheDocument();
  expect(invalidate).toHaveBeenCalledWith([QueryKeys.codeEnvironments]);
  expect(dataService.denyCodeSetupAttempt).not.toHaveBeenCalled();
});

it('sends denial only after clicking Deny, without requiring a plane', async () => {
  const denied: CodeSetupAttempt = { ...initialAttempt, status: 'denied' };
  jest.mocked(dataService.denyCodeSetupAttempt).mockImplementation(async () => {
    jest.mocked(dataService.getCodeSetupAttempt).mockResolvedValue(denied);
    return denied;
  });
  setup();
  fireEvent.click(
    await screen.findByRole('button', { name: mockTranslations.com_ui_code_setup_deny }),
  );
  await waitFor(() => expect(dataService.denyCodeSetupAttempt).toHaveBeenCalledWith('attempt-1'));
  expect(await screen.findByText(mockTranslations.com_ui_code_setup_denied)).toBeInTheDocument();
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
});

it('disables both actions while a decision is pending', async () => {
  jest.mocked(dataService.approveCodeSetupAttempt).mockReturnValue(new Promise(() => undefined));
  setup();
  fireEvent.click(await screen.findByRole('radio', { name: 'My control plane' }));
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }));
  expect(await screen.findByText(mockTranslations.com_ui_code_setup_saving)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_deny }),
  ).toBeDisabled();
});

it.each([
  ['provisioning', 'com_ui_code_setup_provisioning'],
  ['approved', 'com_ui_code_setup_approved'],
  ['completed', 'com_ui_code_setup_completed'],
  ['denied', 'com_ui_code_setup_denied'],
  ['cancelled', 'com_ui_code_setup_cancelled'],
  ['expired', 'com_ui_code_setup_expired'],
  ['failed', 'com_ui_code_setup_failed'],
] as const)('shows %s without offering approval or denial', async (status, key) => {
  jest.mocked(dataService.getCodeSetupAttempt).mockResolvedValue({ ...initialAttempt, status });
  setup();
  expect(await screen.findByText(mockTranslations[key])).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: mockTranslations.com_ui_code_setup_deny }),
  ).not.toBeInTheDocument();
});

it('offers only an explicit retry for a retryable failure', async () => {
  jest.mocked(dataService.getCodeSetupAttempt).mockResolvedValue({
    ...initialAttempt,
    status: 'failed',
    failure: { code: 'provider_unavailable', retryable: true },
  });
  setup();
  expect(await screen.findByText(mockTranslations.com_ui_code_setup_retryable)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).toBeDisabled();
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
});

it('does not offer actions for an expired pending request', async () => {
  jest
    .mocked(dataService.getCodeSetupAttempt)
    .mockResolvedValue({ ...initialAttempt, expiresAt: '2000-01-01T00:00:00.000Z' });
  setup();
  expect(await screen.findByText(mockTranslations.com_ui_code_setup_expired)).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).not.toBeInTheDocument();
});

it.each([403, 404, 410])(
  'does not disclose the request on a wrong-user or unavailable %s response',
  async (status) => {
    jest.mocked(dataService.getCodeSetupAttempt).mockRejectedValue(httpError(status));
    setup();
    expect(
      await screen.findByText(mockTranslations.com_ui_code_setup_unavailable),
    ).toBeInTheDocument();
    expect(screen.queryByText(initialAttempt.machineName)).not.toBeInTheDocument();
    expect(screen.queryByText(/private server details/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
    ).not.toBeInTheDocument();
  },
);

it('retries a read failure without retrying a mutation', async () => {
  jest
    .mocked(dataService.getCodeSetupAttempt)
    .mockRejectedValueOnce(httpError(503))
    .mockResolvedValue(initialAttempt);
  setup();
  expect(
    await screen.findByText(mockTranslations.com_ui_code_setup_load_failed),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_retry }));
  expect(await screen.findByText(initialAttempt.machineName)).toBeInTheDocument();
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
});

it('reconciles a lost approval response before offering another decision', async () => {
  jest.mocked(dataService.approveCodeSetupAttempt).mockImplementation(async () => {
    jest
      .mocked(dataService.getCodeSetupAttempt)
      .mockResolvedValue({ ...initialAttempt, status: 'provisioning' });
    throw httpError(503);
  });
  setup();
  fireEvent.click(await screen.findByRole('radio', { name: 'My control plane' }));
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }));
  expect(
    await screen.findByText(mockTranslations.com_ui_code_setup_provisioning),
  ).toBeInTheDocument();
  expect(dataService.approveCodeSetupAttempt).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).not.toBeInTheDocument();
});

it('does not allow approval without an authorized plane, but still allows denial', async () => {
  jest
    .mocked(dataService.getCodeSetupAttempt)
    .mockResolvedValue({ ...initialAttempt, controlPlanes: [] });
  setup();
  expect(await screen.findByText(mockTranslations.com_ui_code_setup_no_planes)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_deny }),
  ).toBeEnabled();
});

it('uses account-scoped cache keys', async () => {
  const { queryClient } = setup();
  expect(await screen.findByText(initialAttempt.machineName)).toBeInTheDocument();
  expect(
    queryClient.getQueryData(DynamicQueryKeys.codeSetupAttempt('attempt-1', 'user-1')),
  ).toEqual(initialAttempt);
  expect(
    queryClient.getQueryData(DynamicQueryKeys.codeSetupAttempt('attempt-1', 'other-user')),
  ).toBeUndefined();
});

it('waits for normal auth readiness and does not fetch or approve early', () => {
  mockAuth.isAuthReady = false;
  setup();
  expect(screen.getByRole('status')).toHaveTextContent(mockTranslations.com_ui_code_setup_loading);
  expect(dataService.getCodeSetupAttempt).not.toHaveBeenCalled();
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
});

it('protects the exact setup route and preserves its destination under a basename', async () => {
  mockAuth.isAuthenticated = false;
  const { router } = setup({ basename: '/librechat' });
  await screen.findByText('Sign-in page');
  expect(router.state.location.pathname).toBe('/librechat/login');
  expect(new URLSearchParams(router.state.location.search).get('redirect_to')).toBe(
    '/code/setup/attempt-1',
  );
  expect(dataService.getCodeSetupAttempt).not.toHaveBeenCalled();
});

it.each(['/code/setup/attempt-1/extra', '/other/code/setup/attempt-1', '/code/setup'])(
  'does not match the non-exact path %s',
  async (path) => {
    setup({ path });
    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(dataService.getCodeSetupAttempt).not.toHaveBeenCalled();
  },
);

it('requires terms acceptance before setup and never treats acceptance as approval', async () => {
  jest.mocked(dataService.getStartupConfig).mockResolvedValue({
    interface: { termsOfService: { modalAcceptance: true, modalContent: 'Required terms' } },
  } as never);
  jest.mocked(dataService.getUserTerms).mockResolvedValue({ termsAccepted: false } as never);
  jest
    .mocked(dataService.acceptTerms)
    .mockResolvedValue({ termsAcceptedAt: '2026-10-22T00:00:00.000Z' } as never);
  setup();
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(dataService.getCodeSetupAttempt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_accept }));
  expect(await screen.findByText(initialAttempt.machineName)).toBeInTheDocument();
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
});

it('reopens terms when a decision is refused after a terms reset', async () => {
  jest.mocked(dataService.getStartupConfig).mockResolvedValue({
    interface: { termsOfService: { modalAcceptance: true, modalContent: 'Updated terms' } },
  } as never);
  jest
    .mocked(dataService.getUserTerms)
    .mockResolvedValueOnce({ termsAccepted: true } as never)
    .mockResolvedValue({ termsAccepted: false } as never);
  jest
    .mocked(dataService.approveCodeSetupAttempt)
    .mockRejectedValue(httpError(403, TERMS_NOT_ACCEPTED_CODE));
  setup();
  fireEvent.click(await screen.findByRole('radio', { name: 'My control plane' }));
  fireEvent.click(screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(dataService.approveCodeSetupAttempt).toHaveBeenCalledTimes(1);
});

it('expires at the original deadline without extending it during reads', async () => {
  jest.useFakeTimers();
  try {
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    jest
      .mocked(dataService.getCodeSetupAttempt)
      .mockResolvedValue({ ...initialAttempt, expiresAt });
    setup();
    expect(await screen.findByText(mockTranslations.com_ui_code_setup_pending)).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(await screen.findByText(mockTranslations.com_ui_code_setup_expired)).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('datetime', expiresAt);
    expect(
      screen.queryByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
    ).not.toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

it('disables a selected plane when it is no longer authorized', async () => {
  const { queryClient } = setup();
  fireEvent.click(await screen.findByRole('radio', { name: 'My control plane' }));
  expect(
    screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
  ).toBeEnabled();
  queryClient.setQueryData(DynamicQueryKeys.codeSetupAttempt('attempt-1', 'user-1'), {
    ...initialAttempt,
    controlPlanes: [],
  });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: mockTranslations.com_ui_code_setup_approve }),
    ).toBeDisabled(),
  );
  expect(dataService.approveCodeSetupAttempt).not.toHaveBeenCalled();
});
