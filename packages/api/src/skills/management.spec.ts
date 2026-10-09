/* eslint jest/expect-expect: [warn, { assertFunctionNames: ['expect', '**.expect'] }] */
import express from 'express';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, tenantStorage } from '@librechat/data-schemas';
import { PermissionBits, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { AllMethods, IRole, IUser } from '@librechat/data-schemas';
import type { FiltersConfig } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { SkillManagementDeps } from './management';
import type { ServerRequest } from '~/types';
import { createSkillManagementHandlers } from './management';
import { createSkillsHandlers } from './handlers';

const tenantId = 'management-test';
const author = new Types.ObjectId();
const user = { id: author.toString(), _id: author, role: 'USER', tenantId } as IUser;
let server: MongoMemoryServer;
let db: AllMethods;
let app: express.Express;
let skillId: string;
let allowEdit: boolean;
let allowView: boolean;
let allowUse: boolean;
let canManage: boolean;
let authenticated: boolean;
let saveFile: jest.MockedFunction<SkillManagementDeps['saveFile']>;
let filters: FiltersConfig | undefined;
let readSkill: jest.SpyInstance;
let beforeList: jest.Mock;
let uploadLimiter: jest.MockedFunction<RequestHandler>;
let accessible: jest.Mock;
let publiclyAccessible: jest.Mock;
let publicStatus: jest.Mock;
let capabilityCheck: jest.Mock;
let originalStrict: string | undefined;
const inTenant = <T>(fn: () => T) => tenantStorage.run({ tenantId }, fn);

beforeAll(async () => {
  originalStrict = process.env.TENANT_ISOLATION_STRICT;
  process.env.TENANT_ISOLATION_STRICT = 'true';
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
  if (originalStrict == null) delete process.env.TENANT_ISOLATION_STRICT;
  else process.env.TENANT_ISOLATION_STRICT = originalStrict;
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  allowEdit = true;
  allowView = true;
  allowUse = true;
  canManage = false;
  authenticated = true;
  filters = undefined;
  readSkill = jest.spyOn(db, 'getSkillById');
  const { skill } = await inTenant(() =>
    db.createSkill({
      name: 'test-skill',
      description: 'Use this skill to test management operations safely.',
      body: 'Original instructions',
      author,
      authorName: 'Test',
      tenantId,
    }),
  );
  skillId = skill._id.toString();
  saveFile = jest.fn(async ({ relativePath, content }) => ({
    relativePath,
    bytes: Buffer.byteLength(content),
  }));
  beforeList = jest.fn();
  uploadLimiter = jest.fn((_req, _res, next) => next());
  accessible = jest.fn(async () => (allowView ? [new Types.ObjectId(skillId)] : []));
  publiclyAccessible = jest.fn(async () => []);
  publicStatus = jest.fn(async () => false);
  capabilityCheck = jest.fn(async () => canManage);
  const handlers = createSkillsHandlers({
    ...db,
    findAccessibleResources: accessible,
    findPubliclyAccessibleResources: publiclyAccessible,
    hasPublicPermission: publicStatus,
    grantPermission: async () => undefined,
    getStrategyFunctions: () => ({}),
    isValidObjectIdString: (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id),
  });
  const management = createSkillManagementHandlers({
    handlers,
    beforeList,
    fileWriteLimiters: [uploadLimiter],
    getSkillById: db.getSkillById,
    getRoleByName: async () =>
      ({
        permissions: {
          [PermissionTypes.SKILLS]: {
            [Permissions.USE]: allowUse,
            [Permissions.CREATE]: true,
          },
        },
      }) as IRole,
    checkPermission: async ({ requiredPermission }) =>
      requiredPermission === PermissionBits.EDIT ? allowEdit : allowView,
    saveFile,
    hasCapability: capabilityCheck,
  });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated) req.user = user;
    (req as ServerRequest).config = { filters } as ServerRequest['config'];
    tenantStorage.run({ tenantId }, next);
  });
  app.get('/skills', async (req, res) => {
    await management.list(req, res);
  });
  app.get('/skills/:id', async (req, res) => {
    await management.get(req, res);
  });
  app.patch('/skills/:id', async (req, res) => {
    await management.update(req, res);
  });
  app.get('/skills/:id/files', async (req, res) => {
    await management.listFiles(req, res);
  });
  app.get('/skills/:id/files/*relativePath', async (req, res) => {
    await management.getFile(req, res);
  });
  app.put('/skills/:id/files/*relativePath', async (req, res) => {
    await management.updateFile(req, res);
  });
});

