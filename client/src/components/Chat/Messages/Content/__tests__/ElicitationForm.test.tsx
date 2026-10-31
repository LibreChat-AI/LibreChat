import React from 'react';
import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ElicitationForm from '../ElicitationForm';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      com_ui_elicitation_title: 'Authorization required',
      com_ui_elicitation_cancel: 'Cancel',
      com_ui_elicitation_continue: "I've authorized — continue",
      com_ui_elicitation_open_url: 'Open authorization page',
      com_ui_elicitation_reopen: 'Reopen page',
      com_ui_elicitation_completed: 'Completed',
      com_ui_elicitation_declined: 'Declined',
      com_ui_elicitation_cancelled: 'Cancelled',
      com_ui_elicitation_authorized: 'Authorization confirmed',
      com_ui_elicitation_invalid_url: "This authorization link is invalid and can't be opened.",
      com_ui_elicitation_error: "Couldn't send your response — try again.",
      com_ui_elicitation_url_domain_label: 'Domain:',
      com_ui_elicitation_suspicious_url:
        'This domain contains encoded or mixed-script characters that can be used to disguise the real destination — double-check it before continuing.',
    };
    const template = translations[key] || key;
    if (!options) {
      return template;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) =>
      token in options ? String(options[token]) : `{{${token}}}`,
    );
  },
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ messageId: 'test-message-1' }),
  useOptionalMessagesOperations: () => ({
    getMessages: () => undefined,
    setMessages: jest.fn(),
  }),
}));

jest.mock('librechat-data-provider', () => ({
  /** Keep the real module: transitive imports (provider icon registry) need its
   *  other exports, and a bare object mock leaves them undefined at import time. */
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    respondToElicitation: jest.fn().mockResolvedValue({ ok: true }),
  },
}));

const renderUrlForm = (overrides = {}) =>
  render(
    <RecoilRoot>
      <ElicitationForm
        flowId="test-flow-url-1"
        mode="url"
        message="Please authorize access to your account"
        url="https://example.com/authorize?token=abc"
        {...overrides}
      />
    </RecoilRoot>,
  );

describe('ElicitationForm - url mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the message and an authorization link opening in a new tab', () => {
    renderUrlForm();
    expect(screen.getByText('Please authorize access to your account')).toBeInTheDocument();

    const link = screen.getByText('Open authorization page').closest('a');
    expect(link).toHaveAttribute('href', 'https://example.com/authorize?token=abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders Continue and Cancel controls', () => {
    renderUrlForm();
    expect(screen.getByText("I've authorized — continue")).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('posts action "complete" when Continue is clicked and shows the authorized status', async () => {
    renderUrlForm();
    fireEvent.click(screen.getByText('Open authorization page'));
    fireEvent.click(screen.getByText("I've authorized — continue"));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-url-1', {
        action: 'complete',
      });
    });
    expect((await screen.findAllByText('Authorization confirmed')).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('posts action "cancel" when Cancel is clicked and shows the cancelled status', async () => {
    renderUrlForm();
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(dataService.respondToElicitation).toHaveBeenCalledWith('test-flow-url-1', {
        action: 'cancel',
      });
    });
    expect((await screen.findAllByText('Cancelled')).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the authorized status immediately when a persisted action is provided', () => {
    renderUrlForm({ action: 'complete' });
    expect(screen.getAllByText('Authorization confirmed').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Open authorization page')).not.toBeInTheDocument();
  });

  it('renders no clickable anchor and a warning for a javascript: URL', () => {
    renderUrlForm({ url: 'javascript:alert(1)' });
    expect(screen.queryByText('Open authorization page')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByText("This authorization link is invalid and can't be opened."),
    ).toBeInTheDocument();
  });

  it('renders no clickable anchor for a data: URL', () => {
    renderUrlForm({ url: 'data:text/html,<script>alert(1)</script>' });
    expect(screen.queryByText('Open authorization page')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps Continue disabled when the authorization URL is unsafe', () => {
    renderUrlForm({ url: 'javascript:alert(1)' });
    expect(screen.getByText("I've authorized — continue").closest('button')).toBeDisabled();
  });

  it('shows the full URL as visible text and highlights its domain before the user can click', () => {
    renderUrlForm();
    // The raw URL must be readable up front — not just present as an href.
    expect(screen.getByText('https://example.com/authorize?token=abc')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('warns when the authorization URL has a Punycode/homograph domain', () => {
    renderUrlForm({ url: 'https://xn--80ak6aa92e.com/authorize' });
    expect(
      screen.getByText(
        'This domain contains encoded or mixed-script characters that can be used to disguise the real destination — double-check it before continuing.',
      ),
    ).toBeInTheDocument();
  });

  it('does not warn for an ordinary ASCII domain', () => {
    renderUrlForm();
    expect(
      screen.queryByText(
        'This domain contains encoded or mixed-script characters that can be used to disguise the real destination — double-check it before continuing.',
      ),
    ).not.toBeInTheDocument();
  });

  it('shows an inline error and stays interactive when the response fails to send', async () => {
    (dataService.respondToElicitation as jest.Mock).mockRejectedValueOnce(new Error('network'));
    renderUrlForm();
    fireEvent.click(screen.getByText('Cancel'));

    expect(await screen.findByText("Couldn't send your response — try again.")).toBeInTheDocument();
    // The card is still interactive for a retry.
    expect(screen.getByText("I've authorized — continue")).toBeInTheDocument();
  });

  it('treats a 409 as already-resolved and shows the resolved status instead of the retry error', async () => {
    const conflictError = Object.assign(new Error('Conflict'), {
      response: { status: 409 },
    });
    (dataService.respondToElicitation as jest.Mock).mockRejectedValueOnce(conflictError);
    renderUrlForm();
    fireEvent.click(screen.getByText('Open authorization page'));
    fireEvent.click(screen.getByText("I've authorized — continue"));

    expect((await screen.findAllByText('Authorization confirmed')).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.queryByText("Couldn't send your response — try again.")).not.toBeInTheDocument();
  });

  it('renders the action that actually won the race, not the one it submitted', async () => {
    // Another tab cancelled while this card submitted a continue; the route
    // returns the settled action and the loser must render that, not its own.
    const conflictError = Object.assign(new Error('Conflict'), {
      response: { status: 409, data: { error: 'Elicitation already resolved', action: 'cancel' } },
    });
    (dataService.respondToElicitation as jest.Mock).mockRejectedValueOnce(conflictError);
    renderUrlForm();
    fireEvent.click(screen.getByText('Open authorization page'));
    fireEvent.click(screen.getByText("I've authorized — continue"));

    expect((await screen.findAllByText('Cancelled')).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Authorization confirmed')).not.toBeInTheDocument();
  });
});
