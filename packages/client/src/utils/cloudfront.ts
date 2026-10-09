import { apiBaseUrl } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';

type CloudFrontCookieRefreshConfig = NonNullable<
  NonNullable<TStartupConfig['cloudFront']>['cookieRefresh']
>;
type CloudFrontCookieRefreshResponse = {
  ok?: boolean;
};
type CloudFrontCookieRefreshOptions = {
  getAuthorizationHeader?: () => string | undefined;
};

let cookieRefreshConfig: CloudFrontCookieRefreshConfig | undefined;
let getAuthorizationHeader: CloudFrontCookieRefreshOptions['getAuthorizationHeader'];
let refreshPromise: Promise<boolean> | null = null;
let removeImageErrorListener: (() => void) | null = null;
const retriedImageSources = new WeakMap<HTMLImageElement, string>();
const pendingImageRefreshes = new WeakMap<HTMLImageElement, string>();
const forwardedImageErrors = new WeakSet<HTMLImageElement>();

function getRefreshConfig(
  startupConfig?: Pick<TStartupConfig, 'cloudFront'> | null,
): CloudFrontCookieRefreshConfig | undefined {
  return startupConfig?.cloudFront?.cookieRefresh ?? cookieRefreshConfig;
}

function getBaseUrl(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value, getBaseUrl());
  } catch {
    return null;
  }
}

export function configureCloudFrontCookieRefresh(
  startupConfig?: Pick<TStartupConfig, 'cloudFront'> | null,
  options: CloudFrontCookieRefreshOptions = {},
): void {
  cookieRefreshConfig = startupConfig?.cloudFront?.cookieRefresh;
  getAuthorizationHeader = options.getAuthorizationHeader;
}

export function isCloudFrontMediaUrl(
  url: string | null | undefined,
  startupConfig?: Pick<TStartupConfig, 'cloudFront'> | null,
): boolean {
  const config = getRefreshConfig(startupConfig);
  if (!url || !config?.domain) {
    return false;
  }

  const mediaUrl = parseUrl(url);
  const cloudFrontUrl = parseUrl(config.domain);
  return mediaUrl?.origin === cloudFrontUrl?.origin;
}

export function withCloudFrontCacheBuster(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) {
    return url;
  }

  parsed.searchParams.set('_cf_refresh', Date.now().toString());
  return parsed.toString();
}

function getRetryKey(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) {
    return url;
  }

  parsed.searchParams.delete('_cf_refresh');
  return parsed.toString();
}

function dispatchImageError(img: HTMLImageElement): void {
  forwardedImageErrors.add(img);
  img.dispatchEvent(new Event('error'));
}

function getRefreshEndpoint(endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }

  const baseUrl = apiBaseUrl();
  if (!baseUrl || endpoint === baseUrl || endpoint.startsWith(`${baseUrl}/`)) {
    return endpoint;
  }

  return `${baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
}

async function postCloudFrontCookieRefresh(endpoint: string): Promise<boolean> {
  const authorization = getAuthorizationHeader?.();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (authorization) {
    headers.Authorization = authorization;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: '{}',
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as CloudFrontCookieRefreshResponse;
  return payload.ok === true;
}

export function refreshCloudFrontCookiesOnce(): Promise<boolean> {
  const config = getRefreshConfig();
  if (!config?.endpoint) {
    return Promise.resolve(false);
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  const endpoint = getRefreshEndpoint(config.endpoint);
  refreshPromise = postCloudFrontCookieRefresh(endpoint)
    .catch(() => false)
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

export function installCloudFrontImageRetry(
  startupConfig?: Pick<TStartupConfig, 'cloudFront'> | null,
  options: CloudFrontCookieRefreshOptions = {},
): () => void {
  configureCloudFrontCookieRefresh(startupConfig, options);
  removeImageErrorListener?.();
  removeImageErrorListener = null;

  const config = getRefreshConfig();
  if (typeof window === 'undefined' || !config?.endpoint || !config.domain) {
    return () => undefined;
  }

  const handleImageError = (event: Event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) {
      return;
    }
    if (forwardedImageErrors.has(img)) {
      forwardedImageErrors.delete(img);
      return;
    }

    const failedSrc = img.currentSrc || img.src || img.getAttribute('src') || '';
    if (!isCloudFrontMediaUrl(failedSrc)) {
      return;
    }

    const retryKey = getRetryKey(failedSrc);
    if (retriedImageSources.get(img) === retryKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (pendingImageRefreshes.get(img) === retryKey) {
      return;
    }
    pendingImageRefreshes.set(img, retryKey);

    void refreshCloudFrontCookiesOnce().then((refreshed) => {
      pendingImageRefreshes.delete(img);
      if (!refreshed || !img.isConnected) {
        dispatchImageError(img);
        return;
      }

      retriedImageSources.set(img, retryKey);
      img.src = withCloudFrontCacheBuster(failedSrc);
    });
  };

  window.addEventListener('error', handleImageError, true);
  const cleanup = () => {
    window.removeEventListener('error', handleImageError, true);
    if (removeImageErrorListener === cleanup) {
      removeImageErrorListener = null;
    }
  };
  removeImageErrorListener = cleanup;

  return cleanup;
}
