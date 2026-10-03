import { getClientPlatform, reduceStack, scrubText, summarizeError } from './redact';

describe('scrubText', () => {
  it.each([
    ['user jane.doe+test@example.co.uk failed', 'user [email] failed'],
    ['Authorization: Bearer abcDEF123456.token', 'Authorization: [redacted]'],
    ['sent Bearer abcdef0123456789xyz', 'sent Bearer [redacted]'],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt [jwt]',
    ],
    ['key sk-proj-abcdefghijklmnop1234 rejected', 'key [key] rejected'],
    ['aws AKIAIOSFODNN7EXAMPLE', 'aws [key]'],
    ['api_key=supersecretvalue&next=1', 'api_key=[redacted]&next=1'],
    ['password: "hunter2 hunter2"', 'password: [redacted]'],
    ['convo 65f1c2a9b8e4d3f2a1b0c9d8 missing', 'convo [hex] missing'],
    ['file 123e4567-e89b-12d3-a456-426614174000 gone', 'file :id gone'],
    ['secret Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo end', 'secret [redacted] end'],
    [
      'GET https://chat.example.com/c/abc123?token=xyz#frag failed',
      'GET /c/:conversationId failed',
    ],
    ['GET /api/files/download?id=42&sig=abc failed', 'GET /api/files/download failed'],
    [
      'Unexpected token, "my private prompt text" is not valid JSON',
      'Unexpected token, "[redacted]" is not valid JSON',
    ],
  ])('scrubs %p', (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it('keeps ordinary diagnostic text and identifiers intact', () => {
    const text = "Cannot read properties of undefined (reading 'default') in SubagentThreadPanel";
    expect(scrubText(text)).toBe(text);
  });
});

describe('reduceStack', () => {
  it('drops the message line, reduces URLs to paths and caps frame count', () => {
    const stack = [
      'TypeError: leaked user@example.com content',
      '    at Panel (https://chat.example.com/assets/index-Ab12Cd.js:10:20)',
      '    at https://chat.example.com/c/65f1c2a9b8e4d3f2a1b0c9d8?x=1:3:4',
      'render@https://chat.example.com/assets/vendor-Xy.js:5:6',
      ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (/assets/a.js:${i}:1)`),
    ].join('\n');

    const frames = reduceStack(stack)?.split('\n') ?? [];

    expect(frames[0]).toBe('at Panel (/assets/index-Ab12Cd.js:10:20)');
    expect(frames[1]).toBe('at /c/:conversationId');
    expect(frames[2]).toBe('render@/assets/vendor-Xy.js:5:6');
    expect(frames).toHaveLength(12);
    expect(frames.join('\n')).not.toContain('example.com');
    expect(frames.join('\n')).not.toContain('user@');
  });
});

describe('summarizeError', () => {
  it('reads only name, generated message, stack and status from errors', () => {
    const error = Object.assign(new Error('Request failed for jane@example.com'), {
      name: 'AxiosError',
      response: { status: 503, data: { prompt: 'secret prompt' } },
      config: { headers: { Authorization: 'Bearer abcdefghijklmnop' } },
    });

    const summary = summarizeError(error);

    expect(summary).toEqual({
      type: 'AxiosError',
      message: 'Request failed for [email]',
      stacktrace: expect.any(String),
      statusCode: 503,
    });
    expect(JSON.stringify(summary)).not.toMatch(/secret prompt|abcdefghijklmnop/);
  });

  it('drops application error messages, which can echo prompt or response content', () => {
    const summary = summarizeError(new Error('Model rejected prompt: my medical history'));

    expect(summary?.type).toBe('Error');
    expect(summary?.message).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('medical history');
  });

  it.each([
    [new TypeError("Cannot read properties of undefined (reading 'default')"), true],
    [new SyntaxError(`Unexpected token 'h', "hello there" is not valid JSON`), true],
    [new Error('Unable to preload CSS for /assets/panel.css'), true],
    [new DOMException('The operation was aborted.', 'AbortError'), true],
    [Object.assign(new Error('Prompt too long'), { name: 'ProviderError' }), false],
  ])('keeps generated messages only (%p)', (error, kept) => {
    const message = summarizeError(error)?.message;
    expect(message !== undefined).toBe(kept);
    expect(message ?? '').not.toContain('hello there');
  });

  it('truncates long messages', () => {
    const summary = summarizeError(new TypeError('x '.repeat(1000)));
    expect(summary?.message?.length).toBeLessThanOrEqual(512);
  });

  it('ignores non-error values', () => {
    expect(summarizeError({ text: 'message body' })).toBeUndefined();
    expect(summarizeError('plain string')).toBeUndefined();
  });
});

describe('getClientPlatform', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0',
      { browser: 'Edge', os: 'Windows' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      { browser: 'Safari', os: 'macOS' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1',
      { browser: 'Chrome', os: 'iOS' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      { browser: 'Firefox', os: 'Linux' },
    ],
  ])('maps %p to coarse families', (userAgent, expected) => {
    expect(getClientPlatform(userAgent)).toEqual(expected);
  });
});
