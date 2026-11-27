import { createClient } from '@redis/client';

describe('node-redis TLS URI handling', () => {
  it('infers TLS from a rediss:// url', () => {
    const client = createClient({ url: 'rediss://localhost:6380' });
    expect(client.options?.socket).toMatchObject({ tls: true });
  });

  it('leaves a redis:// url without TLS', () => {
    const client = createClient({ url: 'redis://localhost:6379' });
    expect(client.options?.socket).toMatchObject({ tls: false });
  });

  it('keeps custom CA material alongside the TLS flag', () => {
    const client = createClient({
      url: 'rediss://localhost:6380',
      socket: { tls: true, ca: 'test-ca' },
    });
    expect(client.options?.socket).toMatchObject({ tls: true, ca: 'test-ca' });
  });

  it('rejects an explicit TLS mismatch with a rediss:// url', () => {
    expect(() =>
      createClient({
        url: 'rediss://localhost:6380',
        socket: { tls: false },
      }),
    ).toThrow(/tls socket option.*mismatch/i);
  });
});
