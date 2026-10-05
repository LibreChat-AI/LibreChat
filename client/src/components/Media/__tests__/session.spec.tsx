import { act, renderHook } from '@testing-library/react';
import { runSessionCleanups } from '~/store/session';
import { useMediaSessionGuard } from '../session';

test('returning to the same principal cannot revive work from the earlier session', () => {
  const hook = renderHook(
    ({ scope, authenticated }) => useMediaSessionGuard(scope, authenticated),
    { initialProps: { scope: 'tenant-a:owner', authenticated: true } },
  );
  const first = hook.result.current;
  expect(first()).toBe(true);
  hook.rerender({ scope: 'tenant-b:owner', authenticated: true });
  const second = hook.result.current;
  expect(first()).toBe(false);
  expect(second()).toBe(true);
  hook.rerender({ scope: 'tenant-a:owner', authenticated: true });
  expect(first()).toBe(false);
  expect(second()).toBe(false);
  expect(hook.result.current()).toBe(true);
});

test('session cleanup revokes work before debounced auth state changes and stays latched', () => {
  const hook = renderHook(({ authenticated }) => useMediaSessionGuard('owner', authenticated), {
    initialProps: { authenticated: true },
  });
  const first = hook.result.current;
  act(() => runSessionCleanups());
  expect(first()).toBe(false);
  hook.rerender({ authenticated: true });
  expect(hook.result.current()).toBe(false);
  hook.rerender({ authenticated: false });
  expect(hook.result.current()).toBe(false);
  hook.rerender({ authenticated: true });
  expect(first()).toBe(false);
  expect(hook.result.current()).toBe(true);
});

test('unmount revokes work even after the same principal mounts a new host', () => {
  const first = renderHook(() => useMediaSessionGuard('owner', true));
  const stale = first.result.current;
  first.unmount();
  const second = renderHook(() => useMediaSessionGuard('owner', true));
  expect(stale()).toBe(false);
  expect(second.result.current()).toBe(true);
});
