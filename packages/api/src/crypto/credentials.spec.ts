import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { encrypt, decrypt, createModels, createMethods } from '@librechat/data-schemas';
import type { PluginAuthMethods } from '@librechat/data-schemas';
import { encryptCredential, decryptCredential } from './credentials';
import { getPluginAuthMap } from '~/agents/auth';

describe('credential encryption', () => {
  it('writes v3 values with a fresh IV each time and reads them back', async () => {
    const first = await encryptCredential('sk-secret');
    const second = await encryptCredential('sk-secret');

    expect(first).toMatch(/^v3:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(second).not.toBe(first);
    await expect(decryptCredential(first)).resolves.toBe('sk-secret');
    await expect(decryptCredential(second)).resolves.toBe('sk-secret');
  });

  it('writes v3 when the format is v3 explicitly', async () => {
    const value = await encryptCredential('sk-secret', 'v3');

    expect(value).toMatch(/^v3:[0-9a-f]{32}:[0-9a-f]+$/);
    await expect(decryptCredential(value)).resolves.toBe('sk-secret');
  });

  it('writes the legacy fixed-IV format when configured, readable by legacy decrypt', async () => {
    const value = await encryptCredential('sk-secret', 'legacy');

    expect(value).toMatch(/^[0-9a-f]+$/);
    expect(value).toBe(await encrypt('sk-secret'));
    await expect(decrypt(value)).resolves.toBe('sk-secret');
    await expect(decryptCredential(value)).resolves.toBe('sk-secret');
  });

  it('still reads legacy fixed-IV values', async () => {
    const legacy = await encrypt('legacy-secret');

    expect(legacy.startsWith('v3:')).toBe(false);
    await expect(decryptCredential(legacy)).resolves.toBe('legacy-secret');
  });

  it('round-trips an empty string', async () => {
    await expect(decryptCredential(await encryptCredential(''))).resolves.toBe('');
  });
});

describe('getPluginAuthMap with mixed-version records', () => {
  let mongoServer: MongoMemoryServer;
  let methods: PluginAuthMethods;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    methods = createMethods(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('decrypts legacy and v3 records stored for the same plugin', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const pluginKey = 'mcp_server';
    await methods.updatePluginAuth({
      userId,
      pluginKey,
      authField: 'LEGACY_KEY',
      value: await encrypt('legacy-value'),
    });
    await methods.updatePluginAuth({
      userId,
      pluginKey,
      authField: 'NEW_KEY',
      value: await encryptCredential('new-value'),
    });

    const authMap = await getPluginAuthMap({
      userId,
      pluginKeys: [pluginKey],
      findPluginAuthsByKeys: methods.findPluginAuthsByKeys,
    });

    expect(authMap).toEqual({
      [pluginKey]: { LEGACY_KEY: 'legacy-value', NEW_KEY: 'new-value' },
    });
  });
});
