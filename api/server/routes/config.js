const express = require('express');
const {
  isEnabled,
  isLangfuseConnectionAvailable,
  isLangfuseFanoutEnabled,
  getBalanceConfig,
  getCloudFrontConfig,
  getAppConfigOptionsFromUser,
  resolveBuildInfo,
  resolveTitleTiming,
  sanitizeModelSpecs,
  excludeHiddenModelSpecs,
  isFileSnapshotEnabled,
  getEndpointsDropParamsMap,
  resolveCodeEnvironmentDecisionVersion,
  resolveCodeEnvironmentMoveCapabilities,
  resolveCodeEnvironmentTransitionVersion,
} = require('@librechat/api');
const { EModelEndpoint, defaultSocialLogins } = require('librechat-data-provider');
const { logger, getTenantId, SystemCapabilities } = require('@librechat/data-schemas');
const { hasCapability, hasConfigCapability } = require('~/server/middleware/roles/capabilities');
const { getLdapConfig } = require('~/server/services/Config/ldap');
const { getRumConfig } = require('~/server/services/Config/rum');
const { getAppConfig } = require('~/server/services/Config/app');

const router = express.Router();
const emailLoginEnabled =
  process.env.ALLOW_EMAIL_LOGIN === undefined || isEnabled(process.env.ALLOW_EMAIL_LOGIN);
const passwordResetEnabled = isEnabled(process.env.ALLOW_PASSWORD_RESET);

const sharedLinksEnabled =
  process.env.ALLOW_SHARED_LINKS === undefined || isEnabled(process.env.ALLOW_SHARED_LINKS);

const publicSharedLinksEnabled =
  sharedLinksEnabled && isEnabled(process.env.ALLOW_SHARED_LINKS_PUBLIC);

const sharePointFilePickerEnabled = isEnabled(process.env.ENABLE_SHAREPOINT_FILEPICKER);
const openidReuseTokens = isEnabled(process.env.OPENID_REUSE_TOKENS);

/**
 * Resolve build metadata eagerly at module load so the first `/api/config`
 * request does not pay the cost of `execFileSync('git', ...)` on the hot path.
 * The resolver caches its result after the first call.
 */
resolveBuildInfo();

function isBirthday() {
  const today = new Date();
  return today.getMonth() === 1 && today.getDate() === 11;
}

/**
 * Pre-login fields rendered by the unauthenticated login, registration, password-reset,
 * and email-verification pages. Any field added here is readable by anonymous callers
 * of `GET /api/config`, so keep this set strictly to what those pages need.
 *
 * See client consumers under `client/src/components/Auth/` and `client/src/routes/Layouts/Startup.tsx`.
 */
function buildPreLoginPayload() {
  const isOpenIdEnabled =
    !!process.env.OPENID_CLIENT_ID &&
    (isEnabled(process.env.OPENID_USE_PKCE) || !!process.env.OPENID_CLIENT_SECRET?.trim()) &&
    !!process.env.OPENID_ISSUER &&
    !!process.env.OPENID_SESSION_SECRET;

  const isSamlEnabled =
    !!process.env.SAML_ENTRY_POINT &&
    !!process.env.SAML_ISSUER &&
    !!process.env.SAML_CERT &&
    !!process.env.SAML_SESSION_SECRET;

  const ldap = getLdapConfig();

  /** @type {Partial<TStartupConfig>} */
  const payload = {
    appTitle: process.env.APP_TITLE || 'LibreChat',
    discordLoginEnabled: !!process.env.DISCORD_CLIENT_ID && !!process.env.DISCORD_CLIENT_SECRET,
    facebookLoginEnabled: !!process.env.FACEBOOK_CLIENT_ID && !!process.env.FACEBOOK_CLIENT_SECRET,
    githubLoginEnabled: !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET,
    googleLoginEnabled: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    appleLoginEnabled:
      !!process.env.APPLE_CLIENT_ID &&
      !!process.env.APPLE_TEAM_ID &&
      !!process.env.APPLE_KEY_ID &&
      !!process.env.APPLE_PRIVATE_KEY_PATH,
    openidLoginEnabled: isOpenIdEnabled,
    openidLabel: process.env.OPENID_BUTTON_LABEL || 'Continue with OpenID',
    openidImageUrl: process.env.OPENID_IMAGE_URL,
    openidAutoRedirect: isEnabled(process.env.OPENID_AUTO_REDIRECT),
    samlLoginEnabled: !isOpenIdEnabled && isSamlEnabled,
    samlLabel: process.env.SAML_BUTTON_LABEL,
    samlImageUrl: process.env.SAML_IMAGE_URL,
    serverDomain: process.env.DOMAIN_SERVER || 'http://localhost:3080',
    emailLoginEnabled,
    registrationEnabled: !ldap?.enabled && isEnabled(process.env.ALLOW_REGISTRATION),
    socialLoginEnabled: isEnabled(process.env.ALLOW_SOCIAL_LOGIN),
    emailEnabled:
      (!!process.env.EMAIL_SERVICE || !!process.env.EMAIL_HOST) &&
      !!process.env.EMAIL_USERNAME &&
      !!process.env.EMAIL_PASSWORD &&
      !!process.env.EMAIL_FROM,
    passwordResetEnabled,
  };

  const minPasswordLength = parseInt(process.env.MIN_PASSWORD_LENGTH, 10);
  if (minPasswordLength && !isNaN(minPasswordLength)) {
    payload.minPasswordLength = minPasswordLength;
  }

  if (ldap) {
    payload.ldap = ldap;
  }

  return payload;
}

