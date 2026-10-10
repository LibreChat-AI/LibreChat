import type { ScheduledMCPResourceBinding } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';
import { getScheduledMCPConfigurationRevision } from './configuration';

const binding: ScheduledMCPResourceBinding = {
  url: 'https://warehouse.example/mcp',
  credentialMode: 'resource_bearer',
  issuer: 'https://issuer.example/',
  audience: 'warehouse',
  scopes: ['read'],
};
const config: Extract<ParsedServerConfig, { type: 'http' | 'streamable-http' }> = {
  type: 'streamable-http',
  url: binding.url,
  headers: { 'X-Workspace': 'catalog', Accept: 'application/json' },
  requestHeaders: { 'X-Workspace': 'chat', 'X-Account': 'account-1' },
  proxy: 'http://proxy-a.example/',
  dbId: 'server-1',
  source: 'config',
  author: 'author-1',
  oauth: {
    authorization_url: 'https://issuer.example/authorize',
    token_url: 'https://issuer.example/token',
    client_id: 'client-1',
    client_secret: 'fixture-secret',
    scope: 'read',
    audience: 'warehouse',
  },
  oauth_headers: { 'X-Authorization-Tenant': 'tenant-1' },
  apiKey: {
    source: 'admin',
    authorization_type: 'custom',
    custom_header: 'X-Api-Key',
    key: 'fixture-key',
  },
};

it.each<Partial<Extract<ParsedServerConfig, { type: 'http' | 'streamable-http' }>>>([
  { headers: { ...config.headers, 'X-Workspace': 'catalog-2' } },
  { requestHeaders: { ...config.requestHeaders, 'X-Workspace': 'chat-2' } },
  { proxy: 'http://proxy-b.example/' },
  { dbId: 'server-2' },
  { source: 'user' },
  { author: 'author-2' },
  { oauth: { ...config.oauth, audience: 'other-recipient' } },
  { oauth: { ...config.oauth, scope: 'read write' } },
  { oauth_headers: { 'X-Authorization-Tenant': 'tenant-2' } },
  { apiKey: { ...config.apiKey!, custom_header: 'X-Other-Key' } },
])('changes the consent fence for changed routing or trust: %j', (change) => {
  expect(getScheduledMCPConfigurationRevision({ ...config, ...change }, binding)).not.toBe(
    getScheduledMCPConfigurationRevision(config, binding),
  );
});

it('does not collapse catalog routing into request-header overrides', () => {
  const first = {
    ...config,
    headers: { 'X-Workspace': 'catalog-1' },
    requestHeaders: { 'X-Workspace': 'chat' },
  };
  expect(getScheduledMCPConfigurationRevision(first, binding)).not.toBe(
    getScheduledMCPConfigurationRevision(
      { ...first, headers: { 'X-Workspace': 'catalog-2' } },
      binding,
    ),
  );
});

it('canonicalizes map order and scope sets without widening a recipient', () => {
  const reordered = {
    ...config,
    headers: { Accept: 'application/json', 'X-Workspace': 'catalog' },
    requestHeaders: { 'X-Account': 'account-1', 'X-Workspace': 'chat' },
    oauth: Object.fromEntries(Object.entries(config.oauth!).reverse()),
  };
  expect(
    getScheduledMCPConfigurationRevision(reordered, { ...binding, scopes: ['read', 'read'] }),
  ).toBe(getScheduledMCPConfigurationRevision(config, binding));
});

it('excludes rotating client/API secrets and display/inspection bookkeeping', () => {
  expect(
    getScheduledMCPConfigurationRevision(
      {
        ...config,
        oauth: { ...config.oauth, client_secret: 'rotated-fixture-secret' },
        apiKey: { ...config.apiKey!, key: 'rotated-fixture-key' },
        title: 'A new title',
        description: 'A new description',
        updatedAt: 2000,
        resolvedInstructions: 'A new inspection result',
      },
      binding,
    ),
  ).toBe(getScheduledMCPConfigurationRevision(config, binding));
});

