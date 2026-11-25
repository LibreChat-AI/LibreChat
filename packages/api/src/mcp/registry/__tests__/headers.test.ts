import type { ParsedServerConfig } from '~/mcp/types';
import { mergeRetainedHeaderValues, retainStoredHeaderValues } from '../headers';

const remote = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ({
    type: 'streamable-http',
    url: 'https://example.com/mcp',
    headers,
    ...extra,
  }) as unknown as ParsedServerConfig;

describe('mergeRetainedHeaderValues', () => {
  it('keeps stored values for blank submissions, matching names case-insensitively', () => {
    const result = mergeRetainedHeaderValues(
      { 'x-client-secret': '', 'X-Client-Id': 'new-id' },
      { 'X-Client-Secret': 'stored-secret', 'X-Client-Id': 'old-id', 'X-Removed': 'gone' },
    );
    expect(result.headers).toEqual({ 'x-client-secret': 'stored-secret', 'X-Client-Id': 'new-id' });
    expect(result.retained).toEqual(['x-client-secret']);
  });

  it('leaves a blank value blank when nothing is stored under that name', () => {
    expect(mergeRetainedHeaderValues({ 'X-New': '' }, {})).toEqual({
      headers: { 'X-New': '' },
      retained: [],
    });
  });

  it('returns undefined headers when none are submitted', () => {
    expect(mergeRetainedHeaderValues(undefined, { 'X-Stored': 'v' }).headers).toBeUndefined();
  });
});

describe('retainStoredHeaderValues', () => {
  it('returns the config unchanged without submitted headers', () => {
    const config = remote({});
    delete (config as { headers?: unknown }).headers;
    expect(retainStoredHeaderValues(config, remote({ 'X-A': 'v' }))).toBe(config);
  });

  it('refuses to carry a stored value to a different url', () => {
    expect(() =>
      retainStoredHeaderValues(
        remote({ 'X-Secret': '' }, { url: 'https://attacker.example/mcp' }),
        remote({ 'X-Secret': 'stored' }),
      ),
    ).toThrow(expect.objectContaining({ code: 'MCP_HEADERS_REENTRY_REQUIRED' }));
  });

  it('refuses to carry a stored value to a different transport', () => {
    expect(() =>
      retainStoredHeaderValues(
        remote({ 'X-Secret': '' }, { type: 'sse' }),
        remote({ 'X-Secret': 'stored' }),
      ),
    ).toThrow(expect.objectContaining({ code: 'MCP_HEADERS_REENTRY_REQUIRED' }));
  });

  it('allows a url change when every header value is re-entered', () => {
    const result = retainStoredHeaderValues(
      remote({ 'X-Secret': 'fresh' }, { url: 'https://other.example/mcp' }),
      remote({ 'X-Secret': 'stored' }),
    ) as ParsedServerConfig & { headers?: Record<string, string> };
    expect(result.headers).toEqual({ 'X-Secret': 'fresh' });
  });
});
