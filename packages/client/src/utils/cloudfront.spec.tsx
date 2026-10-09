import { fireEvent, waitFor } from '@testing-library/react';

const mockApiBaseUrl = jest.fn(() => '');
const mockGetTokenHeader = jest.fn(() => 'Bearer test-token');

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => mockApiBaseUrl(),
}));

import {
  isCloudFrontMediaUrl,
  refreshCloudFrontCookiesOnce,
  installCloudFrontImageRetry,
  configureCloudFrontCookieRefresh,
} from './cloudfront';

const cloudFrontStartupConfig = {
  cloudFront: {
    cookieRefresh: {
      endpoint: '/api/auth/cloudfront/refresh',
      domain: 'https://cdn.example.com',
    },
  },
};

function refreshResponse(payload: { ok?: boolean }, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(payload),
  } as Response;
}

describe('CloudFront cookie refresh helpers', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockApiBaseUrl.mockReturnValue('');
    mockGetTokenHeader.mockReturnValue('Bearer test-token');
    fetchMock = jest.fn(() =>
      Promise.resolve(refreshResponse({ ok: true })),
    ) as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;
    configureCloudFrontCookieRefresh(undefined);
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('no-ops when startup config has no CloudFront refresh capability', async () => {
    configureCloudFrontCookieRefresh({});

    await expect(refreshCloudFrontCookiesOnce()).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent refresh calls', async () => {
    let resolveRefresh: ((value: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    configureCloudFrontCookieRefresh(cloudFrontStartupConfig, {
      getAuthorizationHeader: mockGetTokenHeader,
    });

    const first = refreshCloudFrontCookiesOnce();
    const second = refreshCloudFrontCookiesOnce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/cloudfront/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: '{}',
      }),
    );
    resolveRefresh?.(refreshResponse({ ok: true }));
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('returns false on 401 without retrying the refresh request', async () => {
    fetchMock.mockResolvedValue(refreshResponse({}, false));
    configureCloudFrontCookieRefresh(cloudFrontStartupConfig, {
      getAuthorizationHeader: mockGetTokenHeader,
    });

    await expect(refreshCloudFrontCookiesOnce()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefixes the refresh endpoint with the configured app base path', async () => {
    mockApiBaseUrl.mockReturnValue('/chat');
    configureCloudFrontCookieRefresh(cloudFrontStartupConfig, {
      getAuthorizationHeader: mockGetTokenHeader,
    });

    await expect(refreshCloudFrontCookiesOnce()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      '/chat/api/auth/cloudfront/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('detects only the configured CloudFront domain', () => {
    expect(
      isCloudFrontMediaUrl(
        'https://cdn.example.com/i/images/user/file.png',
        cloudFrontStartupConfig,
      ),
    ).toBe(true);
    expect(
      isCloudFrontMediaUrl(
        'https://images.example.net/i/images/user/file.png',
        cloudFrontStartupConfig,
      ),
    ).toBe(false);
  });

  it('retries a configured CloudFront image only once from the global listener', async () => {
    const cleanup = installCloudFrontImageRetry(cloudFrontStartupConfig);
    const img = document.createElement('img');
    const onFailure = jest.fn();
    img.src = 'https://cdn.example.com/i/images/user/file.png';
    img.addEventListener('error', onFailure);
    document.body.appendChild(img);

    fireEvent.error(img);

    await waitFor(() =>
      expect(img).toHaveAttribute(
        'src',
        'https://cdn.example.com/i/images/user/file.png?_cf_refresh=1700000000000',
      ),
    );

    fireEvent.error(img);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);

    cleanup();
    img.remove();
  });

  it('does not consume the one retry when cookie refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(refreshResponse({ ok: false }))
      .mockResolvedValueOnce(refreshResponse({ ok: true }));
    const cleanup = installCloudFrontImageRetry(cloudFrontStartupConfig);
    const img = document.createElement('img');
    const onFailure = jest.fn();
    img.src = 'https://cdn.example.com/i/images/user/file.png';
    img.addEventListener('error', onFailure);
    document.body.appendChild(img);

    fireEvent.error(img);

    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/i/images/user/file.png');

    fireEvent.error(img);

    await waitFor(() =>
      expect(img).toHaveAttribute(
        'src',
        'https://cdn.example.com/i/images/user/file.png?_cf_refresh=1700000000000',
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    cleanup();
    img.remove();
  });

  it('does not retry arbitrary external images', () => {
    const cleanup = installCloudFrontImageRetry(cloudFrontStartupConfig);
    const img = document.createElement('img');
    const onFailure = jest.fn();
    img.src = 'https://example.com/photo.png';
    img.addEventListener('error', onFailure);
    document.body.appendChild(img);

    fireEvent.error(img);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);

    cleanup();
    img.remove();
  });
});
