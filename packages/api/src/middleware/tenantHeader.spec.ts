import { rejectTenantHeader } from './tenantHeader';

it('reserves the channel tenantless identifier without banning underscores inside real tenant IDs', () => {
  expect(rejectTenantHeader('_')).toBe('reserved');
  expect(rejectTenantHeader('org_1')).toBeUndefined();
  expect(rejectTenantHeader('__SYSTEM__')).toBe('system');
});
