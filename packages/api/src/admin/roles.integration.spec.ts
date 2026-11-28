import mongoose from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, logger } from '@librechat/data-schemas';
import type { IUser, RecordAuditEntryInput } from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import type { AdminRolesDeps } from './roles';
import { createAdminRolesHandlers } from './roles';

/**
 * An administrator adds a member to a role while another deletes it, over real collections: the
 * admin role handlers with the data-schemas methods the routes wire. Whichever side commits last,
 * no account is left holding the name of a role that is gone, and the audit trail names every
 * move that happened.
 */

const LIFECYCLE_TIMEOUT_MS = 180_000;

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  jest.spyOn(logger, 'error').mockReturnValue(logger);
  jest.spyOn(logger, 'warn').mockReturnValue(logger);
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(['Role', 'User'].map((name) => mongoose.models[name].deleteMany({})));
});

type Reply = { status: number; body: unknown };

function call(
  handler: (req: ServerRequest, res: Response) => Promise<Response>,
  params: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<Reply> {
  const reply: Reply = { status: 200, body: undefined };
  const res = {
    status: (code: number) => {
      reply.status = code;
      return res;
    },
    json: (data: unknown) => {
      reply.body = data;
      return res;
    },
  } as unknown as Response;
  const req = {
    params,
    body,
    query: {},
    headers: {},
    user: { _id: new mongoose.Types.ObjectId(), role: SystemRoles.ADMIN, name: 'Admin' },
  } as unknown as ServerRequest;
  return handler(req, res).then(() => reply);
}

/** The handlers the admin roles route builds, auditing into `entries`. */
function roleHandlers(entries: RecordAuditEntryInput[], overrides: Partial<AdminRolesDeps> = {}) {
  return createAdminRolesHandlers({
    listRoles: methods.listRoles,
    countRoles: methods.countRoles,
    getRoleByName: methods.getPartitionRole,
    createRoleByName: methods.createRoleByName,
    updateRoleByName: methods.updateRoleByName,
    updateAccessPermissions: methods.updateAccessPermissions,
    deleteRoleByName: methods.deleteRoleByName,
    findUser: methods.findUser,
    updateUser: methods.updateUser,
    prepareRoleMembers: methods.prepareRoleMembers,
    reserveRoleRename: methods.reserveRoleRename,
    settleRoleRename: methods.settleRoleRename,
    listUsersByRole: methods.listUsersByRole,
    countUsersByRole: methods.countUsersByRole,
    deleteConfig: methods.deleteConfig,
    deleteAclEntries: methods.deletePrincipalAclEntries,
    deleteGrantsForPrincipal: methods.deleteGrantsForPrincipal,
    recordAuditEntry: async (entry) => {
      entries.push(entry);
    },
    ...overrides,
  });
}

async function createMember(role: string, email = 'member@example.com'): Promise<string> {
  const user = await mongoose.models.User.create({ email, role });
  return user._id.toString();
}

async function storedRole(userId: string): Promise<string | undefined> {
  return (await methods.findUser({ _id: userId }, 'role'))?.role;
}

/** The ids each `role.member_removed` entry a role deletion wrote lists. */
const removedByDeletion = (entries: RecordAuditEntryInput[]) =>
  entries
    .filter((entry) => entry.action === 'role.member_removed')
    .filter((entry) => entry.metadata?.cause === 'role_deleted')
    .flatMap((entry) => String(entry.metadata?.userIds).split(','));

describe('adding a member to a role while it is deleted', () => {
  it('an add that commits after the deletion read its members ends on USER, audited by the deletion', async () => {
    await methods.createRoleByName({ name: 'editor' });
    const userId = await createMember(SystemRoles.USER);
    const entries: RecordAuditEntryInput[] = [];
    const handlers = roleHandlers(entries);
    let added: Reply | undefined;
    /** The deletion found no members left; the add runs to completion before the role delete. */
    const Role = mongoose.models.Role;
    const real = Role.findOneAndDelete.bind(Role);
    const spy = jest.spyOn(Role, 'findOneAndDelete').mockImplementationOnce(((
      filter: mongoose.FilterQuery<unknown>,
    ) => {
      const query = real(filter);
      const exec = query.exec.bind(query);
      query.exec = (async () => {
        added = await call(handlers.addRoleMember, { name: 'editor' }, { userId });
        return exec();
      }) as typeof query.exec;
      return query;
    }) as unknown as typeof Role.findOneAndDelete);

    let deleted: Reply;
    try {
      deleted = await call(handlers.deleteRole, { name: 'editor' });
    } finally {
      spy.mockRestore();
    }

    expect(added).toEqual({ status: 200, body: { success: true } });
    expect(deleted).toEqual({ status: 200, body: { success: true } });
    expect(await storedRole(userId)).toBe(SystemRoles.USER);
    expect(removedByDeletion(entries)).toEqual([userId]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        action: 'role.member_added',
        metadata: expect.objectContaining({ userId }),
      }),
    );
  });

  it('an add whose role is deleted before its write commits is undone and answers 404', async () => {
    await methods.createRoleByName({ name: 'editor' });
    await methods.createRoleByName({ name: 'viewer' });
    const userId = await createMember('viewer');
    const entries: RecordAuditEntryInput[] = [];
    let deleted: Reply | undefined;
    /** The add read the role, then the whole deletion runs before the add reads the user. */
    const handlers = roleHandlers(entries, {
      findUser: async (criteria, fields) => {
        deleted ??= await call(handlers.deleteRole, { name: 'editor' });
        return methods.findUser(criteria, fields);
      },
    });

    const added = await call(handlers.addRoleMember, { name: 'editor' }, { userId });

    expect(deleted).toEqual({ status: 200, body: { success: true } });
    expect(added).toEqual({ status: 404, body: { error: 'Role not found' } });
    expect(await storedRole(userId)).toBe('viewer');
    expect(entries.filter((entry) => entry.action === 'role.member_added')).toEqual([]);
  });

  it.each([
    ['deleted', false],
    ['deleted and recreated under its name', true],
  ])(
    'an undone add whose previous role was %s meanwhile moves the user on to USER',
    async (_label, recreate) => {
      await methods.createRoleByName({ name: 'editor' });
      await methods.createRoleByName({ name: 'viewer' });
      const userId = await createMember('viewer');
      const entries: RecordAuditEntryInput[] = [];
      const deleted: Reply[] = [];
      /** `editor` is deleted after the add read it and before its write, and `viewer` right
       * after the write, while the user holds `editor`: neither deletion sees the user. */
      const handlers = roleHandlers(entries, {
        findUser: async (criteria, fields) => {
          if (deleted.length === 0) {
            deleted.push(await call(handlers.deleteRole, { name: 'editor' }));
          }
          return methods.findUser(criteria, fields);
        },
        updateUser: async (id, data, expected) => {
          const updated = await methods.updateUser(id, data, expected as FilterQuery<IUser>);
          if (data.role === 'editor' && deleted.length === 1) {
            deleted.push(await call(handlers.deleteRole, { name: 'viewer' }));
            if (recreate) {
              await methods.createRoleByName({ name: 'viewer' });
            }
          }
          return updated;
        },
      });

      const added = await call(handlers.addRoleMember, { name: 'editor' }, { userId });

      const success = { status: 200, body: { success: true } };
      expect(deleted).toEqual([success, success]);
      expect(added).toEqual({ status: 404, body: { error: 'Role not found' } });
      expect(await storedRole(userId)).toBe(SystemRoles.USER);
      expect(entries).toContainEqual(
        expect.objectContaining({
          action: 'role.member_removed',
          target: expect.objectContaining({ id: 'viewer' }),
          metadata: { userId, newRole: SystemRoles.USER, cause: 'role_deleted' },
        }),
      );
      expect(entries.filter((entry) => entry.action === 'role.member_added')).toEqual([]);
    },
  );

  it('an undone add leaves a later add of the role recreated under its name in place', async () => {
    await methods.createRoleByName({ name: 'editor' });
    await methods.createRoleByName({ name: 'viewer' });
    const userId = await createMember('viewer');
    const entries: RecordAuditEntryInput[] = [];
    let deleted: Reply | undefined;
    let later: Reply | undefined;
    /** After the first add's write and before it reads the role back, the role is deleted
     * (moving the user to USER), recreated under its name, and a second add assigns the user to
     * the new role: the first add's undo must not take that assignment back. */
    const handlers = roleHandlers(entries, {
      updateUser: async (id, data, expected) => {
        const updated = await methods.updateUser(id, data, expected as FilterQuery<IUser>);
        if (data.role === 'editor' && deleted === undefined) {
          deleted = await call(handlers.deleteRole, { name: 'editor' });
          await methods.createRoleByName({ name: 'editor' });
          later = await call(handlers.addRoleMember, { name: 'editor' }, { userId });
        }
        return updated;
      },
    });

    const first = await call(handlers.addRoleMember, { name: 'editor' }, { userId });

    const success = { status: 200, body: { success: true } };
    expect(deleted).toEqual(success);
    expect(later).toEqual(success);
    expect(first).toEqual({ status: 404, body: { error: 'Role not found' } });
    expect(await storedRole(userId)).toBe('editor');
  });

  it('keeps an admin when the last two are added to a role deleted before either reads it back', async () => {
    await methods.createRoleByName({ name: 'editor' });
    const admins = [
      await createMember(SystemRoles.ADMIN, 'first-admin@example.com'),
      await createMember(SystemRoles.ADMIN, 'second-admin@example.com'),
    ];
    const entries: RecordAuditEntryInput[] = [];
    /** Opens once every add has reached it. */
    const barrier = () => {
      let count = 0;
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return async (before?: () => Promise<unknown>) => {
        count += 1;
        if (count === admins.length) {
          await before?.();
          open();
        }
        await opened;
      };
    };
    /** Both adds pass their admin check before either writes; once both writes commit, the role
     * is deleted (moving both to USER) before either goes on. */
    const checked = barrier();
    const written = barrier();
    const handlers = roleHandlers(entries, {
      updateUser: async (id, data, expected) => {
        if (data.role !== 'editor') {
          return methods.updateUser(id, data, expected as FilterQuery<IUser>);
        }
        await checked();
        const updated = await methods.updateUser(id, data, expected as FilterQuery<IUser>);
        await written(() => call(handlers.deleteRole, { name: 'editor' }));
        return updated;
      },
    });

    const replies = await Promise.all(
      admins.map((userId) => call(handlers.addRoleMember, { name: 'editor' }, { userId })),
    );

    expect(replies.map(({ status }) => status)).not.toContain(200);
    expect(await methods.countUsersByRole(SystemRoles.ADMIN)).toBeGreaterThanOrEqual(1);
  });
});
