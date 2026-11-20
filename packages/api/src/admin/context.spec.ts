import type { ServerRequest } from '~/types/http';
import { buildAuditContext } from './context';

describe('buildAuditContext', () => {
  it('prefers the server-assigned request id over client headers', () => {
    const req = {
      requestId: 'server-id',
      headers: { 'x-request-id': 'client-id' },
    } as unknown as ServerRequest;

    expect(buildAuditContext(req).requestId).toBe('server-id');
  });

  it('falls back to the correlation headers', () => {
    const req = { headers: { 'x-correlation-id': 'client-id' } } as unknown as ServerRequest;

    expect(buildAuditContext(req).requestId).toBe('client-id');
  });
});
