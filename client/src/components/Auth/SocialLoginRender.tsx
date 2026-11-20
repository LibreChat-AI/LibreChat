import { TStartupConfig } from 'librechat-data-provider';
import {
  GoogleIcon,
  FacebookIcon,
  OpenIDIcon,
  GithubIcon,
  DiscordIcon,
  AppleIcon,
  SamlIcon,
} from '@librechat/client';

import PasskeySignIn from './PasskeySignIn';
import SocialButton from './SocialButton';
import { useLocalize } from '~/hooks';

function SocialLoginRender({
  startupConfig,
  /** Passkeys sign an existing account in, so they are offered on login only. */
  showPasskey = false,
}: {
  startupConfig: TStartupConfig | null | undefined;
  showPasskey?: boolean;
}) {
  const localize = useLocalize();

  if (!startupConfig) {
    return null;
  }

  const providerComponents = {
    discord: startupConfig.discordLoginEnabled && (
      <SocialButton
        key="discord"
        enabled={startupConfig.discordLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="discord"
        Icon={DiscordIcon}
        label={localize('com_auth_discord_login')}
        id="discord"
      />
    ),
    facebook: startupConfig.facebookLoginEnabled && (
      <SocialButton
        key="facebook"
        enabled={startupConfig.facebookLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="facebook"
        Icon={FacebookIcon}
        label={localize('com_auth_facebook_login')}
        id="facebook"
      />
    ),
    github: startupConfig.githubLoginEnabled && (
      <SocialButton
        key="github"
        enabled={startupConfig.githubLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="github"
        Icon={GithubIcon}
        label={localize('com_auth_github_login')}
        id="github"
      />
    ),
    google: startupConfig.googleLoginEnabled && (
      <SocialButton
        key="google"
        enabled={startupConfig.googleLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="google"
        Icon={GoogleIcon}
        label={localize('com_auth_google_login')}
        id="google"
      />
    ),
    apple: startupConfig.appleLoginEnabled && (
      <SocialButton
        key="apple"
        enabled={startupConfig.appleLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="apple"
        Icon={AppleIcon}
        label={localize('com_auth_apple_login')}
        id="apple"
      />
    ),
    openid: startupConfig.openidLoginEnabled && (
      <SocialButton
        key="openid"
        enabled={startupConfig.openidLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="openid"
        Icon={() =>
          startupConfig.openidImageUrl ? (
            <img src={startupConfig.openidImageUrl} alt="OpenID Logo" className="h-5 w-5" />
          ) : (
            <OpenIDIcon />
          )
        }
        label={startupConfig.openidLabel}
        id="openid"
      />
    ),
    saml: startupConfig.samlLoginEnabled && (
      <SocialButton
        key="saml"
        enabled={startupConfig.samlLoginEnabled}
        serverDomain={startupConfig.serverDomain}
        oauthPath="saml"
        Icon={() =>
          startupConfig.samlImageUrl ? (
            <img src={startupConfig.samlImageUrl} alt="SAML Logo" className="h-5 w-5" />
          ) : (
            <SamlIcon />
          )
        }
        label={startupConfig.samlLabel ? startupConfig.samlLabel : localize('com_auth_saml_login')}
        id="saml"
      />
    ),
  };

  const passkeyEnabled = showPasskey && startupConfig.passkeyLoginEnabled === true;
  const socialEnabled =
    startupConfig.socialLoginEnabled === true && (startupConfig.socialLogins?.length ?? 0) > 0;

  if (!passkeyEnabled && !socialEnabled) {
    return null;
  }

  return (
    <>
      {startupConfig.emailLoginEnabled && (
        <>
          <div className="border-border-medium relative mt-6 flex w-full items-center justify-center border border-t uppercase">
            <div className="bg-surface-primary text-text-primary absolute px-3 text-xs">
              {localize('com_auth_or')}
            </div>
          </div>
          <div className="mt-8" />
        </>
      )}
      <div className="mt-2">
        <PasskeySignIn enabled={passkeyEnabled} />
        {socialEnabled &&
          startupConfig.socialLogins?.map((provider) => providerComponents[provider] || null)}
      </div>
    </>
  );
}

export default SocialLoginRender;
