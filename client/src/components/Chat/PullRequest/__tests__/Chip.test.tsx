import React from 'react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversationPullRequest } from 'librechat-data-provider';
import PullRequestChip from '../Chip';

const mockGet = jest.fn();

jest.mock('~/data-provider/Endpoints', () => ({
  useGetStartupConfig: () => ({ data: { pullRequestsEnabled: true } }),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationPullRequest: (...args: unknown[]) => mockGet(...args),
    },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) =>
    values == null ? key : `${key}:${Object.values(values).join(',')}`,
}));
const mockAgents: { current: Record<string, { name: string; avatar?: { filepath: string } }> } = {
  current: { 'agent-1': { name: 'Coder' } },
};
jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => mockAgents.current,
  useChatContext: () => ({ conversation: { agent_id: 'agent-1' } }),
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

const renderChip = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PullRequestChip conversationId="convo-1" />
    </QueryClientProvider>,
  );
};

describe('PullRequestChip', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockAgents.current = { 'agent-1': { name: 'Coder' } };
  });

  it('renders nothing while loading, so the header does not shift', () => {
    mockGet.mockReturnValue(new Promise(() => undefined));
    const { container } = renderChip();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a conversation without a pull request', async () => {
    mockGet.mockResolvedValue({ pullRequest: null });
    const { container } = renderChip();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the first lookup fails', async () => {
    mockGet.mockRejectedValue(new Error('503'));
    const { container } = renderChip();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the title, a CI dot and a label that states everything the colors say', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    const button = await screen.findByTestId('header-pull-request-button');
    expect(button).toHaveTextContent(pr.title);
    expect(screen.getByTestId('pull-request-ci-dot')).toHaveClass('bg-status-success');
    const label = button.getAttribute('aria-label') ?? '';
    expect(label).toContain(pr.title);
    expect(label).toContain('com_ui_pr_state:com_ui_pr_state_open');
    expect(label).toContain('com_ui_pr_checks:com_ui_pr_checks_passing');
  });

  it.each([
    ['failing', 'bg-status-error'],
    ['running', 'bg-status-warning'],
  ] as const)('colors the dot for %s checks', async (checks, dotClass) => {
    mockGet.mockResolvedValue({ pullRequest: { ...pr, checks } });
    renderChip();
    expect(await screen.findByTestId('pull-request-ci-dot')).toHaveClass(dotClass);
  });

  it('puts the dot on the agent picture when the agent has one, and not on the icon', async () => {
    mockAgents.current = {
      'agent-1': { name: 'Coder', avatar: { filepath: '/images/coder.png' } },
    };
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    const dot = await screen.findByTestId('pull-request-ci-dot');
    expect(screen.getAllByTestId('pull-request-ci-dot')).toHaveLength(1);
    expect(dot.parentElement?.querySelector('img')).not.toBeNull();
  });

  it('keeps the dot on the pull request icon when the agent has no picture', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    const dot = await screen.findByTestId('pull-request-ci-dot');
    expect(screen.getAllByTestId('pull-request-ci-dot')).toHaveLength(1);
    expect(dot.parentElement?.querySelector('svg')).not.toBeNull();
    expect(dot.parentElement?.querySelector('img')).toBeNull();
  });

  it('shows no dot when there are no checks', async () => {
    mockGet.mockResolvedValue({ pullRequest: { ...pr, checks: 'none' } });
    renderChip();
    await screen.findByTestId('header-pull-request-button');
    expect(screen.queryByTestId('pull-request-ci-dot')).not.toBeInTheDocument();
  });

  it('keeps the card closed until the chip is hovered or focused', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    const button = await screen.findByTestId('header-pull-request-button');
    expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the card on hover and says so on the chip', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    const button = await screen.findByTestId('header-pull-request-button');
    await userEvent.hover(button);
    const card = await screen.findByTestId('pull-request-card');
    expect(card.closest('[role="dialog"]')).toHaveAccessibleName('com_ui_pull_request');
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes the card when the pointer leaves', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    const button = await screen.findByTestId('header-pull-request-button');
    await userEvent.hover(button);
    await screen.findByTestId('pull-request-card');
    await userEvent.unhover(button);
    await waitFor(() => expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument());
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the card for keyboard focus', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    await screen.findByTestId('header-pull-request-button');
    await userEvent.tab();
    expect(screen.getByTestId('header-pull-request-button')).toHaveFocus();
    expect(await screen.findByTestId('pull-request-card')).toBeInTheDocument();
  });

  it('shows the GitHub tooltip inside the open card, so it is not painted behind it', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    await userEvent.hover(await screen.findByTestId('header-pull-request-button'));
    const card = await screen.findByTestId('pull-request-card');
    const layer = card.closest('[role="dialog"]') as HTMLElement;
    await userEvent.hover(screen.getByTestId('pull-request-github-link'));
    expect(await within(layer).findByRole('tooltip')).toHaveTextContent('com_ui_pr_open_in_github');
  });

  it('opens a card with the number, line counts, badges and a safe GitHub link', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderChip();
    await userEvent.click(await screen.findByTestId('header-pull-request-button'));
    const card = await screen.findByTestId('pull-request-card');
    expect(within(card).getByText('com_ui_pr_label:1234')).toBeInTheDocument();
    expect(within(card).getByText('+1234')).toBeInTheDocument();
    expect(within(card).getByText('-56')).toBeInTheDocument();
    expect(within(card).getByText(pr.title)).toBeInTheDocument();
    expect(within(card).getByText('com_ui_pr_state:com_ui_pr_state_open')).toBeInTheDocument();
    expect(within(card).getByText('com_ui_pr_checks:com_ui_pr_checks_passing')).toBeInTheDocument();
    const link = within(card).getByTestId('pull-request-github-link');
    expect(link).toHaveAttribute('href', pr.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName('com_ui_pr_open_in_github');
  });

  it('keeps the last known pull request when a later refresh fails', async () => {
    mockGet.mockResolvedValueOnce({ pullRequest: pr });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PullRequestChip conversationId="convo-1" />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByTestId('header-pull-request-button'));
    await screen.findByTestId('pull-request-card');
    expect(screen.queryByText('com_ui_pr_refresh_failed')).not.toBeInTheDocument();

    mockGet.mockRejectedValue(new Error('503'));
    await client.refetchQueries();

    expect(await screen.findByText('com_ui_pr_refresh_failed')).toBeInTheDocument();
    expect(screen.getByTestId('pull-request-card')).toHaveTextContent(pr.title);
  });

  it('labels a merged pull request and drops its CI dot', async () => {
    mockGet.mockResolvedValue({ pullRequest: { ...pr, state: 'merged' } });
    renderChip();
    const button = await screen.findByTestId('header-pull-request-button');
    expect(button.getAttribute('aria-label')).toContain('com_ui_pr_state_merged');
    expect(screen.queryByTestId('pull-request-ci-dot')).not.toBeInTheDocument();
  });
});
