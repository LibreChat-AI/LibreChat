import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent } from '../agents.helpers';
import { withMongo } from '../db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  uniqueName,
  requestJson,
  getRagQueries,
  getAccessToken,
  getRagEmbedded,
  resetProvisioning,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * Files uploaded for File Search before v0.8.8 carry `embedded: true` but no
 * `metadata.embeddedEntities`. They must stay searchable without being embedded a second
 * time, which would store a duplicate copy under the same file_id (#16843).
 */
test.describe('legacy File Search embeddings', () => {
  test('an agent file embedded before namespace tracking is searched without re-embedding @scenario:legacy-search-file-not-re-embedded', async ({
    page,
  }) => {
    test.setTimeout(180000);
    let agentId: string | undefined;
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    try {
      const token = await getAccessToken(page);
      const agent = await requestJson<AgentDetail>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: uniqueName('legacy-search-agent'),
          description: 'Legacy File Search embedding fixture.',
          instructions: 'Search the attached files.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          tools: ['file_search'],
        },
      });
      agentId = agent.id;

      const upload = await page.request.post('/api/files', {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          agent_id: agentId,
          tool_resource: 'file_search',
          file_id: randomUUID(),
          file: {
            name: `${uniqueName('legacy-search')}.txt`,
            mimeType: 'text/plain',
            buffer: Buffer.from('Legacy search fixture text.'),
          },
        },
      });
      expect(upload.ok(), await upload.text()).toBeTruthy();
      /* The server assigns the stored id; the fake RAG records it rather than a name. */
      const fileId = ((await upload.json()) as UploadedFile).file_id as string;
      expect(fileId, 'upload response should include a file_id').toBeTruthy();
      await expect
        .poll(async () => (await getRagEmbedded(page)).map((e) => e.file_id), { timeout: 15000 })
        .toContain(fileId);

      /* Reshape the record into what v0.8.7 wrote: embedded, with no namespace list. */
      const reshaped = await withMongo((db) =>
        db
          .collection('files')
          .updateOne(
            { file_id: fileId, embedded: true },
            { $unset: { 'metadata.embeddedEntities': '' } },
          ),
      );
      expect(reshaped.matchedCount).toBe(1);
      await resetProvisioning(page);

      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      await sendMessageAndWaitForCompletion(page, `E2E_FILE_SEARCH:${uniqueName('legacy')}`);

      await expect
        .poll(async () => (await getRagQueries(page)).filter((q) => q.file_id === fileId).length, {
          timeout: 30000,
        })
        .toBeGreaterThan(0);
      expect(
        (await getRagEmbedded(page)).filter((e) => e.file_id === fileId),
        'a legacy embedded File Search file must not be embedded again',
      ).toHaveLength(0);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a legacy file another agent also holds is embedded for that agent only @scenario:legacy-search-file-shared-re-embedded', async ({
    page,
  }) => {
    test.setTimeout(180000);
    let sourceId: string | undefined;
    let inheritorId: string | undefined;
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    try {
      const token = await getAccessToken(page);
      const createSearchAgent = (label: string) =>
        requestJson<AgentDetail>(page, {
          path: '/api/agents',
          token,
          method: 'POST',
          body: {
            name: uniqueName(label),
            description: 'Legacy File Search embedding fixture.',
            instructions: 'Search the attached files.',
            provider: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
            tools: ['file_search'],
          },
        });
      sourceId = (await createSearchAgent('legacy-source-agent')).id;
      inheritorId = (await createSearchAgent('legacy-inheritor-agent')).id;

      const upload = await page.request.post('/api/files', {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          agent_id: sourceId,
          tool_resource: 'file_search',
          file_id: randomUUID(),
          file: {
            name: `${uniqueName('legacy-shared')}.txt`,
            mimeType: 'text/plain',
            buffer: Buffer.from('Legacy shared search fixture text.'),
          },
        },
      });
      expect(upload.ok(), await upload.text()).toBeTruthy();
      /* The server assigns the stored id; the fake RAG records it rather than a name. */
      const fileId = ((await upload.json()) as UploadedFile).file_id as string;
      expect(fileId, 'upload response should include a file_id').toBeTruthy();
      await expect
        .poll(async () => (await getRagEmbedded(page)).map((e) => e.file_id), { timeout: 15000 })
        .toContain(fileId);

      /* The owner of a file may attach it to another of their agents. */
      await requestJson<AgentDetail>(page, {
        path: `/api/agents/${encodeURIComponent(inheritorId)}`,
        token,
        method: 'PATCH',
        body: { tool_resources: { file_search: { file_ids: [fileId] } } },
      });
      const reshaped = await withMongo((db) =>
        db
          .collection('files')
          .updateOne(
            { file_id: fileId, embedded: true },
            { $unset: { 'metadata.embeddedEntities': '' } },
          ),
      );
      expect(reshaped.matchedCount).toBe(1);
      await resetProvisioning(page);

      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(inheritorId)}`, {
        timeout: 10000,
      });
      await sendMessageAndWaitForCompletion(page, `E2E_FILE_SEARCH:${uniqueName('shared')}`);

      /* Its vectors are in the source agent's namespace, so the searching agent gets its
       * own embedding rather than querying a namespace that holds none. */
      await expect
        .poll(async () => (await getRagEmbedded(page)).filter((e) => e.file_id === fileId).length, {
          timeout: 30000,
        })
        .toBe(1);
      await expect
        .poll(async () => (await getRagQueries(page)).filter((q) => q.file_id === fileId).length)
        .toBeGreaterThan(0);

      /* The record now lists only the inheritor, yet the source agent's own vectors are still
       * there, so its next search must not embed a second copy. */
      await resetProvisioning(page);
      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(sourceId)}`, {
        timeout: 10000,
      });
      await sendMessageAndWaitForCompletion(page, `E2E_FILE_SEARCH:${uniqueName('source')}`);
      await expect
        .poll(async () => (await getRagQueries(page)).filter((q) => q.file_id === fileId).length, {
          timeout: 30000,
        })
        .toBeGreaterThan(0);
      expect(
        (await getRagEmbedded(page)).filter((e) => e.file_id === fileId),
        'the agent that embedded the file must not embed it again',
      ).toHaveLength(0);
    } finally {
      await cleanupAgent(page, inheritorId);
      await cleanupAgent(page, sourceId);
    }
  });
});
