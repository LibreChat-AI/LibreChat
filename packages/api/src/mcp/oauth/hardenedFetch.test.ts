import { createHardenedOAuthFetch, resetHardenedOAuthFetchDispatchers } from './hardenedFetch';
import { createSSRFSafeUndiciConnect, isOAuthUrlAllowed, isSSRFTarget } from '~/auth';

jest.mock('~/auth', () => ({
  createSSRFSafeUndiciConnect: jest.fn(() => ({ lookup: jest.fn() })),
  isOAuthUrlAllowed: jest.fn(() => false),
  isSSRFTarget: jest.fn(() => false),
}));

const mockCreateSSRFSafeUndiciConnect = createSSRFSafeUndiciConnect as jest.MockedFunction<
  typeof createSSRFSafeUndiciConnect
>;
const mockIsOAuthUrlAllowed = isOAuthUrlAllowed as jest.MockedFunction<typeof isOAuthUrlAllowed>;
const mockIsSSRFTarget = isSSRFTarget as jest.MockedFunction<typeof isSSRFTarget>;

describe('createHardenedOAuthFetch', () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValue({ ok: true } as Response);
    mockIsOAuthUrlAllowed.mockReturnValue(false);
    mockIsSSRFTarget.mockReturnValue(false);
  });

  afterEach(() => {
    resetHardenedOAuthFetchDispatchers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('attaches an SSRF-safe dispatcher at connect time', async () => {
    await createHardenedOAuthFetch()('https://auth.example.com:9443/token', {
      method: 'POST',
    });

    expect(mockCreateSSRFSafeUndiciConnect).toHaveBeenCalledWith(undefined, '9443');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.example.com:9443/token',
      expect.objectContaining({
        method: 'POST',
        dispatcher: expect.any(Object),
        redirect: 'error',
      }),
    );
  });

  it('does not apply allowedAddresses when allowedDomains is active but unmatched', async () => {
    await createHardenedOAuthFetch({
      allowedDomains: ['https://trusted.example.com'],
      allowedAddresses: ['10.0.0.5:9444'],
    })('https://untrusted.example.com:9444/token');

    expect(mockCreateSSRFSafeUndiciConnect).toHaveBeenCalledWith(null, '9444');
    expect(mockFetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({ dispatcher: expect.any(Object) }),
    );
  });

  it('preserves admin-trusted allowedDomains bypass behavior', async () => {
    mockIsOAuthUrlAllowed.mockReturnValueOnce(true);

    await createHardenedOAuthFetch({
      allowedDomains: ['https://auth.example.com'],
    })('https://auth.example.com/token', { method: 'GET' });

    expect(mockCreateSSRFSafeUndiciConnect).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('dispatcher');
    expect(mockFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects an IPv6 literal before the Undici lookup can be bypassed', async () => {
    mockIsSSRFTarget.mockReturnValueOnce(true);

    await expect(createHardenedOAuthFetch()('http://[::1]:9443/token')).rejects.toThrow();

    expect(mockIsSSRFTarget).toHaveBeenCalledWith('::1', undefined, '9443');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('checks private IPs before reusing a dispatcher cached for the same port', async () => {
    await createHardenedOAuthFetch()('https://auth.example.com:9443/token');
    mockIsSSRFTarget.mockReturnValueOnce(true);

    await expect(createHardenedOAuthFetch()('http://127.0.0.1:9443/token')).rejects.toThrow(
      'OAuth endpoint targets a blocked address',
    );

    expect(mockIsSSRFTarget).toHaveBeenCalledWith('127.0.0.1', undefined, '9443');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes alternate IPv4 spellings before checking the literal', async () => {
    mockIsSSRFTarget.mockReturnValueOnce(true);

    await expect(createHardenedOAuthFetch()('http://0x7f000001:9443/token')).rejects.toThrow(
      'OAuth endpoint targets a blocked address',
    );

    expect(mockIsSSRFTarget).toHaveBeenCalledWith('127.0.0.1', undefined, '9443');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not apply address exemptions to an IP when domain policy is active but unmatched', async () => {
    mockIsSSRFTarget.mockReturnValueOnce(true);

    await expect(
      createHardenedOAuthFetch({
        allowedDomains: ['trusted.example.com'],
        allowedAddresses: ['127.0.0.1:9443'],
      })('http://127.0.0.1:9443/token'),
    ).rejects.toThrow();

    expect(mockIsSSRFTarget).toHaveBeenCalledWith('127.0.0.1', null, '9443');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('normalizes allowedAddresses before caching dispatchers', async () => {
    await createHardenedOAuthFetch({
      allowedAddresses: ['10.0.0.5:9443', '192.168.1.5:9443'],
    })('https://auth.example.com:9443/token');

    await createHardenedOAuthFetch({
      allowedAddresses: ['192.168.1.5:9443', '10.0.0.5:9443'],
    })('https://auth.example.com:9443/token');

    expect(mockCreateSSRFSafeUndiciConnect).toHaveBeenCalledTimes(1);
  });
});
