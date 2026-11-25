import {
  sanitizeTelemetryUrl,
  sanitizeSpanAttributes,
  sanitizeReplayEvent,
  isReplayRouteAllowed,
  isCredentialRequest,
} from './privacy';

const secret = 'synthetic-login-token-do-not-export';
const url = `https://alice:${secret}@librechat.example/c/new?tempToken=${secret}#${secret}`;

it.each([
  '/login',
  '/login/2fa',
  '/login/2fa/setup',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify',
  '/oauth/success',
  '/',
  '/app/login/2fa',
  '/LOGIN/2fa',
  '/%6cogin/2fa',
])('excludes the authentication route %s', (pathname) => {
  expect(isReplayRouteAllowed(pathname)).toBe(false);
});

it('keeps chat and other ordinary application routes recordable', () => {
  expect(isReplayRouteAllowed('/c/new')).toBe(true);
  expect(isReplayRouteAllowed('/search')).toBe(true);
});

it('strips credentials, query strings and fragments without changing useful URL paths', () => {
  expect(sanitizeTelemetryUrl(url)).toBe('https://librechat.example/c/new');
  expect(sanitizeTelemetryUrl(`/c/new?tempToken=${secret}#${secret}`)).toBe('/c/new');
  expect(sanitizeTelemetryUrl(`assets/image.png?token=${secret}`)).toBe('assets/image.png');
  expect(sanitizeTelemetryUrl(`//cdn.example/image.png?token=${secret}`)).toBe(
    '//cdn.example/image.png',
  );
  expect(sanitizeTelemetryUrl(`javascript:${secret}`)).toBe('[redacted]');
  expect(sanitizeTelemetryUrl(`data:text/html,${secret}`)).toBe('[redacted]');
});

it('sanitizes recorder metadata before it can enter the SDK queue', () => {
  const event = sanitizeReplayEvent(
    { type: 4, timestamp: 1, data: { href: url, width: 1200, height: 800 } },
    '/c/new',
  );
  expect(event).toMatchObject({ type: 4, data: { href: 'https://librechat.example/c/new' } });
  expect(JSON.stringify(event)).not.toContain(secret);
});

it('drops auth-screen metadata and snapshots even during a route/effect race', () => {
  const authUrl = `https://librechat.example/login/2fa?tempToken=${secret}`;
  expect(
    sanitizeReplayEvent(
      { type: 4, timestamp: 1, data: { href: authUrl, width: 1, height: 1 } },
      '/c/new',
    ),
  ).toEqual({ type: 0, timestamp: 1, data: {} });
  const event = sanitizeReplayEvent(
    {
      type: 2,
      timestamp: 2,
      data: {
        initialOffset: { top: 0, left: 0 },
        node: { type: 0, id: 1, childNodes: [{ type: 3, id: 2, textContent: secret }] },
      },
    },
    '/login/2fa',
  );
  expect(event).toEqual({ type: 0, timestamp: 2, data: {} });
});

it('sanitizes URL attributes and CSS in the complete DOM snapshot', () => {
  const event = sanitizeReplayEvent(
    {
      type: 2,
      timestamp: 1,
      data: {
        initialOffset: { top: 0, left: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'a',
              attributes: {
                href: url,
                'data-url': `/relative?tempToken=${secret}`,
                'data-src': url,
                srcset: `${url} 1x, /image.png?token=${secret} 2x`,
                style: `background:url('/image.png?token=${secret}')`,
                srcdoc: secret,
              },
              childNodes: [
                { type: 3, id: 3, isStyle: true, textContent: `a { background: url('${url}') }` },
              ],
            },
          ],
        },
      },
    },
    '/c/new',
  );
  expect(JSON.stringify(event)).not.toContain(secret);
  expect(JSON.stringify(event)).toContain('https://librechat.example/c/new');
});

it('sanitizes newly inserted nodes and attribute mutations', () => {
  const event = sanitizeReplayEvent(
    {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        adds: [
          {
            parentId: 1,
            nextId: null,
            node: { type: 2, id: 2, tagName: 'img', attributes: { src: url }, childNodes: [] },
          },
        ],
        removes: [],
        texts: [],
        attributes: [{ id: 3, attributes: { href: url, src: null } }],
      },
    },
    '/c/new',
  );
  expect(JSON.stringify(event)).not.toContain(secret);
});

