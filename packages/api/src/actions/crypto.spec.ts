process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Loaded via dynamic import in beforeAll so encryption initializes after
// CREDS_KEY is set above (encryptV2 reads the key at module load).
let encryptSensitiveValue: typeof import('./crypto').encryptSensitiveValue;
let decryptSensitiveValue: typeof import('./crypto').decryptSensitiveValue;
let encryptV2: typeof import('@librechat/data-schemas').encryptV2;

beforeAll(async () => {
  ({ encryptSensitiveValue, decryptSensitiveValue } = await import('./crypto'));
  ({ encryptV2 } = await import('@librechat/data-schemas'));
});

describe('action credential encryption', () => {
  describe('round trip', () => {
    it.each([
      ['an email-style client id', 'client@id.com'],
      ['reserved characters', 's+cret=/end'],
      ['a colon', 'user:pass'],
      ['a literal percent sign', '100%secret'],
      ['a plus sign that must not become a space', 'a+b'],
      ['a literal percent escape', 'secret%2Fvalue'],
      ['unicode', 'sécret-π'],
    ])('preserves %s', async (_label, value) => {
      expect(await decryptSensitiveValue(await encryptSensitiveValue(value))).toBe(value);
    });
  });

  describe('credentials stored before encoding was introduced', () => {
    it('returns a pre-encoding value unchanged', async () => {
      const stored = await encryptV2('plain-secret');

      expect(await decryptSensitiveValue(stored)).toBe('plain-secret');
    });

    /**
     * Regression: decoding unconditionally threw `URIError` here, which broke every read of the
     * action rather than just mangling the credential.
     */
    it('does not throw on a pre-encoding value containing a stray percent sign', async () => {
      const stored = await encryptV2('100%secret');

      await expect(decryptSensitiveValue(stored)).resolves.toBe('100%secret');
    });

    /**
     * Known, pre-existing limitation rather than desired behaviour: stored values carry no marker
     * saying whether they were encoded, so a pre-encoding credential that happens to contain a
     * valid escape is indistinguishable from an encoded one and is still decoded. Re-saving the
     * action rewrites it in the encoded format and settles the ambiguity.
     */
    it('still rewrites a pre-encoding value that happens to contain a valid escape', async () => {
      const stored = await encryptV2('secret%2Fvalue');

      expect(await decryptSensitiveValue(stored)).toBe('secret/value');
    });
  });
});
