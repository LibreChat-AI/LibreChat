import {
  sanitizeTelemetryUrl,
  sanitizeSpanAttributes,
  sanitizeReplayEvent,
  isReplayRouteAllowed,
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
