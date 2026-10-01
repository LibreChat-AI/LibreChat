import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import type {
  TPasskey,
  TPasskeyTransport,
  TPasskeyAuthenticationResponse,
  TPasskeyRegistrationResponse,
} from 'librechat-data-provider';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { SESSION_KEY, withBasePath, isSafeRedirect, REDIRECT_PARAM } from '~/utils/redirect';
import { useRegisterPasskeyMutation } from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';

async function loadWebAuthn() {
  return import('@simplewebauthn/browser');
}

/** Thrown by the browser when the user dismisses or times out the native prompt. */
const isDismissal = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
};

/**
 * The server answers a rejected step-up with 403 rather than 401, so a mistyped
 * password is an inline error instead of a token refresh and a sign-out.
 */
export const isPasswordRejection = (error: unknown): boolean =>
  (error as { response?: { status?: number } } | null)?.response?.status === 403;

/** Maps a WebAuthn ceremony failure onto a message the user can act on. */
const ceremonyErrorKey = (error: unknown): TranslationKeys => {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'InvalidStateError') {
    return 'com_auth_passkey_already_registered';
  }
  if (name === 'SecurityError') {
    return 'com_auth_passkey_origin_error';
  }
  return 'com_auth_passkey_error';
};

/**
 * Mirrors the server's `defaultPasskeyName` transport mapping. The chosen label is
 * persisted verbatim and rendered back to the user, so it is resolved here where a
 * locale is available rather than falling back to the server's English default.
 */
const defaultNameKey = (transports: TPasskeyTransport[] = []): TranslationKeys => {
  if (transports.includes('hybrid')) {
    return 'com_ui_passkey_default_phone';
  }
  if (transports.includes('usb') || transports.includes('nfc')) {
    return 'com_ui_passkey_default_security_key';
  }
  if (transports.includes('internal')) {
    return 'com_ui_passkey_default_this_device';
  }
  return 'com_ui_passkey_default_generic';
};

/** Sync capability check without loading the WebAuthn browser package. */
export const passkeysSupported = (): boolean =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';

/**
 * Resolves where to send the user after a successful passkey login.
 * Mirrors password-flow sessionStorage + query handling without needing a router.
 */
function resolvePostLoginHref(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get(REDIRECT_PARAM);
    const fromSession = sessionStorage.getItem(SESSION_KEY);
    if (fromSession) {
      sessionStorage.removeItem(SESSION_KEY);
    }
    const target = fromQuery ?? fromSession;
    if (target && isSafeRedirect(target)) {
      return withBasePath(target);
    }
  } catch {
    /* ignore storage / URL access failures */
  }
  return withBasePath('/');
}

/**
 * Drives the passkey sign-in ceremony.
 *
 * `signIn` runs the modal ceremony from an explicit user action. Separately, if
 * the browser supports conditional mediation, an autofill ceremony is started
 * once on mount so a passkey is offered inline from the login form's email
 * field.
 *
 * A completed sign-in navigates the whole document so the app boots against the
 * new session. The 2FA handoff must not: no refresh cookie exists yet, so a
 * remount of `AuthContextProvider` would silent-refresh, find nothing and bounce
 * back to login before the code can be entered. That step stays inside the
 * router, matching the password flow in `AuthContext`.
 */
