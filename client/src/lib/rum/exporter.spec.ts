import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { PrivacyTraceExporter } from './exporter';

it('sanitizes the actual span export boundary, including events, resources and links, without changing the source span', () => {
  const secret = 'fake-login-token-do-not-export';
  const url = `https://user:${secret}@app.example/login/2fa?tempToken=${secret}#${secret}`;
  const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 };
  const span: ReadableSpan = {
    name: `GET ${url}`,
    kind: 0,
    spanContext: () => context,
    startTime: [1, 0],
    endTime: [2, 0],
    duration: [1, 0],
    ended: true,
    status: { code: 2, message: `failed ${url}` },
    attributes: { 'location.href': url, 'http.request.header.authorization': [`Bearer ${secret}`] },
    resource: resourceFromAttributes({
      'service.name': 'librechat-web',
      'page.url': url,
      'http.response.header.set_cookie': [`session=${secret}`],
    }),
    instrumentationScope: { name: 'test' },
    events: [
      {
        name: 'exception',
        time: [2, 0],
        attributes: {
          'exception.stacktrace': `at ${url}`,
          'http.request.header.x_api_key': secret,
        },
      },
    ],
    links: [
      { context, attributes: { 'http.url': url, 'http.response.header.x_access_token': [secret] } },
    ],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
  const exportSpans = jest.fn<
    ReturnType<SpanExporter['export']>,
    Parameters<SpanExporter['export']>
  >();
  const exporter: SpanExporter = {
    export: exportSpans,
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
  new PrivacyTraceExporter(exporter).export([span], jest.fn());
  const safe = exportSpans.mock.calls[0][0][0];
  expect(JSON.stringify(safe)).not.toContain(secret);
  expect(JSON.stringify(safe)).not.toMatch(/authorization|set_cookie|x_api_key|x_access_token/);
  expect(span.attributes['http.request.header.authorization']).toEqual([`Bearer ${secret}`]);
  expect(span.resource.attributes['http.response.header.set_cookie']).toEqual([
    `session=${secret}`,
  ]);
  expect(span.events[0].attributes?.['http.request.header.x_api_key']).toBe(secret);
  expect(span.links[0].attributes?.['http.response.header.x_access_token']).toEqual([secret]);
  expect(safe.spanContext()).toEqual(context);
  expect(safe.attributes['location.href']).toBe('https://app.example/login/2fa');
  expect(safe.resource.attributes['service.name']).toBe('librechat-web');
  expect(span.attributes['location.href']).toBe(url);
});

it.each([
  ['/api/auth/refresh', true],
  ['/librechat/api/mcp/oauth/tokens/flow-123', true],
  ['/api/keys', true],
  ['/api/messages', false],
])('applies the body policy to every attribute bag for %s', (path, sensitive) => {
  const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 };
  const bodies = {
    'http.request.body': '{"secret":"synthetic-request-credential"}',
    'http.response.body': ['{"token":"synthetic-response-credential"}'],
  };
  const span: ReadableSpan = {
    name: 'HTTP POST',
    kind: 2,
    spanContext: () => context,
    startTime: [1, 0],
    endTime: [2, 0],
    duration: [1, 0],
    ended: true,
    status: { code: 0 },
    attributes: {
      ...bodies,
      'http.url': `https://app.example${path}?ignored=query`,
      'http.method': 'POST',
      'http.status_code': 200,
    },
    resource: resourceFromAttributes({ 'service.name': 'librechat-web', ...bodies }),
    instrumentationScope: { name: 'test' },
    events: [{ name: 'network', time: [2, 0], attributes: { ...bodies } }],
    links: [{ context, attributes: { ...bodies } }],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
  const original = JSON.stringify({ ...span, resource: span.resource.attributes });
  const exportSpans = jest.fn<
    ReturnType<SpanExporter['export']>,
    Parameters<SpanExporter['export']>
  >();
  const exporter: SpanExporter = {
    export: exportSpans,
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
  new PrivacyTraceExporter(exporter).export([span], jest.fn());
  const safe = exportSpans.mock.calls[0][0][0];
  for (const attributes of [
    safe.attributes,
    safe.resource.attributes,
    safe.events[0].attributes,
    safe.links[0].attributes,
  ]) {
    if (sensitive) {
      expect(attributes).not.toHaveProperty('http.request.body');
      expect(attributes).not.toHaveProperty('http.response.body');
      expect(JSON.stringify(attributes)).not.toContain('synthetic-request-credential');
      expect(JSON.stringify(attributes)).not.toContain('synthetic-response-credential');
    } else {
      expect(attributes).toMatchObject(bodies);
    }
  }
  expect(safe.attributes).toMatchObject({
    'http.url': `https://app.example${path}`,
    'http.method': 'POST',
    'http.status_code': 200,
  });
  expect(safe.resource.attributes['service.name']).toBe('librechat-web');
  expect(safe.spanContext()).toEqual(context);
  expect(safe.startTime).toEqual(span.startTime);
  expect(safe.endTime).toEqual(span.endTime);
  expect(safe.duration).toEqual(span.duration);
  expect(safe.status).toEqual(span.status);
  expect(JSON.stringify({ ...span, resource: span.resource.attributes })).toBe(original);
});
