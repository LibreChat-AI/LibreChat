import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { request } from 'librechat-data-provider';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ResponseReviewDecision, ResponseReviewView } from 'librechat-data-provider';
import translation from '~/locales/en/translation.json';
import Review from '../Review';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    jest.requireActual('~/locales/en/translation.json')[key] ?? key,
}));

const actionId = 'action-review';
function question(): ResponseReviewView {
  return {
    responseId: 'resp_review',
    status: 'in_progress',
    oauth: [],
    canSubmitDecision: true,
    pendingAction: {
      actionId,
      expiresAt: Date.now() + 60_000,
      payload: {
        type: 'ask_user_question',
        question: {
          question: 'Which environment?',
          options: [{ label: 'Staging', value: 'staging' }],
        },
      },
    },
  };
}
function tools(): ResponseReviewView {
  return {
    ...question(),
    pendingAction: {
      actionId,
      expiresAt: Date.now() + 60_000,
      payload: {
        type: 'tool_approval',
        action_requests: [{ name: 'search', arguments: { query: 'test' }, tool_call_id: 'call-1' }],
        review_configs: [
          {
            action_name: 'search',
            tool_call_id: 'call-1',
            allowed_decisions: ['approve', 'reject', 'edit', 'respond'],
          },
        ],
      },
    },
  };
}
function mount(
  review = question(),
  refresh = jest.fn().mockResolvedValue({ data: review, isError: false }),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const tree = (value: ResponseReviewView) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Review review={value} userId="owner" tenantId="tenant" refresh={refresh} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree(review));
  return {
    ...result,
    refresh,
    update: (value: ResponseReviewView) => result.rerender(tree(value)),
  };
}

let post: jest.SpyInstance;
let chatRequest: jest.SpyInstance;
beforeEach(() => {
  chatRequest = jest
    .spyOn(request, 'authenticatedFetch')
    .mockRejectedValue(new Error('Unexpected chat request'));
  post = jest.spyOn(request, 'post').mockResolvedValue({
    responseId: 'resp_review',
    actionId,
    intentId: 'intent-1',
    status: 'queued',
  });
});
afterEach(() => {
  const unexpectedChatCalls = chatRequest.mock.calls.length;
  jest.restoreAllMocks();
  if (unexpectedChatCalls) throw new Error('Responses review invoked the chat resume transport');
});

it('submits a single question through Responses and blocks a duplicate click', async () => {
  let finish: (value: object) => void = () => {};
  post.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  await userEvent.click(screen.getByRole('button', { name: /Staging/ }));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/api/agents/responses/resp_review/review', {
    actionId,
    answer: 'staging',
  });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: translation.com_ui_submitting }));
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({ responseId: 'resp_review', actionId, intentId: 'intent-1', status: 'queued' }),
  );
  expect(
    await screen.findByText(translation.com_ui_response_review_decision_queued),
  ).toBeInTheDocument();
});

it('uses the existing batch stepper and submits all answers together', async () => {
  const review = question();
  if (!review.pendingAction || review.pendingAction.payload.type !== 'ask_user_question')
    throw new Error('missing fixture');
  review.pendingAction.payload.questions = [
    {
      id: 'env',
      question: 'Which environment?',
      options: [{ label: 'Staging', value: 'staging' }],
    },
    { id: 'time', question: 'When?', options: [{ label: 'Now', value: 'now' }] },
  ];
  mount(review);
  await userEvent.click(screen.getByRole('button', { name: /Staging/ }));
  expect(post).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: /Now/ }));
  await userEvent.click(screen.getByRole('button', { name: translation.com_ui_submit }));
  expect(post).toHaveBeenCalledWith('/api/agents/responses/resp_review/review', {
    actionId,
    answers: { env: 'staging', time: 'now' },
  });
});

it.each([
  ['approve', translation.com_ui_approve, undefined, undefined],
  ['reject', translation.com_ui_reject, 'Not needed', 'reason'],
  ['respond', translation.com_ui_respond, 'Use this result', 'responseText'],
  ['edit', translation.com_ui_edit, '{"query":"updated"}', 'editedArguments'],
] as const)('submits the existing tool card %s decision', async (decision, label, text, field) => {
  mount(tools());
  expect(screen.getByText('search')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: label }));
  if (text)
    fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value: text } });
  await userEvent.click(screen.getByRole('button', { name: translation.com_ui_submit }));
  expect(post).toHaveBeenCalledWith('/api/agents/responses/resp_review/review', {
    actionId,
    decisions: [
      {
        tool_call_id: 'call-1',
        decision,
        ...(field ? { [field]: field === 'editedArguments' ? { query: 'updated' } : text } : {}),
      },
    ],
  });
});

