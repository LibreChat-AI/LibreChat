import { formatDistanceToNow } from 'date-fns';

import type { TranslationKeys } from '~/hooks';

export const EXPIRY_NEVER = 'never';
export const DEFAULT_EXPIRY = '30';

export const EXPIRY_OPTIONS: { value: string; labelKey: TranslationKeys }[] = [
  { value: '7', labelKey: 'com_ui_api_key_expire_7d' },
  { value: '30', labelKey: 'com_ui_api_key_expire_30d' },
  { value: '90', labelKey: 'com_ui_api_key_expire_90d' },
  { value: '365', labelKey: 'com_ui_api_key_expire_1y' },
  { value: EXPIRY_NEVER, labelKey: 'com_ui_api_key_expire_never' },
];

const MS_PER_DAY = 86400000;
const EXPIRING_THRESHOLD_DAYS = 14;

export function computeExpiresAt(option: string): string | null {
  if (option === EXPIRY_NEVER) {
    return null;
  }
  const days = Number(option);
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }
  return new Date(Date.now() + days * MS_PER_DAY).toISOString();
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return '';
  }
  return formatDistanceToNow(date, { addSuffix: true });
}

export type ExpiryStatus = { state: 'expired' } | { state: 'expiring'; days: number } | null;

export function getExpiryStatus(expiresAt?: string, now: Date = new Date()): ExpiryStatus {
  if (!expiresAt) {
    return null;
  }
  const diffMs = new Date(expiresAt).getTime() - now.getTime();
  if (diffMs <= 0) {
    return { state: 'expired' };
  }
  const days = Math.ceil(diffMs / MS_PER_DAY);
  if (days <= EXPIRING_THRESHOLD_DAYS) {
    return { state: 'expiring', days };
  }
  return null;
}
