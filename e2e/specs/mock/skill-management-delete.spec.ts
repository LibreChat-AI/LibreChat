import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { expect, test } from '@playwright/test';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import {
  managementTenantId,
  managementUserId,
  startManagementOidc,
} from '../../setup/agent-management';
import { applyRuntimeEnv } from '../../setup/runtimeEnv';
import { withMongo } from './db';

const skillsPath = '/api/agents/v1/skills';
const localBlobPath = (filepath: string) => {
  const prefix = `/uploads/${managementUserId}/`;
  expect(filepath.startsWith(prefix)).toBe(true);
  return path.resolve('uploads', filepath.slice('/uploads/'.length));
};

test.describe('machine Skill management deletion', () => {
  test.describe.configure({ mode: 'default' });
  let oidc: Awaited<ReturnType<typeof startManagementOidc>>;
  let headers: { Authorization: string };
  let methods: ReturnType<typeof createMethods>;

  test.beforeAll(async () => {
    oidc = await startManagementOidc();
    headers = { Authorization: `Bearer ${oidc.token}` };
    applyRuntimeEnv();
    await mongoose.connect(process.env.MONGO_URI!);
    createModels(mongoose);
    methods = createMethods(mongoose);
    await tenantStorage.run({ tenantId: managementTenantId }, async () => {
      await methods.initializeRoles();
      await methods.seedDefaultRoles();
      await methods.seedSystemGrants();
      await mongoose.models.User.updateOne(
        { _id: managementUserId },
        {
          $set: {
            name: 'Skill Management E2E',
            email: 'skill-management@example.test',
            emailVerified: true,
            provider: 'local',
            role: 'ADMIN',
            tenantId: managementTenantId,
          },
        },
        { upsert: true },
      );
    });
  });

  test.afterAll(async () => {
    try {
      await withMongo(async (db) => {
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
          if (!name.startsWith('system.')) {
            await db.collection(name).deleteMany({ tenantId: managementTenantId });
          }
        }
      });
      await fs.promises.rm(path.resolve('uploads', managementUserId), {
        recursive: true,
        force: true,
      });
    } finally {
      await mongoose.disconnect();
      await oidc?.close();
    }
  });

  test('creates, replaces, and deletes a Skill and its local blobs through HTTP', async ({
    request,
  }) => {
    const withoutToken = await request.post(skillsPath, {
      data: { name: 'unauthorized', description: 'Unauthorized.', body: 'No.' },
    });
    expect(withoutToken.status()).toBe(401);

    const created = await request.post(skillsPath, {
      headers,
      data: {
        name: `delete-e2e-${Date.now()}`,
        description: 'Exercises machine Skill deletion with stored files.',
        body: 'Test instructions.',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();
    const filePath = `${skillsPath}/${id}/files/references/guide.md`;

    const firstPut = await request.put(filePath, {
      headers,
      data: { content: 'First version.' },
    });
    expect(firstPut.status(), await firstPut.text()).toBe(200);
    const firstFile = await tenantStorage.run({ tenantId: managementTenantId }, () =>
      methods.getSkillFileByPath(id, 'references/guide.md'),
    );
    expect(firstFile?.source).toBe('local');
    expect(firstFile?.filepath).toBeTruthy();
    const oldBlobPath = localBlobPath(firstFile!.filepath);
    expect(fs.existsSync(oldBlobPath)).toBe(true);

    const secondPut = await request.put(filePath, {
      headers,
      data: { content: 'Second version.' },
    });
    expect(secondPut.status(), await secondPut.text()).toBe(200);
    const secondFile = await tenantStorage.run({ tenantId: managementTenantId }, () =>
      methods.getSkillFileByPath(id, 'references/guide.md'),
    );
    expect(secondFile?.filepath).not.toBe(firstFile?.filepath);
    const newBlobPath = localBlobPath(secondFile!.filepath);
    expect(fs.existsSync(newBlobPath)).toBe(true);
    await expect.poll(() => fs.existsSync(oldBlobPath)).toBe(false);

    const read = await request.get(filePath, { headers });
    expect(read.status(), await read.text()).toBe(200);
    expect((await read.json()).content).toBe('Second version.');

    const deleted = await request.delete(`${skillsPath}/${id}`, { headers });
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true, cleanupComplete: true });
    expect(
      await tenantStorage.run({ tenantId: managementTenantId }, () => methods.getSkillById(id)),
    ).toBeNull();
    expect(
      await tenantStorage.run({ tenantId: managementTenantId }, () =>
        methods.getSkillFileByPath(id, 'references/guide.md'),
      ),
    ).toBeNull();
    expect(fs.existsSync(newBlobPath)).toBe(false);
    expect((await request.get(`${skillsPath}/${id}`, { headers })).status()).toBe(404);
    expect((await request.get(filePath, { headers })).status()).toBe(404);
  });

  test('retries whole-Skill cleanup after a transient local storage failure', async ({
    request,
  }) => {
    const created = await request.post(skillsPath, {
      headers,
      data: {
        name: `delete-retry-e2e-${Date.now()}`,
        description: 'Exercises retry after local storage rejects deletion.',
        body: 'Test retry instructions.',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();
    const put = await request.put(`${skillsPath}/${id}/files/references/retry.md`, {
      headers,
      data: { content: 'Retry me.' },
    });
    expect(put.status(), await put.text()).toBe(200);
    const file = await tenantStorage.run({ tenantId: managementTenantId }, () =>
      methods.getSkillFileByPath(id, 'references/retry.md'),
    );
    expect(file?.filepath).toBeTruthy();
    const blobPath = localBlobPath(file!.filepath);
    expect(fs.existsSync(blobPath)).toBe(true);
    const blobDirectory = path.dirname(blobPath);
    const originalMode = fs.statSync(blobDirectory).mode & 0o777;

    const deleted = await (async () => {
      try {
        await fs.promises.chmod(blobDirectory, 0o555);
        return await request.delete(`${skillsPath}/${id}`, { headers });
      } finally {
        await fs.promises.chmod(blobDirectory, originalMode);
      }
    })();
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect(await deleted.json()).toEqual({ id, deleted: true, cleanupComplete: false });
    expect(fs.existsSync(blobPath)).toBe(true);

    await expect
      .poll(
        async () => {
          const skill = await tenantStorage.run({ tenantId: managementTenantId }, () =>
            methods.getSkillById(id),
          );
          return { skillAbsent: skill == null, blobAbsent: !fs.existsSync(blobPath) };
        },
        { timeout: 15_000 },
      )
      .toEqual({ skillAbsent: true, blobAbsent: true });
  });
});
