/**
 * @jest-environment @happy-dom/jest-environment
 */
import React, { useCallback, useLayoutEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useNavigate } from 'react-router-dom';
import {
  readTwoFactorSetupToken,
  clearTwoFactorSetupToken,
  persistTwoFactorSetupToken,
} from 'librechat-data-provider';
import type { TUser } from 'librechat-data-provider';
import TwoFactorSetupScreen from '../TwoFactorSetupScreen';
import StartupLayout from '~/routes/Layouts/Startup';
import { getPostLoginRedirect } from '~/utils';

const mockEnableMutate = jest.fn();
const mockConfirmMutate = jest.fn();
const mockAcknowledgeMutate = jest.fn();
const mockFinalizeMutate = jest.fn();
const mockCancelMutate = jest.fn();
const mockCompleteAuthentication = jest.fn();
const mockShowToast = jest.fn();
const mockLoading = {
  enable: false,
  confirm: false,
  acknowledge: false,
  finalize: false,
  cancel: false,
};
/** The screen is a memo with no props, so a flag that flips mid-test has to notify it like a real mutation. */
const mockCancelListeners = new Set<() => void>();
const mockSetCancelling = (cancelling: boolean) => {
  mockLoading.cancel = cancelling;
  act(() => mockCancelListeners.forEach((notify) => notify()));
};
let mockCompleteAuthenticationImpl: (token: string, user: TUser) => void =
  mockCompleteAuthentication;

jest.mock('~/data-provider', () => ({
  useEnableTwoFactorSetupMutation: () => ({
    mutate: mockEnableMutate,
    isLoading: mockLoading.enable,
  }),
  useConfirmTwoFactorSetupMutation: () => ({
    mutate: mockConfirmMutate,
    isLoading: mockLoading.confirm,
  }),
  useAcknowledgeTwoFactorSetupMutation: () => ({
    mutate: mockAcknowledgeMutate,
    isLoading: mockLoading.acknowledge,
  }),
  useFinalizeTwoFactorSetupMutation: () => ({
    mutate: mockFinalizeMutate,
    isLoading: mockLoading.finalize,
  }),
  useCancelTwoFactorSetupMutation: function useCancelTwoFactorSetupMutation() {
    const { useEffect, useReducer } = jest.requireActual('react');
    const [, notify] = useReducer((count: number) => count + 1, 0);
    useEffect(() => {
      mockCancelListeners.add(notify);
      return () => {
        mockCancelListeners.delete(notify);
      };
    }, []);
    return { mutate: mockCancelMutate, isLoading: mockLoading.cancel };
  },
  useGetStartupConfig: () => ({ data: null, isFetching: false, error: null }),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ completeAuthentication: mockCompleteAuthenticationImpl }),
}));

jest.mock('~/components/Auth/AuthLayout', () => ({ children }: { children: React.ReactNode }) => (
  <div data-testid="auth-layout">{children}</div>
));

jest.mock('~/components/Nav/SettingsTabs/Account/TwoFactorPhases', () => ({
  SetupPhase: ({ onGenerate }: { onGenerate: () => void }) => (
    <button data-testid="generate" onClick={onGenerate} />
  ),
  QRPhase: ({ onNext }: { onNext: () => void }) => (
    <button data-testid="qr-next" onClick={onNext} />
  ),
  VerifyPhase: ({
    onTokenChange,
    onNext,
  }: {
    onTokenChange: (value: string) => void;
    onNext: () => void;
  }) => (
    <>
      <button data-testid="enter-code" onClick={() => onTokenChange('123456')} />
      <button data-testid="verify" onClick={onNext} />
    </>
  ),
  BackupPhase: ({
    onDownload,
    onNext,
    downloaded,
  }: {
    onDownload: () => void;
    onNext: () => void;
    downloaded: boolean;
  }) => (
    <>
      <button data-testid="download" onClick={onDownload} />
      <button data-testid="complete" onClick={onNext} disabled={!downloaded} />
    </>
  ),
}));

