import mongoose from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IUser, RecordAuditEntryInput } from '@librechat/data-schemas';
import { writeIdpRoleChange } from './openidRoleSync';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

async function createUser(role?: string): Promise<string> {
  const doc = await mongoose.models.User.create({
    email: `idp-${new mongoose.Types.ObjectId().toString()}@example.com`,
    provider: 'openid',
    role,
  });
  if (role === undefined) {
    await mongoose.models.User.updateOne({ _id: doc._id }, { $unset: { role: '' } });
  }
  return doc._id.toString();
}

async function storedRole(userId: string): Promise<string | undefined> {
  const user = await methods.findUser({ _id: userId }, 'role');
  return user?.role;
}

function write(userId: string, update: Partial<IUser>, observedRole: string | undefined) {
  const entries: RecordAuditEntryInput[] = [];
  const result = writeIdpRoleChange({
    userId,
    update,
    observedRole,
    updateUser: methods.updateUser,
    findUser: methods.findUser,
    recordAuditEntry: async (entry) => {
      entries.push(entry);
    },
    source: 'openid_login',
  });
  return { entries, result };
}

describe('writeIdpRoleChange against MongoDB', () => {
  it('audits one transition when overlapping logins move the role from the same read', async () => {
    const userId = await createUser(SystemRoles.USER);
    const first = write(userId, { role: SystemRoles.ADMIN }, SystemRoles.USER);
    const second = write(userId, { role: SystemRoles.ADMIN }, SystemRoles.USER);

    const users = await Promise.all([first.result, second.result]);

    expect(users.map((user) => user?.role)).toEqual([SystemRoles.ADMIN, SystemRoles.ADMIN]);
    expect(await storedRole(userId)).toBe(SystemRoles.ADMIN);
    const entries = [...first.entries, ...second.entries];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'user.role_changed',
      severity: 'critical',
      target: { type: 'user', id: userId },
      metadata: { previousRole: SystemRoles.USER, role: SystemRoles.ADMIN, source: 'openid_login' },
    });
  });

  it('audits the role a login replaced when a concurrent write moved it after the read', async () => {
    const userId = await createUser(SystemRoles.USER);
    await methods.updateUser(userId, { role: SystemRoles.ADMIN });

    const { entries, result } = write(userId, { role: SystemRoles.USER }, SystemRoles.USER);

    expect((await result)?.role).toBe(SystemRoles.USER);
    expect(await storedRole(userId)).toBe(SystemRoles.USER);
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({
      previousRole: SystemRoles.ADMIN,
      role: SystemRoles.USER,
    });
  });

  it('does not audit a login that keeps the role it read', async () => {
    const userId = await createUser('BASIC-USER');

    const { entries, result } = write(userId, { role: 'BASIC-USER', name: 'Kept' }, 'BASIC-USER');

    expect(await result).toMatchObject({ role: 'BASIC-USER', name: 'Kept' });
    expect(entries).toHaveLength(0);
  });

  it('audits a legacy account without a stored role from an unset role', async () => {
    const userId = await createUser(undefined);
    expect(await storedRole(userId)).toBeUndefined();

    const { entries, result } = write(userId, { role: 'BASIC-USER' }, undefined);

    expect((await result)?.role).toBe('BASIC-USER');
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ previousRole: null, role: 'BASIC-USER' });
  });

  it('resolves null without an audit entry when the user was deleted before the write', async () => {
    const userId = await createUser(SystemRoles.USER);
    await mongoose.models.User.deleteOne({ _id: userId });

    const { entries, result } = write(userId, { role: SystemRoles.ADMIN }, SystemRoles.USER);

    expect(await result).toBeNull();
    expect(entries).toHaveLength(0);
    expect(await mongoose.models.User.countDocuments({ _id: userId })).toBe(0);
  });
});
