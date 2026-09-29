import { confirmRelease, parseRelease, readRelease, resolvePollInterval } from './release';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const release = (digest: string, releaseRevision?: number) => ({
  schemaVersion: 1,
  buildId: `assets-${digest}`,
  assetManifestHash: digest,
  ...(releaseRevision == null ? {} : { releaseRevision }),
});
const url = new URL('/subpath/version.json', window.location.origin);

const response = (
  body: object,
  headers = { 'content-type': 'application/json', 'cache-control': 'no-store' },
) => ({
  ok: true,
  url: url.href,
  headers: { get: (name: keyof typeof headers) => headers[name] },
  json: async () => body,
});

describe('frontend release descriptor', () => {
  afterEach(() => {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it('clamps invalid runtime cadence overrides before installing timers', () => {
    expect(resolvePollInterval(60000)).toBe(60000);
    expect(resolvePollInterval(3600000)).toBe(3600000);
    for (const invalid of [undefined, 0, 59999, 3600001, 1.5, NaN, Infinity]) {
      expect(resolvePollInterval(invalid)).toBe(300000);
    }
  });

  it('accepts a matching digest and an optional publisher revision', () => {
    expect(parseRelease(release(digestA, 2))).toEqual(release(digestA, 2));
    expect(parseRelease(release(digestA))).toEqual(release(digestA));
  });

  it('rejects malformed builds, inconsistent hashes, and bad revisions', () => {
    expect(parseRelease({ ...release(digestA), assetManifestHash: digestB })).toBeNull();
    expect(parseRelease({ ...release(digestA), schemaVersion: 2 })).toBeNull();
    expect(parseRelease(release(digestA, -1))).toBeNull();
    expect(parseRelease(release(digestA, 1.5))).toBeNull();
    expect(parseRelease({ buildId: 'A' })).toBeNull();
  });

  it('requires a no-store JSON response at the exact static path', async () => {
    const fetcher = jest.fn(async () => response(release(digestA)) as Response);
    globalThis.fetch = Object.assign(fetcher, { preconnect: () => undefined });
    fetcher.mockResolvedValueOnce(response(release(digestA)) as Response);
    expect(await readRelease(url)).toEqual(release(digestA));
    expect(fetcher).toHaveBeenCalledWith(url.href, expect.objectContaining({ cache: 'no-store' }));
    fetcher.mockResolvedValueOnce(
      response(release(digestA), {
        'content-type': 'text/html',
        'cache-control': 'no-store',
      }) as Response,
    );
    expect(await readRelease(url)).toBeNull();
    fetcher.mockResolvedValueOnce(
      response(release(digestA), {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
      }) as Response,
    );
    expect(await readRelease(url)).toBeNull();
  });

  it('defers inconsistent observations rather than following a rolling-pod alternation', async () => {
    const fetcher = jest.fn(async () => response(release(digestA)) as Response);
    globalThis.fetch = Object.assign(fetcher, { preconnect: () => undefined });
    fetcher.mockResolvedValueOnce(response(release(digestA)) as Response);
    fetcher.mockResolvedValueOnce(response(release(digestB)) as Response);
    expect(await confirmRelease(url, 0)).toBeNull();
    fetcher.mockResolvedValueOnce(response(release(digestB, 4)) as Response);
    fetcher.mockResolvedValueOnce(response(release(digestB, 5)) as Response);
    expect(await confirmRelease(url, 0)).toBeNull();
  });
});
