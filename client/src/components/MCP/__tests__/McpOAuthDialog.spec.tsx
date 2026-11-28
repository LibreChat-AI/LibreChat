import type { ReactNode } from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen, fireEvent } from '@testing-library/react';
import McpOAuthDialog from '../McpOAuthDialog';

jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  CopyButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" data-testid="copy-url" onClick={onClick} />
  ),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useCopyToClipboard: () => jest.fn(),
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual('react');
  const Pass = ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children);
  return {
    OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? React.createElement('div', null, children) : null,
    OGDialogContent: Pass,
    OGDialogTitle: Pass,
    OGDialogDescription: Pass,
    Input: ({
      value,
      'data-testid': testId,
      'aria-label': ariaLabel,
    }: {
      value?: string;
      'data-testid'?: string;
      'aria-label'?: string;
    }) =>
      React.createElement('input', {
        readOnly: true,
        value,
        'data-testid': testId,
        'aria-label': ariaLabel,
      }),
    Button: ({
      children,
      asChild,
      onClick,
      'aria-label': ariaLabel,
      'aria-expanded': ariaExpanded,
    }: {
      children?: ReactNode;
      asChild?: boolean;
      onClick?: () => void;
      'aria-label'?: string;
      'aria-expanded'?: boolean;
    }) =>
      asChild
        ? React.createElement('span', null, children)
        : React.createElement(
            'button',
            { type: 'button', onClick, 'aria-label': ariaLabel, 'aria-expanded': ariaExpanded },
            children,
          ),
  };
});

const baseProps = {
  open: true,
  onOpenChange: jest.fn(),
  serverName: 'srv',
  oauthUrl: 'https://oauth.example/authorize?x=1',
};

describe('McpOAuthDialog', () => {
  test('renders the continue button, copyable URL, and a QR toggle (collapsed by default)', () => {
    render(<McpOAuthDialog {...baseProps} />);
    expect(screen.getByText('com_ui_continue_oauth')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-oauth-url')).toHaveValue(baseProps.oauthUrl);
    expect(screen.getByTestId('copy-url')).toBeInTheDocument();
    const toggle = screen.getByLabelText('com_ui_show_qr');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('com_ui_hide_qr')).not.toBeInTheDocument();
  });

  test('toggling flips the QR label and aria-expanded', () => {
    render(<McpOAuthDialog {...baseProps} />);
    fireEvent.click(screen.getByLabelText('com_ui_show_qr'));
    const toggle = screen.getByLabelText('com_ui_hide_qr');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('com_ui_mcp_oauth_scan_qr')).toBeInTheDocument();
  });

  test('Continue is a real link to the OAuth URL, not a scripted click', () => {
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    render(<McpOAuthDialog {...baseProps} />);
    const anchor = screen.getByText('com_ui_continue_oauth').closest('a');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('href', baseProps.oauthUrl);
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(clickSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
    openSpy.mockRestore();
  });

  test('renders nothing without an OAuth URL', () => {
    const { container } = render(<McpOAuthDialog {...baseProps} oauthUrl="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