export function usePasskeySignIn({ enabled }: { enabled: boolean }) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const [isSigningIn, setIsSigningIn] = useState(false);
  /** Guards against a second autofill ceremony on React 18 double-invoked effects. */
  const autofillStarted = useRef(false);
  /** Re-entry guard for both button sign-in and autofill complete paths. */
  const inFlightRef = useRef(false);

  const complete = useCallback(
    async (credential: TPasskeyAuthenticationResponse, sessionId: string) => {
      const result = await dataService.verifyPasskeyLogin({ credential, sessionId });
      if (result.twoFAPending === true && result.tempToken != null) {
        navigate(`/login/2fa?tempToken=${encodeURIComponent(result.tempToken)}`, { replace: true });
        return;
      }
      window.location.href = resolvePostLoginHref();
    },
    [navigate],
  );

  const signIn = useCallback(async () => {
    if (!enabled || inFlightRef.current) {
      return;
    }
    if (!passkeysSupported()) {
      showToast({ message: localize('com_auth_passkey_not_supported'), status: 'error' });
      return;
    }

    inFlightRef.current = true;
    setIsSigningIn(true);
    let navigated = false;
    try {
      const { startAuthentication, browserSupportsWebAuthn } = await loadWebAuthn();
      if (!browserSupportsWebAuthn()) {
        showToast({ message: localize('com_auth_passkey_not_supported'), status: 'error' });
        return;
      }
      const { options, sessionId } = await dataService.getPasskeyLoginOptions();
      const credential = (await startAuthentication({
        optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
      })) as TPasskeyAuthenticationResponse;
      await complete(credential, sessionId);
      navigated = true;
      // On success we navigate away; keep busy state until unload.
    } catch (error) {
      if (!isDismissal(error)) {
        showToast({ message: localize(ceremonyErrorKey(error)), status: 'error' });
      }
    } finally {
      if (!navigated) {
        inFlightRef.current = false;
        setIsSigningIn(false);
      }
    }
  }, [enabled, complete, localize, showToast]);

  useEffect(() => {
    if (!enabled || autofillStarted.current) {
      return;
    }
    autofillStarted.current = true;

    let cancelled = false;
    const startAutofill = async () => {
      try {
        const { startAuthentication, browserSupportsWebAuthnAutofill } = await loadWebAuthn();
        if (!(await browserSupportsWebAuthnAutofill())) {
          return;
        }
        const { options, sessionId } = await dataService.getPasskeyLoginOptions();
        const credential = (await startAuthentication({
          optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
          useBrowserAutofill: true,
        })) as TPasskeyAuthenticationResponse;
        if (cancelled || inFlightRef.current) {
          return;
        }
        inFlightRef.current = true;
        setIsSigningIn(true);
        try {
          await complete(credential, sessionId);
          // On success we navigate away; keep busy state until unload.
        } catch (error) {
          if (!isDismissal(error)) {
            showToast({ message: localize(ceremonyErrorKey(error)), status: 'error' });
          }
          inFlightRef.current = false;
          setIsSigningIn(false);
        }
      } catch {
        /**
         * Autofill is a progressive enhancement: a failure leaves the form usable.
         * It holds the lock only inside the inner try, which releases it itself, so
         * an autofill ceremony superseded by the button must not unlock that one.
         */
      }
    };

    void startAutofill();
    return () => {
      cancelled = true;
    };
  }, [enabled, complete, localize, showToast]);

  return { signIn, isSigningIn };
}

/**
 * Drives passkey enrollment for the signed-in user. Both server steps require the
 * account password, so `registerPasskey` takes it and reports a rejected password
 * through `passwordErrorKey` rather than a toast, keeping the error next to the
 * field that caused it.
 *
 * Resolves to the stored credential so callers can put it straight into rename
 * mode, or `null` when the ceremony was dismissed or failed.
 */
export function usePasskeyRegistration() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [isRegistering, setIsRegistering] = useState(false);
  const [passwordErrorKey, setPasswordErrorKey] = useState<TranslationKeys | null>(null);
  const inFlightRef = useRef(false);
  const { mutateAsync: verifyRegistration } = useRegisterPasskeyMutation();

  const clearPasswordError = useCallback(() => setPasswordErrorKey(null), []);

  const registerPasskey = useCallback(
    async (password: string): Promise<TPasskey | null> => {
      if (inFlightRef.current) {
        return null;
      }
      if (!passkeysSupported()) {
        showToast({ message: localize('com_auth_passkey_not_supported'), status: 'error' });
        return null;
      }

      inFlightRef.current = true;
      setIsRegistering(true);
      setPasswordErrorKey(null);
      try {
        const { startRegistration, browserSupportsWebAuthn } = await loadWebAuthn();
        if (!browserSupportsWebAuthn()) {
          showToast({ message: localize('com_auth_passkey_not_supported'), status: 'error' });
          return null;
        }
        const options = await dataService.getPasskeyRegistrationOptions({ password });
        const credential = (await startRegistration({
          optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
        })) as TPasskeyRegistrationResponse;
        const { passkey } = await verifyRegistration({
          credential,
          password,
          name: localize(defaultNameKey(credential.response?.transports)),
        });
        showToast({ message: localize('com_ui_passkey_added'), status: 'success' });
        return passkey;
      } catch (error) {
        if (isPasswordRejection(error)) {
          setPasswordErrorKey('com_ui_passkey_password_incorrect');
        } else if (!isDismissal(error)) {
          showToast({ message: localize(ceremonyErrorKey(error)), status: 'error' });
        }
        return null;
      } finally {
        inFlightRef.current = false;
        setIsRegistering(false);
      }
    },
    [verifyRegistration, localize, showToast],
  );

  return { registerPasskey, isRegistering, passwordErrorKey, clearPasswordError };
}
