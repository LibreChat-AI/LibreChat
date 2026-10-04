import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export interface PrivateTextCipher {
  seal(text: string, binding: readonly string[]): string;
  open(envelope: string, binding: readonly string[]): string;
  revision(value: readonly string[]): string;
}

/** Uses the deployment credential key, domain-separated from credential encryption. */
export function createPrivateTextCipher(hexKey: string): PrivateTextCipher {
  if (!/^[a-fA-F0-9]{64}$/.test(hexKey)) {
    throw new Error('Private message encryption is unavailable.');
  }
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(hexKey, 'hex'), '', 'librechat-owner-text-v1', 32),
  );
  const aad = (binding: readonly string[]) =>
    Buffer.from(JSON.stringify(['owner-text-v1', ...binding]));
  return {
    revision(value) {
      return createHmac('sha256', key).update(aad(value)).digest('hex').slice(0, 32);
    },
    seal(text, binding) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(binding));
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [
        'v1',
        nonce.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        ciphertext.toString('base64'),
      ].join(':');
    },
    open(envelope, binding) {
      try {
        const [version, nonce, tag, ciphertext, extra] = envelope.split(':');
        if (version !== 'v1' || extra != null || !nonce || !tag || ciphertext == null) {
          throw new Error();
        }
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
        decipher.setAAD(aad(binding));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new Error('Private message text is unavailable.');
      }
    },
  };
}
