import { logger } from '@librechat/data-schemas';

const TRUTHY = new Set(['true', '1', 'yes', 'on', 'enabled']);
const FALSY = new Set(['false', '0', 'no', 'off', 'disabled', 'none']);

export function normalizeEnvValue(value: string | undefined): string {
  return value == null ? '' : value.trim().toLowerCase();
}

export function isFalsyEnvValue(value: string): boolean {
  return FALSY.has(value);
}

/**
 * Resolves a security toggle. Unrecognized values warn and fall back rather than
 * being treated as the opposite of the default, so a typo cannot silently flip a
 * deployment into the riskier setting.
 */
export function parseEnvSwitch(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  const normalized = normalizeEnvValue(value);
  if (normalized === '') {
    return fallback;
  }
  if (TRUTHY.has(normalized)) {
    return true;
  }
  if (FALSY.has(normalized)) {
    return false;
  }
  logger.warn(`[SecurityHeaders] Ignoring invalid ${name}="${value}"; using ${fallback}.`);
  return fallback;
}
