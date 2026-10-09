import type { ToolApprovalHook } from './hooks';
import {
  registerToolApprovalHook,
  getRegisteredToolApprovalHookCount,
  clearToolApprovalHooks,
  buildToolApprovalHooks,
  resolvedToolApprovalHooksCanMatch,
} from './hooks';

const denyHook: ToolApprovalHook = async () => ({ decision: 'deny' });

describe('tool-approval hook registry', () => {
  afterEach(() => clearToolApprovalHooks());

  test('register increments the count and returns an unregister fn', () => {
    expect(getRegisteredToolApprovalHookCount()).toBe(0);
    const off = registerToolApprovalHook(() => denyHook);
    expect(getRegisteredToolApprovalHookCount()).toBe(1);
    off();
    expect(getRegisteredToolApprovalHookCount()).toBe(0);
  });

  test('unregister removes exactly its own registration and is idempotent', () => {
    const off1 = registerToolApprovalHook(() => denyHook);
    registerToolApprovalHook(() => denyHook);
    off1();
    expect(getRegisteredToolApprovalHookCount()).toBe(1);
    off1(); // already removed — no-op, does not remove the second
    expect(getRegisteredToolApprovalHookCount()).toBe(1);
  });

  test('clearToolApprovalHooks removes everything', () => {
    registerToolApprovalHook(() => denyHook);
    registerToolApprovalHook(() => denyHook);
    clearToolApprovalHooks();
    expect(getRegisteredToolApprovalHookCount()).toBe(0);
  });

  describe('buildToolApprovalHooks', () => {
    test('resolves factories against context and carries each matcher', () => {
      registerToolApprovalHook(() => denyHook);
      registerToolApprovalHook(() => denyHook, { matcher: 'write_.*' });

      const built = buildToolApprovalHooks({ userId: 'bob' });
      expect(built).toHaveLength(2);
      expect(built[0].matcher).toBeUndefined();
      expect(built[1].matcher).toBe('write_.*');
      expect(typeof built[0].hook).toBe('function');
    });

    test('drops factories that opt out (return undefined) for the given context', () => {
      // First hook applies to everyone except admins; second always applies.
      registerToolApprovalHook((ctx) => (ctx.userId === 'admin' ? undefined : denyHook));
      registerToolApprovalHook(() => denyHook, { matcher: 'write_.*' });

      expect(buildToolApprovalHooks({ userId: 'bob' })).toHaveLength(2);
      expect(buildToolApprovalHooks({ userId: 'admin' })).toHaveLength(1);
    });

    test('invokes factories in registration order', () => {
      const order: string[] = [];
      registerToolApprovalHook(() => {
        order.push('a');
        return undefined;
      });
      registerToolApprovalHook(() => {
        order.push('b');
        return undefined;
      });
      buildToolApprovalHooks({});
      expect(order).toEqual(['a', 'b']);
    });

    test('returns an empty list when nothing is registered', () => {
      expect(buildToolApprovalHooks({})).toEqual([]);
    });
  });

  describe('resolvedToolApprovalHooksCanMatch', () => {
    test('matches only hooks that can run for the selected tool names', () => {
      const hooks = [{ hook: denyHook, matcher: '^approval_probe$' }];
      expect(resolvedToolApprovalHooksCanMatch(hooks, ['read_file'])).toBe(false);
      expect(resolvedToolApprovalHooksCanMatch(hooks, ['approval_probe'])).toBe(true);
    });

    test('treats an unscoped hook as matching any nonempty tool surface', () => {
      const hooks = [{ hook: denyHook }];
      expect(resolvedToolApprovalHooksCanMatch(hooks, [])).toBe(false);
      expect(resolvedToolApprovalHooksCanMatch(hooks, ['read_file'])).toBe(true);
    });
  });
});
