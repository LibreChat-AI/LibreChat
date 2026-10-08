import { fireEvent, render, screen } from '@testing-library/react';
import { ShareHeader, SharedLinkUnavailable } from './ShareView';

const defaultProps = {
  title: 'Shared conversation',
  formattedDate: 'August 27, 2026',
  theme: 'system',
  langcode: 'en-US',
  settingsLabel: 'Settings',
  continueLabel: 'Continue chat',
  langfuseSessionLabel: 'View session in Langfuse',
  isContinuing: false,
  onContinue: jest.fn(),
  onThemeChange: jest.fn(),
  onLangChange: jest.fn(),
};

describe('ShareHeader', () => {
  it('shows the Langfuse session as an external link when supplied', () => {
    const url = 'https://cloud.langfuse.com/project/project-1/sessions/conversation-1';

    render(<ShareHeader {...defaultProps} langfuseSessionUrl={url} />);

    const link = screen.getByRole('link', { name: 'View session in Langfuse' });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.parentElement).toHaveClass('flex-wrap');
  });

  it('omits the Langfuse action when the server does not supply a session', () => {
    render(<ShareHeader {...defaultProps} />);

    expect(
      screen.queryByRole('link', { name: 'View session in Langfuse' }),
    ).not.toBeInTheDocument();
  });
});

describe('SharedLinkUnavailable', () => {
  it('lets the viewer retry a broken shared-link load', () => {
    const onRetry = jest.fn();

    render(
      <SharedLinkUnavailable
        message="Shared link not found"
        retryLabel="Retry"
        isRetrying={false}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables retry while the shared link is refetching', () => {
    render(
      <SharedLinkUnavailable
        message="Shared link not found"
        retryLabel="Retry"
        isRetrying={true}
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });
});
