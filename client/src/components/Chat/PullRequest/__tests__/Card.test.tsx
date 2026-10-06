import React from 'react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { TConversationPullRequest } from 'librechat-data-provider';
import PullRequestCard from '../Card';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string | number>) =>
    values == null ? key : `${key}:${Object.values(values).join(',')}`,
}));

const pr: TConversationPullRequest = {
  number: 7,
  title: 'Simplify Single Tool Execution Path',
  url: 'https://github.com/o/r/pull/7',
  additions: 12,
  deletions: 3,
  state: 'open',
  isDraft: false,
  mergeable: 'conflicting',
  checks: 'failing',
};

describe('PullRequestCard', () => {
  it('shows conflicts and failing checks as error badges', () => {
    render(<PullRequestCard pullRequest={pr} />);
    const state = screen.getByTestId('pull-request-state-badge');
    const checks = screen.getByTestId('pull-request-checks-badge');
    expect(state).toHaveTextContent('com_ui_pr_state:com_ui_pr_state_conflicts');
    expect(checks).toHaveTextContent('com_ui_pr_checks:com_ui_pr_checks_failing');
    expect(state).toHaveClass('text-status-error');
    expect(checks).toHaveClass('text-status-error');
  });

  it('renders the badges with the shared Chip, so they follow its sizing and theming', () => {
    render(<PullRequestCard pullRequest={pr} />);
    for (const id of ['pull-request-state-badge', 'pull-request-checks-badge']) {
      const badge = screen.getByTestId(id);
      expect(badge).toHaveClass('inline-flex', 'rounded-theme-control', 'min-h-6');
    }
  });

  it('puts the GitHub tooltip in the layer the card lives in, not behind it', async () => {
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    render(<PullRequestCard pullRequest={pr} portalElement={layer} />);
    await userEvent.hover(screen.getByTestId('pull-request-github-link'));
    expect(await within(layer).findByText('com_ui_pr_open_in_github')).toBeInTheDocument();
    layer.remove();
  });

  it('colors added lines and removed lines with their own roles and names them for a screen reader', () => {
    render(<PullRequestCard pullRequest={pr} />);
    expect(screen.getByText('+12')).toHaveClass('text-status-success');
    expect(screen.getByText('-3')).toHaveClass('text-status-error');
    expect(screen.getByLabelText('com_ui_pr_additions:12')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_pr_deletions:3')).toBeInTheDocument();
  });

  it('does not show a refresh warning by default', () => {
    render(<PullRequestCard pullRequest={pr} />);
    expect(screen.queryByText('com_ui_pr_refresh_failed')).not.toBeInTheDocument();
  });

  it('announces a failed refresh and retries on request', async () => {
    const onRetry = jest.fn();
    render(<PullRequestCard pullRequest={pr} refreshFailed onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_pr_refresh_failed');
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows a failed refresh without a retry button when no handler is given', () => {
    render(<PullRequestCard pullRequest={pr} refreshFailed />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
  });
});
