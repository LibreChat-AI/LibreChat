import type { TranslationKeys } from '~/hooks';

const PERMISSION_ERROR_KEYS: Record<string, TranslationKeys> = {
  RESOURCE_PERMISSIONS_BUSY: 'com_ui_permissions_busy',
  RESOURCE_PERMISSIONS_UNAVAILABLE: 'com_ui_permissions_unavailable',
  PERMISSION_AUDIT_UNAVAILABLE: 'com_ui_permissions_audit_unavailable',
};

/** The localized message for a failed permission update, from the stable code the API returns. */
export function permissionErrorKey(error: unknown): TranslationKeys {
  const code = (error as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
  return (code && PERMISSION_ERROR_KEYS[code]) || 'com_ui_permissions_failed_update';
}
