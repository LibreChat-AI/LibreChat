import fs from 'fs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import path from 'path';
import mongoose from 'mongoose';
import { expect, test } from '@playwright/test';
import { createModels, createMethods, tenantStorage } from '@librechat/data-schemas';
import type { CodeProvisionRecord, RagEmbedRecord } from './helpers';
import {
  managementUserId,
  managementTenantId,
  startManagementOidc,
} from '../../setup/agent-management';
import { applyRuntimeEnv } from '../../setup/runtimeEnv';
import { CODE_API_BASE, RAG_API_BASE } from './helpers';
import { withMongo } from './db';

const agentsPath = '/api/agents/v1/agents';
const content = 'Agent management upload regression: violet.\n';
const stagingPath = path.resolve('uploads', 'temp', managementUserId);

test.describe('agent management file lifecycle', () => {
  test.describe.configure({ mode: 'default' });
  let oidc: Awaited<ReturnType<typeof startManagementOidc>>;
  let headers: { Authorization: string };

  test.beforeAll(async () => {
    oidc = await startManagementOidc();
    headers = { Authorization: `Bearer ${oidc.token}` };
    applyRuntimeEnv();
    await mongoose.connect(process.env.MONGO_URI!);
    createModels(mongoose);
    const methods = createMethods(mongoose);
    await tenantStorage.run({ tenantId: managementTenantId }, async () => {
      await methods.initializeRoles();
      await methods.seedDefaultRoles();
      await methods.seedSystemGrants();
      await mongoose.models.User.updateOne(
        { _id: managementUserId },
        {
          $set: {
            name: 'Agent Management E2E',
            email: 'agent-management@example.test',
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
      // Unlinking intentionally retains files; teardown owns the fixture tenant's data.
      await withMongo(async (db) => {
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
          if (name.startsWith('system.')) {
            continue;
          }
          await db.collection(name).deleteMany({ tenantId: managementTenantId });
        }
      });
      await fs.promises.rm(path.resolve('uploads', managementUserId), {
        recursive: true,
        force: true,
      });
      await fs.promises.rm(stagingPath, { recursive: true, force: true });
    } finally {
      await mongoose.disconnect();
      await oidc?.close();
    }
  });

  test('registers an SDK agent and executes it through native chat and persistence', async ({
    request,
  }) => {
    const binding = { id: 'e2e-sdk', protocolVersion: 1 };
    const created = await request.post(agentsPath, {
      headers,
      data: {
        name: 'SDK runtime agent',
        provider: 'Mock Provider A',
        model: 'mock-model-a',
        sdk_runtime: binding,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const agent = await created.json();
    expect(agent.sdk_runtime).toEqual(binding);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('Test JWT secret is unavailable');
    const chatHeaders = {
      Authorization: `Bearer ${jwt.sign({ id: managementUserId }, secret, { expiresIn: '5m' })}`,
      'X-Tenant-Id': managementTenantId,
      'User-Agent': 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36',
    };
    try {
      const read = await request.get(`${agentsPath}/${agent.id}`, { headers });
      expect((await read.json()).sdk_runtime).toEqual(binding);
      const run = async () => {
        const admitted = await request.post('/api/agents/chat/agents', {
          headers: chatHeaders,
          data: {
            text: 'E2E_REPLY:sdk-runtime',
            sender: 'User',
            isCreatedByUser: true,
            parentMessageId: '00000000-0000-0000-0000-000000000000',
            messageId: randomUUID(),
            endpoint: 'agents',
            agent_id: agent.id,
            key: 'never',
            isTemporary: false,
            isRegenerate: false,
            isContinued: false,
          },
        });
        expect(admitted.status(), await admitted.text()).toBe(200);
        const { streamId, conversationId } = await admitted.json();
        const stream = await request.get(`/api/agents/chat/stream/${streamId}`, {
          headers: chatHeaders,
        });
        expect(stream.status(), await stream.text()).toBe(200);
        const saved = await request.get(`/api/messages/${conversationId}`, {
          headers: chatHeaders,
        });
        expect(saved.status(), await saved.text()).toBe(200);
        return JSON.stringify(await saved.json());
      };
      expect(await run()).toContain('E2E reply sdk-runtime');
      const changed = await request.patch(`${agentsPath}/${agent.id}`, {
        headers,
        data: { sdk_runtime: { id: 'not-configured', protocolVersion: 1 } },
      });
      expect(changed.status(), await changed.text()).toBe(400);
      // Simulate an existing binding whose operator configuration was removed.
      await withMongo(async (db) => {
        await db
          .collection('agents')
          .updateOne(
            { id: agent.id, tenantId: managementTenantId },
            { $set: { sdk_runtime: { id: 'not-configured', protocolVersion: 1 } } },
          );
      });
      expect(await run()).not.toContain('E2E reply sdk-runtime');
      const cleared = await request.patch(`${agentsPath}/${agent.id}`, {
        headers,
        data: { sdk_runtime: null },
      });
      expect(cleared.status(), await cleared.text()).toBe(200);
      expect((await cleared.json()).sdk_runtime).toBeNull();
      expect(await run()).toContain('E2E reply sdk-runtime');
    } finally {
      await request.delete(`${agentsPath}/${agent.id}`, { headers });
    }
  });

  for (const purpose of ['context', 'file_search', 'execute_code']) {
    test(`uploads, persists, lists and unlinks ${purpose} files`, async ({ request }) => {
      const created = await request.post(agentsPath, {
        headers,
        data: { name: `Upload ${purpose}`, provider: 'Mock Provider A', model: 'mock-model-a' },
      });
      expect(created.status(), await created.text()).toBe(201);
      const { id: agentId } = await created.json();
      const filesPath = `${agentsPath}/${agentId}/files`;
      try {
        const filename = `${purpose}.txt`;
        const uploaded = await request.post(filesPath, {
          headers,
          multipart: {
            purpose,
            file: { name: filename, mimeType: 'text/plain', buffer: Buffer.from(content) },
          },
        });
        expect(uploaded.status(), await uploaded.text()).toBe(200);
        const file = await uploaded.json();
        expect(file).toMatchObject({
          filename,
          bytes: Buffer.byteLength(content),
          purposes: [purpose],
        });
        expect(file.id).toMatch(/^[a-f\d-]{36}$/i);

        await withMongo(async (db) => {
          const stored = await db.collection('files').findOne({
            file_id: file.id,
            tenantId: managementTenantId,
            user: new mongoose.Types.ObjectId(managementUserId),
          });
          expect(stored).not.toBeNull();
          if (purpose === 'context') {
            expect(stored?.text).toBe(content);
          } else if (purpose === 'file_search') {
            expect(stored?.embedded).toBe(true);
          } else {
            expect(stored?.metadata?.codeEnvRef?.file_id).toBeTruthy();
          }
        });

        if (purpose !== 'context') {
          const url =
            purpose === 'file_search'
              ? `${RAG_API_BASE}/__debug/embedded`
              : `${CODE_API_BASE}/__debug/uploads`;
          const provisioned = await request.get(url);
          expect(provisioned.status()).toBe(200);
          const records = await provisioned.json();
          if (purpose === 'file_search') {
            expect(
              records.embedded.map((record: RagEmbedRecord & { bytes: number }) => ({
                file_id: record.file_id,
                entity_id: record.entity_id,
                bytes: record.bytes,
              })),
            ).toContainEqual({
              file_id: file.id,
              entity_id: agentId,
              bytes: Buffer.byteLength(content),
            });
          } else {
            expect(
              records.uploads.map((record: CodeProvisionRecord & { bytes: number }) => ({
                filename: record.filename,
                id: record.id,
                bytes: record.bytes,
              })),
            ).toContainEqual({ filename, id: agentId, bytes: Buffer.byteLength(content) });
          }
        }

        const listed = await request.get(filesPath, { headers });
        expect(listed.status()).toBe(200);
        expect((await listed.json()).data).toEqual([expect.objectContaining({ id: file.id })]);
        const unlinked = await request.delete(`${filesPath}/${file.id}`, { headers });
        expect(unlinked.status(), await unlinked.text()).toBe(200);
        expect(await unlinked.json()).toEqual({ id: file.id, deleted: true });
        expect((await (await request.get(filesPath, { headers })).json()).data).toEqual([]);
        await withMongo(async (db) => {
          expect(await db.collection('files').countDocuments({ file_id: file.id })).toBe(1);
        });
        expect(fs.existsSync(stagingPath) ? fs.readdirSync(stagingPath) : []).toEqual([]);
      } finally {
        const deleted = await request.delete(`${agentsPath}/${agentId}`, { headers });
        expect(deleted.status(), await deleted.text()).toBe(200);
      }
    });
  }

  test('rejects invalid uploads and cleans staged files', async ({ request }) => {
    const created = await request.post(agentsPath, {
      headers,
      data: { name: 'Rejected uploads', provider: 'Mock Provider A', model: 'mock-model-a' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id: agentId } = await created.json();
    const filesPath = `${agentsPath}/${agentId}/files`;
    try {
      for (const [purpose, buffer] of [
        ['unsupported', Buffer.from(content)],
        ['context', Buffer.alloc(0)],
      ] as const) {
        const uploaded = await request.post(filesPath, {
          headers,
          multipart: { purpose, file: { name: 'invalid.txt', mimeType: 'text/plain', buffer } },
        });
        expect(uploaded.status(), await uploaded.text()).toBe(400);
        expect((await (await request.get(filesPath, { headers })).json()).data).toEqual([]);
        expect(fs.existsSync(stagingPath) ? fs.readdirSync(stagingPath) : []).toEqual([]);
      }
    } finally {
      expect((await request.delete(`${agentsPath}/${agentId}`, { headers })).status()).toBe(200);
    }
  });
});
