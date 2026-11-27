import type { QueryDevtoolsRequest } from './devtools';
import {
  QUERY_DEVTOOLS_HEADER,
  maybeInjectQueryDevtoolsBootstrap,
  shouldEnableQueryDevtools,
} from './devtools';

const createReq = (value?: string): QueryDevtoolsRequest => ({
  get: (header) => (header === QUERY_DEVTOOLS_HEADER ? value : undefined),
});

describe('query devtools HTML bootstrap', () => {
  const html =
    '<!DOCTYPE html><html lang="en-US"><head><title>LibreChat</title></head><body></body></html>';

  it('uses the documented debug header value as the opt-in signal', () => {
    expect(shouldEnableQueryDevtools(createReq('1'))).toBe(true);
    expect(shouldEnableQueryDevtools(createReq('true'))).toBe(false);
    expect(shouldEnableQueryDevtools(createReq())).toBe(false);
  });

  it('does not inject the production devtools flag by default', () => {
    expect(maybeInjectQueryDevtoolsBootstrap(html, createReq())).toBe(html);
  });

  it('injects a server-to-client flag when the debug header is present', () => {
    const updatedHtml = maybeInjectQueryDevtoolsBootstrap(html, createReq('1'));

    expect(updatedHtml).toContain('window.__LIBRECHAT_CONFIG__');
    expect(updatedHtml).toContain('data-librechat-query-devtools="true"');
    expect(updatedHtml).toContain('"enableQueryDevtools":true');
    expect(updatedHtml.indexOf('enableQueryDevtools')).toBeLessThan(updatedHtml.indexOf('</head>'));
  });
});
