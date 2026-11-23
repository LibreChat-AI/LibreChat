import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import OAuthSuccess from '../OAuthSuccess';

const mockAnnounce = jest.fn();

jest.mock('~/data-provider', () => ({
  announceOAuthSettled: (settlement: unknown) => mockAnnounce(settlement),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('OAuthSuccess', () => {
  it('announces the settled sign-in once, for a window the provider severed from this one', () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/oauth/success?serverName=GitHub&flow=flow-a']}>
        <OAuthSuccess />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter initialEntries={['/oauth/success?serverName=GitHub&flow=flow-a']}>
        <OAuthSuccess />
      </MemoryRouter>,
    );
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith({ outcome: 'succeeded', flowId: 'flow-a' });
  });

  it('names the connected server and closes the window on demand', () => {
    const close = jest.spyOn(window, 'close').mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={['/oauth/success?serverName=GitHub&flow=flow-a']}>
        <OAuthSuccess />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'com_ui_oauth_success_title' })).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_close_window' }));
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });
});
