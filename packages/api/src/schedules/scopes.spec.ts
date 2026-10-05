import jwt from 'jsonwebtoken';
import {
  hasScheduledOboScopeBinding,
  readScheduledOboScopeBinding,
  resolveScheduledOboScopes,
} from './scopes';

const authority = {
  issuer: 'https://login.microsoftonline.com/test-tenant/v2.0',
  tokenEndpoint: 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
};
const requested = 'api://resource/.default';
const binding = {
  version: 1 as const,
  resource: 'api://resource',
  permissions: ['Files.Read', 'Files.Write'],
};

it('binds concrete delegated permissions rather than expecting the default selector in the response', () => {
  expect(
    resolveScheduledOboScopes(
      { scope: 'api://resource/Files.Write api://resource/Files.Read offline_access' },
      requested,
      authority,
    ),
  ).toEqual({ ok: true, binding });
  expect(
    resolveScheduledOboScopes({ scope: 'Files.Read Files.Write' }, requested, authority),
  ).toEqual({ ok: true, binding });
});

it.each([
  ['Files.Write Files.Read', true],
  ['api://resource/Files.Read api://resource/Files.Write', true],
  ['Files.Read Files.Write Files.List', true],
  ['Files.Read', false],
  ['openid offline_access', false],
  ['api://other/Files.Read api://resource/Files.Write', false],
  ['api://resource/.default', false],
  ['', false],
])('checks returned concrete scope %s against the enrolled permissions', (scope, valid) => {
  expect(resolveScheduledOboScopes({ scope }, requested, authority, binding).ok).toBe(valid);
});

it('rejects selector/dynamic mixes, unknown providers and cross-resource stored bindings', () => {
  expect(
    resolveScheduledOboScopes({ scope: 'Files.Read' }, `${requested} Files.Read`, authority).ok,
  ).toBe(false);
  expect(resolveScheduledOboScopes({ scope: 'User.Read' }, '.default', authority).ok).toBe(false);
  expect(
    resolveScheduledOboScopes({ scope: 'Files.Read' }, requested, {
      ...authority,
      issuer: 'https://login.example.test/tenant',
    }).ok,
  ).toBe(false);
  expect(
    resolveScheduledOboScopes({ scope: 'Files.Read' }, requested, {
      ...authority,
      tokenEndpoint: 'https://other.example.test/token',
    }).ok,
  ).toBe(false);
  expect(
    resolveScheduledOboScopes({ scope: 'Files.Read' }, requested, authority, {
      ...binding,
      resource: 'api://other',
    }).ok,
  ).toBe(false);
});

it('uses a resource-bound provider JWT projection when initial scope is omitted', () => {
  const access_token = jwt.sign(
    { aud: 'api://resource', scp: 'Files.Write Files.Read' },
    'test-only-signing-key',
  );
  expect(resolveScheduledOboScopes({ access_token }, requested, authority)).toEqual({
    ok: true,
    binding,
  });
  const wrong = jwt.sign(
    { aud: 'api://other', scp: 'Files.Read Files.Write' },
    'test-only-signing-key',
  );
  expect(resolveScheduledOboScopes({ access_token: wrong }, requested, authority).ok).toBe(false);
  expect(
    resolveScheduledOboScopes({ access_token: 'opaque-with-no-scope' }, requested, authority).ok,
  ).toBe(false);
});

it('supports the Entra API application-ID audience form without accepting another application', () => {
  const resource = 'api://11111111-2222-3333-4444-555555555555';
  const access_token = jwt.sign({ aud: resource.slice(6), scp: 'read' }, 'test-only-signing-key');
  expect(resolveScheduledOboScopes({ access_token }, `${resource}/.default`, authority)).toEqual({
    ok: true,
    binding: { version: 1, resource, permissions: ['read'] },
  });
});

it('does not override an explicit narrower response using wider JWT claims', () => {
  const access_token = jwt.sign(
    { aud: 'api://resource', scp: 'Files.Read Files.Write' },
    'test-only-signing-key',
  );
  expect(
    resolveScheduledOboScopes({ access_token, scope: 'Files.Read' }, requested, authority, binding)
      .ok,
  ).toBe(false);
});

it('retains established consent on opaque scope omission, but detects narrowing in a resource JWT projection', () => {
  expect(
    resolveScheduledOboScopes({ access_token: 'opaque' }, requested, authority, binding),
  ).toEqual({ ok: true, binding });
  const access_token = jwt.sign(
    { aud: 'api://resource', scp: 'Files.Read' },
    'test-only-signing-key',
  );
  expect(resolveScheduledOboScopes({ access_token }, requested, authority, binding).ok).toBe(false);
});

