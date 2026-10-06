import React from 'react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TConversationPullRequest } from 'librechat-data-provider';
import PullRequestRowMark from '../RowMark';

const mockGetMany = jest.fn();
const mockStartup: { current: { pullRequestsEnabled?: boolean } | undefined } = {
  current: { pullRequestsEnabled: true },
};

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <div data-testid="row" onClick={rowClick}>
        <PullRequestRowMark
          conversationId="convo-1"
          labelId="pr-label"
          selected={false}
          {...props}
        />
      </div>
    </QueryClientProvider>,
  );
  return { ...view, rowClick, client };
};

describe('PullRequestRowMark', () => {
  beforeEach(() => {
    mockGetMany.mockReset();
    mockStartup.current = { pullRequestsEnabled: true };
  });

  it.each([
    ['while loading', () => new Promise(() => undefined)],
    ['without a pull request', () => Promise.resolve(answer('convo-1', null))],
    ['when the lookup fails', () => Promise.reject(new Error('503'))],
    [
      'when that conversation failed on the server',
      () =>
        Promise.resolve({
          results: [{ conversationId: 'convo-1', error: { code: 'RATE_LIMITED' } }],
        }),
    ],
  ])('renders nothing %s, so the row is unchanged', async (_label, respond) => {
    mockGetMany.mockImplementation(respond);
    const { container } = renderMark();
    await waitFor(() => expect(mockGetMany).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="convo-pull-request"]')).toBeNull();
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
    expect(mockGetMany).toHaveBeenCalledWith(['convo-1']);
  });

  it('shows the state icon with the CI dot, in the row surface colors', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark({ selected: false });
    const dot = await screen.findByTestId('pull-request-ci-dot');
    expect(dot).toHaveClass('bg-status-success', 'ring-surface-primary-alt');
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

  it('writes what the colors say into text the row can announce', async () => {
    mockGetMany.mockResolvedValue(answer('convo-1', pr));
    renderMark({ labelId: 'row-pr' });
    await screen.findByTestId('convo-pull-request');
    const text = document.getElementById('row-pr');
    expect(text).toHaveTextContent(pr.title);
    expect(text).toHaveTextContent('com_ui_pr_state_open');
    expect(text).toHaveTextContent('com_ui_pr_checks_passing');
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
