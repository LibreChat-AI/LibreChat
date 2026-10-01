import { act, renderHook, waitFor } from '@testing-library/react';
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

const mockStartAuthentication = jest.fn();
const mockGetPasskeyLoginOptions = jest.fn();
const mockVerifyPasskeyLogin = jest.fn();
const mockShowToast = jest.fn();
const mockNavigate = jest.fn();
const mockLocalize = (key: string) => key;
const mockToastContext = { showToast: mockShowToast };

jest.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => mockStartAuthentication(...args),
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: async () => true,
}));

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
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'PublicKeyCredential', {
      configurable: true,
      value: function PublicKeyCredential() {},
    });
    mockGetPasskeyLoginOptions.mockResolvedValue({ options: {}, sessionId: 'session' });
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
});