/**
 * Fields shared by authenticated chat and share-view config. Anonymous share
 * views receive these through `/api/share/:shareId/config` after share access
 * checks, not through the generic startup config endpoint.
 */
function buildPublicSharePayload() {
  /** @type {Partial<TStartupConfig>} */
  const payload = {
    analyticsGtmId: process.env.ANALYTICS_GTM_ID,
  };

  if (typeof process.env.CUSTOM_FOOTER === 'string') {
    payload.customFooter = process.env.CUSTOM_FOOTER;
  }

  return payload;
}

/**
 * Post-login fields appended only when `req.user` is present. These describe the
 * authenticated UX (account-settings links, share-link feature flags, birthday icon,
 * openid token-reuse marker) and are not needed on the pre-login screens, so they
 * are not exposed to unauthenticated callers.
 */
function buildPostLoginPayload() {
  /** @type {Partial<TStartupConfig>} */
  const payload = {
    showBirthdayIcon:
      isBirthday() ||
      isEnabled(process.env.SHOW_BIRTHDAY_ICON) ||
      process.env.SHOW_BIRTHDAY_ICON === '',
    helpAndFaqURL: process.env.HELP_AND_FAQ_URL || 'https://librechat.ai',
    sharedLinksEnabled,
    publicSharedLinksEnabled,
    openidReuseTokens,
    /** Read inline (not module-level) for per-request evaluation and test isolation */
    allowAccountDeletion:
      process.env.ALLOW_ACCOUNT_DELETION === undefined ||
      isEnabled(process.env.ALLOW_ACCOUNT_DELETION),
  };

  return payload;
}

function buildBuildInfoPayload(interfaceConfig) {
  if (interfaceConfig?.buildInfo === false) {
    return undefined;
  }
  const info = resolveBuildInfo();
  if (!info.commit && !info.branch && !info.buildDate) {
    return undefined;
  }
  return {
    commit: info.commit,
    commitShort: info.commitShort,
    branch: info.branch,
    buildDate: info.buildDate,
  };
}

function buildWebSearchConfig(appConfig) {
  const ws = appConfig?.webSearch;
  if (!ws) {
    return undefined;
  }
  const { searchProvider, scraperProvider, rerankerType } = ws;
  if (!searchProvider && !scraperProvider && !rerankerType) {
    return undefined;
  }
  return {
    ...(searchProvider && { searchProvider }),
    ...(scraperProvider && { scraperProvider }),
    ...(rerankerType && { rerankerType }),
  };
}

function buildCloudFrontStartupConfig() {
  const config = getCloudFrontConfig();
  if (
    config?.imageSigning !== 'cookies' ||
    !config.domain ||
    !config.cookieDomain ||
    !config.privateKey ||
    !config.keyPairId
  ) {
    return undefined;
  }

  return {
    cookieRefresh: {
      endpoint: '/api/auth/cloudfront/refresh',
      domain: config.domain,
    },
  };
}

