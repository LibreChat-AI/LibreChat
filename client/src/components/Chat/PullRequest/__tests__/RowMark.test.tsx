import React from 'react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TConversationPullRequest } from 'librechat-data-provider';
import PullRequestRowMark from '../RowMark';

const mockGetMany = jest.fn();
const mockGetOne = jest.fn();
const mockStartup: {
  current: { pullRequestsEnabled?: boolean; pullRequestsBatchVersion?: number } | undefined;
} = {
  current: { pullRequestsEnabled: true, pullRequestsBatchVersion: 1 },
};

const mockUser: { current: { id: string } | undefined } = { current: { id: 'user-a' } };
jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: () => mockUser.current,
}));
jest.mock('~/data-provider/Endpoints', () => ({
  useGetStartupConfig: () => ({ data: mockStartup.current }),
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationPullRequests: (...args: unknown[]) => mockGetMany(...args),
      getConversationPullRequest: (...args: unknown[]) => mockGetOne(...args),
    },
  };
});
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) =>
    values == null ? key : `${key}:${Object.values(values).join(',')}`,
}));

const pr: TConversationPullRequest = {
  number: 1234,
  title: 'Simplify Single Tool Execution Path',
  url: 'https://github.com/LibreChat-AI/LibreChat/pull/1234',
  additions: 1234,
  deletions: 56,
  state: 'open',
  isDraft: false,
  mergeable: 'clean',
  checks: 'passing',
};

const answer = (conversationId: string, value: TConversationPullRequest | null) => ({
  results: [{ conversationId, pullRequest: value }],
});

let pointerX = 100;
const movePointerOver = (element: HTMLElement) => {
  pointerX += 7;
  fireEvent.mouseMove(element, {
    screenX: pointerX,
    screenY: pointerX,
    movementX: 7,
    movementY: 7,
  });
};

const renderMark = (props: Partial<React.ComponentProps<typeof PullRequestRowMark>> = {}) => {
  const rowClick = jest.fn();
  const rowKey = jest.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <div data-testid="row" onClick={rowClick} onKeyDown={rowKey}>
        <PullRequestRowMark
          conversationId="convo-1"
          labelId="pr-label"
          selected={false}
          {...props}
        />
      </div>
    </QueryClientProvider>,
  );
  return { ...view, rowClick, rowKey, client };
};

