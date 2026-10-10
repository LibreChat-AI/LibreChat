import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createPasskeyMethods } from './passkey';
import passkeySchema from '~/schema/passkey';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createPasskeyMethods>;

const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();

const passkeyData = (overrides: Partial<t.PasskeyCreateData> = {}): t.PasskeyCreateData => ({
  user: userId.toString(),
  credentialId: 'credential-one',
  publicKey: Buffer.from([1, 2, 3]),
  counter: 0,
  transports: ['internal'],
  deviceType: 'multiDevice',
  backedUp: true,
  name: 'This device',
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.Passkey) {
    mongoose.model<t.IPasskey>('Passkey', passkeySchema);
  }
  methods = createPasskeyMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.models.Passkey.syncIndexes();
});

describe('createPasskey', () => {
  it('stores the credential with its public key intact', async () => {
    const created = await methods.createPasskey(passkeyData());

    expect(created.credentialId).toBe('credential-one');
    expect(Buffer.from(created.publicKey).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(created.backedUp).toBe(true);
    expect(created.lastUsedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('returns a plain record, not a Mongoose document', async () => {
    await methods.createPasskey(passkeyData());

    const found = await methods.findPasskeyByCredentialId('credential-one');

    expect(found).not.toHaveProperty('$__');
    expect(found).not.toHaveProperty('_doc');
    expect(found?.id).toMatch(/^[a-f\d]{24}$/);
    expect(found?.userId).toBe(userId.toString());
  });

  it('rejects a credential ID that is already registered', async () => {
    await methods.createPasskey(passkeyData());

    await expect(
      methods.createPasskey(passkeyData({ user: otherUserId.toString(), name: 'Someone else' })),
    ).rejects.toThrow();
  });

  it('builds the unique credential index itself when auto-indexing never ran', async () => {
    await mongoose.connection.dropDatabase();
    const freshMethods = createPasskeyMethods(mongoose);

    await freshMethods.createPasskey(passkeyData());

    await expect(
      freshMethods.createPasskey(
        passkeyData({ user: otherUserId.toString(), name: 'Someone else' }),
      ),
    ).rejects.toThrow(/duplicate key/);
    expect(await mongoose.models.Passkey.countDocuments({ credentialId: 'credential-one' })).toBe(
      1,
    );
  });
});

describe('findPasskeysByUser', () => {
  it('returns only the requested user credentials, newest first', async () => {
    // Explicit dates keep the ordering assertion independent of insertion speed.
    // Insert oldest first so natural insertion order cannot satisfy the assertion.
    await mongoose.models.Passkey.insertMany([
      {
        ...passkeyData({ credentialId: 'a', name: 'First' }),
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
      {
        ...passkeyData({ credentialId: 'b', name: 'Second' }),
        createdAt: new Date('2024-01-02T00:00:00Z'),
      },
      {
        ...passkeyData({ credentialId: 'c', name: 'Other user', user: otherUserId.toString() }),
        createdAt: new Date('2024-01-03T00:00:00Z'),
      },
    ]);

    const found = await methods.findPasskeysByUser(userId.toString());

    expect(found.map((passkey) => passkey.name)).toEqual(['Second', 'First']);
    expect(await methods.countPasskeysByUser(userId.toString())).toBe(2);
  });
});

describe('findPasskeyByCredentialId', () => {
  it('resolves the owning user without a user scope, as sign-in requires', async () => {
    await methods.createPasskey(passkeyData());

    const found = await methods.findPasskeyByCredentialId('credential-one');

    expect(found?.userId).toBe(userId.toString());
  });

  it('returns null for an unknown credential', async () => {
    expect(await methods.findPasskeyByCredentialId('nope')).toBeNull();
  });

  /**
   * `lean()` hands back a BSON `Binary`, and `new Uint8Array(binary)` yields
   * zero bytes, which would make every signature verification fail. Assert on
   * the read path, not the write path, since only the read path is affected.
   */
  it('returns the public key as a Buffer that survives Uint8Array conversion', async () => {
    const publicKey = Buffer.from([9, 8, 7, 6, 5]);
    await methods.createPasskey(passkeyData({ publicKey }));

    const found = await methods.findPasskeyByCredentialId('credential-one');

    expect(Buffer.isBuffer(found?.publicKey)).toBe(true);
    expect(new Uint8Array(found!.publicKey)).toEqual(new Uint8Array(publicKey));
  });

  it('returns Buffer public keys when listing a user credentials', async () => {
    const publicKey = Buffer.from([4, 3, 2, 1]);
    await methods.createPasskey(passkeyData({ publicKey }));

    const [found] = await methods.findPasskeysByUser(userId.toString());

    expect(Buffer.isBuffer(found.publicKey)).toBe(true);
    expect(new Uint8Array(found.publicKey)).toEqual(new Uint8Array(publicKey));
  });
});

describe('recordPasskeyUse', () => {
  it('advances the signature counter and stamps last use', async () => {
    await methods.createPasskey(passkeyData());

    await expect(methods.recordPasskeyUse('credential-one', 7)).resolves.toBe(true);

    const updated = await methods.findPasskeyByCredentialId('credential-one');
    expect(updated?.counter).toBe(7);
    expect(updated?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('refreshes the backup state alongside the counter', async () => {
    await methods.createPasskey(passkeyData({ backedUp: false }));

    await expect(methods.recordPasskeyUse('credential-one', 7, true)).resolves.toBe(true);
    expect((await methods.findPasskeyByCredentialId('credential-one'))?.backedUp).toBe(true);

    await expect(methods.recordPasskeyUse('credential-one', 8, false)).resolves.toBe(true);
    expect((await methods.findPasskeyByCredentialId('credential-one'))?.backedUp).toBe(false);
  });

  it('leaves the backup state alone when the assertion loses the counter race', async () => {
    await methods.createPasskey(passkeyData({ counter: 5, backedUp: false }));

    await expect(methods.recordPasskeyUse('credential-one', 3, true)).resolves.toBe(false);
    expect((await methods.findPasskeyByCredentialId('credential-one'))?.backedUp).toBe(false);
  });

  it('does not regress the counter when the new value is lower', async () => {
    await methods.createPasskey(passkeyData({ counter: 5 }));

    await expect(methods.recordPasskeyUse('credential-one', 3)).resolves.toBe(false);

    const updated = await methods.findPasskeyByCredentialId('credential-one');
    expect(updated?.counter).toBe(5);
    expect(updated?.lastUsedAt).toBeNull();
  });

  it('stamps last use when a counterless authenticator stays at 0', async () => {
    await methods.createPasskey(passkeyData({ counter: 0 }));

    await expect(methods.recordPasskeyUse('credential-one', 0)).resolves.toBe(true);

    const updated = await methods.findPasskeyByCredentialId('credential-one');
    expect(updated?.counter).toBe(0);
    expect(updated?.lastUsedAt).toBeInstanceOf(Date);
  });

  /**
   * Two assertions that verified against the same stored counter must not both
   * commit, otherwise a cloned authenticator is indistinguishable from the real one.
   */
  it('lets only one of two assertions at the same counter win', async () => {
    await methods.createPasskey(passkeyData({ counter: 5 }));

    const [first, second] = await Promise.all([
      methods.recordPasskeyUse('credential-one', 6),
      methods.recordPasskeyUse('credential-one', 6),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const updated = await methods.findPasskeyByCredentialId('credential-one');
    expect(updated?.counter).toBe(6);
  });

  it('reports a replay that repeats the stored counter', async () => {
    await methods.createPasskey(passkeyData({ counter: 5 }));

    await expect(methods.recordPasskeyUse('credential-one', 5)).resolves.toBe(false);
  });

  it('does not throw when the credential is gone', async () => {
    await expect(methods.recordPasskeyUse('missing', 1)).resolves.toBe(false);
  });

  describe('when the counter write fails', () => {
    const failWrite = () =>
      jest.spyOn(mongoose.models.Passkey, 'updateOne').mockReturnValue({
        exec: () => Promise.reject(new Error('write failed')),
      } as unknown as ReturnType<typeof mongoose.models.Passkey.updateOne>);

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('fails closed for a counter-capable credential', async () => {
      await methods.createPasskey(passkeyData({ counter: 5 }));
      failWrite();

      await expect(methods.recordPasskeyUse('credential-one', 6)).resolves.toBe(false);
    });

    it('lets a counterless credential through, since it carries no clone signal', async () => {
      await methods.createPasskey(passkeyData({ counter: 0 }));
      failWrite();

      await expect(methods.recordPasskeyUse('credential-one', 0)).resolves.toBe(true);
    });
  });
});

describe('renamePasskey', () => {
  it('renames a credential the user owns', async () => {
    const created = await methods.createPasskey(passkeyData());

    const renamed = await methods.renamePasskey(created.id, userId.toString(), 'Work laptop');

    expect(renamed?.name).toBe('Work laptop');
  });

  it('refuses to rename another user credential', async () => {
    const created = await methods.createPasskey(passkeyData());

    const renamed = await methods.renamePasskey(created.id, otherUserId.toString(), 'Stolen');

    expect(renamed).toBeNull();
    const untouched = await methods.findPasskeyByCredentialId('credential-one');
    expect(untouched?.name).toBe('This device');
  });
});

describe('deletePasskey', () => {
  it('deletes a credential the user owns', async () => {
    const created = await methods.createPasskey(passkeyData());

    const result = await methods.deletePasskey(created.id, userId.toString());

    expect(result.deletedCount).toBe(1);
    expect(await methods.findPasskeyByCredentialId('credential-one')).toBeNull();
  });

  it('refuses to delete another user credential', async () => {
    const created = await methods.createPasskey(passkeyData());

    const result = await methods.deletePasskey(created.id, otherUserId.toString());

    expect(result.deletedCount).toBe(0);
    expect(await methods.findPasskeyByCredentialId('credential-one')).not.toBeNull();
  });
});

describe('deletePasskeysByUser', () => {
  it('clears every credential for the user and leaves others alone', async () => {
    await methods.createPasskey(passkeyData({ credentialId: 'a' }));
    await methods.createPasskey(passkeyData({ credentialId: 'b' }));
    await methods.createPasskey(passkeyData({ credentialId: 'c', user: otherUserId.toString() }));

    const result = await methods.deletePasskeysByUser(userId.toString());

    expect(result.deletedCount).toBe(2);
    expect(await methods.countPasskeysByUser(otherUserId.toString())).toBe(1);
  });
});