it('sanitizes structured style mutations, CSSOM rules and declaration updates', () => {
  const mutation = sanitizeReplayEvent(
    {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        adds: [],
        removes: [],
        texts: [{ id: 1, value: null }],
        attributes: [
          {
            id: 2,
            attributes: {
              style: {
                background: `url('${url}')`,
                'background-image': [`url('${url}')`, 'important'],
                color: false,
              },
            },
          },
        ],
      },
    },
    '/c/new',
  );
  const rule = sanitizeReplayEvent(
    {
      type: 3,
      timestamp: 1,
      data: { source: 8, id: 1, adds: [{ rule: `a { background: url('${url}') }` }] },
    },
    '/c/new',
  );
  const declaration = sanitizeReplayEvent(
    {
      type: 3,
      timestamp: 1,
      data: {
        source: 13,
        id: 1,
        index: [0],
        set: { property: 'background', value: `url('${url}')`, priority: 'important' },
      },
    },
    '/c/new',
  );
  expect(JSON.stringify([mutation, rule, declaration])).not.toContain(secret);
});

it('sanitizes SDK document/referrer/network span attributes and standalone query values', () => {
  const attributes = sanitizeSpanAttributes({
    'location.href': url,
    'document.referrer': url,
    'http.url': url,
    'http.target': `/api/check?token=${secret}`,
    'url.query': `token=${secret}`,
    'url.fragment': secret,
    urls: [url],
    message: `failed resource ${url}`,
    count: 3,
  });
  expect(JSON.stringify(attributes)).not.toContain(secret);
  expect(attributes).toMatchObject({
    'location.href': 'https://librechat.example/c/new',
    'http.target': '/api/check',
    'url.query': '',
    'url.fragment': '',
    count: 3,
  });
});

it.each(['request', 'response'])(
  'drops %s credential headers in string and array form',
  (direction) => {
    const headers = [
      'authorization',
      'Authorization',
      'proxy-authorization',
      'proxy_authorization',
      'cookie',
      'set-cookie',
      'Set_Cookie',
      'api-key',
      'api_key',
      'apikey',
      'X-API-Key',
      'X_HDX_API_KEY',
      'token',
      'x-access-token',
      'X_Refresh_Token',
      'x-amz-security-token',
      'signature',
      'X-Signature',
      'signature-input',
    ];
    for (const header of headers) {
      for (const value of [secret, [secret]]) {
        const key = `http.${direction}.header.${header}`;
        const source = { [key]: value, 'http.status_code': 200 };
        expect(sanitizeSpanAttributes(source)).toEqual({ 'http.status_code': 200 });
        expect(source[key]).toEqual(value);
      }
    }
  },
);

it('checks header names before URL redaction and preserves ordinary attributes', () => {
  expect(
    sanitizeSpanAttributes({
      'HTTP.REQUEST.HEADER.Authorization': secret,
      'http.response.header.x_token_url': secret,
      'http.request.header.content_type': ['application/json'],
      'http.response.header.x_request_id': ['request-123'],
      'http.response.header.location': [url],
      'http.method': 'POST',
      'gen_ai.usage.input_tokens': 10,
      count: 3,
    }),
  ).toEqual({
    'http.request.header.content_type': ['application/json'],
    'http.response.header.x_request_id': ['request-123'],
    'http.response.header.location': ['https://librechat.example/c/new'],
    'http.method': 'POST',
    'gen_ai.usage.input_tokens': 10,
    count: 3,
  });
});

