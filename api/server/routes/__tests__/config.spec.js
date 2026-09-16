jest.mock('~/cache/getLogStores');

const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/Config/ldap', () => ({
  getLdapConfig: jest.fn(() => null),
}));

const mockHasCapability = jest.fn();
const mockHasConfigCapability = jest.fn();
jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: (...args) => mockHasCapability(...args),
  hasConfigCapability: (...args) => mockHasConfigCapability(...args),
}));

const mockGetTenantId = jest.fn(() => undefined);
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  getTenantId: (...args) => mockGetTenantId(...args),
}));

const mockGetCloudFrontConfig = jest.fn(() => null);
const mockResolveBuildInfo = jest.fn(() => ({
  commit: null,
  commitShort: null,
  branch: null,
  buildDate: null,
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getCloudFrontConfig: (...args) => mockGetCloudFrontConfig(...args),
  resolveBuildInfo: (...args) => mockResolveBuildInfo(...args),
}));

const request = require('supertest');
const express = require('express');
const configRoute = require('../config');

function createApp(user) {
  const app = express();
  app.disable('x-powered-by');
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api/config', configRoute);
  return app;
}

const baseAppConfig = {
  registration: { socialLogins: ['google', 'github'] },
  interfaceConfig: {
    privacyPolicy: { externalUrl: 'https://example.com/privacy' },
    termsOfService: { externalUrl: 'https://example.com/tos' },
    modelSelect: true,
  },
  turnstileConfig: { siteKey: 'test-key' },
  modelSpecs: { list: [{ name: 'test-spec' }] },
  webSearch: { searchProvider: 'tavily' },
};

const mockUser = {
  id: 'user123',
  role: 'USER',
  tenantId: undefined,
};

afterEach(() => {
  jest.resetAllMocks();
  mockResolveBuildInfo.mockReturnValue({
    commit: null,
    commitShort: null,
    branch: null,
    buildDate: null,
  });
  delete process.env.APP_TITLE;
  delete process.env.CHECK_BALANCE;
  delete process.env.START_BALANCE;
  delete process.env.SANDPACK_BUNDLER_URL;
  delete process.env.SANDPACK_STATIC_BUNDLER_URL;
  delete process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES;
  delete process.env.ALLOW_REGISTRATION;
  delete process.env.ALLOW_SOCIAL_LOGIN;
  delete process.env.ALLOW_PASSWORD_RESET;
  delete process.env.DOMAIN_SERVER;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.OPENID_CLIENT_ID;
  delete process.env.OPENID_CLIENT_SECRET;
  delete process.env.OPENID_ISSUER;
  delete process.env.OPENID_SESSION_SECRET;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_SECRET;
  delete process.env.SAML_ENTRY_POINT;
  delete process.env.SAML_ISSUER;
  delete process.env.SAML_CERT;
  delete process.env.SAML_SESSION_SECRET;
  delete process.env.ALLOW_ACCOUNT_DELETION;
  delete process.env.ALLOW_EMAIL_CHANGE;
  delete process.env.ADMIN_PANEL_URL;
  delete process.env.ENABLE_INSIGHTS;
  delete process.env.ANALYTICS_GTM_ID;
  delete process.env.CUSTOM_FOOTER;
  delete process.env.HELP_AND_FAQ_URL;
  delete process.env.LANGFUSE_FANOUT_ENABLED;
  delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
  delete process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_TRACING_ENABLED;
  delete process.env.LANGFUSE_SAMPLE_RATE;
  delete process.env.TENANT_ISOLATION_STRICT;
  delete process.env.CODE_ENVIRONMENT_DECISION_VERSION;
});

