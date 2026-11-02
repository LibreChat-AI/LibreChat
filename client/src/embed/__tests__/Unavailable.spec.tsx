import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import EmbedUnavailable from '../Unavailable';

const mockAuth = { isAuthReady: false, isAuthenticated: false };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => mockAuth,
}));

describe('EmbedUnavailable', () => {
  it('waits while the host is still signing the user in', () => {
    Object.assign(mockAuth, { isAuthReady: false, isAuthenticated: false });
    render(<EmbedUnavailable />);
    expect(screen.getByLabelText('com_ui_loading')).toBeInTheDocument();
    expect(screen.queryByText('com_embed_unavailable_title')).not.toBeInTheDocument();
  });

  it('keeps waiting once signed in, while the session navigates back to the chat', () => {
    Object.assign(mockAuth, { isAuthReady: true, isAuthenticated: true });
    render(<EmbedUnavailable />);
    expect(screen.getByLabelText('com_ui_loading')).toBeInTheDocument();
  });

  it('reports the failure with a retry once sign-in has failed', () => {
    Object.assign(mockAuth, { isAuthReady: true, isAuthenticated: false });
    render(<EmbedUnavailable />);
    expect(
      screen.getByRole('heading', { name: 'com_embed_unavailable_title' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
  });
});
