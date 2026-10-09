import type { TUserMemory } from 'librechat-data-provider';
import { getMemoryAddress, getMemoryListKey, getMemoryUpdateAddress } from './address';

const memory = (overrides: Partial<TUserMemory> = {}): TUserMemory => ({
  _id: 'memory-id',
  key: 'preference',
  value: 'tea',
  updated_at: '2026-08-04T00:00:00.000Z',
  ...overrides,
});

describe('memory addressing', () => {
  it('uses the opaque id for a policy-projected memory even when its key is safe', () => {
    const projected = memory({ contentFilterBlocked: true, value: '' });

    expect(getMemoryAddress(projected)).toEqual({ id: 'memory-id' });
    expect(getMemoryListKey(projected)).toBe('id:memory-id');
  });

  it('uses the opaque id when the key is redacted', () => {
    const projected = memory({ key: '', contentFilterBlocked: true });

    expect(getMemoryAddress(projected)).toEqual({ id: 'memory-id' });
    expect(getMemoryListKey(projected)).toBe('id:memory-id');
  });

  it('preserves key addressing for legacy safe responses without an id', () => {
    const legacy = memory({ _id: undefined });

    expect(getMemoryAddress(legacy)).toEqual({ key: 'preference' });
    expect(getMemoryListKey(legacy)).toBe('key::preference');
  });

  it('does not create a blank key address for a malformed legacy response', () => {
    expect(getMemoryAddress(memory({ _id: undefined, key: '' }))).toBeNull();
  });

  it('preserves a hidden key by omitting it from an opaque update', () => {
    const projected = memory({ key: '', contentFilterBlocked: true });

    expect(getMemoryUpdateAddress(projected, '')).toEqual({ id: 'memory-id' });
  });

  it('uses the opaque id for value-blocked edits and sends only an explicit rename', () => {
    const projected = memory({ contentFilterBlocked: true, value: '' });

    expect(getMemoryUpdateAddress(projected, 'preference')).toEqual({ id: 'memory-id' });
    expect(getMemoryUpdateAddress(projected, 'new_preference')).toEqual({
      id: 'memory-id',
      key: 'new_preference',
    });
  });

  it('retains the legacy original-key contract for unprojected memories', () => {
    const legacy = memory({ _id: undefined });

    expect(getMemoryUpdateAddress(legacy, 'new_preference')).toEqual({
      key: 'new_preference',
      originalKey: 'preference',
    });
  });
});
