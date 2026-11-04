import type { QueryParamRequest } from './query';
import { stripQueryParam, setQueryParam } from './query';

function buildReq(url: string): QueryParamRequest {
  return { query: {}, originalUrl: url, url };
}

describe('stripQueryParam', () => {
  it('removes the named param and leaves the rest of the query intact', () => {
    const req = buildReq('/oauth/openid?prompt=login&state=abc');
    stripQueryParam(req, 'prompt');
    expect(req.url).toBe('/oauth/openid?state=abc');
  });

  it('drops the path entirely when the removed param was the only one', () => {
    const req = buildReq('/oauth/openid?prompt=login');
    stripQueryParam(req, 'prompt');
    expect(req.url).toBe('/oauth/openid');
  });

  it('is a no-op when the param is absent', () => {
    const req = buildReq('/oauth/openid?state=abc');
    stripQueryParam(req, 'prompt');
    expect(req.url).toBe('/oauth/openid?state=abc');
  });

  it('is a no-op on a URL with no query string', () => {
    const req = buildReq('/oauth/openid');
    stripQueryParam(req, 'prompt');
    expect(req.url).toBe('/oauth/openid');
  });

  it('keeps a value that itself contains a literal ?, instead of dropping it after a second ?', () => {
    const req = buildReq('/oauth/openid?redirectTo=%2Ffoo%3Fbar%3Dbaz&prompt=login');
    stripQueryParam(req, 'prompt');
    expect(req.url).toBe('/oauth/openid?redirectTo=%2Ffoo%3Fbar%3Dbaz');
  });
});

describe('setQueryParam', () => {
  it('adds the param to a URL with no existing query string', () => {
    const req = buildReq('/oauth/openid');
    setQueryParam(req, 'code_challenge', 'abc123');
    expect(req.url).toBe('/oauth/openid?code_challenge=abc123');
  });

  it('adds the param alongside an existing query string', () => {
    const req = buildReq('/oauth/openid?prompt=login');
    setQueryParam(req, 'code_challenge', 'abc123');
    expect(new URL(req.url, 'http://x').searchParams.get('code_challenge')).toBe('abc123');
    expect(new URL(req.url, 'http://x').searchParams.get('prompt')).toBe('login');
  });

  it('overwrites an existing value for the same param', () => {
    const req = buildReq('/oauth/openid?code_challenge=old');
    setQueryParam(req, 'code_challenge', 'new');
    expect(new URL(req.url, 'http://x').searchParams.get('code_challenge')).toBe('new');
  });

  it('updates both url and originalUrl', () => {
    const req: QueryParamRequest = {
      query: {},
      originalUrl: '/api/admin/oauth/openid',
      url: '/oauth/openid',
    };
    setQueryParam(req, 'code_challenge', 'abc123');
    expect(req.originalUrl).toBe('/api/admin/oauth/openid?code_challenge=abc123');
    expect(req.url).toBe('/oauth/openid?code_challenge=abc123');
  });
});