router.get('/', async function (req, res) {
  try {
    const preLoginPayload = buildPreLoginPayload();
    const publicSharePayload = buildPublicSharePayload();
    const rum = getRumConfig();

    if (!req.user) {
      const tenantId = getTenantId();
      const baseConfig = await getAppConfig(tenantId ? { tenantId } : { baseOnly: true });

      /** @type {Partial<TStartupConfig>} */
      const payload = {
        ...preLoginPayload,
        socialLogins: baseConfig?.registration?.socialLogins ?? defaultSocialLogins,
        turnstile: baseConfig?.turnstileConfig,
        ...(rum ? { rum } : {}),
      };

      const interfaceConfig = baseConfig?.interfaceConfig;
      const buildInfoDisabled = interfaceConfig?.buildInfo === false;
      if (interfaceConfig?.privacyPolicy || interfaceConfig?.termsOfService || buildInfoDisabled) {
        payload.interface = {};
        if (interfaceConfig.privacyPolicy) {
          payload.interface.privacyPolicy = interfaceConfig.privacyPolicy;
        }
        if (interfaceConfig.termsOfService) {
          payload.interface.termsOfService = interfaceConfig.termsOfService;
        }
        if (buildInfoDisabled) {
          payload.interface.buildInfo = false;
        }
      }

      const unauthBuildInfo = buildBuildInfoPayload(interfaceConfig);
      if (unauthBuildInfo) {
        payload.buildInfo = unauthBuildInfo;
      }

      return res.status(200).send(payload);
    }

    const appConfig = await getAppConfig(getAppConfigOptionsFromUser(req.user));
    const codeEnvironmentDecisionVersion = resolveCodeEnvironmentDecisionVersion(
      process.env.CODE_ENVIRONMENT_DECISION_VERSION,
    );
    const codeEnvironmentMoveCapabilities = resolveCodeEnvironmentMoveCapabilities(appConfig);
    const codeEnvironmentTransitionVersion = resolveCodeEnvironmentTransitionVersion(appConfig);

    const endpointsDropParamsMap = getEndpointsDropParamsMap(appConfig?.endpoints);

    const balanceConfig = getBalanceConfig(appConfig);
    const cloudFront = buildCloudFrontStartupConfig();
    const langfuseFanoutEnabled = isLangfuseFanoutEnabled();
    const langfuseConnectionAvailable = isLangfuseConnectionAvailable();
    let langfuseConnectionAccess = false;

    if (langfuseConnectionAvailable) {
      try {
        const userId = req.user.id ?? req.user._id?.toString();
        if (userId) {
          const capabilityUser = {
            id: userId,
            role: req.user.role ?? '',
            tenantId: req.user.tenantId,
            idOnTheSource: req.user.idOnTheSource ?? null,
          };
          const hasAdminAccess = await hasCapability(
            capabilityUser,
            SystemCapabilities.ACCESS_ADMIN,
          );
          if (hasAdminAccess) {
            langfuseConnectionAccess = await hasConfigCapability(capabilityUser, 'langfuse');
          }
        }
      } catch (err) {
        logger.warn(`[config] Langfuse capability check failed: ${err.message}`);
      }
    }

    /** @type {TStartupConfig} */
    const payload = {
      ...preLoginPayload,
      ...publicSharePayload,
      ...buildPostLoginPayload(),
      sharedLinksSnapshotFilesEnabled: sharedLinksEnabled && isFileSnapshotEnabled(appConfig),
      socialLogins: appConfig?.registration?.socialLogins ?? defaultSocialLogins,
      interface: appConfig?.interfaceConfig,
      titleGenerationTiming: resolveTitleTiming({
        appConfig,
        endpoint: EModelEndpoint.agents,
      }),
      turnstile: appConfig?.turnstileConfig,
      modelSpecs: sanitizeModelSpecs(excludeHiddenModelSpecs(appConfig?.modelSpecs)),
      balance: balanceConfig,
      bundlerURL: process.env.SANDPACK_BUNDLER_URL,
      staticBundlerURL: process.env.SANDPACK_STATIC_BUNDLER_URL,
      sharePointFilePickerEnabled,
      sharePointBaseUrl: process.env.SHAREPOINT_BASE_URL,
      sharePointPickerGraphScope: process.env.SHAREPOINT_PICKER_GRAPH_SCOPE,
      sharePointPickerSharePointScope: process.env.SHAREPOINT_PICKER_SHAREPOINT_SCOPE,
      conversationImportMaxFileSize: process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES
        ? parseInt(process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES, 10)
        : 0,
      langfuseFanoutEnabled,
      langfuseConnectionAccess,
      insightsEnabled: isEnabled(process.env.ENABLE_INSIGHTS),
      compactionEnabled: appConfig?.summarization?.enabled !== false,
      ...(codeEnvironmentDecisionVersion != null ? { codeEnvironmentDecisionVersion } : {}),
      ...codeEnvironmentMoveCapabilities,
      ...(codeEnvironmentTransitionVersion != null ? { codeEnvironmentTransitionVersion } : {}),
      ...(cloudFront ? { cloudFront } : {}),
      ...(rum ? { rum } : {}),
      fileUploadSseEnabled: isEnabled(process.env.FILE_UPLOAD_SSE_ENABLED),
      endpointsDropParamsMap: endpointsDropParamsMap,
    };

    const webSearch = buildWebSearchConfig(appConfig);
    if (webSearch) {
      payload.webSearch = webSearch;
    }

    const buildInfo = buildBuildInfoPayload(appConfig?.interfaceConfig);
    if (buildInfo) {
      payload.buildInfo = buildInfo;
    }

    const adminPanelURL = process.env.ADMIN_PANEL_URL;
    if (adminPanelURL || !payload.allowAccountDeletion) {
      try {
        const userId = req.user.id ?? req.user._id?.toString();
        if (userId) {
          const hasAdminAccess = await hasCapability(
            { id: userId, role: req.user.role ?? '', tenantId: req.user.tenantId },
            SystemCapabilities.ACCESS_ADMIN,
          );
          if (hasAdminAccess && adminPanelURL) {
            payload.adminPanelURL = adminPanelURL;
          }
          if (hasAdminAccess && !payload.allowAccountDeletion) {
            payload.allowAccountDeletion = true;
          }
        }
      } catch (err) {
        logger.warn(`[config] ACCESS_ADMIN capability check failed: ${err.message}`);
      }
    }

    return res.status(200).send(payload);
  } catch (err) {
    logger.error('Error in startup config', err);
    return res.status(500).send({ error: err.message });
  }
});

module.exports = router;
