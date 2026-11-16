import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import OAuthError from '../OAuthError';

const mockAnnounce = jest.fn();

jest.mock('~/data-provider', () => ({
  announceOAuthSettled: (settlement: unknown) => mockAnnounce(settlement),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <OAuthError />
    </MemoryRouter>,
  );

describe('OAuthError', () => {
  beforeEach(() => mockAnnounce.mockReset());

  it('announces the failed sign-in with the flow it names', () => {
    renderAt('/oauth/error?error=callback_failed&flow=flow-a');
    expect(mockAnnounce).toHaveBeenCalledTimes(1);
    expect(mockAnnounce).toHaveBeenCalledWith({ outcome: 'failed', flowId: 'flow-a' });
  });

  it('announces a failure without a flow when the redirect names none', () => {
    renderAt('/oauth/error?error=invalid_state');
    expect(mockAnnounce).toHaveBeenCalledWith({ outcome: 'failed', flowId: undefined });
  });

  it('maps a known error code to its message', () => {
    renderAt('/oauth/error?error=invalid_state');
    expect(screen.getByRole('heading', { name: 'com_ui_oauth_error_title' })).toBeInTheDocument();
    expect(screen.getByText('com_ui_oauth_error_invalid_state')).toBeInTheDocument();
  });

  it.each([
    ['discord_forbidden', 'com_ui_discord_admin'],
    ['discord_not_configured', 'com_ui_discord_disabled'],
    ['discord_invalid_state', 'com_ui_discord_oauth_restart'],
    ['discord_invalid_input', 'com_ui_discord_oauth_restart'],
    ['discord_invalid_grant', 'com_ui_discord_oauth_restart'],
    ['discord_application_changed', 'com_ui_discord_oauth_changed'],
    ['discord_installation_changed', 'com_ui_discord_oauth_changed'],
    ['discord_guild_changed', 'com_ui_discord_guild_changed'],
    ['discord_missing_permissions', 'com_ui_discord_permissions'],
    ['discord_unsupported_installation', 'com_ui_discord_code_grant'],
    ['discord_provider_refused', 'com_ui_discord_oauth_refused'],
    ['discord_rate_limited', 'com_ui_discord_rate_limited'],
    ['discord_provider_unavailable', 'com_ui_discord_provider_unavailable'],
    ['discord_timeout', 'com_ui_discord_provider_unavailable'],
  ])('explains the Discord callback code %s with an actionable message', (code, key) => {
    renderAt(`/oauth/error?error=${code}&flow=flow-a`);
    expect(screen.getByText(key)).toBeInTheDocument();
    expect(screen.queryByText('com_ui_oauth_error_generic')).toBeNull();
    expect(mockAnnounce).toHaveBeenCalledWith({ outcome: 'failed', flowId: 'flow-a' });
  });

  it.each([
    'discord_unavailable',
    'discord_principal_unavailable',
    'discord_malformed_response',
    'discord_response_too_large',
    'discord_unrecognized_code',
  ])('keeps the generic message for the Discord code %s', (code) => {
    renderAt(`/oauth/error?error=${code}`);
    expect(screen.getByText('com_ui_oauth_error_generic')).toBeInTheDocument();
  });

  it('never renders provider text carried in the redirect', () => {
    renderAt(
      '/oauth/error?error=discord_provider_refused&error_description=Bot%20private-token%20refused',
    );
    expect(screen.getByText('com_ui_discord_oauth_refused')).toBeInTheDocument();
    expect(screen.queryByText(/private-token/)).toBeNull();
  });
});
