import {
  getStoredFileURL,
  parseStoredFileURL,
  STORED_FILES_ROUTE,
  getKeyFromStoredFileURL,
  isStoredFileProxyEnabled,
} from '../link';

const key = 'images/a1b2c3d4e5f6a1b2c3d4e5f6/file-1__photo one.png';

describe('stored file links', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DOMAIN_CLIENT = 'https://chat.example.com';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('round-trips a source and key through an encoded link', () => {
    const url = getStoredFileURL('s3', key);
    expect(url).toBe(
      `${STORED_FILES_ROUTE}/s3/images/a1b2c3d4e5f6a1b2c3d4e5f6/file-1__photo%20one.png`,
    );
    expect(parseStoredFileURL(url)).toEqual({ source: 's3', key });
    expect(parseStoredFileURL(`${url}?v=123`)).toEqual({ source: 's3', key });
  });

  it('reads a key only for the source it was written for', () => {
    const url = getStoredFileURL('s3', key);
    expect(getKeyFromStoredFileURL(url, 's3')).toBe(key);
    expect(getKeyFromStoredFileURL(url, 'azure_blob')).toBeNull();
  });

  it('rejects values that are not stored file links', () => {
    expect(parseStoredFileURL('https://bucket.s3.amazonaws.com/images/x.png')).toBeNull();
    expect(parseStoredFileURL('/images/user/x.png')).toBeNull();
    expect(parseStoredFileURL(`${STORED_FILES_ROUTE}/s3`)).toBeNull();
    expect(parseStoredFileURL(`${STORED_FILES_ROUTE}/s3/%E0%A4%A`)).toBeNull();
  });

  it('prefixes the base path of a subdirectory deployment', () => {
    process.env.DOMAIN_CLIENT = 'https://example.com/chat/';
    const url = getStoredFileURL('s3', key);
    expect(url.startsWith(`/chat${STORED_FILES_ROUTE}/s3/images/`)).toBe(true);
    expect(parseStoredFileURL(url)).toEqual({ source: 's3', key });
  });

  it('reads STORAGE_PROXY_FILES on each call', () => {
    delete process.env.STORAGE_PROXY_FILES;
    expect(isStoredFileProxyEnabled()).toBe(false);
    process.env.STORAGE_PROXY_FILES = 'true';
    expect(isStoredFileProxyEnabled()).toBe(true);
  });
});
