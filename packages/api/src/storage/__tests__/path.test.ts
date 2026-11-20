import { resolveDownloadPath, stripCacheBust, toLocalUrlPath, fromLocalUrlPath } from '../path';

describe('resolveDownloadPath', () => {
  it('prefers the recorded object key over the stored URL', () => {
    expect(
      resolveDownloadPath({
        filepath: 'https://bucket.s3.amazonaws.com/uploads/u1/f.pdf?X-Amz-Expires=900',
        storageKey: 'uploads/u1/f.pdf',
      }),
    ).toBe('uploads/u1/f.pdf');
  });

  it('falls back to the path when no key was recorded', () => {
    expect(resolveDownloadPath({ filepath: '/uploads/u1/f.pdf' })).toBe('/uploads/u1/f.pdf');
  });

  it('treats an empty or null key as absent', () => {
    expect(resolveDownloadPath({ filepath: '/uploads/u1/f.pdf', storageKey: '' })).toBe(
      '/uploads/u1/f.pdf',
    );
    expect(resolveDownloadPath({ filepath: '/uploads/u1/f.pdf', storageKey: null })).toBe(
      '/uploads/u1/f.pdf',
    );
  });

  it('keeps a remote URL intact for strategies that fetch it directly', () => {
    const url = 'https://firebasestorage.googleapis.com/v0/b/x/o/f.pdf?alt=media&token=t';
    expect(resolveDownloadPath({ filepath: url })).toBe(url);
  });
});

describe('stripCacheBust', () => {
  it('removes the cache-buster a regenerated code output persists', () => {
    expect(stripCacheBust('/images/u1/chart.png?v=1789460622697')).toBe('/images/u1/chart.png');
  });

  it('removes everything from the first question mark onward', () => {
    expect(stripCacheBust('/uploads/u1/doc.pdf?manual=true&v=2')).toBe('/uploads/u1/doc.pdf');
  });

  it('leaves a path without a query string untouched', () => {
    expect(stripCacheBust('/images/u1/chart.png')).toBe('/images/u1/chart.png');
  });

  it('keeps a name whose sanitized form cannot contain a question mark', () => {
    expect(stripCacheBust('/uploads/u1/what_is_this_.pdf')).toBe('/uploads/u1/what_is_this_.pdf');
  });
});

describe('toLocalUrlPath', () => {
  it('percent-encodes a segment that holds a character a URL cannot carry', () => {
    expect(toLocalUrlPath('images', 'u1', 'a#b?c%d e.png')).toBe(
      '/images/u1/a%23b%3Fc%25d%20e.png',
    );
    expect(toLocalUrlPath('uploads', 'u1', 'a\\b.txt')).toBe('/uploads/u1/a%5Cb.txt');
    expect(toLocalUrlPath('uploads', 'u1', 'a\tb\nc\rd.txt')).toBe('/uploads/u1/a%09b%0Ac%0Dd.txt');
  });

  it('records every other name as it is, so URLs that already worked do not change', () => {
    expect(toLocalUrlPath('uploads', 'u1', 'file-id__output_1.csv')).toBe(
      '/uploads/u1/file-id__output_1.csv',
    );
    expect(toLocalUrlPath('images', 'u1', '会社 1.png')).toBe('/images/u1/会社 1.png');
    expect(toLocalUrlPath('uploads', 'u1', "a b+c,d@e=f&g'(h)!.txt")).toBe(
      "/uploads/u1/a b+c,d@e=f&g'(h)!.txt",
    );
  });

  it('encodes only the segment that needs it and keeps the separators of a nested name', () => {
    expect(toLocalUrlPath('uploads', 'u1', 'nested dir/a#1.png')).toBe(
      '/uploads/u1/nested dir/a%231.png',
    );
  });

  it('joins and normalizes the parts like a file path', () => {
    expect(toLocalUrlPath('images', 'u1/', '/a/../b#.png')).toBe('/images/u1/b%23.png');
  });

  it('parses back to the same path with no query string or fragment', () => {
    const url = toLocalUrlPath('images', 'u1', 'a#b?c=d%e.png');
    const parsed = new URL(url, 'http://localhost');

    expect(parsed.pathname).toBe(url);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
  });

  it('rejects a segment that needs encoding and cannot be encoded', () => {
    expect(() => toLocalUrlPath('images', 'u1', 'a#\uD800.png')).toThrow(URIError);
  });
});

describe('fromLocalUrlPath', () => {
  it.each(['a#b?c%d e.png', 'a%41#.png', '100%.png', 'a\tb.png', '会社#1.png', '%23'])(
    'returns the name toLocalUrlPath encoded for %s',
    (name) => {
      expect(fromLocalUrlPath(toLocalUrlPath('uploads', 'u1', name))).toBe(`/uploads/u1/${name}`);
    },
  );

  it('decodes only the segments that were encoded', () => {
    expect(fromLocalUrlPath('/uploads/u1/dir 会社/a%231.png')).toBe('/uploads/u1/dir 会社/a#1.png');
  });

  it.each([
    ['a literal escape of a space', '/uploads/u1/a%20b.txt'],
    ['a malformed escape', '/uploads/u1/50%.png'],
    ['an escape that decodes to another name', '/uploads/u1/a%41.png'],
    ['an escaped non-ASCII name', '/uploads/u1/%E4%BC%9A.png'],
    ['an escaped separator', '/uploads/u1/a%2Fb.png'],
    ['an escaped dot segment', '/uploads/u1/%2e%2e/x.png'],
    ['an escaped separator behind an unsafe character', '/uploads/u1/%23%2F..%2F..%2Fx'],
    ['a lowercase escape', '/uploads/u1/a%2fb.png'],
    ['an unencoded reserved character', '/uploads/u1/a#b.png'],
    ['an unencoded space', '/uploads/u1/a b.png'],
    ['an unencoded non-ASCII name', '/uploads/u1/会社.png'],
    ['an unencoded lone surrogate', '/uploads/u1/broken\uD800%23.png'],
  ])('keeps %s as recorded', (_, recorded) => {
    expect(fromLocalUrlPath(recorded)).toBe(recorded);
  });

  it('keeps an empty path empty', () => {
    expect(fromLocalUrlPath('')).toBe('');
  });
});
