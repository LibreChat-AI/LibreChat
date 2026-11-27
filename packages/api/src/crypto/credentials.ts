import { encryptV3, decryptV3, encrypt, decrypt } from '@librechat/data-schemas';
import type { TCredentialsConfig } from 'librechat-data-provider';

const V3_PREFIX = 'v3:';

export type CredentialWriteFormat = TCredentialsConfig['writeFormat'];

/**
 * Encrypts a stored user credential (plugin, tool, or MCP custom user variable).
 * `v3` (the default) uses a random IV per value and carries the `v3:` prefix;
 * `legacy` writes the fixed-IV format that releases predating `v3` can read.
 */
export async function encryptCredential(
  value: string,
  format: CredentialWriteFormat = 'v3',
): Promise<string> {
  if (format === 'legacy') {
    return encrypt(value);
  }
  return encryptV3(value);
}

/**
 * Decrypts a stored user credential by format: `v3:` values use `decryptV3`,
 * anything else is a legacy fixed-IV value (hex only, so it can never start
 * with `v3:`) and uses the legacy `decrypt`.
 */
export async function decryptCredential(value: string): Promise<string> {
  if (value.startsWith(V3_PREFIX)) {
    return decryptV3(value);
  }
  return decrypt(value);
}
