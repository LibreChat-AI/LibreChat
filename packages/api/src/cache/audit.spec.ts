import { auditCacheStores, formatMemoryUsage } from './audit';

describe('auditCacheStores', () => {
  it('puts count and ttl in the message and never reads keys or values', () => {
    const messages: string[] = [];
    const store = new Map([['user-key-1', { access_token: 'secret-token' }]]);
    const keys = jest.spyOn(store, 'keys');
    const values = jest.spyOn(store, 'values');
    const entries = jest.spyOn(store, 'entries');

    auditCacheStores([{ opts: { namespace: 'TEST', ttl: 1000, store } }, { opts: {} }], {
      info: (message) => messages.push(message),
    });

    expect(messages).toEqual([
      '[Cache] Starting audit',
      '[Cache] TEST entries: count=1, ttl=1000ms',
    ]);
    expect(keys).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
  });
});

describe('formatMemoryUsage', () => {
  it('renders every figure in the message', () => {
    const mb = 1024 * 1024;
    const message = formatMemoryUsage(
      { heapUsed: mb, heapTotal: 2 * mb, rss: 3 * mb, external: 4 * mb } as NodeJS.MemoryUsage,
      7,
    );
    expect(message).toContain('heapUsed=1.00 MB');
    expect(message).toContain('rss=3.00 MB');
    expect(message).toContain('totalCacheEntries=7');
  });
});