function renderScreen(tempToken: string | null = 'setup-token', initialEntry = '/login/2fa/setup') {
  if (tempToken != null) {
    persistTwoFactorSetupToken(tempToken);
  }
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TwoFactorSetupScreen />
    </MemoryRouter>,
  );
}

/** Mirrors the auth context: resolve the destination once, flip state, and navigate there. */
function StartupAuthRoute() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const navigate = useNavigate();
  mockCompleteAuthenticationImpl = useCallback(
    (token: string, user: TUser) => {
      mockCompleteAuthentication(token, user);
      const destination =
        getPostLoginRedirect(new URLSearchParams(window.location.search)) ?? '/c/new';
      setIsAuthenticated(true);
      navigate(destination, { replace: true });
    },
    [navigate],
  );

  return <StartupLayout isAuthenticated={isAuthenticated} />;
}

describe('TwoFactorSetupScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    clearTwoFactorSetupToken();
    Object.assign(mockLoading, {
      enable: false,
      confirm: false,
      acknowledge: false,
      finalize: false,
      cancel: false,
    });
    mockCompleteAuthenticationImpl = mockCompleteAuthentication;
    URL.createObjectURL = jest.fn(() => 'blob:backup-codes');
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects direct visits without a temporary setup token', () => {
    renderScreen(null);

    expect(screen.getByRole('alert')).toHaveTextContent('com_auth_two_factor_setup_expired');
    expect(screen.queryByTestId('generate')).not.toBeInTheDocument();
  });

  it('adopts a setup token handed off after it mounted without one', () => {
    renderScreen(null);
    expect(screen.queryByTestId('generate')).not.toBeInTheDocument();

    act(() => {
      persistTwoFactorSetupToken('refreshed-token');
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('generate'));
    expect(mockEnableMutate).toHaveBeenCalledWith(
      { tempToken: 'refreshed-token' },
      expect.any(Object),
    );
  });

  it('adopts a setup token handed off before its listener was installed', () => {
    function LateHandOff() {
      useLayoutEffect(() => {
        persistTwoFactorSetupToken('late-token');
      }, []);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/login/2fa/setup']}>
        <TwoFactorSetupScreen />
        <LateHandOff />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('generate'));
    expect(mockEnableMutate).toHaveBeenCalledWith({ tempToken: 'late-token' }, expect.any(Object));
  });

  it('keeps the token it started with when another is handed off mid-flow', () => {
    renderScreen('setup-token');

    act(() => {
      persistTwoFactorSetupToken('other-token');
    });

    fireEvent.click(screen.getByTestId('generate'));
    expect(mockEnableMutate).toHaveBeenCalledWith({ tempToken: 'setup-token' }, expect.any(Object));
  });

  it('offers a way back to sign-in when the setup credential is missing', () => {
    const router = createMemoryRouter(
      [
        { path: '/login/2fa/setup', element: <TwoFactorSetupScreen /> },
        { path: '/login', element: <div data-testid="login-page" /> },
      ],
      { initialEntries: ['/login/2fa/setup'] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_auth_two_factor_setup_expired');

    /** The layout withholds the sign-in controls on this path, so the screen has to carry its own
     * way out or a reload only replays the same empty state. */
    fireEvent.click(screen.getByRole('button', { name: 'com_auth_back_to_login' }));

    /** With no credential there is nothing for the server to authorize, so it is a plain navigation. */
    expect(mockCancelMutate).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });

  describe('leaving required enrollment', () => {
    const backToLogin = () => screen.getByRole('button', { name: 'com_auth_back_to_login' });

    function renderWithLogin(initialEntry = '/login/2fa/setup') {
      persistTwoFactorSetupToken('setup-token');
      const router = createMemoryRouter(
        [
          { path: '/login/2fa/setup', element: <TwoFactorSetupScreen /> },
          { path: '/login', element: <div data-testid="login-page" /> },
        ],
        { initialEntries: [initialEntry] },
      );
      render(<RouterProvider router={router} />);
      return router;
    }

    it('keeps a way back to sign-in on screen through every phase', () => {
      renderScreen();

      expect(screen.getByTestId('generate')).toBeInTheDocument();
      expect(backToLogin()).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('generate'));
      act(() => {
        mockEnableMutate.mock.calls[0][1].onSuccess({
          otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
          backupCodes: ['backup01'],
        });
      });
      expect(screen.getByTestId('qr-next')).toBeInTheDocument();
      expect(backToLogin()).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('qr-next'));
      expect(screen.getByTestId('verify')).toBeInTheDocument();
      expect(backToLogin()).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('enter-code'));
      fireEvent.click(screen.getByTestId('verify'));
      act(() => {
        mockConfirmMutate.mock.calls[0][1].onSuccess({
          backupCodes: ['confirmed-backup01'],
          acknowledgementToken: 'acknowledgement-token',
        });
      });
      expect(screen.getByTestId('complete')).toBeInTheDocument();
      expect(backToLogin()).toBeInTheDocument();
    });

    it('ends the server session with the setup credential before it navigates away', () => {
      const router = renderWithLogin();

      fireEvent.click(backToLogin());

      expect(mockCancelMutate).toHaveBeenCalledWith(
        { tempToken: 'setup-token' },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );
      /** Leaving before the cookie is gone would let the next silent refresh re-enter setup. */
      expect(router.state.location.pathname).toBe('/login/2fa/setup');
      expect(readTwoFactorSetupToken()).toBe('setup-token');

      act(() => mockCancelMutate.mock.calls[0][1].onSuccess({ message: 'cancelled' }));

      expect(readTwoFactorSetupToken()).toBe('');
      expect(router.state.location.pathname).toBe('/login');
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });

    it('signs out of a staged enrollment from the backup phase', () => {
      const router = renderWithLogin();
      reachBackupPhase();

      fireEvent.click(backToLogin());

      expect(mockCancelMutate).toHaveBeenCalledWith(
        { tempToken: 'setup-token' },
        expect.any(Object),
      );
      act(() => mockCancelMutate.mock.calls[0][1].onSuccess({ message: 'cancelled' }));
      expect(router.state.location.pathname).toBe('/login');
      expect(readTwoFactorSetupToken()).toBe('');
    });

    it('carries a safe redirect destination back to the login page', () => {
      const router = renderWithLogin('/login/2fa/setup?redirect_to=%2Fc%2Fabc');

      fireEvent.click(backToLogin());
      act(() => mockCancelMutate.mock.calls[0][1].onSuccess({ message: 'cancelled' }));

      expect(router.state.location.pathname).toBe('/login');
      expect(router.state.location.search).toBe('?redirect_to=%2Fc%2Fabc');
    });

    it('stays on the screen with an actionable error when the sign-out fails', () => {
      const router = renderWithLogin();

      fireEvent.click(backToLogin());
      act(() => mockCancelMutate.mock.calls[0][1].onError(new Error('network error')));

      /** The session is still alive, so leaving would only bounce the user back into setup. */
      expect(screen.getByRole('alert')).toHaveTextContent('com_auth_two_factor_setup_cancel_error');
      expect(router.state.location.pathname).toBe('/login/2fa/setup');
      expect(readTwoFactorSetupToken()).toBe('setup-token');
      expect(backToLogin()).toBeEnabled();
    });

    it.each([401, 403])(
      'leaves when the server no longer accepts the setup credential (%s)',
      (status) => {
        const router = renderWithLogin();

        fireEvent.click(backToLogin());
        act(() => mockCancelMutate.mock.calls[0][1].onError({ response: { status } }));

        expect(readTwoFactorSetupToken()).toBe('');
        expect(router.state.location.pathname).toBe('/login');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      },
    );

    it('keeps a rate-limited sign-out on the screen so it can be retried', () => {
      const router = renderWithLogin();

      fireEvent.click(backToLogin());
      act(() => mockCancelMutate.mock.calls[0][1].onError({ response: { status: 429 } }));

      expect(screen.getByRole('alert')).toHaveTextContent('com_auth_two_factor_setup_cancel_error');
      expect(router.state.location.pathname).toBe('/login/2fa/setup');
    });

    it('disables the control while the sign-out is in flight', () => {
      mockLoading.cancel = true;
      renderScreen();

      expect(backToLogin()).toBeDisabled();
    });

    it.each(['enable', 'confirm', 'acknowledge', 'finalize'] as const)(
      'disables the control while the %s setup request is in flight',
      (request) => {
        mockLoading[request] = true;
        renderScreen();

        /** A commit racing a sign-out could hand back a session after the cookies were cleared. */
        expect(backToLogin()).toBeDisabled();
      },
    );

    it('ignores setup actions while the sign-out is in flight and resumes once it fails', () => {
      renderScreen();

      mockSetCancelling(true);
      fireEvent.click(screen.getByTestId('generate'));
      expect(mockEnableMutate).not.toHaveBeenCalled();

      mockSetCancelling(false);
      fireEvent.click(screen.getByTestId('generate'));
      act(() => {
        mockEnableMutate.mock.calls[0][1].onSuccess({
          otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
          backupCodes: ['backup01'],
        });
      });
      fireEvent.click(screen.getByTestId('qr-next'));
      fireEvent.click(screen.getByTestId('enter-code'));

      mockSetCancelling(true);
      fireEvent.click(screen.getByTestId('verify'));
      expect(mockConfirmMutate).not.toHaveBeenCalled();

      mockSetCancelling(false);
      fireEvent.click(screen.getByTestId('verify'));
      act(() => {
        mockConfirmMutate.mock.calls[0][1].onSuccess({
          backupCodes: ['confirmed-backup01'],
          acknowledgementToken: 'acknowledgement-token',
        });
      });
      fireEvent.click(screen.getByTestId('download'));

      mockSetCancelling(true);
      fireEvent.click(screen.getByTestId('complete'));
      expect(mockAcknowledgeMutate).not.toHaveBeenCalled();

      mockSetCancelling(false);
      fireEvent.click(screen.getByTestId('complete'));
      expect(mockAcknowledgeMutate).toHaveBeenCalledTimes(1);
    });
  });

  it('enrolls, confirms, and requires backup-code download before completion', () => {
    renderScreen();

    expect(screen.getByText('com_auth_two_factor_setup_required_description')).toHaveClass(
      'text-text-primary',
    );

    fireEvent.click(screen.getByTestId('generate'));
    expect(mockEnableMutate).toHaveBeenCalledWith(
      { tempToken: 'setup-token' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    act(() => {
      mockEnableMutate.mock.calls[0][1].onSuccess({
        otpauthUrl: 'otpauth://totp/LibreChat:user@example.com?secret=ABC123&issuer=LibreChat',
        backupCodes: ['backup01'],
      });
    });
    expect(screen.getByTestId('two-factor-setup-phase')).toHaveFocus();
    fireEvent.click(screen.getByTestId('qr-next'));
    fireEvent.click(screen.getByTestId('enter-code'));
    fireEvent.click(screen.getByTestId('verify'));

    expect(mockConfirmMutate).toHaveBeenCalledWith(
      { tempToken: 'setup-token', token: '123456' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    act(() => {
      mockConfirmMutate.mock.calls[0][1].onSuccess({
        backupCodes: ['confirmed-backup01'],
        acknowledgementToken: 'acknowledgement-token',
      });
    });
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();
    expect(screen.getByTestId('complete')).toBeDisabled();

    fireEvent.click(screen.getByTestId('download'));
    expect(screen.getByTestId('complete')).toBeEnabled();
    fireEvent.click(screen.getByTestId('complete'));
    expect(mockAcknowledgeMutate).toHaveBeenCalledWith(
      { acknowledgementToken: 'acknowledgement-token' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(mockFinalizeMutate).not.toHaveBeenCalled();

    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });
    expect(mockFinalizeMutate).toHaveBeenCalledWith(
      { finalizationToken: 'finalization-token' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();

    act(() => {
      mockFinalizeMutate.mock.calls[0][1].onSuccess({
        token: 'auth-token',
        user: { id: 'user-1' },
      });
    });
    expect(mockCompleteAuthentication).toHaveBeenCalledWith('auth-token', { id: 'user-1' });
  });

  it('keeps startup unauthenticated until backup acknowledgement, then reaches the safe destination', () => {
    sessionStorage.setItem('post_login_redirect_to', '/c/requested?model=test');
    persistTwoFactorSetupToken('setup-token');
    const createRouter = () =>
      createMemoryRouter(
        [
          {
            path: '/',
            element: <StartupAuthRoute />,
            children: [{ path: 'login/2fa/setup', element: <TwoFactorSetupScreen /> }],
          },
          { path: '/c/requested', element: <div data-testid="requested-destination" /> },
        ],
        {
          basename: '/chat',
          initialEntries: ['/chat/login/2fa/setup'],
        },
      );
    const initialRouter = createRouter();
    const initialRender = render(<RouterProvider router={initialRouter} />);
    expect(sessionStorage.getItem('post_login_redirect_to')).toBe('/c/requested?model=test');
    initialRender.unmount();

    const router = createRouter();
    render(<RouterProvider router={router} />);
    expect(sessionStorage.getItem('post_login_redirect_to')).toBe('/c/requested?model=test');

    fireEvent.click(screen.getByTestId('generate'));
    act(() => {
      mockEnableMutate.mock.calls[0][1].onSuccess({
        otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
        backupCodes: ['backup01'],
      });
    });
    fireEvent.click(screen.getByTestId('qr-next'));
    fireEvent.click(screen.getByTestId('enter-code'));
    fireEvent.click(screen.getByTestId('verify'));
    act(() => {
      mockConfirmMutate.mock.calls[0][1].onSuccess({
        backupCodes: ['confirmed-backup01'],
        acknowledgementToken: 'acknowledgement-token',
      });
    });

    expect(screen.getByTestId('complete')).toBeDisabled();
    expect(screen.getByTestId('auth-layout')).toBeInTheDocument();
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/chat/login/2fa/setup');

    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));

    expect(router.state.location.pathname).toBe('/chat/login/2fa/setup');
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();
    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });
    act(() => {
      mockFinalizeMutate.mock.calls[0][1].onSuccess({
        token: 'auth-token',
        user: { id: 'user-1' },
      });
    });

    expect(mockCompleteAuthentication).toHaveBeenCalledWith('auth-token', { id: 'user-1' });
    expect(router.state.location.pathname).toBe('/chat/c/requested');
    expect(router.state.location.search).toBe('?model=test');
    expect(screen.getByTestId('requested-destination')).toBeInTheDocument();
    expect(sessionStorage.getItem('post_login_redirect_to')).toBeNull();
  });

  it('keeps the backup phase mounted and shows an actionable error when finalization fails', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('generate'));
    act(() => {
      mockEnableMutate.mock.calls[0][1].onSuccess({
        otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
        backupCodes: ['backup01'],
      });
    });
    fireEvent.click(screen.getByTestId('qr-next'));
    fireEvent.click(screen.getByTestId('enter-code'));
    fireEvent.click(screen.getByTestId('verify'));
    act(() => {
      mockConfirmMutate.mock.calls[0][1].onSuccess({
        backupCodes: ['confirmed-backup01'],
        acknowledgementToken: 'acknowledgement-token',
      });
    });
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));
    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });
    act(() => mockFinalizeMutate.mock.calls[0][1].onError(new Error('network error')));

    expect(screen.getByTestId('complete')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('com_auth_two_factor_setup_finalize_error');
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();
  });

  function reachBackupPhase(acknowledgementToken = 'acknowledgement-token') {
    fireEvent.click(screen.getByTestId('generate'));
    act(() => {
      mockEnableMutate.mock.calls.at(-1)?.[1].onSuccess({
        otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
        backupCodes: ['backup01'],
      });
    });
    fireEvent.click(screen.getByTestId('qr-next'));
    fireEvent.click(screen.getByTestId('enter-code'));
    fireEvent.click(screen.getByTestId('verify'));
    act(() => {
      mockConfirmMutate.mock.calls.at(-1)?.[1].onSuccess({
        backupCodes: ['confirmed-backup01'],
        acknowledgementToken,
      });
    });
  }

  it('retries a failed finalization with the issued credential instead of replaying acknowledgement', () => {
    renderScreen();
    reachBackupPhase();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));
    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });
    act(() => mockFinalizeMutate.mock.calls[0][1].onError(new Error('network error')));

    fireEvent.click(screen.getByTestId('complete'));

    expect(mockAcknowledgeMutate).toHaveBeenCalledTimes(1);
    expect(mockFinalizeMutate).toHaveBeenCalledTimes(2);
    expect(mockFinalizeMutate.mock.calls[1][0]).toEqual({
      finalizationToken: 'finalization-token',
    });

    act(() => {
      mockFinalizeMutate.mock.calls[1][1].onSuccess({
        token: 'auth-token',
        user: { id: 'user-1' },
      });
    });
    expect(mockCompleteAuthentication).toHaveBeenCalledWith('auth-token', { id: 'user-1' });
  });

  /** A consumed one-time nonce answers 400, unlike the 401 an unusable setup token returns. */
  const spentCredentialError = { response: { status: 400 } };

  it('restarts sign-in when a spent acknowledgement credential is replayed', () => {
    renderScreen();
    reachBackupPhase();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));

    act(() => mockAcknowledgeMutate.mock.calls[0][1].onError(spentCredentialError));

    /** Retrying a nonce the server already burned can never succeed, so the flow has to reset. */
    expect(readTwoFactorSetupToken()).toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restarts sign-in when a spent finalization credential is replayed', () => {
    renderScreen();
    reachBackupPhase();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));
    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });

    act(() => mockFinalizeMutate.mock.calls[0][1].onError(spentCredentialError));

    expect(readTwoFactorSetupToken()).toBe('');
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();
  });

  it('keeps a rejected verification code on the verify phase', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('generate'));
    act(() => {
      mockEnableMutate.mock.calls[0][1].onSuccess({
        otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
        backupCodes: ['backup01'],
      });
    });
    fireEvent.click(screen.getByTestId('qr-next'));
    fireEvent.click(screen.getByTestId('enter-code'));
    fireEvent.click(screen.getByTestId('verify'));

    act(() => mockConfirmMutate.mock.calls[0][1].onError(spentCredentialError));

    /** A wrong code shares the 400, so only the one-time transitions may treat it as spent. */
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_2fa_invalid');
    expect(readTwoFactorSetupToken()).toBe('setup-token');
    expect(screen.getByTestId('verify')).toBeInTheDocument();
  });

  /**
   * Every setup route gates on the enforcement policy and on the ban list before it reaches a
   * controller, and both answer 403. Neither can be satisfied from this screen, so all four
   * mutations have to leave rather than keep a credential the server will never accept again.
   */
  const retiredFlowError = { response: { status: 403 } };

  it('restarts sign-in when enforcement is withdrawn during enrollment', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('generate'));

    act(() => mockEnableMutate.mock.calls[0][1].onError(retiredFlowError));

    expect(readTwoFactorSetupToken()).toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restarts sign-in when enforcement is withdrawn at verification', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('generate'));
    act(() => {
      mockEnableMutate.mock.calls[0][1].onSuccess({
        otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
        backupCodes: ['backup01'],
      });
    });
    fireEvent.click(screen.getByTestId('qr-next'));
    fireEvent.click(screen.getByTestId('enter-code'));
    fireEvent.click(screen.getByTestId('verify'));

    act(() => mockConfirmMutate.mock.calls[0][1].onError(retiredFlowError));

    /** A wrong code and a retired flow both reach this handler, so only the 403 may reset it. */
    expect(readTwoFactorSetupToken()).toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restarts sign-in when enforcement is withdrawn at acknowledgement', () => {
    renderScreen();
    reachBackupPhase();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));

    act(() => mockAcknowledgeMutate.mock.calls[0][1].onError(retiredFlowError));

    expect(readTwoFactorSetupToken()).toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restarts sign-in when enforcement is withdrawn at finalization', () => {
    renderScreen();
    reachBackupPhase();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));
    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });

    act(() => mockFinalizeMutate.mock.calls[0][1].onError(retiredFlowError));

    expect(readTwoFactorSetupToken()).toBe('');
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();
  });

  it('tells the user sessions may remain, then restarts sign-in, when finalization retires none', () => {
    renderScreen();
    reachBackupPhase();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));
    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });

    act(() =>
      mockFinalizeMutate.mock.calls[0][1].onError({
        isAxiosError: true,
        response: { status: 500, data: { code: 'CREDENTIAL_RETIREMENT_INCOMPLETE' } },
      }),
    );

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_auth_two_factor_setup_sessions_incomplete',
      status: 'warning',
    });
    expect(readTwoFactorSetupToken()).toBe('');
    expect(mockCompleteAuthentication).not.toHaveBeenCalled();
  });

  it('keeps a rate-limited verification on the verify phase', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('generate'));
    act(() => {
      mockEnableMutate.mock.calls[0][1].onSuccess({
        otpauthUrl: 'otpauth://totp/LibreChat:user?secret=ABC123',
        backupCodes: ['backup01'],
      });
    });
    fireEvent.click(screen.getByTestId('qr-next'));
    fireEvent.click(screen.getByTestId('enter-code'));
    fireEvent.click(screen.getByTestId('verify'));

    act(() => mockConfirmMutate.mock.calls[0][1].onError({ response: { status: 429 } }));

    /** Throttling clears on its own, so it must not be swept up with the retired-flow 403. */
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_2fa_invalid');
    expect(readTwoFactorSetupToken()).toBe('setup-token');
    expect(screen.getByTestId('verify')).toBeInTheDocument();
  });

  it('discards the stale finalization credential when confirmation is repeated', () => {
    renderScreen();
    reachBackupPhase();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));
    act(() => {
      mockAcknowledgeMutate.mock.calls[0][1].onSuccess({ finalizationToken: 'finalization-token' });
    });
    act(() => mockFinalizeMutate.mock.calls[0][1].onError(new Error('network error')));

    act(() => {
      mockConfirmMutate.mock.calls.at(-1)?.[1].onSuccess({
        backupCodes: ['rotated-backup01'],
        acknowledgementToken: 'rotated-acknowledgement-token',
      });
    });

    expect(screen.getByTestId('complete')).toBeDisabled();
    fireEvent.click(screen.getByTestId('download'));
    fireEvent.click(screen.getByTestId('complete'));

    expect(mockAcknowledgeMutate).toHaveBeenCalledTimes(2);
    expect(mockAcknowledgeMutate.mock.calls[1][0]).toEqual({
      acknowledgementToken: 'rotated-acknowledgement-token',
    });
    expect(mockFinalizeMutate).toHaveBeenCalledTimes(1);
  });
});
