import { act, renderHook, waitFor } from '@testing-library/react';
import { clearTwoFactorSetupToken, readTwoFactorSetupToken } from 'librechat-data-provider';
import { usePasskeySignIn } from '../usePasskey';

type Deferred = {
  promise: Promise<unknown>;
  reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

let mockWebAuthnImportError: Error | undefined;
const mockStartAuthentication = jest.fn();
const mockGetPasskeyLoginOptions = jest.fn();
const mockVerifyPasskeyLogin = jest.fn();
const mockShowToast = jest.fn();
const mockNavigate = jest.fn();
const mockLocalize = (key: string) => key;
const mockToastContext = { showToast: mockShowToast };

jest.mock('@simplewebauthn/browser', () => {
  if (mockWebAuthnImportError) {
    throw mockWebAuthnImportError;
  }
  return {
    startAuthentication: (...args: unknown[]) => mockStartAuthentication(...args),
    browserSupportsWebAuthn: () => true,
    browserSupportsWebAuthnAutofill: async () => true,
  };
});

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    getPasskeyLoginOptions: (...args: unknown[]) => mockGetPasskeyLoginOptions(...args),
    verifyPasskeyLogin: (...args: unknown[]) => mockVerifyPasskeyLogin(...args),
  },
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => mockToastContext,
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => mockLocalize,
}));

jest.mock('~/data-provider', () => ({
  useRegisterPasskeyMutation: () => ({ mutateAsync: jest.fn() }),
}));

describe('usePasskeySignIn', () => {
  afterEach(() => {
    mockWebAuthnImportError = undefined;
    delete window.__lcRecoverStaleAssets;
    delete window.__lcStaleAssetRecoveryPending;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'PublicKeyCredential', {
      configurable: true,
      value: function PublicKeyCredential() {},
    });
    mockGetPasskeyLoginOptions.mockResolvedValue({ options: {}, sessionId: 'session' });
  });

  it('recovers a missing WebAuthn chunk before its local sign-in catch', async () => {
    mockWebAuthnImportError = new TypeError(
      'Failed to fetch dynamically imported module: /assets/webauthn-old.js',
    );
    const recover = jest.fn(() => false);
    window.__lcRecoverStaleAssets = recover;
    const { result } = renderHook(() => usePasskeySignIn({ enabled: true }));
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.signIn();
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(mockStartAuthentication).not.toHaveBeenCalled();
    expect(mockGetPasskeyLoginOptions).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_auth_passkey_error',
      status: 'error',
    });
  });

  it('keeps the manual ceremony locked when it aborts the pending autofill ceremony', async () => {
    const autofill = deferred();
    const manual = deferred();
    mockStartAuthentication.mockImplementation(({ useBrowserAutofill }) =>
      useBrowserAutofill ? autofill.promise : manual.promise,
    );

    const { result } = renderHook(() => usePasskeySignIn({ enabled: true }));
    await waitFor(() => expect(mockStartAuthentication).toHaveBeenCalledTimes(1));

    act(() => {
      void result.current.signIn();
    });
    await waitFor(() => expect(mockStartAuthentication).toHaveBeenCalledTimes(2));
    expect(result.current.isSigningIn).toBe(true);

    await act(async () => {
      autofill.reject(Object.assign(new Error('superseded'), { name: 'AbortError' }));
      await autofill.promise.catch(() => undefined);
    });

    expect(result.current.isSigningIn).toBe(true);
    await act(async () => {
      await result.current.signIn();
    });
    expect(mockGetPasskeyLoginOptions).toHaveBeenCalledTimes(2);
    expect(mockStartAuthentication).toHaveBeenCalledTimes(2);
  });

  describe('after the ceremony', () => {
    const signInWith = async (response: Record<string, unknown>) => {
      mockStartAuthentication.mockImplementation(({ useBrowserAutofill }) =>
        useBrowserAutofill ? deferred().promise : Promise.resolve({ id: 'credential' }),
      );
      mockVerifyPasskeyLogin.mockResolvedValue(response);
      const { result } = renderHook(() => usePasskeySignIn({ enabled: true }));
      await act(async () => {
        await result.current.signIn();
      });
    };

    afterEach(() => {
      clearTwoFactorSetupToken();
    });

    it('sends an account that must enroll to two-factor setup with its credential', async () => {
      await signInWith({
        code: 'TWO_FACTOR_ENROLLMENT_REQUIRED',
        twoFAPending: true,
        twoFASetupRequired: true,
        tempToken: 'setup-token',
      });

      expect(mockNavigate).toHaveBeenCalledWith('/login/2fa/setup', { replace: true });
      expect(readTwoFactorSetupToken()).toBe('setup-token');
    });

    it('sends an enrolled account to the code challenge', async () => {
      await signInWith({ twoFAPending: true, tempToken: 'challenge-token' });

      expect(mockNavigate).toHaveBeenCalledWith('/login/2fa?tempToken=challenge-token', {
        replace: true,
      });
      expect(readTwoFactorSetupToken()).toBeFalsy();
    });
  });
});
