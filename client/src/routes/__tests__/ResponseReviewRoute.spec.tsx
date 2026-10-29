import React from 'react';
import { request } from 'librechat-data-provider';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResponseReviewView } from 'librechat-data-provider';
import ResponseReviewRoute from '../ResponseReviewRoute';
import { useAuthContext } from '~/hooks';

jest.mock('~/hooks', () => ({
  useAuthContext: jest.fn(),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
let getReview: jest.SpyInstance;
beforeEach(() => {
  window.history.replaceState({}, '', '/responses/resp_test/review');
  jest.mocked(useAuthContext).mockReturnValue({
    user: { id: 'user-a', tenantId: 'tenant-a' },
    isAuthenticated: true,
  } as ReturnType<typeof useAuthContext>);
  getReview = jest.spyOn(request, 'get');
  jest.spyOn(request, 'post').mockResolvedValue({ success: true });
});
afterEach(() => jest.restoreAllMocks());
function renderReview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Routes>
          <Route path="/responses/:responseId/review" element={<ResponseReviewRoute />} />
          <Route path="/login" element={<div data-testid="login" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}
const view: ResponseReviewView = {
  responseId: 'resp_test',
  status: 'in_progress',
  oauth: [
    {
      actionId: 'oauth-test',
      toolName: 'example',
      authURL: `https://oauth.example/auth?state=private&redirect_uri=${encodeURIComponent('http://localhost:3080/api/mcp/example/oauth/callback')}`,
      expiresAt: Date.now() + 60_000,
    },
  ],
};

it('shows an honest recovery warning and hides stale sign-in after execution state is lost', async () => {
  getReview.mockResolvedValue({ ...view, recovery: 'execution_state_unavailable' });
  renderReview();
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_response_review_recovery');
  expect(screen.queryByRole('link', { name: /sign/i })).not.toBeInTheDocument();
  expect(request.post).not.toHaveBeenCalled();
});

it('shows loading until the owner-authenticated request finishes', async () => {
  let finish: (value: ResponseReviewView) => void = () => {};
  getReview.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  renderReview();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  finish(view);
  expect(
    await screen.findByRole('button', { name: 'com_ui_response_review_authorize' }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_response_review_authorize' })).toBeEnabled(),
  );
  expect(request.post).toHaveBeenCalledWith('/api/mcp/example/oauth/bind');
});

it('offers retry for an unavailable or unauthorized request without exposing diagnostics', async () => {
  getReview.mockRejectedValueOnce(new Error('private-provider-detail')).mockResolvedValueOnce(view);
  renderReview();
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_response_review_unavailable');
  expect(document.body.textContent).not.toContain('private-provider-detail');
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  expect(
    await screen.findByRole('button', { name: 'com_ui_response_review_authorize' }),
  ).toBeInTheDocument();
});

it('shows terminal status with no sign-in action', async () => {
  getReview.mockResolvedValue({ ...view, status: 'completed' });
  renderReview();
  expect(await screen.findByRole('status')).toHaveTextContent('com_ui_response_review_complete');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_ui_response_review_authorize' }),
  ).not.toBeInTheDocument();
  expect(request.post).not.toHaveBeenCalled();
});

it('redirects unauthenticated users without fetching a private prompt', async () => {
  jest
    .mocked(useAuthContext)
    .mockReturnValue({ isAuthenticated: false } as ReturnType<typeof useAuthContext>);
  renderReview();
  await waitFor(() => expect(screen.getByTestId('login')).toBeInTheDocument());
  expect(getReview).not.toHaveBeenCalled();
});

it.each(['queued', 'in_progress'] as const)(
  'offers Stop while %s, including OAuth waits',
  async (status) => {
    getReview.mockResolvedValue({ ...view, status });
    jest
      .spyOn(request, 'post')
      .mockImplementation(async (path) =>
        String(path).endsWith('/cancel')
          ? { id: 'resp_test', status: 'in_progress' }
          : { success: true },
      );
    renderReview();
    await userEvent.click(await screen.findByRole('button', { name: 'com_ui_stop' }));
    expect(request.post).toHaveBeenCalledWith('/api/agents/responses/resp_test/cancel', {});
    expect(await screen.findByText('com_ui_response_review_stopping')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_response_review_stopped')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_response_review_authorize' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_stop' })).toBeDisabled();
    getReview.mockResolvedValue({ ...view, status: 'cancelled', oauth: [] });
    await waitFor(
      () => expect(screen.getByText('com_ui_response_review_stopped')).toBeInTheDocument(),
      { timeout: 4000 },
    );
    expect(screen.queryByRole('button', { name: 'com_ui_stop' })).not.toBeInTheDocument();
  },
);

it('does not treat a terminal cancel acknowledgement as canonical until review confirms it', async () => {
  getReview.mockResolvedValue({ ...view, oauth: [] });
  jest.spyOn(request, 'post').mockResolvedValue({ id: 'resp_test', status: 'cancelled' });
  renderReview();
  await userEvent.click(await screen.findByRole('button', { name: 'com_ui_stop' }));
  expect(await screen.findByText('com_ui_response_review_stopping')).toBeInTheDocument();
  expect(screen.queryByText('com_ui_response_review_stopped')).not.toBeInTheDocument();
});

it('does not double-submit Stop and permits only an explicit same-request retry after failure', async () => {
  getReview.mockResolvedValue({ ...view, oauth: [] });
  let fail: (error: Error) => void = () => {};
  jest.spyOn(request, 'post').mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  renderReview();
  const stop = await screen.findByRole('button', { name: 'com_ui_stop' });
  await userEvent.dblClick(stop);
  expect(request.post).toHaveBeenCalledTimes(1);
  fail(new Error('private diagnostic'));
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_response_review_stop_error');
  expect(document.body.textContent).not.toContain('private diagnostic');
  expect(request.post).toHaveBeenCalledTimes(1);
  getReview.mockResolvedValue({ ...view, status: 'cancelled', oauth: [] });
  jest.mocked(request.post).mockResolvedValueOnce({ id: 'resp_test', status: 'cancelled' });
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_response_review_stop_retry' }));
  expect(await screen.findByText('com_ui_response_review_stopped')).toBeInTheDocument();
  expect(request.post).toHaveBeenCalledTimes(2);
});

it.each(['cancelled', 'failed', 'incomplete', 'completed'] as const)(
  'does not offer Stop for %s',
  async (status) => {
    getReview.mockResolvedValue({ ...view, status, oauth: [] });
    renderReview();
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: 'com_ui_stop' })).not.toBeInTheDocument();
  },
);

it.each([
  {
    type: 'ask_user_question' as const,
    question: { question: 'Continue?', options: [{ label: 'Continue', value: 'yes' }] },
  },
  {
    type: 'tool_approval' as const,
    action_requests: [{ name: 'lookup', arguments: {}, tool_call_id: 'call' }],
    review_configs: [
      { action_name: 'lookup', tool_call_id: 'call', allowed_decisions: ['approve' as const] },
    ],
  },
])('supports Stop during a $type pause and disables its decision controls', async (payload) => {
  getReview.mockResolvedValue({
    ...view,
    oauth: [],
    canSubmitDecision: true,
    pendingAction: { actionId: 'action', expiresAt: Date.now() + 60000, payload },
  });
  jest.spyOn(request, 'post').mockResolvedValue({ id: 'resp_test', status: 'in_progress' });
  renderReview();
  await userEvent.click(await screen.findByRole('button', { name: 'com_ui_stop' }));
  expect(await screen.findByText('com_ui_response_review_stopping')).toBeInTheDocument();
  const fieldset = document.querySelector('fieldset');
  expect(fieldset).toBeDisabled();
  expect(request.post).toHaveBeenCalledTimes(1);
  expect(request.post).toHaveBeenCalledWith('/api/agents/responses/resp_test/cancel', {});
});
