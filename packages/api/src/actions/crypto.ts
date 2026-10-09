import { encryptV2, decryptV2 } from '@librechat/data-schemas';

/**
 * Encrypts an action credential, encoding it first so that reserved characters (`@`, `+`, `=`,
 * `/`, `:`) survive storage.
 */
export async function encryptSensitiveValue(value: string): Promise<string> {
  return encryptV2(encodeURIComponent(value));
}

/**
 * Decrypts an action credential, reversing the encoding applied by {@link encryptSensitiveValue}.
 *
 * Encoding before encryption was introduced in 299cabd6e (March 2025). Credentials stored earlier
 * were encrypted raw and carry no marker saying so, so a legacy value containing a stray `%` would
 * make `decodeURIComponent` throw `URIError`; those are returned as decrypted.
 *
 * Every reader of these fields must use this helper. Decoding in one read path but not another
 * sends different credentials to the provider depending on which path ran.
 */
export async function decryptSensitiveValue(encryptedValue: string): Promise<string> {
  const decryptedValue = await decryptV2(encryptedValue);

  try {
    return decodeURIComponent(decryptedValue);
  } catch {
    return decryptedValue;
  }
}
