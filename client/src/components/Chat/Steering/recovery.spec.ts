import { createStore } from 'jotai';
import {
  blockRecovery,
  canRestoreRecovery,
  recoveryDisposition,
  recoveryDispositionsFamily,
} from './recovery';

const item = { recoverySteerId: 'source' };

describe('steer recovery safety state', () => {
  beforeEach(() => {
    sessionStorage.clear();
    recoveryDispositionsFamily.remove('conversation');
  });

  it('preserves terminal cancellation and dismissal over a late start rejection', () => {
    expect(blockRecovery({ source: 'cancelled' }, 'source')).toEqual({ source: 'cancelled' });
    expect(blockRecovery({ source: 'dismissed' }, 'source')).toEqual({ source: 'dismissed' });
    expect(blockRecovery({ source: 'cancelling' }, 'source')).toEqual({ source: 'cancelling' });
    expect(blockRecovery({}, 'source')).toEqual({ source: 'blocked' });
  });

  it('does not allow stale submission restoration after cancellation or dismissal', () => {
    expect(canRestoreRecovery({ source: 'cancelled' }, item)).toBe(false);
    expect(canRestoreRecovery({ source: 'dismissed' }, item)).toBe(false);
    expect(canRestoreRecovery({ source: 'blocked' }, item)).toBe(true);
    expect(recoveryDisposition({ source: 'blocked' }, {})).toBeUndefined();
  });

  it('retains tab-local safety decisions across reload, without message content', () => {
    const first = createStore();
    first.set(recoveryDispositionsFamily('conversation'), { source: 'dismissed' });
    expect(sessionStorage.getItem('steer-recovery:conversation')).toBe('{"source":"dismissed"}');
    recoveryDispositionsFamily.remove('conversation');
    const reloaded = createStore();
    expect(reloaded.get(recoveryDispositionsFamily('conversation'))).toEqual({
      source: 'dismissed',
    });
    expect(reloaded.get(recoveryDispositionsFamily('another-conversation'))).toEqual({});
  });

  it('retains in-memory safety when browser storage is unavailable', () => {
    const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      const store = createStore();
      expect(() =>
        store.set(recoveryDispositionsFamily('conversation'), { source: 'blocked' }),
      ).not.toThrow();
      expect(store.get(recoveryDispositionsFamily('conversation'))).toEqual({ source: 'blocked' });
    } finally {
      write.mockRestore();
    }
  });

  it('treats an interrupted cancellation as held rather than locked or sendable after reload', () => {
    const first = createStore();
    first.set(recoveryDispositionsFamily('conversation'), { source: 'cancelling' });
    recoveryDispositionsFamily.remove('conversation');
    expect(createStore().get(recoveryDispositionsFamily('conversation'))).toEqual({
      source: 'blocked',
    });
  });
});