it.each([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/resetPassword',
  '/api/auth/2fa/setup/confirm',
  '/api/auth/passkey/login/verify',
  '/api/auth/graph-token',
  '/oauth/openid/callback',
  '/oauth/saml/callback',
  '/api/user/verify',
  '/api/user/verify/resend',
  '/api/user/email/change',
  '/api/user/email/verify',
  '/api/user/delete',
  '/api/user/plugins',
  '/api/keys',
  '/api/api-keys',
  '/api/mcp/oauth/tokens/flow-123',
  '/api/mcp/server-123/oauth/bind',
  '/api/mcp/server-123/oauth/callback',
  '/api/mcp/servers',
  '/api/mcp/servers/server-123',
  '/api/agents/actions/agent-123',
  '/api/assistants/v1/actions/assistant-123',
  '/api/assistants/v2/actions/assistant-123',
  '/api/actions/action-123/oauth/callback',
  '/api/pull-requests/oauth/connect',
  '/api/admin/login/local',
  '/api/admin/oauth/exchange',
  '/api/admin/oauth/refresh',
  '/api/admin/config/user/user-123/fields',
  '/api/admin/config/tenant/tenant-123/changes',
  '/api/admin/langfuse/connection',
  '/api/admin/langfuse/connection/test',
  '/api/admin/skills/sync/credentials/github',
  '/api/admin/code-environments/worker-123/pairings',
  '/api/code-environments/pairings',
  '/api/code-environments/setup/complete',
  '/api/channels/workspaces/apps',
  '/api/channels/workspaces/connect',
  '/api/channels/workspaces/oauth/callback',
  '/api/channels/links/preview',
  '/api/channels/links/accept',
  '/api/agents/agent-123/channels/channel-123',
  '/app/api/auth/refresh',
  '/app/oauth/openid/callback',
  '/proxy/api/app/oauth/openid/callback',
  '/oauth/google',
  '/oauth/facebook/callback',
  '/oauth/github/callback',
  '/oauth/discord/callback',
  '/oauth/apple/callback',
  '/app/%61pi/auth/refresh',
  '/app/api%2fauth%2frefresh',
  '/API/Auth/Refresh/',
  '/api/auth/%ZZ',
])('removes credential request and response bodies for %s', (pathname) => {
  const requestUrl = `https://librechat.example${pathname}?retry=true#fragment`;
  for (const body of [secret, [secret]]) {
    const source = Object.freeze({
      'http.url': requestUrl,
      'http.method': 'POST',
      'http.status_code': 200,
      'http.request.body': body,
      'http.response.body': body,
      'http.request.header.content_type': ['application/json'],
    });
    expect(isCredentialRequest(source)).toBe(true);
    expect(sanitizeSpanAttributes(source)).toEqual({
      'http.url': `https://librechat.example${pathname}`,
      'http.method': 'POST',
      'http.status_code': 200,
      'http.request.header.content_type': ['application/json'],
    });
    expect(source['http.request.body']).toEqual(body);
    expect(source['http.response.body']).toEqual(body);
  }
});

it.each([
  '/api/agents/chat',
  '/api/messages',
  '/api/user',
  '/api/user/preferences',
  '/api/user/settings/favorites',
  '/api/mcp/tools',
  '/api/mcp/resources/read',
  '/api/mcp/server-123/auth-values',
  '/api/mcp/server-123/reinitialize',
  '/api/admin/users',
  '/api/admin/roles',
  '/api/admin/langfuse/prompts',
  '/api/admin/skills/sync/run',
  '/api/code-environments',
  '/api/code-environments/worker-123/status',
  '/api/code-environments/setup/attempt-123/approve',
  '/api/agents/agent-123/channels/channel-123/workspace-routes',
  '/api/channels/workspaces/workspace-123/managers',
  '/api/channels/links',
  '/api/authors',
  '/api/keys-export',
  '/api/user/pluginsettings',
  '/api/mcp/servers-list',
  '/api/agents/actions-report',
  '/api/pull-requests/oauth-status',
  '/oauth-status',
  '/app/api/authors?next=/api/auth/refresh',
  '/app/api/messages#/api/auth/refresh',
])('preserves opted-in ordinary request bodies for %s', (pathname) => {
  const source = {
    'http.url': `https://librechat.example${pathname}`,
    'location.href': 'https://librechat.example/login',
    'http.request.body': 'ordinary prompt',
    'http.response.body': ['ordinary response'],
    'http.status_code': 200,
  };
  expect(isCredentialRequest(source)).toBe(false);
  expect(sanitizeSpanAttributes(source)).toMatchObject({
    'http.request.body': 'ordinary prompt',
    'http.response.body': ['ordinary response'],
    'http.status_code': 200,
  });
});

it('propagates credential body removal to attribute bags without a request URL', () => {
  const source = Object.freeze({
    'HTTP.REQUEST.BODY': secret,
    'http.response.body': [secret],
    'http.response.body.size': 123,
    'http.status_code': 200,
  });
  expect(sanitizeSpanAttributes(source, true)).toEqual({
    'http.response.body.size': 123,
    'http.status_code': 200,
  });
  expect(source['HTTP.REQUEST.BODY']).toBe(secret);
  expect(source['http.response.body']).toEqual([secret]);
  expect(sanitizeSpanAttributes(source)).toEqual(source);
});

it('uses relative request URLs and ignores page, referrer, missing and invalid URL attributes', () => {
  expect(isCredentialRequest({ 'http.url': '/app/api/auth/refresh?retry=true' })).toBe(true);
  expect(isCredentialRequest({ 'http.url': 'api/auth/refresh' })).toBe(true);
  expect(isCredentialRequest({ 'http.url': 'http://[invalid' })).toBe(false);
  expect(isCredentialRequest({ 'http.url': ['/api/auth/refresh'] })).toBe(false);
  expect(
    isCredentialRequest({
      'location.href': '/api/auth/refresh',
      'document.referrer': '/api/auth/refresh',
    }),
  ).toBe(false);
  expect(isCredentialRequest({})).toBe(false);
});
