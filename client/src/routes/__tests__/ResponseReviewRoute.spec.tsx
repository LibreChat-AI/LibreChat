import React from 'react';
import { RecoilRoot } from 'recoil';
import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { request, dataService, QueryKeys } from 'librechat-data-provider';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ResponseReviewView } from 'librechat-data-provider';
import ResponseReviewRoute from '../ResponseReviewRoute';
import { useAuthContext } from '~/hooks';
import store from '~/store';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getStartupConfig: jest.fn(),
      getUserTerms: jest.fn(),
      acceptTerms: jest.fn(),
    },
  };
});
jest.mock('~/hooks', () => ({
  useAuthContext: jest.fn(),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock(
  '~/components/Chat/Messages/Content/MarkdownLite',
  () =>
    ({ content }: { content: string }) => <p>{content}</p>,
);
let getReview: jest.SpyInstance;
const startup = jest.mocked(dataService.getStartupConfig);
const terms = jest.mocked(dataService.getUserTerms);
const acceptTerms = jest.mocked(dataService.acceptTerms);
beforeEach(() => {
  window.history.replaceState({}, '', '/responses/resp_test/review');
  jest.mocked(useAuthContext).mockReturnValue({
    user: { id: 'user-a', tenantId: 'tenant-a' },
    isAuthenticated: true,
    isAuthReady: true,
    logout: jest.fn(),
  } as unknown as ReturnType<typeof useAuthContext>);
  startup.mockReset().mockResolvedValue({ interface: {} } as never);
  terms
    .mockReset()
    .mockResolvedValue({ termsAccepted: true, termsAcceptedAt: new Date('2030-01-01') });
  acceptTerms
    .mockReset()
    .mockResolvedValue({ message: 'Accepted', termsAcceptedAt: '2030-01-01T00:00:00.000Z' });
  getReview = jest.spyOn(request, 'get');
  jest.spyOn(request, 'post').mockResolvedValue({ success: true });
});
afterEach(() => jest.restoreAllMocks());
function renderReview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.queriesEnabled, true);
          set(store.user, jest.mocked(useAuthContext)().user as never);
        }}
      >
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/responses/:responseId/review" element={<ResponseReviewRoute />} />
              <Route path="/login" element={<div data-testid="login" />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const result = render(tree());
  return { ...result, client, rerenderReview: () => result.rerender(tree()) };
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
    .mockReturnValue({ isAuthenticated: false, isAuthReady: true } as ReturnType<
      typeof useAuthContext
    >);
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

const reviewKey = [QueryKeys.responseReview, 'user-a', 'tenant-a', 'resp_test'];
function questionView(): ResponseReviewView {
  return {
    ...view,
    oauth: [],
    canSubmitDecision: true,
    pendingAction: {
      actionId: 'question-action',
      expiresAt: Date.now() + 60_000,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Continue?', options: [{ label: 'Continue', value: 'yes' }] },
      },
    },
  };
}

it('waits for a slow restored session before redirecting or reading private data', async () => {
  const authenticated = jest.mocked(useAuthContext)();
  jest.mocked(useAuthContext).mockReturnValue({
    ...authenticated,
    user: undefined,
    isAuthenticated: false,
    isAuthReady: false,
  } as ReturnType<typeof useAuthContext>);
  getReview.mockResolvedValue({ ...view, oauth: [] });
  const mounted = renderReview();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(screen.queryByTestId('login')).not.toBeInTheDocument();
  expect(getReview).not.toHaveBeenCalled();
  jest.mocked(useAuthContext).mockReturnValue(authenticated);
  mounted.rerenderReview();
  expect(await screen.findByRole('button', { name: 'com_ui_stop' })).toBeEnabled();
  expect(screen.queryByTestId('login')).not.toBeInTheDocument();
});

it('retains the same draft form across a polling error and enables it only after a fresh read', async () => {
  getReview.mockResolvedValue(questionView());
  const { client } = renderReview();
  const draft = await screen.findByRole('textbox');
  await waitFor(() => expect(draft).toBeEnabled());
  fireEvent.change(draft, { target: { value: 'Keep this answer' } });
  getReview.mockRejectedValue(new Error('lost connection'));
  await act(async () => {
    await client.invalidateQueries(reviewKey);
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_response_review_unavailable');
  expect(screen.getByRole('textbox')).toBe(draft);
  expect(draft).toHaveValue('Keep this answer');
  expect(draft).toBeDisabled();
  expect(request.post).not.toHaveBeenCalled();
  getReview.mockResolvedValue(questionView());
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(draft).toBeEnabled());
  expect(screen.getByRole('textbox')).toBe(draft);
  expect(draft).toHaveValue('Keep this answer');
  expect(request.post).not.toHaveBeenCalled();
});

it('keeps an uncertain Stop sticky across a failed poll and permits only explicit Stop retry', async () => {
  getReview.mockResolvedValue(questionView());
  const { client } = renderReview();
  const stop = await screen.findByRole('button', { name: 'com_ui_stop' });
  await waitFor(() => expect(stop).toBeEnabled());
  jest.mocked(request.post).mockRejectedValue(new Error('lost cancel acknowledgement'));
  getReview.mockRejectedValue(new Error('poll failed'));
  await userEvent.click(stop);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'com_ui_response_review_stop_retry' }),
    ).toBeDisabled(),
  );
  getReview.mockResolvedValue(questionView());
  await act(async () => {
    await client.invalidateQueries(reviewKey);
  });
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(request.post).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'com_ui_response_review_stop_retry' })).toBeEnabled(),
  );
  jest.mocked(request.post).mockResolvedValue({ id: 'resp_test', status: 'cancelled' });
  getReview.mockResolvedValue({ ...view, oauth: [], status: 'cancelled' });
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_response_review_stop_retry' }));
  expect(await screen.findByText('com_ui_response_review_stopped')).toBeInTheDocument();
  expect(request.post).toHaveBeenCalledTimes(2);
});