it('lists and retrieves stable representations without ownership or storage internals', async () => {
  const list = await request(app).get('/skills').expect(200);
  expect(list.body).toMatchObject({
    object: 'list',
    first_id: skillId,
    last_id: skillId,
    has_more: false,
    after: null,
  });
  expect(list.body.data[0]).toMatchObject({ id: skillId, name: 'test-skill', version: 1 });
  expect(list.body.data[0]).not.toHaveProperty('body');
  const detail = await request(app).get(`/skills/${skillId}`).expect(200);
  expect(detail.body).toMatchObject({ id: skillId, body: 'Original instructions' });
  for (const key of ['_id', 'tenantId', 'author', 'sourceMetadata', 'source']) {
    expect(detail.body).not.toHaveProperty(key);
    expect(list.body.data[0]).not.toHaveProperty(key);
  }
});
it('reuses validation and versioned persistence for partial updates', async () => {
  const updated = await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 1, body: 'Updated instructions' })
    .expect(200);
  expect(updated.body).toMatchObject({
    id: skillId,
    version: 2,
    body: 'Updated instructions',
    name: 'test-skill',
  });
  expect(await inTenant(() => db.getSkillById(skillId))).toMatchObject({
    version: 2,
    body: 'Updated instructions',
  });
  const conflict = await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 1, body: 'Stale writer' })
    .expect(409);
  expect(conflict.body).toMatchObject({ error: { code: 'conflict' } });
  expect(conflict.body).not.toHaveProperty('current');
  await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 2, name: 'INVALID NAME' })
    .expect(400);
});
it.each(['tenantId', 'author', 'source', 'sourceMetadata', 'user', 'permissions'])(
  'rejects caller-controlled %s',
  async (key) => {
    await request(app)
      .patch(`/skills/${skillId}`)
      .send({ expectedVersion: 1, body: 'Updated', [key]: 'forged' })
      .expect(400);
    expect(await inTenant(() => db.getSkillById(skillId))).toMatchObject({ version: 1 });
  },
);
it.each([
  { expectedVersion: 0, body: 'x' },
  { body: 'x' },
  { expectedVersion: 1 },
  { expectedVersion: 1, body: null },
])('rejects malformed updates %j', async (body) => {
  await request(app).patch(`/skills/${skillId}`).send(body).expect(400);
});
it('hides inaccessible and cross-tenant Skills, including on file writes', async () => {
  allowView = false;
  allowEdit = false;
  await request(app).get(`/skills/${skillId}`).expect(404);
  await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 1, body: 'x' })
    .expect(404);
  await request(app)
    .put(`/skills/${skillId}/files/reference.md`)
    .send({ content: 'x' })
    .expect(404);
  expect(saveFile).not.toHaveBeenCalled();
  allowView = true;
  allowEdit = true;
  const { skill } = await tenantStorage.run({ tenantId: 'foreign' }, () =>
    db.createSkill({
      name: 'foreign',
      description: 'Foreign tenant skill for access isolation tests.',
      body: 'secret',
      author,
      authorName: 'Foreign',
      tenantId: 'foreign',
    }),
  );
  await request(app).get(`/skills/${skill._id}`).set('x-tenant-id', 'foreign').expect(404);
  await request(app)
    .patch(`/skills/${skill._id}`)
    .send({ expectedVersion: 1, body: 'x' })
    .expect(404);
});
it('allows viewing without allowing editing', async () => {
  allowEdit = false;
  await request(app).get(`/skills/${skillId}`).expect(200);
  await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 1, body: 'x' })
    .expect(404);
});
it('enforces authentication and the Skills role gate', async () => {
  authenticated = false;
  await request(app).get('/skills').expect(403);
  authenticated = true;
  allowUse = false;
  await request(app).get('/skills').expect(403);
});
it('keeps synchronized Skill content and files read-only', async () => {
  await inTenant(() =>
    db.updateSkill({ id: skillId, expectedVersion: 1, update: { source: 'github' } }),
  );
  await request(app).get(`/skills/${skillId}`).expect(200);
  await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 2, body: 'x' })
    .expect(403);
  await request(app)
    .put(`/skills/${skillId}/files/reference.md`)
    .send({ content: 'x' })
    .expect(403);
  expect(saveFile).not.toHaveBeenCalled();
});
it('writes nested text files through existing storage and rejects unsafe paths', async () => {
  await request(app)
    .put(`/skills/${skillId}/files/references/guide.md`)
    .send({ content: 'Guide' })
    .expect(200);
  expect(saveFile).toHaveBeenCalledWith(
    expect.objectContaining({
      skillId,
      relativePath: 'references/guide.md',
      content: 'Guide',
      mimeType: 'text/plain',
    }),
  );
  saveFile.mockClear();
  for (const path of [
    'SKILL.md',
    'SKILL.md/child.md',
    '..%2Fescape.md',
    'bad%5Cpath.md',
    'x'.repeat(1025),
  ]) {
    await request(app).put(`/skills/${skillId}/files/${path}`).send({ content: 'x' }).expect(400);
  }
  expect(saveFile).not.toHaveBeenCalled();
});
it('rejects raw downloads and malformed pagination', async () => {
  await request(app).get(`/skills/${skillId}/files/SKILL.md?raw=true`).expect(400);
  await request(app).get('/skills?limit=0').expect(400);
  await request(app).get('/skills?cursor=garbage').expect(400);
  await request(app).get('/skills?tenantId=foreign').expect(400);
});

