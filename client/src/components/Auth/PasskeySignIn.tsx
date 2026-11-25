import React from 'react';
import { PasskeyIcon, Spinner } from '@librechat/client';
import { usePasskeySignIn } from '~/hooks/Auth/usePasskey';
import { useLocalize } from '~/hooks';

/**
 * Sign-in affordance for discoverable passkeys. Styled to match `SocialButton`
 * so it reads as one more way in rather than a separate mechanism.
 *
 * Mounting this also arms the browser's conditional (autofill) ceremony, which
 * is why it renders even while the button itself is busy.
 */
function PasskeySignIn({ enabled }: { enabled: boolean }) {
  const localize = useLocalize();
  const { signIn, isSigningIn } = usePasskeySignIn({ enabled });

  if (!enabled) {
    return null;
  }

  return (
    <div className="mt-2 flex gap-x-2">
      <button
        type="button"
        data-testid="passkey"
        onClick={() => void signIn()}
        disabled={isSigningIn}
        aria-busy={isSigningIn}
        aria-label={localize('com_auth_passkey_login')}
        className="border-border-light bg-surface-primary text-text-primary hover:bg-surface-tertiary focus-visible:ring-text-primary flex w-full items-center space-x-3 rounded-2xl border px-5 py-3 transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
      >
        {isSigningIn ? <Spinner className="h-5 w-5" /> : <PasskeyIcon />}
        <p>{localize('com_auth_passkey_login')}</p>
      </button>
    </div>
  );
}

export default React.memo(PasskeySignIn);
