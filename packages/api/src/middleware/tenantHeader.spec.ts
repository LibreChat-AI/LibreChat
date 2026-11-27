import { rejectTenantHeader } from './tenantHeader';

it('reserves the channel tenantless identifier without banning underscores inside real tenant IDs', () => {
  expect(rejectTenantHeader('_')).toBe('reserved');
  expect(rejectTenantHeader('org_1')).toBeUndefined();
  expect(rejectTenantHeader('org.with.periods')).toBeUndefined();
  expect(rejectTenantHeader('a'.repeat(128))).toBeUndefined();
  expect(rejectTenantHeader('a'.repeat(129))).toBe('malformed');
  expect(rejectTenantHeader('org/name')).toBe('malformed');
  expect(rejectTenantHeader('__SYSTEM__')).toBe('system');
});