it('gates OAuth binding and Stop until the actual terms modal accepts current policy', async () => {
  startup.mockResolvedValue({
    interface: { termsOfService: { modalAcceptance: true, modalContent: 'Current terms' } },
  } as never);
  terms.mockResolvedValue({ termsAccepted: false, termsAcceptedAt: null });
  getReview.mockResolvedValue(view);
  renderReview();
  const accept = await screen.findByRole('button', { name: 'com_ui_accept' });
  expect(screen.getByText('com_ui_stop').closest('button')).toBeDisabled();
  expect(request.post).not.toHaveBeenCalled();
  await userEvent.click(accept);
  expect(acceptTerms).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole('button', { name: 'com_ui_stop' })).toBeEnabled());
  expect(request.post).toHaveBeenCalledTimes(1);
  expect(request.post).toHaveBeenCalledWith('/api/mcp/example/oauth/bind');
});

it.each(['startup', 'terms'] as const)(
  'fails closed on %s policy errors and retries its owning query',
  async (failed) => {
    startup.mockResolvedValue({
      interface: { termsOfService: { modalAcceptance: true } },
    } as never);
    if (failed === 'startup') startup.mockRejectedValueOnce(new Error('private config failure'));
    else terms.mockRejectedValueOnce(new Error('private terms failure'));
    getReview.mockResolvedValue(view);
    renderReview();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'com_ui_response_review_unavailable',
    );
    expect(request.post).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'com_ui_stop' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'com_ui_stop' })).toBeEnabled());
    expect(failed === 'startup' ? startup : terms).toHaveBeenCalledTimes(2);
  },
);

it('retains the immutable decision attempt through polling failure without automatically resubmitting', async () => {
  getReview.mockResolvedValue(questionView());
  let rejectDecision!: (error: Error) => void;
  jest.mocked(request.post).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectDecision = reject;
      }),
  );
  const { client } = renderReview();
  const answer = await screen.findByRole('button', { name: /Continue/ });
  await waitFor(() => expect(answer).toBeEnabled());
  await userEvent.click(answer);
  expect(request.post).toHaveBeenCalledTimes(1);
  const submitted = jest.mocked(request.post).mock.calls[0];
  getReview.mockRejectedValue(new Error('poll unavailable'));
  await act(async () => {
    await client.invalidateQueries(reviewKey);
  });
  expect(await screen.findByText('com_ui_response_review_saved')).toBeInTheDocument();
  await act(async () => {
    rejectDecision(new Error('acknowledgement lost'));
  });
  expect(await screen.findByText('com_ui_response_review_decision_error')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(request.post).toHaveBeenCalledTimes(1);
  getReview.mockResolvedValue(questionView());
  await act(async () => {
    await client.invalidateQueries(reviewKey);
  });
  const retry = within(
    screen.getByRole('region', { name: 'com_ui_response_review_decision' }),
  ).getByRole('button', { name: 'com_ui_retry' });
  await waitFor(() => expect(retry).toBeEnabled());
  jest.mocked(request.post).mockResolvedValue({ status: 'queued' });
  await userEvent.click(retry);
  expect(request.post).toHaveBeenCalledTimes(2);
  expect(jest.mocked(request.post).mock.calls[1]).toEqual(submitted);
});

it('discards the old owner draft and waits for current policy instead of trusting the shared cache', async () => {
  getReview.mockResolvedValue(questionView());
  const mounted = renderReview();
  const draft = await screen.findByRole('textbox');
  await waitFor(() => expect(draft).toBeEnabled());
  fireEvent.change(draft, { target: { value: 'Owner A only' } });
  let finishPolicy!: (value: never) => void;
  startup.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPolicy = resolve;
      }),
  );
  const auth = jest.mocked(useAuthContext)();
  jest
    .mocked(useAuthContext)
    .mockReturnValue({ ...auth, user: { id: 'user-b', tenantId: 'tenant-b' } } as ReturnType<
      typeof useAuthContext
    >);
  mounted.rerenderReview();
  const newDraft = await screen.findByRole('textbox');
  expect(newDraft).not.toBe(draft);
  expect(newDraft).toHaveValue('');
  expect(newDraft).toBeDisabled();
  expect(request.post).not.toHaveBeenCalled();
  await act(async () => {
    finishPolicy({ interface: {} } as never);
  });
  await waitFor(() => expect(newDraft).toBeEnabled());
});

it('declines the actual terms modal through logout without binding OAuth or cancelling', async () => {
  startup.mockResolvedValue({ interface: { termsOfService: { modalAcceptance: true } } } as never);
  terms.mockResolvedValue({ termsAccepted: false, termsAcceptedAt: null });
  getReview.mockResolvedValue(view);
  renderReview();
  await userEvent.click(await screen.findByRole('button', { name: 'com_ui_decline' }));
  expect(jest.mocked(useAuthContext)().logout).toHaveBeenCalledWith('/login?redirect=false');
  expect(request.post).not.toHaveBeenCalled();
  expect(acceptTerms).not.toHaveBeenCalled();
});