it('preserves the resource-management capability without bypassing tenant isolation', async () => {
  allowEdit = false;
  canManage = true;
  allowView = false;
  const response = await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 1, body: 'Managed update' })
    .expect(200);
  expect(response.body.body).toBe('Managed update');
  const { skill } = await tenantStorage.run({ tenantId: 'foreign' }, () =>
    db.createSkill({
      name: 'foreign',
      description: 'Foreign tenant skill for capability isolation tests.',
      body: 'secret',
      author,
      authorName: 'Foreign',
      tenantId: 'foreign',
    }),
  );
  await request(app)
    .patch(`/skills/${skill._id}`)
    .send({ expectedVersion: 1, body: 'x' })
    .expect(404);
  const list = await request(app).get('/skills').expect(200);
  expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([skillId]);
  canManage = false;
  const denied = await request(app).get('/skills').expect(200);
  expect(denied.body.data).toEqual([]);
});

it('reuses the authorized Skill on detail reads', async () => {
  await request(app).get(`/skills/${skillId}`).expect(200);
  expect(readSkill).toHaveBeenCalledTimes(1);
});
it('classifies content-policy blocks as invalid input and never writes the file', async () => {
  filters = {
    skills: {
      pii: {
        fields: ['file_text'],
        starterPatterns: [],
        customPatterns: [{ id: 'private', label: 'private text', regex: 'PRIVATE-TEXT' }],
      },
    },
  };
  const result = await request(app)
    .put(`/skills/${skillId}/files/notes.md`)
    .send({ content: 'PRIVATE-TEXT' })
    .expect(400);
  expect(result.body).toMatchObject({ error: { code: 'invalid_request' } });
  expect(saveFile).not.toHaveBeenCalled();
});
it('returns a documented 409 when another writer changes the skill file during the save', async () => {
  saveFile.mockRejectedValueOnce(
    Object.assign(new Error('private file storage revision'), { code: 'SKILL_FILE_CONFLICT' }),
  );
  const result = await request(app)
    .put(`/skills/${skillId}/files/notes.md`)
    .send({ content: 'Notes' })
    .expect(409);
  expect(result.body).toEqual({ error: { code: 'conflict', message: 'Resource conflict' } });
});

it('returns safe errors for storage failures', async () => {
  saveFile.mockRejectedValueOnce(new Error('secret-storage-path'));
  const result = await request(app)
    .put(`/skills/${skillId}/files/notes.md`)
    .send({ content: 'Notes' })
    .expect(500);
  expect(result.body).toEqual({
    error: { code: 'internal_error', message: 'Internal server error' },
  });
});

