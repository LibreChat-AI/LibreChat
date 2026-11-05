import type { OpenIDBackchannelLogoutAppConfig } from './backchannel';
import type { OpenIDSessionAuthorization } from './sessions';
import type { OpenIDSessionsAppConfig } from './runtime';

export interface OpenIDAuthorizationStartupSessions {
  connectOpenIDAuthorization: (
    appConfig?: OpenIDSessionsAppConfig,
  ) => Promise<OpenIDSessionAuthorization | undefined>;
}

export interface OpenIDAuthorizationStartupBackchannel {
  initOpenIDBackchannelLogout: (appConfig?: OpenIDBackchannelLogoutAppConfig) => Promise<void>;
  startOpenIDBackchannelLogoutWorker: () => void;
}

export interface StartOpenIDAuthorizationInput {
  appConfig?: OpenIDBackchannelLogoutAppConfig;
  sessions: OpenIDAuthorizationStartupSessions;
  backchannel: OpenIDAuthorizationStartupBackchannel;
}

/** Enforcement on blocks startup for a verified authorization connection; enforcement off starts
 *  it in the background so the server accepts requests immediately while it connects. */
export async function startOpenIDAuthorization({
  appConfig,
  sessions,
  backchannel,
}: StartOpenIDAuthorizationInput): Promise<void> {
  if (appConfig?.registration?.openidSessionEnforcement === true) {
    await sessions.connectOpenIDAuthorization(appConfig);
  } else {
    sessions.connectOpenIDAuthorization(appConfig);
  }
  await backchannel.initOpenIDBackchannelLogout(appConfig);
  backchannel.startOpenIDBackchannelLogoutWorker();
}
