import { permissionErrorKey } from '../errors';

const withCode = (code: string) => ({ response: { data: { code } } });

describe('permissionErrorKey', () => {
  it.each([
    ['RESOURCE_PERMISSIONS_BUSY', 'com_ui_permissions_busy'],
    ['RESOURCE_PERMISSIONS_UNAVAILABLE', 'com_ui_permissions_unavailable'],
    ['PERMISSION_AUDIT_UNAVAILABLE', 'com_ui_permissions_audit_unavailable'],
    ['PRINCIPAL_PREPARATION_FAILED', 'com_ui_permissions_principal_preparation_failed'],
    ['DIRECTORY_VERIFICATION_UNAVAILABLE', 'com_ui_permissions_directory_verification_unavailable'],
  ])('maps %s to an actionable message', (code, key) => {
    expect(
      permissionErrorKey({
        message: 'Internal database or directory diagnostic',
        response: {
          data: { ...withCode(code).response.data, message: 'Sensitive provider response' },
        },
      }),
    ).toBe(key);
  });

  it.each([
    withCode('SOMETHING_ELSE'),
    { response: { data: { message: 'DIRECTORY_VERIFICATION_UNAVAILABLE' } } },
    new Error('PRINCIPAL_PREPARATION_FAILED'),
    null,
    undefined,
  ])('falls back to the generic failure for %p', (error) => {
    expect(permissionErrorKey(error)).toBe('com_ui_permissions_failed_update');
  });
});
