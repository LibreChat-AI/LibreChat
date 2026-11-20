const CREDS_KEY: string = 'a'.repeat(64);
const CREDS_IV: string = 'b'.repeat(32);

let credCrypto: typeof import('./index');

beforeAll(async () => {
  process.env.CREDS_KEY = CREDS_KEY;
  process.env.CREDS_IV = CREDS_IV;
  credCrypto = await import('./index');
});

describe('decryptV2', () => {
  it('round-trips a value encrypted with encryptV2', async () => {
    const encrypted = await credCrypto.encryptV2('secret-token');
    expect(encrypted).toContain(':');
    await expect(credCrypto.decryptV2(encrypted)).resolves.toBe('secret-token');
  });

  it('rejects undelimited input instead of returning it as plaintext', async () => {
    await expect(credCrypto.decryptV2('plain-token')).rejects.toThrow('Invalid encrypted value');
    await expect(credCrypto.decryptV2('')).rejects.toThrow('Invalid encrypted value');
  });
});

describe('encryptV3', () => {
  it('uses a fresh IV per value', () => {
    expect(credCrypto.encryptV3('same')).not.toBe(credCrypto.encryptV3('same'));
  });
});