it('keeps literal-scope behavior separate and refuses absent or malformed selector bindings', () => {
  expect(
    resolveScheduledOboScopes({ scope: 'read write' }, 'read', {
      issuer: 'https://other.test',
      tokenEndpoint: 'https://other.test/token',
    }),
  ).toEqual({ ok: true });
  expect(resolveScheduledOboScopes({ scope: 'read' }, 'read write', authority).ok).toBe(false);
  expect(resolveScheduledOboScopes({}, 'read write', authority).ok).toBe(true);
  expect(hasScheduledOboScopeBinding(requested, authority)).toBe(false);
  expect(hasScheduledOboScopeBinding(requested, authority, binding)).toBe(true);
  expect(
    hasScheduledOboScopeBinding(requested, authority, {
      ...binding,
      permissions: ['api://other/read'],
    }),
  ).toBe(false);
  expect(
    readScheduledOboScopeBinding({ version: 1, resource: 'api://resource', permissions: [] }),
  ).toBeUndefined();
});

it.each(['login.microsoftonline.com', 'login.microsoftonline.us', 'login.chinacloudapi.cn'])(
  'recognizes selector semantics only on matched %s issuer/token authorities',
  (host) => {
    const metadata = {
      issuer: `https://${host}/tenant/v2.0`,
      tokenEndpoint: `https://${host}/tenant/oauth2/v2.0/token`,
    };
    expect(resolveScheduledOboScopes({ scope: 'Files.Read' }, requested, metadata).ok).toBe(true);
    expect(
      resolveScheduledOboScopes({ scope: 'Files.Read' }, requested, {
        ...metadata,
        tokenEndpoint: 'https://login.other.test/token',
      }).ok,
    ).toBe(false);
  },
);

it('recognizes the Entra v1 issuer without confusing it with a different cloud', () => {
  expect(
    resolveScheduledOboScopes({ scope: 'User.Read' }, 'https://graph.microsoft.com/.default', {
      ...authority,
      issuer: 'https://sts.windows.net/tenant/',
    }).ok,
  ).toBe(true);
  expect(
    resolveScheduledOboScopes({ scope: 'User.Read' }, 'https://graph.microsoft.com/.default', {
      issuer: 'https://sts.windows.net/tenant/',
      tokenEndpoint: 'https://login.chinacloudapi.cn/tenant/oauth2/v2.0/token',
    }).ok,
  ).toBe(false);
});

it('preserves a resource identifier trailing slash while normalizing its qualified permission names', () => {
  expect(
    resolveScheduledOboScopes(
      { scope: 'https://database.windows.net/user_impersonation' },
      'https://database.windows.net//.default',
      authority,
    ),
  ).toEqual({
    ok: true,
    binding: {
      version: 1,
      resource: 'https://database.windows.net/',
      permissions: ['user_impersonation'],
    },
  });
  expect(
    resolveScheduledOboScopes(
      { scope: 'https://database.windows.net.evil/user_impersonation' },
      'https://database.windows.net//.default',
      authority,
    ).ok,
  ).toBe(false);
  expect(hasScheduledOboScopeBinding(requested, authority, { ...binding, permissions: [] })).toBe(
    false,
  );
});

it('does not use an unrecognized audience alias to remap stored consent, and denies an observable app-only projection', () => {
  const access_token = jwt.sign(
    { aud: 'api://other', scp: 'Files.Read Files.Write' },
    'test-only-signing-key',
  );
  expect(resolveScheduledOboScopes({ access_token }, requested, authority, binding)).toEqual({
    ok: true,
    binding,
  });
  const appOnly = jwt.sign(
    { aud: 'api://resource', roles: ['Files.Read', 'Files.Write'] },
    'test-only-signing-key',
  );
  expect(
    resolveScheduledOboScopes({ access_token: appOnly }, requested, authority, binding).ok,
  ).toBe(false);
});

it('preserves an enrolled resource permission set on scope omission even when JWT audience aliases cannot be inferred', () => {
  const authority = {
    issuer: 'https://login.microsoftonline.com/tenant/v2.0',
    tokenEndpoint: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
  };
  const binding = {
    version: 1 as const,
    resource: 'api://custom-api',
    permissions: ['Files.Read'],
  };
  const access_token = jwt.sign(
    { aud: '11111111-2222-3333-4444-555555555555', scp: 'Files.Read' },
    'test-only',
  );
  expect(
    resolveScheduledOboScopes({ access_token }, 'api://custom-api/.default', authority, binding),
  ).toEqual({ ok: true, binding });
});

it('keeps unknown providers on exact literal scope validation, never treating default as a wildcard', () => {
  const custom = {
    issuer: 'https://login.example.test/tenant',
    tokenEndpoint: 'https://login.example.test/token',
  };
  expect(
    resolveScheduledOboScopes({ scope: 'api://resource/.default' }, requested, custom),
  ).toEqual({ ok: true });
  expect(resolveScheduledOboScopes({ scope: 'Files.Read' }, requested, custom)).toEqual({
    ok: false,
  });
  expect(hasScheduledOboScopeBinding(requested, custom)).toBe(true);
});
