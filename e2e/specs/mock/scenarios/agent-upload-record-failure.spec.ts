import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { Db, Document } from 'mongodb';
import { withMongo } from '../db';
import { MOCK_ENDPOINTS } from '../helpers';
import { loginAdmin, requestResult } from '../content-filters.helpers';

type AgentDoc = { tool_resources?: { context?: { file_ids?: string[] } } };

async function createAgent(request: APIRequestContext, token: string): Promise<string> {
  const result = await requestResult(request, {
    path: '/api/agents',
    token,
    method: 'POST',
    data: {
      name: `E2E upload record failure ${randomUUID().slice(0, 8)}`,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools: [],
    },
  });
  expect(result.status, result.text).toBe(201);
  const id = (result.body as { id?: unknown }).id;
  expect(typeof id).toBe('string');
  return id as string;
}

const uploadContext = (
  request: APIRequestContext,
  token: string,
  agentId: string,
  filename: string,
) =>
  requestResult(request, {
    path: '/api/files',
    token,
    method: 'POST',
    multipart: {
      endpoint: 'agents',
      agent_id: agentId,
      tool_resource: 'context',
      file_id: randomUUID(),
      file: {
        name: filename,
        mimeType: 'text/plain',
        buffer: Buffer.from(`notes for ${filename}`),
      },
    },
  });

const linkedIds = (agentId: string) =>
  withMongo(async (db) => {
    const agent = await db.collection<AgentDoc & Document>('agents').findOne({ id: agentId });
    return agent?.tool_resources?.context?.file_ids ?? [];
  });

/** Makes record writes for one filename fail inside MongoDB, the way an outage or a rejected
 * write would, while every other write of this run keeps working. Returns the restore. */
async function rejectRecordsNamed(db: Db, filename: string): Promise<(db: Db) => Promise<void>> {
  const [existing] = await db.listCollections({ name: 'files' }).toArray();
  const options = (existing as { options?: Document } | undefined)?.options ?? {};
  const validator = { filename: { $ne: filename } };
  if (existing == null) {
    await db.createCollection('files', { validator, validationAction: 'error' });
  } else {
    await db.command({ collMod: 'files', validator, validationAction: 'error' });
  }
  return async (target) => {
    await target.command({
      collMod: 'files',
      validator: options.validator ?? {},
      validationAction: options.validationAction ?? 'error',
    });
  };
}

test.describe('agent upload record failure', () => {
  test('an agent upload whose file record fails leaves no file id on the agent @scenario:agent-upload-record-failure-leaves-no-link', async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const agentId = await createAgent(request, token);
    const suffix = randomUUID().slice(0, 8);
    try {
      const kept = await uploadContext(request, token, agentId, `kept-${suffix}.txt`);
      expect(kept.status, kept.text).toBe(200);
      const keptId = (kept.body as { file_id?: string }).file_id;
      expect(await linkedIds(agentId)).toEqual([keptId]);

      const rejected = `rejected-${suffix}.txt`;
      const restore = await withMongo((db) => rejectRecordsNamed(db, rejected));
      let failed;
      try {
        failed = await uploadContext(request, token, agentId, rejected);
      } finally {
        await withMongo((db) => restore(db));
      }
      expect(failed.ok, failed.text).toBe(false);

      expect(await linkedIds(agentId)).toEqual([keptId]);
      const records = await withMongo((db) =>
        db.collection('files').countDocuments({ filename: rejected }),
      );
      expect(records).toBe(0);
    } finally {
      await requestResult(request, {
        path: `/api/agents/${encodeURIComponent(agentId)}`,
        token,
        method: 'DELETE',
      });
    }
  });
});
