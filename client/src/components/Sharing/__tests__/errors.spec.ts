import { permissionErrorKey } from '../errors';

const withCode = (code: string) => ({ response: { data: { code } } });

describe('permissionErrorKey', () => {
  it.each([
    ['RESOURCE_PERMISSIONS_BUSY', 'com_ui_permissions_busy'],
    ['RESOURCE_PERMISSIONS_UNAVAILABLE', 'com_ui_permissions_unavailable'],
    ['PERMISSION_AUDIT_UNAVAILABLE', 'com_ui_permissions_audit_unavailable'],
  ])('maps %s to an actionable message', (code, key) => {
    expect(permissionErrorKey(withCode(code))).toBe(key);
  });

  it.each([withCode('SOMETHING_ELSE'), new Error('x'), null, undefined])(
    'falls back to the generic failure for %p',
    (error) => {
      expect(permissionErrorKey(error)).toBe('com_ui_permissions_failed_update');
    },
  );
});
