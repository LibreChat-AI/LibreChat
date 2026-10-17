import type { ErrorEvent } from '@sentry/browser';
import { scrubEvent } from './scrub';

function eventWith(overrides: Partial<ErrorEvent>): ErrorEvent {
  return {
    type: undefined,
    event_id: 'e1',
    level: 'error',
    release: 'abc',
    environment: 'dev',
    ...overrides,
  };
}

const frame = {
  filename: 'https://chat.example.com/assets/index-abc.js?token=secret#x',
  abs_path: 'https://chat.example.com/assets/index-abc.js?token=secret',
  function: 'renderMessage',
  lineno: 10,
  colno: 4,
  in_app: true,
  vars: { prompt: 'my secret plan' },
  context_line: 'const text = "my secret plan";',
};

describe('scrubEvent', () => {
  it('drops the user, request, breadcrumbs, extra and contexts', () => {
    const scrubbed = scrubEvent(
      eventWith({
        user: { id: 'u1', email: 'jane@example.com', ip_address: '1.2.3.4' },
        request: {
          url: 'https://chat.example.com/c/abc?q=hi',
          cookies: { refreshToken: 'r' },
          headers: { Authorization: 'Bearer x' },
          data: { text: 'hello' },
        },
        breadcrumbs: [{ message: 'console: user typed my secret plan' }],
        extra: { body: 'my secret plan' },
        contexts: { app: { app_name: 'my secret plan' } },
      }),
      '/c/65f1c2a9b8e4d3f2a1b0c9d8',
    );

    expect(scrubbed).not.toHaveProperty('user');
    expect(scrubbed).not.toHaveProperty('request');
    expect(scrubbed).not.toHaveProperty('breadcrumbs');
    expect(scrubbed).not.toHaveProperty('extra');
    expect(scrubbed).not.toHaveProperty('contexts');
    expect(JSON.stringify(scrubbed)).not.toContain('secret plan');
    expect(scrubbed.transaction).toBe('/c/:conversationId');
    expect(scrubbed.tags).toEqual({ route: '/c/:conversationId' });
  });

  it('redacts free-text messages but keeps engine-generated ones', () => {
    const scrubbed = scrubEvent(
      eventWith({
        message: 'user said my secret plan',
        exception: {
          values: [
            { type: 'Error', value: 'Model refused: "my secret plan"' },
            { type: 'TypeError', value: "Cannot read properties of undefined (reading 'text')" },
          ],
        },
      }),
      '/',
    );

    expect(scrubbed.message).toBe('[redacted]');
    expect(scrubbed.exception?.values?.map((value) => value.value)).toEqual([
      '[redacted]',
      "Cannot read properties of undefined (reading 'text')",
    ]);
  });

  it('keeps frames for grouping without queries, locals or source lines', () => {
    const scrubbed = scrubEvent(
      eventWith({
        exception: { values: [{ type: 'TypeError', stacktrace: { frames: [frame] } }] },
      }),
      '/',
    );

    expect(scrubbed.exception?.values?.[0].stacktrace?.frames).toEqual([
      {
        filename: 'https://chat.example.com/assets/index-abc.js',
        abs_path: 'https://chat.example.com/assets/index-abc.js',
        function: 'renderMessage',
        module: undefined,
        lineno: 10,
        colno: 4,
        in_app: true,
      },
    ]);
  });

  it('passes only the tags reporting sets itself', () => {
    const scrubbed = scrubEvent(
      eventWith({
        tags: { boundary: 'markdown', browser: 'Chrome', os: 'macOS', email: 'jane@example.com' },
      }),
      '/share/abc',
    );

    expect(scrubbed.tags).toEqual({
      route: '/share/:shareId',
      boundary: 'markdown',
      browser: 'Chrome',
      os: 'macOS',
    });
  });
});
