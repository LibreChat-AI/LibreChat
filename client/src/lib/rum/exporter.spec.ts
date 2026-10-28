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
    attributes: { 'location.href': url },
    resource: resourceFromAttributes({ 'service.name': 'librechat-web', 'page.url': url }),
    instrumentationScope: { name: 'test' },
    events: [
      { name: 'exception', time: [2, 0], attributes: { 'exception.stacktrace': `at ${url}` } },
    ],
    links: [{ context, attributes: { 'http.url': url } }],
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
  expect(safe.spanContext()).toEqual(context);
  expect(safe.attributes['location.href']).toBe('https://app.example/login/2fa');
  expect(safe.resource.attributes['service.name']).toBe('librechat-web');
  expect(span.attributes['location.href']).toBe(url);
});
