import { renderHook } from '@testing-library/react';
import useUserKey from './useUserKey';

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: { Alias: { azure: true } } }),
}));
const mockQuery = jest.fn();
const mockSave = jest.fn();
jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: (name: string, options: object) => mockQuery(name, options),
  useUpdateUserKeysMutation: () => ({ mutateAsync: mockSave }),
}));
beforeEach(() => {
  mockSave.mockReset();
});
test.each([
  [null, undefined, false],
  ['never', 'never', true],
  ['2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', false],
  ['invalid', 'invalid', false],
  ['2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', true],
])('distinguishes key expiry %s from a saved indefinite key', (expiresAt, expected, valid) => {
  mockQuery.mockReturnValue({ data: { expiresAt } });
  const { result } = renderHook(() => useUserKey('Alias'));
  expect(result.current.getExpiry()).toBe(expected);
  expect(result.current.checkExpiry()).toBe(valid);
});
test('uses the exact configured name and propagates save failures', async () => {
  mockQuery.mockReturnValue({ data: { expiresAt: null } });
  mockSave.mockRejectedValue(new Error('Save failed'));
  const { result } = renderHook(() =>
    useUserKey('Alias', { keyName: 'CaseSensitive', enabled: false }),
  );
  expect(mockQuery).toHaveBeenCalledWith(
    'CaseSensitive',
    expect.objectContaining({ enabled: false }),
  );
  await expect(result.current.saveUserKey('test-value', null)).rejects.toThrow('Save failed');
  expect(mockSave).toHaveBeenCalledWith({
    name: 'CaseSensitive',
    value: 'test-value',
    expiresAt: '',
  });
});
