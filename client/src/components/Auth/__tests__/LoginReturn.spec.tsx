/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import { SESSION_KEY } from '~/utils/redirect';
import SocialButton from '../SocialButton';
import Login from '../Login';

let mockConfig: Partial<TStartupConfig>;
const mockSetError = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useOutletContext: () => ({ startupConfig: mockConfig }),
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ error: undefined, setError: mockSetError, login: jest.fn() }),
}));
jest.mock('../LoginForm', () => () => null);

const destination = '/code/setup/setup-attempt';
const entry = `/login?redirect_to=${encodeURIComponent(destination)}`;

beforeEach(() => {
  sessionStorage.clear();
  mockConfig = { serverDomain: 'http://localhost:3080/librechat', emailLoginEnabled: false };
  window.history.replaceState({}, '', `/librechat${entry}`);
});

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

it('persists the setup destination before an OAuth provider navigation', async () => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Login />
      <SocialButton
        id="google"
        enabled
        serverDomain={mockConfig.serverDomain}
        oauthPath="google"
        label="Google"
        Icon={() => null}
      />
    </MemoryRouter>,
  );
  const link = screen.getByRole('link', { name: 'Google' });
  // Prevent the external navigation while observing the real provider link and handoff storage.
  link.addEventListener('click', (event) => event.preventDefault());
  fireEvent.click(link);
  expect(link).toHaveAttribute('href', 'http://localhost:3080/librechat/oauth/google');
  expect(sessionStorage.getItem(SESSION_KEY)).toBe(destination);
});

it('persists the same setup destination before automatic OIDC navigation', async () => {
  mockConfig = {
    ...mockConfig,
    openidLoginEnabled: true,
    openidAutoRedirect: true,
    openidLabel: 'OpenID',
  };
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Login />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(window.location.href).toBe('http://localhost:3080/librechat/oauth/openid'),
  );
  expect(sessionStorage.getItem(SESSION_KEY)).toBe(destination);
});