it('fences effective operator routing across environment changes', () => {
  const variable = 'LC_SCHEDULE_CONSENT_ROUTE_FIXTURE';
  const previous = process.env[variable];
  const declared: ParsedServerConfig = {
    ...config,
    dbId: undefined,
    source: 'yaml',
    headers: { 'X-Workspace': `\${${variable}}` },
    requestHeaders: { 'X-Workspace': `\${${variable}}` },
  };
  try {
    process.env[variable] = 'workspace-a';
    const before = getScheduledMCPConfigurationRevision(declared, binding);
    process.env[variable] = 'workspace-b';
    expect(getScheduledMCPConfigurationRevision(declared, binding)).not.toBe(before);
    expect(declared.headers).toEqual({ 'X-Workspace': `\${${variable}}` });
    expect(declared.requestHeaders).toEqual({ 'X-Workspace': `\${${variable}}` });
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

it('preserves literal templates for DB/plugin sources rather than reading host environment', () => {
  const variable = 'LC_SCHEDULE_CONSENT_LITERAL_FIXTURE';
  const previous = process.env[variable];
  try {
    for (const source of ['user', 'plugin'] as const) {
      const declared: ParsedServerConfig = {
        type: 'streamable-http',
        url: binding.url,
        source,
        dbId: source === 'user' ? 'server-1' : undefined,
        headers: { 'X-Workspace': `\${${variable}}` },
      };
      process.env[variable] = 'workspace-a';
      const before = getScheduledMCPConfigurationRevision(declared, binding);
      process.env[variable] = 'workspace-b';
      expect(getScheduledMCPConfigurationRevision(declared, binding)).toBe(before);
    }
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

it.each(['headers', 'requestHeaders', 'oauth_headers'] as const)(
  'refuses unresolved custom routing in %s rather than hashing an unbound template',
  (field) => {
    expect(() =>
      getScheduledMCPConfigurationRevision(
        {
          ...config,
          [field]: { 'X-Workspace': '{{WORKSPACE}}' },
          customUserVars: {
            WORKSPACE: { title: 'Workspace', description: 'Routing recipient', sensitive: false },
          },
        },
        binding,
      ),
    ).toThrow('consent_unavailable');
  },
);
it('refuses dynamic user/body routing and custom placeholders in authorization headers', () => {
  for (const template of [
    '{{LIBRECHAT_USER_EMAIL}}',
    '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    '{{WORKSPACE}}',
  ]) {
    expect(() =>
      getScheduledMCPConfigurationRevision(
        { ...config, headers: { 'X-Workspace': template } },
        binding,
      ),
    ).toThrow('consent_unavailable');
    expect(() =>
      getScheduledMCPConfigurationRevision(
        { ...config, headers: { Authorization: `Bearer ${template}` } },
        binding,
      ),
    ).toThrow('consent_unavailable');
  }
});
it('refuses routing templates introduced by operator environment resolution', () => {
  const variable = 'LC_CONSENT_UNBOUND_ROUTE_FIXTURE';
  const previous = process.env[variable];
  try {
    process.env[variable] = '{{WORKSPACE}}';
    expect(() =>
      getScheduledMCPConfigurationRevision(
        {
          ...config,
          dbId: undefined,
          source: 'yaml',
          headers: { 'X-Workspace': `\${${variable}}` },
        },
        binding,
      ),
    ).toThrow('consent_unavailable');
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});
it('preserves literal-source resource and OAuth URLs across replica environment changes', () => {
  const variable = 'LC_CONSENT_LITERAL_URL_FIXTURE';
  const previous = process.env[variable];
  try {
    for (const source of ['user', 'plugin'] as const) {
      const declared: ParsedServerConfig = {
        type: 'streamable-http',
        url: `https://warehouse.example/\${${variable}}`,
        dbId: source === 'user' ? 'server' : undefined,
        source,
        proxy: `http://proxy.example/\${${variable}}`,
        oauth: {
          authorization_url: `https://issuer.example/\${${variable}}/authorize`,
          token_url: `https://issuer.example/\${${variable}}/token`,
        },
      };
      process.env[variable] = 'one';
      const before = getScheduledMCPConfigurationRevision(declared, {
        ...binding,
        url: declared.url!,
      });
      process.env[variable] = 'two';
      expect(
        getScheduledMCPConfigurationRevision(declared, { ...binding, url: declared.url! }),
      ).toBe(before);
      expect(declared.url).toContain(`\${${variable}}`);
    }
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});
it('keeps plugin custom templates literal because their runtime never substitutes them', () => {
  const literal = {
    ...config,
    source: 'plugin' as const,
    headers: { 'X-Workspace': '{{WORKSPACE}}' },
  };
  expect(getScheduledMCPConfigurationRevision(literal, binding)).toMatch(/^[a-f0-9]{64}$/);
});