describe('PullRequestRowMark', () => {
  beforeEach(() => {
    mockGetMany.mockReset();
    mockGetOne.mockReset();
    mockStartup.current = { pullRequestsEnabled: true, pullRequestsBatchVersion: 1 };
    mockUser.current = { id: 'user-a' };
  });

  it.each([
    [
      'while loading',
      () => new Promise((resolve) => setTimeout(() => resolve(answer('convo-1', null)), 40)),
    ],
    ['without a pull request', () => Promise.resolve(answer('convo-1', null))],
  ])('renders nothing %s, so the row is unchanged', async (_label, respond) => {
    mockGetMany.mockImplementation(respond);
    const { container } = renderMark();
    await waitFor(() => expect(mockGetMany).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector('[data-testid="convo-pull-request"]')).toBeNull();
    expect(container.querySelector('[data-testid="convo-pull-request-failed"]')).toBeNull();
  });

  it.each([
    ['the request fails', () => Promise.reject(new Error('503'))],
    [
      'that conversation failed on the server',
      () =>
        Promise.resolve({
          results: [{ conversationId: 'convo-1', error: { code: 'RATE_LIMITED' } }],
        }),
    ],
  ])('says the lookup failed, with a retry, when %s', async (_label, respond) => {
    mockGetMany.mockImplementationOnce(respond);
    renderMark();
    const failed = await screen.findByTestId('convo-pull-request-failed');
    expect(failed).toHaveAccessibleName('com_ui_pr_load_failed');
    expect(screen.queryByTestId('convo-pull-request')).toBeNull();
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    fireEvent.focus(failed);
    const retry = await screen.findByRole('button', { name: 'com_ui_retry' });
    fireEvent.click(retry);
    expect(await screen.findByTestId('convo-pull-request')).toBeInTheDocument();
    expect(mockGetMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an older server that has the flag but not the batch route', { pullRequestsEnabled: true }],
    [
      'a batch version this client does not know',
      { pullRequestsEnabled: true, pullRequestsBatchVersion: 2 },
    ],
    ['the version without the flag', { pullRequestsBatchVersion: 1 }],
  ])('does not ask %s, so a rolling upgrade shows no failure marks', async (_label, startup) => {
    mockStartup.current = startup;
    const { container } = renderMark();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockGetMany).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="convo-pull-request"]')).toBeNull();
    expect(container.querySelector('[data-testid="convo-pull-request-failed"]')).toBeNull();
  });

  it('shows the failure when a refresh fails after an empty answer was cached', async () => {
    jest.useFakeTimers();
    try {
      mockGetMany
        .mockResolvedValueOnce(answer('convo-1', null))
        .mockRejectedValue(new Error('503'));
      renderMark();
      await jest.advanceTimersByTimeAsync(100);
      expect(screen.queryByTestId('convo-pull-request-failed')).toBeNull();
      await jest.advanceTimersByTimeAsync(61_000);
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(100);
      expect(screen.getByTestId('convo-pull-request-failed')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps its spacing on the rendered mark, so an absent mark takes no room', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    const first = renderMark();
    expect(await screen.findByTestId('convo-pull-request')).toHaveClass('mr-1');
    first.unmount();
    mockGetMany.mockRejectedValueOnce(new Error('503'));
    renderMark();
    expect(await screen.findByTestId('convo-pull-request-failed')).toHaveClass('mr-1');
  });

  it('falls back to the single route when the replica that answered has no batch route', async () => {
    mockGetMany.mockRejectedValue(
      Object.assign(new Error('Not Found'), { response: { status: 404 } }),
    );
    mockGetOne.mockResolvedValue({ pullRequest: pr });
    renderMark();
    expect(await screen.findByTestId('convo-pull-request')).toBeInTheDocument();
    expect(mockGetOne).toHaveBeenCalledWith('convo-1', { signal: expect.any(AbortSignal) });
    expect(screen.queryByTestId('convo-pull-request-failed')).toBeNull();
  });

  it('shows no failure for a conversation without a pull request when only the batch route is missing', async () => {
    mockGetMany.mockRejectedValue(
      Object.assign(new Error('Not Found'), { response: { status: 404 } }),
    );
    mockGetOne.mockResolvedValue({ pullRequest: null });
    const { container } = renderMark();
    await waitFor(() => expect(mockGetOne).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector('[data-testid="convo-pull-request-failed"]')).toBeNull();
    expect(container.querySelector('[data-testid="convo-pull-request"]')).toBeNull();
  });

  it('does not ask for a user it cannot name, so a batch is never sent for no one', async () => {
    mockUser.current = undefined;
    const { container } = renderMark();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockGetMany).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="convo-pull-request"]')).toBeNull();
  });

  it('asks again for the next account, in a queue of its own, once the user changes', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    const first = renderMark({ conversationId: 'convo-1' });
    await screen.findByTestId('convo-pull-request');
    first.unmount();

    /** The next account's row is not held up by anything the previous account left queued. */
    mockUser.current = { id: 'user-b' };
    mockGetMany.mockResolvedValue(answer('convo-2', { ...pr, number: 2 }));
    renderMark({ conversationId: 'convo-2' });
    await screen.findByTestId('convo-pull-request');
    expect(mockGetMany).toHaveBeenLastCalledWith(['convo-2'], { signal: expect.any(AbortSignal) });
  });

  it('does not hold the next account behind work the previous account left in flight', async () => {
    /** The first account's request never answers, as a stalled upstream would leave it. */
    mockGetMany.mockImplementationOnce(() => new Promise(() => undefined));
    const stalled = renderMark({ conversationId: 'convo-1' });
    await waitFor(() => expect(mockGetMany).toHaveBeenCalledTimes(1));
    stalled.unmount();

    mockUser.current = { id: 'user-b' };
    mockGetMany.mockResolvedValue(answer('convo-2', { ...pr, number: 2 }));
    renderMark({ conversationId: 'convo-2' });
    /** Without a queue of its own it would wait out the other account's request, which never ends. */
    expect(await screen.findByTestId('convo-pull-request')).toBeInTheDocument();
    expect(mockGetMany).toHaveBeenLastCalledWith(['convo-2'], { signal: expect.any(AbortSignal) });
  });

  it('does not ask when the deployment does not advertise the feature', async () => {
    mockStartup.current = { pullRequestsEnabled: false };
    const { container } = renderMark();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockGetMany).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="convo-pull-request"]')).toBeNull();
  });

  it('asks through the batch endpoint with the conversation id', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark();
    await screen.findByTestId('convo-pull-request');
    expect(mockGetMany).toHaveBeenCalledWith(['convo-1'], { signal: expect.any(AbortSignal) });
  });

  it('shows the state icon with the CI dot, in the row surface colors', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark({ selected: false });
    const dot = await screen.findByTestId('pull-request-ci-dot');
    expect(dot).toHaveClass('bg-status-success', 'ring-surface-sidebar');
    expect(screen.getByTestId('convo-pull-request').querySelector('svg')).toHaveClass(
      'text-status-success',
    );
  });

  it('paints the dot ring in the selected surface for the open conversation', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark({ selected: true });
    expect(await screen.findByTestId('pull-request-ci-dot')).toHaveClass(
      'ring-surface-nav-selected',
    );
  });

  it.each([
    ['failing', { checks: 'failing' as const }, 'bg-status-error', 'text-status-success'],
    ['running', { checks: 'running' as const }, 'bg-status-warning', 'text-status-success'],
    ['conflicts', { mergeable: 'conflicting' as const }, 'bg-status-success', 'text-status-error'],
  ])('colors the dot and icon for %s', async (_label, patch, dotClass, iconClass) => {
    mockGetMany.mockResolvedValue(answer('convo-1', { ...pr, ...patch }));
    renderMark();
    expect(await screen.findByTestId('pull-request-ci-dot')).toHaveClass(dotClass);
    expect(screen.getByTestId('convo-pull-request').querySelector('svg')).toHaveClass(iconClass);
  });

  it('shows no dot when there are no checks, or the pull request is finished', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', { ...pr, checks: 'none' }));
    const first = renderMark();
    await screen.findByTestId('convo-pull-request');
    expect(screen.queryByTestId('pull-request-ci-dot')).not.toBeInTheDocument();
    first.unmount();
    mockGetMany.mockResolvedValue(answer('convo-1', { ...pr, state: 'merged' }));
    renderMark();
    await screen.findByTestId('convo-pull-request');
    expect(screen.queryByTestId('pull-request-ci-dot')).not.toBeInTheDocument();
  });

  it('tells the row when its description exists, and when it stops existing', async () => {
    const onDescribed = jest.fn();
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    const { unmount } = renderMark({ onDescribed });
    await screen.findByTestId('convo-pull-request');
    expect(onDescribed).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onDescribed).toHaveBeenLastCalledWith(false);
  });

  it('reports no description while loading or without a pull request', async () => {
    const onDescribed = jest.fn();
    mockGetMany.mockResolvedValue(answer('convo-1', null));
    renderMark({ onDescribed });
    await waitFor(() => expect(mockGetMany).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onDescribed).not.toHaveBeenCalledWith(true);
  });

  it('reports a description for a failed lookup too, since it renders the failure text', async () => {
    const onDescribed = jest.fn();
    mockGetMany.mockRejectedValueOnce(new Error('503'));
    renderMark({ onDescribed });
    await screen.findByTestId('convo-pull-request-failed');
    expect(onDescribed).toHaveBeenLastCalledWith(true);
  });

  it('writes what the colors say into text the row can announce', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark({ labelId: 'row-pr' });
    await screen.findByTestId('convo-pull-request');
    const text = document.getElementById('row-pr');
    expect(text).toHaveTextContent(pr.title);
    expect(text).toHaveTextContent('com_ui_pr_state_open');
    expect(text).toHaveTextContent('com_ui_pr_checks_passing');
  });

  it('is a button with an accessible name that says what the colors say', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark();
    const mark = await screen.findByTestId('convo-pull-request');
    expect(mark.tagName).toBe('BUTTON');
    expect(mark).toHaveAccessibleName(expect.stringContaining(pr.title));
    expect(mark).toHaveAccessibleName(expect.stringContaining('com_ui_pr_checks_passing'));
    expect(mark).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the card for keyboard focus, so its GitHub link is reachable', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark();
    const mark = await screen.findByTestId('convo-pull-request');
    await userEvent.tab();
    expect(mark).toHaveFocus();
    expect(await screen.findByTestId('pull-request-card')).toBeInTheDocument();
    expect(mark).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the card on click without opening the row, and keeps Enter and Space off the row', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    const { rowClick, rowKey } = renderMark();
    const mark = await screen.findByTestId('convo-pull-request');
    fireEvent.click(mark);
    expect(await screen.findByTestId('pull-request-card')).toBeInTheDocument();
    fireEvent.keyDown(mark, { key: 'Enter' });
    fireEvent.keyDown(mark, { key: ' ' });
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
  });

  it('opens the card to the side on hover, and closes it when the pointer leaves', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark();
    const mark = await screen.findByTestId('convo-pull-request');
    expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument();
    movePointerOver(mark);
    const card = await screen.findByTestId('pull-request-card');
    expect(card).toHaveTextContent(pr.title);
    expect(screen.getByTestId('pull-request-github-link')).toHaveAttribute('href', pr.url);
    fireEvent.mouseLeave(mark);
    fireEvent.mouseMove(document.body, { screenX: 900, screenY: 900, movementX: 7, movementY: 7 });
    await waitFor(() => expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument());
  });

  it('does not open the row when the card is clicked', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    const { rowClick } = renderMark();
    movePointerOver(await screen.findByTestId('convo-pull-request'));
    const card = await screen.findByTestId('pull-request-card');
    fireEvent.click(card);
    fireEvent.click(screen.getByTestId('pull-request-github-link'));
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('refreshes every row in one request when the window regains focus, once its answer is stale', async () => {
    jest.useFakeTimers();
    try {
      mockGetMany.mockResolvedValue(answer('convo-1', pr));
      renderMark();
      await jest.advanceTimersByTimeAsync(100);
      expect(mockGetMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(61_000);
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(100);
      expect(mockGetMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not refresh on focus while its answer is still fresh', async () => {
    jest.useFakeTimers();
    try {
      mockGetMany.mockResolvedValue(answer('convo-1', pr));
      renderMark();
      await jest.advanceTimersByTimeAsync(100);
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(100);
      expect(mockGetMany).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never polls, so a list of rows does not poll GitHub once per row', async () => {
    jest.useFakeTimers();
    try {
      mockGetMany.mockResolvedValue(answer('convo-1', { ...pr, checks: 'running' }));
      renderMark();
      await jest.advanceTimersByTimeAsync(100);
      expect(mockGetMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(mockGetMany).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares its cache entry with the header, so one conversation is fetched once', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    const { client } = renderMark();
    await screen.findByTestId('convo-pull-request');
    expect(client.getQueryData(['conversationPullRequest', 'convo-1'])).toEqual({
      pullRequest: pr,
    });
  });
});
