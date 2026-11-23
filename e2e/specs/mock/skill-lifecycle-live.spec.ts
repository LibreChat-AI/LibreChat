import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import JSZip from 'jszip';
import { expect, test } from '@playwright/test';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import {
  managementTenantId,
  managementUserId,
  startManagementOidc,
} from '../../setup/agent-management';
import { applyRuntimeEnv } from '../../setup/runtimeEnv';
import {
  getAccessToken,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  selectMockEndpoint,
  uploadViaUnifiedButton,
  isAgentsStream,
} from './helpers';

const api = '/api/agents/v1/skills';
const diskPath = (filepath: string) => {
  expect(filepath).toMatch(/^\/uploads\/[^/]+\/[^/]+$/);
  return path.resolve('uploads', filepath.slice('/uploads/'.length));
};

test.describe('full-stack Skill lifecycle confirmation', () => {
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
            name: 'Lifecycle E2E',
            email: 'lifecycle@example.test',
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
    await mongoose.disconnect();
    await oidc?.close();
  });

  test('machine API creates, lists, reads, updates, rejects stale writes and deletes individual files', async ({
    request,
  }) => {
    const name = `full-crud-${Date.now()}`;
    const created = await request.post(api, {
      headers,
      data: { name, description: 'Original description.', body: 'Original body.' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const initial = await created.json();
    const url = `${api}/${initial.id}`;
    const listed = await request.get(`${api}?limit=100`, { headers });
    expect(listed.status()).toBe(200);
    expect((await listed.json()).data).toContainEqual(expect.objectContaining({ id: initial.id }));
    const get = await request.get(url, { headers });
    expect(get.status()).toBe(200);
    expect(await get.json()).toMatchObject({
      name,
      body: 'Original body.',
      version: initial.version,
    });

    const updated = await request.patch(url, {
      headers,
      data: {
        expectedVersion: initial.version,
        description: 'Updated description.',
        body: 'Updated body.',
      },
    });
    expect(updated.status(), await updated.text()).toBe(200);
    expect(await updated.json()).toMatchObject({
      description: 'Updated description.',
      body: 'Updated body.',
      version: initial.version + 1,
    });
    const stale = await request.patch(url, {
      headers,
      data: { expectedVersion: initial.version, body: 'Must not clobber.' },
    });
    expect(stale.status(), await stale.text()).toBe(409);
    expect((await (await request.get(url, { headers })).json()).body).toBe('Updated body.');

    const fileUrl = `${url}/files/references/live.txt`;
    expect(
      (await request.put(fileUrl, { headers, data: { content: 'First bytes.' } })).status(),
    ).toBe(200);
    const first = await tenantStorage.run({ tenantId: managementTenantId }, () =>
      methods.getSkillFileByPath(initial.id, 'references/live.txt'),
    );
    expect(first).not.toBeNull();
    expect(fs.readFileSync(diskPath(first!.filepath), 'utf8')).toBe('First bytes.');
    expect(
      (await request.put(fileUrl, { headers, data: { content: 'Second bytes.' } })).status(),
    ).toBe(200);
    const second = await tenantStorage.run({ tenantId: managementTenantId }, () =>
      methods.getSkillFileByPath(initial.id, 'references/live.txt'),
    );
    expect(second!.file_id).not.toBe(first!.file_id);
    expect(fs.readFileSync(diskPath(second!.filepath), 'utf8')).toBe('Second bytes.');
    await expect.poll(() => fs.existsSync(diskPath(first!.filepath))).toBe(false);
    await expect
      .poll(async () => {
        const intent = await tenantStorage.run({ tenantId: managementTenantId }, () =>
          methods.getSkillUploadIntent(first!.file_id),
        );
        return { cleaned: intent?.cleanedAt != null, released: intent?.claimOwner == null };
      })
      .toEqual({ cleaned: true, released: true });
    expect((await (await request.get(fileUrl, { headers })).json()).content).toBe('Second bytes.');
    expect((await (await request.get(`${url}/files`, { headers })).json()).data).toContainEqual(
      expect.objectContaining({ relativePath: 'references/live.txt' }),
    );

    const removed = await request.delete(fileUrl, { headers });
    expect(removed.status(), await removed.text()).toBe(200);
    expect(await removed.json()).toEqual({
      skillId: initial.id,
      relativePath: 'references/live.txt',
      deleted: true,
    });
    expect(fs.existsSync(diskPath(second!.filepath))).toBe(false);
    expect((await request.get(fileUrl, { headers })).status()).toBe(404);
    expect((await (await request.get(`${url}/files`, { headers })).json()).data).toEqual([]);
    expect((await request.delete(fileUrl, { headers })).status()).toBe(404);
    expect((await request.delete(url, { headers })).status()).toBe(200);
    expect((await request.get(url, { headers })).status()).toBe(404);
  });

  test('authorized management deletion cleans a seeded other-author file through the real Local adapter', async ({
    request,
  }) => {
    const created = await request.post(api, {
      headers,
      data: {
        name: `cross-author-${Date.now()}`,
        description: 'Cross-author cleanup.',
        body: 'Instructions.',
      },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    const url = `${api}/${id}/files/references/owned.txt`;
    expect(
      (await request.put(url, { headers, data: { content: 'Recorded owner bytes.' } })).status(),
    ).toBe(200);
    const owner = new mongoose.Types.ObjectId();
    let movedPath = '';
    await tenantStorage.run({ tenantId: managementTenantId }, async () => {
      const file = await methods.getSkillFileByPath(id, 'references/owned.txt');
      expect(file).not.toBeNull();
      const persistedPath = file!.filepath.replace(
        `/uploads/${managementUserId}/`,
        `/uploads/${owner}/`,
      );
      movedPath = diskPath(persistedPath);
      await fs.promises.mkdir(path.dirname(movedPath), { recursive: true });
      await fs.promises.rename(diskPath(file!.filepath), movedPath);
      // Fixture represents a pre-existing file authored by another user in the same organization.
      await mongoose.models.SkillFile.updateOne(
        { file_id: file!.file_id },
        {
          $set: { author: owner, filepath: persistedPath },
        },
      );
    });
    const removed = await request.delete(url, { headers });
    expect(removed.status(), await removed.text()).toBe(200);
    expect(fs.existsSync(movedPath)).toBe(false);
    expect((await request.get(url, { headers })).status()).toBe(404);
    // A subsequent request still uses the authenticated manager, not the cloned storage owner.
    const next = await request.put(`${api}/${id}/files/references/next.txt`, {
      headers,
      data: { content: 'Manager bytes.' },
    });
    expect(next.status(), await next.text()).toBe(200);
    const nextFile = await tenantStorage.run({ tenantId: managementTenantId }, () =>
      methods.getSkillFileByPath(id, 'references/next.txt'),
    );
    expect(nextFile!.author.toString()).toBe(managementUserId);
    expect((await request.delete(`${api}/${id}`, { headers })).status()).toBe(200);
    expect(fs.existsSync(diskPath(nextFile!.filepath))).toBe(false);
  });

  test('browser-authenticated multipart binary upload reads exact bytes, replaces by revision and deletes', async ({
    page,
    request,
  }) => {
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const browserHeaders = { Authorization: `Bearer ${token}` };
    const created = await request.post('/api/skills', {
      headers: browserHeaders,
      data: {
        name: `binary-lifecycle-${Date.now()}`,
        description: 'Binary file lifecycle.',
        body: 'Binary attachment test.',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { _id: id } = await created.json();
    const url = `/api/skills/${id}/files`;
    const firstBytes = Buffer.from([0, 1, 2, 3, 255, 128, 0, 42]);
    const uploaded = await request.post(url, {
      headers: browserHeaders,
      multipart: {
        relativePath: 'assets/payload.bin',
        file: { name: 'payload.bin', mimeType: 'application/octet-stream', buffer: firstBytes },
      },
    });
    expect(uploaded.status(), await uploaded.text()).toBe(200);
    const first = await uploaded.json();
    expect(fs.readFileSync(diskPath(first.filepath))).toEqual(firstBytes);
    const binary = await request.get(`${url}/assets/payload.bin`, { headers: browserHeaders });
    expect(binary.status()).toBe(200);
    expect(await binary.json()).toMatchObject({ isBinary: true, bytes: firstBytes.length });
    const raw = await request.get(`${url}/assets/payload.bin?raw=true`, {
      headers: browserHeaders,
    });
    expect(raw.status()).toBe(200);
    expect(await raw.body()).toEqual(firstBytes);

    const nextBytes = Buffer.from([0, 42, 255, 7]);
    const replaced = await request.post(`${url}/assets/payload.bin`, {
      headers: browserHeaders,
      multipart: {
        relativePath: 'assets/payload.bin',
        expectedFileId: first.file_id,
        file: { name: 'payload.bin', mimeType: 'application/octet-stream', buffer: nextBytes },
      },
    });
    expect(replaced.status(), await replaced.text()).toBe(200);
    const second = await replaced.json();
    expect(second.file_id).not.toBe(first.file_id);
    expect(fs.readFileSync(diskPath(second.filepath))).toEqual(nextBytes);
    await expect.poll(() => fs.existsSync(diskPath(first.filepath))).toBe(false);
    const stale = await request.post(`${url}/assets/payload.bin`, {
      headers: browserHeaders,
      multipart: {
        relativePath: 'assets/payload.bin',
        expectedFileId: first.file_id,
        file: { name: 'payload.bin', mimeType: 'application/octet-stream', buffer: firstBytes },
      },
    });
    expect(stale.status(), await stale.text()).toBe(409);
    expect(fs.readFileSync(diskPath(second.filepath))).toEqual(nextBytes);
    expect(
      (await request.delete(`${url}/assets/payload.bin`, { headers: browserHeaders })).status(),
    ).toBe(200);
    expect(fs.existsSync(diskPath(second.filepath))).toBe(false);
    expect(
      (await request.get(`${url}/assets/payload.bin`, { headers: browserHeaders })).status(),
    ).toBe(404);
    expect((await request.delete(`/api/skills/${id}`, { headers: browserHeaders })).status()).toBe(
      200,
    );
  });

  test('imports an archive with text and binary attachments and physically cleans all files on deletion', async ({
    page,
    request,
  }) => {
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const browserHeaders = { Authorization: `Bearer ${token}` };
    const zip = new JSZip();
    zip.file(
      'SKILL.md',
      `---\nname: import-live-${Date.now()}\ndescription: Archive lifecycle test.\n---\n\nImported instructions.\n`,
    );
    zip.file('references/guide.txt', 'Imported guide bytes.');
    const binary = Buffer.from([0, 255, 128, 1, 42]);
    zip.file('assets/payload.bin', binary);
    const imported = await request.post('/api/skills/import', {
      headers: browserHeaders,
      multipart: {
        file: {
          name: 'lifecycle.zip',
          mimeType: 'application/zip',
          buffer: await zip.generateAsync({ type: 'nodebuffer' }),
        },
      },
    });
    expect(imported.status(), await imported.text()).toBe(201);
    const skill = await imported.json();
    expect(skill._importSummary.filesFailed).toBe(0);
    const rows = await mongoose.models.SkillFile.find({ skillId: skill._id }).lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(fs.existsSync(diskPath(String(row.filepath)))).toBe(true);
    const textRead = await request.get(`/api/skills/${skill._id}/files/references/guide.txt`, {
      headers: browserHeaders,
    });
    expect(textRead.status()).toBe(200);
    expect((await textRead.json()).content).toBe('Imported guide bytes.');
    const rawRead = await request.get(
      `/api/skills/${skill._id}/files/assets/payload.bin?raw=true`,
      { headers: browserHeaders },
    );
    expect(rawRead.status()).toBe(200);
    expect(await rawRead.body()).toEqual(binary);
    expect(
      (await request.delete(`/api/skills/${skill._id}`, { headers: browserHeaders })).status(),
    ).toBe(200);
    for (const row of rows) expect(fs.existsSync(diskPath(String(row.filepath)))).toBe(false);
    expect(await mongoose.models.SkillFile.countDocuments({ skillId: skill._id })).toBe(0);
  });

  test('ordinary local upload lists persisted metadata and physically deletes through the shared file route', async ({
    page,
    request,
  }) => {
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    const name = `ordinary-delete-${Date.now()}.csv`;
    const uploaded = await uploadViaUnifiedButton(page, {
      name,
      mimeType: 'text/csv',
      content: 'key,value\nhello,world\n',
    });
    expect(uploaded.ok()).toBe(true);
    const file = await uploaded.json();
    const token = await getAccessToken(page);
    const browserHeaders = { Authorization: `Bearer ${token}` };
    const listed = await request.get('/api/files', { headers: browserHeaders });
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toContainEqual(expect.objectContaining({ file_id: file.file_id }));
    expect(fs.existsSync(diskPath(file.filepath))).toBe(true);
    const removed = await request.delete('/api/files', {
      headers: browserHeaders,
      data: { files: [file] },
    });
    expect(removed.status(), await removed.text()).toBe(200);
    expect(fs.existsSync(diskPath(file.filepath))).toBe(false);
    const after = await request.get('/api/files', { headers: browserHeaders });
    expect(await after.json()).not.toContainEqual(
      expect.objectContaining({ file_id: file.file_id }),
    );
  });

  test('ordinary provider-routed upload reaches the model and persists in chat with an unambiguous attachment selector', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    const name = `provider-lifecycle-${Date.now()}.md`;
    const uploaded = await uploadViaUnifiedButton(page, {
      name,
      mimeType: 'text/markdown',
      content: '# Provider attachment\n\nActual file bytes.\n',
    });
    expect(uploaded.ok()).toBe(true);
    expect((await uploaded.json()).llmDeliveryPath).toBe('provider');
    await expect(
      page.getByTestId('composer-tray').getByRole('button', { name, exact: true }),
    ).toBeVisible();
    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.fill(`E2E_ASSERT_PROVIDER_FILE:${name}`);
    const [stream] = await Promise.all([
      page.waitForResponse(isAgentsStream),
      page.getByTestId('send-button').click(),
    ]);
    expect(stream.ok()).toBe(true);
    await expect(
      page.getByTestId('messages-view').getByText(`E2E provider file assertion passed: ${name}`),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      page.getByTestId('messages-view').getByRole('button', { name, exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByTestId('messages-view').getByRole('button', { name, exact: true }),
    ).toBeVisible();
  });
});
