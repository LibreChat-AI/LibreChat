import { createScannerClient, ScannerError } from './scanner';
import { scanResult } from './testkit.helper';

const cfg = { scannerUrl: 'http://scanner.test', serviceKey: 'svc-key', timeoutMs: 50 };
const jsonRes = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

describe('scanner client', () => {
  it('sends the service key and the session-derived identity, not anything else', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonRes(200, scanResult()));
    const client = createScannerClient(cfg, fetchMock as unknown as typeof fetch);
    await client.scanText('hi', { scope: 'u:1', user: '1', department: 'Risk', roles: ['user'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://scanner.test/scan/text');
    expect(init.headers['X-NMB-Service-Key']).toBe('svc-key');
    expect(JSON.parse(init.body)).toEqual({
      text: 'hi',
      conversation_id: 'u:1',
      user: '1',
      department: 'Risk',
      roles: ['user'],
    });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'bad_request'],
    [500, 'unavailable'],
    [502, 'unavailable'],
  ])('maps HTTP %s to %s', async (status, kind) => {
    const client = createScannerClient(
      cfg,
      jest.fn().mockResolvedValue(jsonRes(status, { detail: 'secret-text' })),
    );
    const err = await client.getReview('rev_0123456789ab').catch((e) => e);
    expect(err).toBeInstanceOf(ScannerError);
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain('secret-text');
  });

  it('maps network errors and timeouts to unavailable', async () => {
    const down = createScannerClient(cfg, jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(down.scanText('x', { scope: 's', user: 'u', roles: [] })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    const slow = createScannerClient(
      cfg,
      jest
        .fn()
        .mockImplementation(
          (_u: string, init: RequestInit) =>
            new Promise((_res, rej) =>
              init.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
            ),
        ),
    );
    await expect(slow.scanText('x', { scope: 's', user: 'u', roles: [] })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('rejects a response that is not a valid decision object', async () => {
    const client = createScannerClient(
      cfg,
      jest.fn().mockResolvedValue(jsonRes(200, { decision: 'maybe', findings: [] })),
    );
    await expect(client.scanText('x', { scope: 's', user: 'u', roles: [] })).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });

  it('refuses to call out without a URL or key', async () => {
    const fetchMock = jest.fn();
    const client = createScannerClient(
      { ...cfg, serviceKey: '' },
      fetchMock as unknown as typeof fetch,
    );
    await expect(client.getBlocklist()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes reviewer roles in the X-NMB-Roles header', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes(200, { id: 'r', source: 'text', segments: [] }));
    await createScannerClient(cfg, fetchMock as unknown as typeof fetch).getOriginal(
      'rev_0123456789ab',
      ['reviewer'],
    );
    expect(fetchMock.mock.calls[0][1].headers['X-NMB-Roles']).toBe('reviewer');
  });
});
