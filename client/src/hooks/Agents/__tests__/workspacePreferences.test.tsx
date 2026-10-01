import { Provider } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { useWorkspacePreferences } from '../workspacePreferences';

const mockUser = { id: 'user-a', tenantId: 'tenant-a' };
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: mockUser }) }));

beforeEach(() => {
  localStorage.clear();
  mockUser.id = 'user-a';
  mockUser.tenantId = 'tenant-a';
});

test('persists choices across mounts and scopes them by user, tenant, agent and machine', () => {
  const first = renderHook(() => useWorkspacePreferences('agent-a'), { wrapper: Provider });
  act(() => first.result.current.remember('machine-a', 'project-a'));
  first.unmount();
  const { result, rerender } = renderHook(({ agent }) => useWorkspacePreferences(agent), {
    wrapper: Provider,
    initialProps: { agent: 'agent-a' },
  });
  expect(result.current.get('machine-a')).toBe('project-a');
  expect(result.current.get('machine-b')).toBeUndefined();
  rerender({ agent: 'agent-b' });
  expect(result.current.get('machine-a')).toBeUndefined();
  mockUser.id = 'user-b';
  rerender({ agent: 'agent-a' });
  expect(result.current.get('machine-a')).toBeUndefined();
  mockUser.id = 'user-a';
  mockUser.tenantId = 'tenant-b';
  rerender({ agent: 'agent-a' });
  expect(result.current.get('machine-a')).toBeUndefined();
});

test('storage errors never prevent a manual choice', () => {
  const { result } = renderHook(() => useWorkspacePreferences('agent-a'), { wrapper: Provider });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  expect(() => act(() => result.current.remember('machine-a', 'project-a'))).not.toThrow();
});

test('records a shared selection for every root agent that reaches the machine', () => {
  const first = renderHook(() => useWorkspacePreferences(), { wrapper: Provider });
  act(() => first.result.current.remember('machine-a', 'project-a', ['agent-a', 'agent-b']));
  first.unmount();

  const { result } = renderHook(() => useWorkspacePreferences(), { wrapper: Provider });
  expect(result.current.get('machine-a', 'agent-a')).toBe('project-a');
  expect(result.current.get('machine-a', 'agent-b')).toBe('project-a');
  expect(result.current.get('machine-a', 'agent-c')).toBeUndefined();
});
