export type FrontendRelease = {
  schemaVersion: 1;
  buildId: string;
  assetManifestHash: string;
  releaseRevision?: number;
};

const BUILD_ID = /^assets-([a-f0-9]{64})$/;

export function resolvePollInterval(value?: number): number {
  return Number.isSafeInteger(value) && value != null && value >= 60000 && value <= 3600000
    ? value
    : 300000;
}

export function parseRelease(value: object | null): FrontendRelease | null {
  if (
    !value ||
    !('buildId' in value) ||
    !('assetManifestHash' in value) ||
    !('schemaVersion' in value)
  ) {
    return null;
  }
  const candidate = value as Partial<FrontendRelease>;
  const digest =
    typeof candidate.buildId === 'string' ? BUILD_ID.exec(candidate.buildId)?.[1] : null;
  if (
    candidate.schemaVersion !== 1 ||
    !digest ||
    candidate.assetManifestHash !== digest ||
    ('releaseRevision' in candidate &&
      (!Number.isSafeInteger(candidate.releaseRevision) || (candidate.releaseRevision ?? 0) < 0))
  ) {
    return null;
  }
  return candidate as FrontendRelease;
}

export async function readRelease(url: URL, timeoutMs = 5000): Promise<FrontendRelease | null> {
  if (url.origin !== window.location.origin) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.href, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (
      !response.ok ||
      new URL(response.url).pathname !== url.pathname ||
      !response.headers.get('content-type')?.includes('application/json') ||
      !response.headers.get('cache-control')?.includes('no-store')
    ) {
      return null;
    }
    return parseRelease(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function confirmRelease(url: URL, delayMs = 1500): Promise<FrontendRelease | null> {
  const first = await readRelease(url);
  if (!first) {
    return null;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const second = await readRelease(url);
  return second?.buildId === first.buildId &&
    second?.releaseRevision === first.releaseRevision &&
    second?.assetManifestHash === first.assetManifestHash
    ? second
    : null;
}