it('reuses the authorized Skill for SKILL.md reads', async () => {
  const response = await request(app).get(`/skills/${skillId}/files/SKILL.md`).expect(200);
  expect(response.body.content).toBe('Original instructions');
  expect(readSkill).toHaveBeenCalledTimes(1);
});
it.each(['1e2', '0x10'])('honors normalized pagination for limit=%s', async (limit) => {
  canManage = true;
  await inTenant(() =>
    db.createSkill({
      name: 'second-skill',
      description: 'Second skill for pagination validation.',
      body: 'Instructions',
      author,
      authorName: 'Test',
      tenantId,
    }),
  );
  const response = await request(app).get(`/skills?limit=${limit}`).expect(200);
  expect(response.body.data).toHaveLength(2);
});

it('authorizes and validates discovery before starting sync', async () => {
  allowUse = false;
  await request(app).get('/skills').expect(403);
  expect(beforeList).not.toHaveBeenCalled();
  allowUse = true;
  await request(app).get('/skills?limit=0').expect(400);
  expect(beforeList).not.toHaveBeenCalled();
  await request(app).get('/skills').expect(200);
  expect(beforeList).toHaveBeenCalledTimes(1);
  expect(beforeList.mock.invocationCallOrder[0]).toBeLessThan(
    accessible.mock.invocationCallOrder[0],
  );
});
it('continues discovery after a sync trigger failure', async () => {
  beforeList.mockRejectedValueOnce(new Error('sync unavailable'));
  await request(app).get('/skills').expect(200);
  expect(accessible).toHaveBeenCalledTimes(1);
});
it('does not enumerate ACLs for capability-managed lists', async () => {
  canManage = true;
  await request(app).get('/skills').expect(200);
  expect(accessible).not.toHaveBeenCalled();
  expect(publiclyAccessible).not.toHaveBeenCalled();
});
it('does not read discarded public status for details, updates, or conflicts', async () => {
  await request(app).get(`/skills/${skillId}`).expect(200);
  await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 1, body: 'Updated' })
    .expect(200);
  await request(app)
    .patch(`/skills/${skillId}`)
    .send({ expectedVersion: 1, body: 'Stale' })
    .expect(409);
  expect(publicStatus).not.toHaveBeenCalled();
});
it('authorizes file targets before charging upload quotas', async () => {
  allowUse = false;
  await request(app).put(`/skills/${skillId}/files/note.txt`).send({ content: 'text' }).expect(403);
  allowUse = true;
  allowEdit = false;
  await request(app).put(`/skills/${skillId}/files/note.txt`).send({ content: 'text' }).expect(404);
  allowEdit = true;
  await request(app)
    .put(`/skills/${new Types.ObjectId()}/files/note.txt`)
    .send({ content: 'text' })
    .expect(404);
  expect(uploadLimiter).not.toHaveBeenCalled();
  expect(saveFile).not.toHaveBeenCalled();
  await request(app).put(`/skills/${skillId}/files/note.txt`).send({ content: 'text' }).expect(200);
  expect(uploadLimiter).toHaveBeenCalledTimes(1);
  expect(readSkill).toHaveBeenCalledTimes(3);
});
it('stops storage writes when the upload limiter rejects', async () => {
  uploadLimiter.mockImplementationOnce((_req, res) => {
    res.sendStatus(429);
  });
  await request(app).put(`/skills/${skillId}/files/note.txt`).send({ content: 'text' }).expect(429);
  expect(saveFile).not.toHaveBeenCalled();
});
it('fails closed when the upload limiter errors', async () => {
  uploadLimiter.mockImplementationOnce((_req, _res, next) => next(new Error('limiter failure')));
  await request(app).put(`/skills/${skillId}/files/note.txt`).send({ content: 'text' }).expect(500);
  expect(saveFile).not.toHaveBeenCalled();
});

it('starts independent capability checks while waiting for the tenant-scoped Skill', async () => {
  let releaseSkill!: (value: null) => void;
  let capabilityStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    capabilityStarted = resolve;
  });
  readSkill.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseSkill = resolve;
      }),
  );
  capabilityCheck.mockImplementationOnce(async () => {
    capabilityStarted();
    return true;
  });
  const response = request(app)
    .get(`/skills/${skillId}`)
    .then((result) => result);
  await started;
  expect(readSkill).toHaveBeenCalledTimes(1);
  releaseSkill(null);
  expect((await response).status).toBe(404);
});
