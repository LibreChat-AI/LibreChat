import { resolveDownloadPath, stripCacheBust } from '../path';

describe('resolveDownloadPath', () => {
  it('prefers the recorded object key over the stored URL', () => {
    expect(
      resolveDownloadPath({
        filepath: 'https://bucket.s3.amazonaws.com/uploads/u1/f.pdf?X-Amz-Expires=900',
        storageKey: 'uploads/u1/f.pdf',
        source: 's3',
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

  it.each(['local', 'azure_blob', 'firebase'])(
    'keeps the %s download path when media also stores an object key',
    (source) => {
      const filepath =
        source === 'local' ? '/images/user/original.png' : 'https://storage.example/original.png';
      expect(
        resolveDownloadPath({ source, filepath, storageKey: 'images/user/original.png' }),
      ).toBe(filepath);
    },
  );
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
