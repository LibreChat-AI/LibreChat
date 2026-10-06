import React from 'react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversationPullRequest } from 'librechat-data-provider';
import usePullRequestMenu from '../menu';

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

/** Stands in for the overflow menu: the entry is a button the menu would render. */
function Harness({ conversationId }: { conversationId: string }) {
  const { item, dialog } = usePullRequestMenu(conversationId);
  return (
    <>
      {item != null && (
        <button
          type="button"
          ref={item.ref}
          aria-label={item.ariaLabel}
          data-hide-on-click={String(item.hideOnClick)}
          data-testid="menu-entry"
          onClick={item.onClick}
        >
          {item.label}
        </button>
      )}
      {dialog}
    </>
  );
}

const renderHarness = (conversationId = 'convo-1') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Harness conversationId={conversationId} />
    </QueryClientProvider>,
  );

describe('usePullRequestMenu', () => {
  beforeEach(() => mockGet.mockReset());

  it.each([
    ['while loading', () => new Promise(() => undefined)],
    ['without a pull request', () => Promise.resolve({ pullRequest: null })],
    ['when the lookup fails', () => Promise.reject(new Error('503'))],
  ])('offers no entry %s, so the menu is unchanged', async (_label, respond) => {
    mockGet.mockImplementation(respond);
    renderHarness();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByTestId('menu-entry')).not.toBeInTheDocument();
  });

  it('does not ask for a pull request without a conversation', () => {
    renderHarness('');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('offers an entry named by number whose label states what the colors say', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderHarness();
    const entry = await screen.findByTestId('menu-entry');
    expect(entry).toHaveTextContent('com_ui_pr_label:1234');
    expect(entry.getAttribute('aria-label')).toContain(pr.title);
    expect(entry.getAttribute('aria-label')).toContain('com_ui_pr_state:com_ui_pr_state_open');
  });

  it('keeps the menu open on click, as every dialog-opening entry must', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderHarness();
    expect(await screen.findByTestId('menu-entry')).toHaveAttribute('data-hide-on-click', 'false');
  });

  it('opens the same card in a dialog and returns focus to the entry on close', async () => {
    mockGet.mockResolvedValue({ pullRequest: pr });
    renderHarness();
    const entry = await screen.findByTestId('menu-entry');
    expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument();

    await userEvent.click(entry);
    const card = await screen.findByTestId('pull-request-card');
    expect(card).toHaveTextContent(pr.title);
    expect(screen.getByTestId('pull-request-github-link')).toHaveAttribute('href', pr.url);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument());
    await waitFor(() => expect(entry).toHaveFocus());
  });
});