it('requires all tool decisions and joins review configuration by tool call id', async () => {
  const review = tools();
  const payload = review.pendingAction?.payload;
  if (!payload || payload.type !== 'tool_approval') throw new Error('missing fixture');
  payload.action_requests.push({
    name: 'search',
    arguments: { query: 'second' },
    tool_call_id: 'call-2',
  });
  payload.review_configs = [
    { action_name: 'search', tool_call_id: 'call-2', allowed_decisions: ['reject'] },
    { action_name: 'search', tool_call_id: 'call-1', allowed_decisions: ['approve'] },
  ];
  mount(review);
  const [first, second] = screen.getAllByTestId('tool-approval');
  await userEvent.click(within(first).getByRole('button', { name: translation.com_ui_approve }));
  expect(screen.getByRole('button', { name: translation.com_ui_submit_decisions })).toBeDisabled();
  await userEvent.click(within(second).getByRole('button', { name: translation.com_ui_reject }));
  await userEvent.click(screen.getByRole('button', { name: translation.com_ui_submit_decisions }));
  expect(post).toHaveBeenCalledWith('/api/agents/responses/resp_review/review', {
    actionId,
    decisions: [
      { tool_call_id: 'call-1', decision: 'approve' },
      { tool_call_id: 'call-2', decision: 'reject' },
    ],
  });
});

it('restores only the immutable journaled decision and retries that exact payload', async () => {
  const decision: ResponseReviewDecision = { actionId, answer: 'saved answer' };
  mount({ ...question(), pendingDecision: { intentId: 'reserved-1', decision } });
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Staging/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText(translation.com_ui_response_review_saved)).toHaveTextContent(
    'saved answer',
  );
  await userEvent.click(screen.getByRole('button', { name: translation.com_ui_retry }));
  expect(post).toHaveBeenCalledWith('/api/agents/responses/resp_review/review', decision);
});

it('retains the attempted answer after failure, refetches the journal, and retries without leaking diagnostics', async () => {
  post.mockRejectedValueOnce(new Error('private provider credential'));
  const view = mount();
  await userEvent.click(screen.getByRole('button', { name: /Staging/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    translation.com_ui_response_review_decision_error,
  );
  await waitFor(() => expect(view.refresh).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('private provider credential');
  await userEvent.click(screen.getByRole('button', { name: translation.com_ui_retry }));
  expect(post).toHaveBeenNthCalledWith(2, '/api/agents/responses/resp_review/review', {
    actionId,
    answer: 'staging',
  });
});

it.each([
  [400, 'invalid_response_decision'],
  [403, 'response_decision_rejected'],
])(
  'allows correcting a definite %s rejection only after the owner confirms no reserved decision',
  async (status, error) => {
    post.mockRejectedValueOnce({ isAxiosError: true, response: { status, data: { error } } });
    const view = mount();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a'.repeat(17_000) } });
    await userEvent.click(screen.getByRole('button', { name: translation.com_ui_submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      translation.com_ui_response_review_decision_invalid,
    );
    expect(view.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox')).toHaveValue('a'.repeat(17_000));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Use staging' } });
    await userEvent.click(screen.getByRole('button', { name: translation.com_ui_submit }));
    expect(post).toHaveBeenNthCalledWith(2, '/api/agents/responses/resp_review/review', {
      actionId,
      answer: 'Use staging',
    });
  },
);

it('keeps a rejected attempt immutable when an owner refresh finds a reserved decision', async () => {
  const review = question();
  post.mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 400, data: { error: 'invalid_response_decision' } },
  });
  const refresh = jest.fn().mockResolvedValue({
    data: {
      ...review,
      pendingDecision: { intentId: 'reserved', decision: { actionId, answer: 'staging' } },
    },
    isError: false,
  });
  mount(review, refresh);
  await userEvent.click(screen.getByRole('button', { name: /Staging/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    translation.com_ui_response_review_decision_error,
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: translation.com_ui_retry }));
  expect(post).toHaveBeenNthCalledWith(2, '/api/agents/responses/resp_review/review', {
    actionId,
    answer: 'staging',
  });
});

it('keeps a definite rejection immutable when the owner refresh fails', async () => {
  post.mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 400, data: { error: 'invalid_response_decision' } },
  });
  const refresh = jest.fn().mockResolvedValue({ isError: true });
  mount(question(), refresh);
  await userEvent.click(screen.getByRole('button', { name: /Staging/ }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    translation.com_ui_response_review_decision_error,
  );
});

it('shows a localized unavailable state when a tool lacks review configuration', () => {
  const review = tools();
  if (review.pendingAction?.payload.type === 'tool_approval')
    review.pendingAction.payload.review_configs = [];
  mount(review);
  expect(screen.getByRole('alert')).toHaveTextContent(translation.com_ui_response_review_disabled);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});

it.each(['expired', 'capability', 'terminal'] as const)(
  'does not expose editable controls when %s',
  (condition) => {
    const review = question();
    if (condition === 'expired' && review.pendingAction)
      review.pendingAction.expiresAt = Date.now() - 1;
    if (condition === 'capability') review.canSubmitDecision = false;
    if (condition === 'terminal') review.status = 'completed';
    mount(review);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  },
);

it('removes controls at expiry without waiting for a server refresh', () => {
  jest.useFakeTimers();
  try {
    const review = question();
    if (review.pendingAction) review.pendingAction.expiresAt = Date.now() + 1000;
    mount(review);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(1001);
    });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(translation.com_ui_approval_expired);
    expect(post).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('disables recovery when the journal action differs from the current action', () => {
  mount({
    ...question(),
    pendingDecision: {
      intentId: 'reserved-1',
      decision: { actionId: 'old-action', answer: 'old' },
    },
  });
  expect(screen.getByRole('button', { name: translation.com_ui_retry })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
});