describe('GET /api/config', () => {
  describe('unauthenticated (no req.user)', () => {
    it('should call getAppConfig with baseOnly when no tenant context', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetTenantId.mockReturnValue(undefined);
      const app = createApp(null);

      await request(app).get('/api/config');

      expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    });

    it('should call getAppConfig with tenantId when tenant context is present', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetTenantId.mockReturnValue('tenant-abc');
      const app = createApp(null);

      await request(app).get('/api/config');

      expect(mockGetAppConfig).toHaveBeenCalledWith({ tenantId: 'tenant-abc' });
    });

    it('should map tenant-scoped config fields in unauthenticated response', async () => {
      const tenantConfig = {
        ...baseAppConfig,
        registration: { socialLogins: ['saml'] },
        turnstileConfig: { siteKey: 'tenant-key' },
      };
      mockGetAppConfig.mockResolvedValue(tenantConfig);
      mockGetTenantId.mockReturnValue('tenant-abc');
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(200);
      expect(response.body.socialLogins).toEqual(['saml']);
      expect(response.body.turnstile).toEqual({ siteKey: 'tenant-key' });
      expect(response.body).not.toHaveProperty('modelSpecs');
    });

    it('should return minimal payload without authenticated-only fields', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toHaveProperty('modelSpecs');
      expect(response.body).not.toHaveProperty('balance');
      expect(response.body).not.toHaveProperty('webSearch');
      expect(response.body).not.toHaveProperty('bundlerURL');
      expect(response.body).not.toHaveProperty('staticBundlerURL');
      expect(response.body).not.toHaveProperty('sharePointFilePickerEnabled');
      expect(response.body).not.toHaveProperty('sharePointBaseUrl');
      expect(response.body).not.toHaveProperty('sharePointPickerGraphScope');
      expect(response.body).not.toHaveProperty('sharePointPickerSharePointScope');
      expect(response.body).not.toHaveProperty('conversationImportMaxFileSize');
      expect(response.body).not.toHaveProperty('insightsEnabled');
      expect(response.body).not.toHaveProperty('mcpApps');
    });

    it('should strip authenticated-only informational fields from unauthenticated response (#12688)', async () => {
      process.env.ANALYTICS_GTM_ID = 'GTM-XYZ';
      process.env.CUSTOM_FOOTER = 'internal footer text';
      process.env.HELP_AND_FAQ_URL = 'https://internal.example.com/faq';
      process.env.ADMIN_PANEL_URL = 'https://admin.example.com';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toHaveProperty('showBirthdayIcon');
      expect(response.body).not.toHaveProperty('helpAndFaqURL');
      expect(response.body).not.toHaveProperty('sharedLinksEnabled');
      expect(response.body).not.toHaveProperty('publicSharedLinksEnabled');
      expect(response.body).not.toHaveProperty('analyticsGtmId');
      expect(response.body).not.toHaveProperty('openidReuseTokens');
      expect(response.body).not.toHaveProperty('allowAccountDeletion');
      expect(response.body).not.toHaveProperty('allowEmailChange');
      expect(response.body).not.toHaveProperty('customFooter');
      expect(response.body).not.toHaveProperty('adminPanelURL');
    });

    it('should not include share-only fields when share context is requested', async () => {
      process.env.ANALYTICS_GTM_ID = 'GTM-XYZ';
      process.env.CUSTOM_FOOTER = 'public footer text';
      process.env.HELP_AND_FAQ_URL = 'https://internal.example.com/faq';
      process.env.SANDPACK_BUNDLER_URL = 'https://bundler.test';
      process.env.SANDPACK_STATIC_BUNDLER_URL = 'https://static-bundler.test';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(null);

      const response = await request(app).get('/api/config?context=share');

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toHaveProperty('analyticsGtmId');
      expect(response.body).not.toHaveProperty('customFooter');
      expect(response.body).not.toHaveProperty('bundlerURL');
      expect(response.body).not.toHaveProperty('staticBundlerURL');
      expect(response.body).not.toHaveProperty('helpAndFaqURL');
      expect(response.body).not.toHaveProperty('allowAccountDeletion');
      expect(response.body).not.toHaveProperty('allowEmailChange');
    });

    it('should include socialLogins and turnstile from base config', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.socialLogins).toEqual(['google', 'github']);
      expect(response.body.turnstile).toEqual({ siteKey: 'test-key' });
    });

    it('should include only privacyPolicy and termsOfService from interface config', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.interface).toEqual({
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
        termsOfService: { externalUrl: 'https://example.com/tos' },
      });
      expect(response.body.interface).not.toHaveProperty('modelSelect');
    });

    it('should not include interface if no privacyPolicy or termsOfService', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: { modelSelect: true },
      });
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('interface');
    });

    it('should include the deployment theme so the login page paints it', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: { modelSelect: true, theme: 'clickhouse' },
      });
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.interface).toEqual({ theme: 'clickhouse' });
    });

    it('keeps passkeys advertised for management when email login is disabled', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const previous = {
        ALLOW_EMAIL_LOGIN: process.env.ALLOW_EMAIL_LOGIN,
        ALLOW_PASSKEY_LOGIN: process.env.ALLOW_PASSKEY_LOGIN,
      };
      process.env.ALLOW_EMAIL_LOGIN = 'false';
      process.env.ALLOW_PASSKEY_LOGIN = 'true';
      try {
        let isolatedRoute;
        jest.isolateModules(() => {
          isolatedRoute = require('../config');
        });
        const app = express();
        app.use('/api/config', isolatedRoute);

        const response = await request(app).get('/api/config');

        expect(response.body.emailLoginEnabled).toBe(false);
        expect(response.body.passkeyLoginEnabled).toBe(true);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    it('should include shared env var fields', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      process.env.APP_TITLE = 'Test App';
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.appTitle).toBe('Test App');
      expect(response.body).toHaveProperty('emailLoginEnabled');
      expect(response.body).toHaveProperty('serverDomain');
    });

    it('should omit CloudFront cookie refresh from unauthenticated response (#12688)', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetCloudFrontConfig.mockReturnValue({
        domain: 'https://cdn.example.com',
        imageSigning: 'cookies',
        cookieDomain: '.example.com',
        privateKey: 'test-private-key',
        keyPairId: 'K123ABC',
      });
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('cloudFront');
    });

    it('should return 500 when getAppConfig throws', async () => {
      mockGetAppConfig.mockRejectedValue(new Error('Config service failure'));
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(500);
      expect(response.body).toHaveProperty('error');
    });

    it('should not expose endpointsDropParamsMap to unauthenticated callers', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        endpoints: {
          custom: [{ name: 'custom-provider', dropParams: ['temperature'] }],
        },
      });
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('endpointsDropParamsMap');
    });
  });

  describe('authenticated (req.user exists)', () => {
    it('should call getAppConfig with role, userId, and tenantId', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetTenantId.mockReturnValue('fallback-tenant');
      const app = createApp(mockUser);

      await request(app).get('/api/config');

      expect(mockGetAppConfig).toHaveBeenCalledWith({
        role: 'USER',
        userId: 'user123',
        idOnTheSource: undefined,
        tenantId: 'fallback-tenant',
        failClosed: true,
      });
    });

    it('should prefer user tenantId over getTenantId fallback', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetTenantId.mockReturnValue('fallback-tenant');
      const app = createApp({ ...mockUser, tenantId: 'user-tenant' });

      await request(app).get('/api/config');

      expect(mockGetAppConfig).toHaveBeenCalledWith({
        role: 'USER',
        userId: 'user123',
        idOnTheSource: undefined,
        tenantId: 'user-tenant',
        failClosed: true,
      });
    });

    it.each([
      [undefined, { enabled: false, legacyHtmlEnabled: true }],
      [true, { enabled: true, legacyHtmlEnabled: true }],
      [false, { enabled: false, legacyHtmlEnabled: false }],
    ])('publishes the authenticated MCP Apps policy for raw apps=%s', async (apps, expected) => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        mcpSettings: apps === undefined ? {} : { apps },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(200);
      expect(response.body.mcpApps).toEqual({
        ...expected,
        cspLimits: { maxSourcesPerDirective: 32, maxSerializedLength: 4096 },
        maxPersistedAppBytes: 1048576,
        maxAdmissionRequestsPerMinute: 240,
        maxActiveViews: 3,
        maxActionPreviewChars: 16384,
      });
    });

    it('publishes deployment-owned MCP App sandbox limits', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        mcpSettings: { apps: true },
        mcpAppSandbox: {
          url: 'https://mcp-sandbox.example.com/api/mcp/sandbox',
          maxSourcesPerDirective: 64,
          maxSerializedLength: 8192,
          maxAdmissionRequestsPerMinute: 480,
          maxActiveViews: 7,
          maxActionPreviewChars: 32768,
        },
      });
      const response = await request(createApp(mockUser)).get('/api/config');

      expect(response.body.mcpApps).toEqual({
        enabled: true,
        legacyHtmlEnabled: true,
        cspLimits: { maxSourcesPerDirective: 64, maxSerializedLength: 8192 },
        maxPersistedAppBytes: 1048576,
        maxAdmissionRequestsPerMinute: 480,
        maxActiveViews: 7,
        maxActionPreviewChars: 32768,
        sandboxUrl: 'https://mcp-sandbox.example.com/api/mcp/sandbox',
      });
    });

    it('should include modelSpecs, balance, and webSearch', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      process.env.CHECK_BALANCE = 'true';
      process.env.START_BALANCE = '10000';
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.modelSpecs).toEqual({ list: [{ name: 'test-spec' }] });
      expect(response.body.balance).toEqual({ enabled: true, startBalance: 10000 });
      expect(response.body.webSearch).toEqual({ searchProvider: 'tavily' });
      expect(response.body.codeEnvironmentDecisionVersion).toBeUndefined();
    });

    it('does not advertise conversation moves unless the effective policy enables them', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.codeEnvironmentMoveVersion).toBeUndefined();
    });

    it('advertises enabled conversation moves regardless of decision activation', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        endpoints: {
          agents: {
            statefulCodeSessions: {
              allowedEnvironments: ['user'],
              conversationMoves: { enabled: true },
            },
          },
        },
      });
      delete process.env.CODE_ENVIRONMENT_DECISION_VERSION;
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.codeEnvironmentDecisionVersion).toBeUndefined();
      expect(response.body.codeEnvironmentMoveVersion).toBe(1);
    });

    it('advertises code environment decisions only after deployment-wide activation', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      process.env.CODE_ENVIRONMENT_DECISION_VERSION = '1';
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.codeEnvironmentDecisionVersion).toBe(1);
    });

    it.each(['0', '2', '1.0', 'true'])(
      'does not advertise unsupported code environment decision version %s',
      async (version) => {
        mockGetAppConfig.mockResolvedValue(baseAppConfig);
        process.env.CODE_ENVIRONMENT_DECISION_VERSION = version;
        const app = createApp(mockUser);

        const response = await request(app).get('/api/config');

        expect(response.body.codeEnvironmentDecisionVersion).toBeUndefined();
      },
    );

    it('should strip private prompt fields from model spec presets', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        modelSpecs: {
          enforce: false,
          prioritize: true,
          list: [
            {
              name: 'guarded-spec',
              label: 'Guarded Spec',
              skills: ['private-skill'],
              preset: {
                endpoint: 'openAI',
                model: 'gpt-4o',
                promptPrefix: 'private prompt prefix',
                instructions: 'private assistant instructions',
                additional_instructions: 'private additional instructions',
                system: 'private bedrock system',
                context: 'private context',
                examples: [{ input: { content: 'a' }, output: { content: 'b' } }],
                greeting: 'Hello',
              },
            },
          ],
        },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(200);
      expect(response.body.modelSpecs.list[0].preset).toEqual({
        endpoint: 'openAI',
        model: 'gpt-4o',
        greeting: 'Hello',
      });
      expect(response.body.modelSpecs.list[0]).not.toHaveProperty('skills');
    });

    it('should include full interface config', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.interface).toEqual(baseAppConfig.interfaceConfig);
    });

    it('delivers the configured steer arm confirmation timeout to authenticated clients', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: {
          ...baseAppConfig.interfaceConfig,
          steerArmConfirmationTimeoutMs: 30_000,
        },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(200);
      expect(response.body.interface.steerArmConfirmationTimeoutMs).toBe(30_000);
    });

    it('should include authenticated-only env var fields', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      process.env.SANDPACK_BUNDLER_URL = 'https://bundler.test';
      process.env.SANDPACK_STATIC_BUNDLER_URL = 'https://static-bundler.test';
      process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES = '5000000';
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.bundlerURL).toBe('https://bundler.test');
      expect(response.body.staticBundlerURL).toBe('https://static-bundler.test');
      expect(response.body.conversationImportMaxFileSize).toBe(5000000);
    });

    it('should advertise Insights only when ENABLE_INSIGHTS is enabled', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(mockUser);

      let response = await request(app).get('/api/config');
      expect(response.body.insightsEnabled).toBe(false);

      process.env.ENABLE_INSIGHTS = 'true';
      response = await request(app).get('/api/config');
      expect(response.body.insightsEnabled).toBe(true);
    });

    it('should advertise Langfuse fanout only when the toggle and collector URL are configured', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      mockHasConfigCapability.mockResolvedValue(true);
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      const app = createApp(mockUser);

      let response = await request(app).get('/api/config');
      expect(response.body.langfuseFanoutEnabled).toBe(false);
      expect(response.body.langfuseConnectionAccess).toBe(true);

      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = '   ';
      response = await request(app).get('/api/config');
      expect(response.body.langfuseFanoutEnabled).toBe(false);
      expect(response.body.langfuseConnectionAccess).toBe(true);

      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout:4318';
      response = await request(app).get('/api/config');
      expect(response.body.langfuseFanoutEnabled).toBe(true);
      expect(response.body.langfuseConnectionAccess).toBe(true);
    });

    it('hides Langfuse connection access when tenant export is emergency-disabled', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      mockHasConfigCapability.mockResolvedValue(true);
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout:4318';
      process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'true';
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.langfuseFanoutEnabled).toBe(true);
      expect(response.body.langfuseConnectionAccess).toBe(false);
      expect(mockHasCapability).not.toHaveBeenCalled();
      expect(mockHasConfigCapability).not.toHaveBeenCalled();
    });

    it('advertises Langfuse connection access from capabilities rather than the user role', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      process.env.TENANT_ISOLATION_STRICT = 'true';
      process.env.LANGFUSE_FANOUT_ENABLED = 'true';
      process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout:4318';
      const app = createApp({ ...mockUser, role: 'DELEGATED_ADMIN' });

      mockHasCapability.mockImplementation(
        async (_user, capability) => capability === 'access:admin',
      );
      mockHasConfigCapability.mockResolvedValue(true);
      let response = await request(app).get('/api/config');
      expect(response.body.langfuseConnectionAccess).toBe(true);

      mockHasConfigCapability.mockResolvedValue(false);
      response = await request(app).get('/api/config');
      expect(response.body.langfuseFanoutEnabled).toBe(true);
      expect(response.body.langfuseConnectionAccess).toBe(false);
    });

    it('skips the Langfuse management capability check without admin access', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(false);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.langfuseConnectionAccess).toBe(false);
      expect(mockHasConfigCapability).not.toHaveBeenCalled();
    });

    it('advertises Langfuse connection access by default in single-tenant mode', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      mockHasConfigCapability.mockResolvedValue(true);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.langfuseFanoutEnabled).toBe(false);
      expect(response.body.langfuseConnectionAccess).toBe(true);
    });

    it('hides single-tenant connection settings when environment credentials are configured', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      mockHasConfigCapability.mockResolvedValue(true);
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
      process.env.LANGFUSE_SECRET_KEY = 'sk-env';
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.langfuseConnectionAccess).toBe(false);
      expect(mockHasCapability).not.toHaveBeenCalled();
      expect(mockHasConfigCapability).not.toHaveBeenCalled();
    });

    it.each([
      ['LANGFUSE_TRACING_ENABLED', 'false'],
      ['LANGFUSE_SAMPLE_RATE', '0'],
    ])('hides Langfuse connection settings when %s=%s', async (key, value) => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      mockHasConfigCapability.mockResolvedValue(true);
      process.env[key] = value;
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.langfuseConnectionAccess).toBe(false);
      expect(mockHasCapability).not.toHaveBeenCalled();
    });

    it('should include post-login informational fields', async () => {
      process.env.ANALYTICS_GTM_ID = 'GTM-XYZ';
      process.env.CUSTOM_FOOTER = 'authenticated footer text';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body).toHaveProperty('helpAndFaqURL');
      expect(response.body).toHaveProperty('sharedLinksEnabled');
      expect(response.body).toHaveProperty('publicSharedLinksEnabled');
      expect(response.body).toHaveProperty('showBirthdayIcon');
      expect(response.body).toHaveProperty('openidReuseTokens');
      expect(response.body.analyticsGtmId).toBe('GTM-XYZ');
      expect(response.body.customFooter).toBe('authenticated footer text');
    });

    it('should advertise CloudFront cookie refresh when signed-cookie mode is active', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetCloudFrontConfig.mockReturnValue({
        domain: 'https://cdn.example.com',
        imageSigning: 'cookies',
        cookieDomain: '.example.com',
        privateKey: 'test-private-key',
        keyPairId: 'K123ABC',
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.cloudFront).toEqual({
        cookieRefresh: {
          endpoint: '/api/auth/cloudfront/refresh',
          domain: 'https://cdn.example.com',
        },
      });
    });

    it('should omit CloudFront cookie refresh when signed-cookie mode is inactive', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetCloudFrontConfig.mockReturnValue({
        domain: 'https://cdn.example.com',
        imageSigning: 'url',
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('cloudFront');
    });

    it('should omit CloudFront cookie refresh when cookie mode cannot mint cookies', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockGetCloudFrontConfig.mockReturnValue({
        domain: 'https://cdn.example.com',
        imageSigning: 'cookies',
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('cloudFront');
    });

    it('should merge per-user balance override into config', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        balance: {
          enabled: true,
          startBalance: 50000,
        },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.balance).toEqual(
        expect.objectContaining({
          enabled: true,
          startBalance: 50000,
        }),
      );
    });

    it('should set allowAccountDeletion to false for authenticated users without ACCESS_ADMIN', async () => {
      process.env.ALLOW_ACCOUNT_DELETION = 'false';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(false);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.allowAccountDeletion).toBe(false);
      expect(mockHasCapability).toHaveBeenCalled();
    });

    it('should enable email changes by default for authenticated users', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.allowEmailChange).toBe(true);
    });

    it('should disable email changes when ALLOW_EMAIL_CHANGE is false', async () => {
      process.env.ALLOW_EMAIL_CHANGE = 'false';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.allowEmailChange).toBe(false);
    });

    it('should override allowAccountDeletion to true for users with ACCESS_ADMIN capability', async () => {
      process.env.ALLOW_ACCOUNT_DELETION = 'false';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.allowAccountDeletion).toBe(true);
      expect(mockHasCapability).toHaveBeenCalled();
    });

    it('should not call hasCapability when allowAccountDeletion is already true', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      process.env.LANGFUSE_TRACING_ENABLED = 'false';
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.allowAccountDeletion).toBe(true);
      expect(mockHasCapability).not.toHaveBeenCalled();
    });

    it('should include adminPanelURL for users with ACCESS_ADMIN capability', async () => {
      process.env.ADMIN_PANEL_URL = 'https://admin.example.com';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.adminPanelURL).toBe('https://admin.example.com');
      expect(mockHasCapability).toHaveBeenCalled();
    });

    it('should omit adminPanelURL for authenticated users without ACCESS_ADMIN', async () => {
      process.env.ADMIN_PANEL_URL = 'https://admin.example.com';
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(false);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('adminPanelURL');
      expect(mockHasCapability).toHaveBeenCalled();
    });

    it('should omit adminPanelURL when ADMIN_PANEL_URL is not set', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockHasCapability.mockResolvedValue(true);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('adminPanelURL');
    });

    it('should return 500 when getAppConfig throws', async () => {
      mockGetAppConfig.mockRejectedValue(new Error('Config service failure'));
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.statusCode).toBe(500);
      expect(response.body).toHaveProperty('error');
      expect(mockGetAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user123', failClosed: true }),
      );
    });
  });

  describe('endpointsDropParamsMap', () => {
    it('maps dropParams for array-configured custom endpoints', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        endpoints: {
          custom: [
            { name: 'custom-provider', dropParams: ['temperature', 'top_p'] },
            { name: 'no-drop-provider' },
          ],
        },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.endpointsDropParamsMap).toEqual({
        'custom-provider': ['temperature', 'top_p'],
      });
    });

    it('normalizes an ollama custom endpoint name to lowercase', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        endpoints: {
          custom: [{ name: 'Ollama', dropParams: ['stop'] }],
        },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.endpointsDropParamsMap).toEqual({ ollama: ['stop'] });
    });

    it('keeps azureOpenAI dropParams model-specific instead of merging across groups', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        endpoints: {
          azureOpenAI: {
            groupMap: {
              groupA: { dropParams: ['temperature'] },
              groupB: { dropParams: ['temperature', 'top_p'] },
            },
            modelGroupMap: {
              'model-a': { group: 'groupA' },
              'model-b': { group: 'groupB' },
            },
          },
        },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.endpointsDropParamsMap.azureOpenAI).toEqual({
        'model-a': ['temperature'],
        'model-b': ['temperature', 'top_p'],
      });
    });

    it('excludes endpoints without dropParams and non-param endpoints like agents', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        endpoints: {
          custom: [{ name: 'no-drop-provider' }],
          azureOpenAI: {
            groupMap: { groupA: {} },
            modelGroupMap: { 'model-a': { group: 'groupA' } },
          },
          agents: [{ name: 'agents-provider', dropParams: ['temperature'] }],
        },
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.endpointsDropParamsMap).toEqual({});
    });

    it('returns an empty map when appConfig has no endpoints', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.endpointsDropParamsMap).toEqual({});
    });
  });

  describe('buildInfo payload', () => {
    const populatedBuildInfo = {
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      commitShort: 'abcdef1',
      branch: 'dev',
      buildDate: '2026-04-20T12:00:00Z',
    };

    it('includes buildInfo in authenticated response when interface flag is not explicitly disabled', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockResolveBuildInfo.mockReturnValue(populatedBuildInfo);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body.buildInfo).toEqual(populatedBuildInfo);
    });

    it('omits buildInfo when interface.buildInfo is false', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: { ...baseAppConfig.interfaceConfig, buildInfo: false },
      });
      mockResolveBuildInfo.mockReturnValue(populatedBuildInfo);
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('buildInfo');
    });

    it('omits buildInfo when all resolver fields are null', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockResolveBuildInfo.mockReturnValue({
        commit: null,
        commitShort: null,
        branch: null,
        buildDate: null,
      });
      const app = createApp(mockUser);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('buildInfo');
    });

    it('includes buildInfo in unauthenticated response when flag is not disabled', async () => {
      mockGetAppConfig.mockResolvedValue(baseAppConfig);
      mockResolveBuildInfo.mockReturnValue(populatedBuildInfo);
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.buildInfo).toEqual(populatedBuildInfo);
    });

    it('omits buildInfo in unauthenticated response when interface.buildInfo is false', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: { ...baseAppConfig.interfaceConfig, buildInfo: false },
      });
      mockResolveBuildInfo.mockReturnValue(populatedBuildInfo);
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body).not.toHaveProperty('buildInfo');
    });

    it('propagates interface.buildInfo=false in unauthenticated response so clients can hide About tab', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: { ...baseAppConfig.interfaceConfig, buildInfo: false },
      });
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.interface).toBeDefined();
      expect(response.body.interface.buildInfo).toBe(false);
    });

    it('does not add interface.buildInfo=true to unauthenticated response (default stays implicit)', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: { privacyPolicy: { externalUrl: 'https://x' }, buildInfo: true },
      });
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.interface).toBeDefined();
      expect(response.body.interface).not.toHaveProperty('buildInfo');
    });

    it('includes interface block with only buildInfo=false when nothing else is set', async () => {
      mockGetAppConfig.mockResolvedValue({
        ...baseAppConfig,
        interfaceConfig: { buildInfo: false },
      });
      const app = createApp(null);

      const response = await request(app).get('/api/config');

      expect(response.body.interface).toEqual({ buildInfo: false });
    });
  });
});

describe('passkey enrollment cap', () => {
  it('publishes the cap normalized from YAML only after authentication', async () => {
    const { AppService } = require('@librechat/data-schemas');
    const appConfig = await AppService({ config: { passkeys: { perUserMax: 2 } } });
    mockGetAppConfig.mockResolvedValue(appConfig);

    const authenticated = await request(createApp(mockUser)).get('/api/config');
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.maxPasskeysPerUser).toBe(2);
    expect(mockGetAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: mockUser.id, role: mockUser.role }),
    );

    const anonymous = await request(createApp()).get('/api/config');
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).not.toHaveProperty('maxPasskeysPerUser');
  });
});
