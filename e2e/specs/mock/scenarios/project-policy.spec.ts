import { ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { FiltersConfig } from 'librechat-data-provider';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';
import { MOCK_ENDPOINTS, RAG_API_BASE } from '../helpers';
import {
  expectContentFilterBlock,
  loginAdmin,
  requestResult,
  restoreRuntimeFilters,
  setRuntimeFilters,
} from '../content-filters.helpers';
import type { RequestResult } from '../content-filters.helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectSuccess(result: RequestResult, status?: number): void {
  expect(result.ok, result.text).toBe(true);
  if (status != null) {
    expect(result.status, result.text).toBe(status);
  }
}

function pii(id: string, field: string, marker: string) {
  return {
    fields: [field],
    starterPatterns: [],
    customPatterns: [{ id, label: 'E2E policy marker', regex: `^${marker}$` }],
  };
}

async function createAgent(
  request: APIRequestContext,
  token: string,
  suffix: string,
  tools: string[] = [],
): Promise<string> {
  const result = await requestResult(request, {
    path: '/api/agents',
    token,
    method: 'POST',
    data: {
      name: `E2E project policy agent ${suffix}`,
      description: 'Deterministic project policy scenario agent.',
      instructions: 'Use the project context and answer deterministically.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      tools,
      conversation_starters: ['Use the project context.'],
    },
  });
  expectSuccess(result, 201);
  return requireString(asObject(result.body).id, 'agent id');
}

async function expectNoProjectTurn(projectId: string, messageId: string): Promise<void> {
  await withMongo(async (db) => {
    const [message, conversation] = await Promise.all([
      db.collection('messages').findOne({ messageId }),
      db.collection('conversations').findOne({ chatProjectId: projectId }),
    ]);
    expect(message, 'blocked project turn must not persist a message').toBeNull();
    expect(conversation, 'blocked project turn must not persist a conversation').toBeNull();
  });
}

async function completeAgentStream(
  request: APIRequestContext,
  token: string,
  started: RequestResult,
): Promise<string> {
  expectSuccess(started, 200);
  const startBody = asObject(started.body);
  expect(startBody.status).toBe('started');
  const conversationId = requireString(startBody.conversationId, 'conversation id');
  const streamId = requireString(startBody.streamId, 'stream id');
  await expect
    .poll(
      async () => {
        const status = await requestResult(request, {
          path: `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
          token,
        });
        if (status.status === 503) {
          return { active: true, status: 'pending' };
        }
        expectSuccess(status, 200);
        const body = asObject(status.body);
        return { active: body.active, status: body.status };
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toEqual({ active: false, status: 'complete' });
  const stream = await requestResult(request, {
    path: `/api/agents/chat/stream/${encodeURIComponent(streamId)}?resume=true`,
    token,
  });
  expectSuccess(stream, 200);
  expect(stream.text).toContain('E2E file_search complete');
  return conversationId;
}
function findContentFilterPayload(value: unknown): JsonObject | undefined {
  if (typeof value === 'string') {
    try {
      return findContentFilterPayload(JSON.parse(value));
    } catch {
      for (const line of value.split('\n')) {
        const data = line.startsWith('data:') ? line.slice('data:'.length).trim() : '';
        if (!data || data === '[DONE]') {
          continue;
        }
        try {
          const payload = findContentFilterPayload(JSON.parse(data));
          if (payload) {
            return payload;
          }
        } catch {
          // Ignore non-JSON SSE lines.
        }
      }
      return undefined;
    }
  }
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  if (!Array.isArray(value)) {
    const object = value as JsonObject;
    if (object.error === 'content_filter_block') {
      return object;
    }
    for (const nested of Object.values(object)) {
      const payload = findContentFilterPayload(nested);
      if (payload) {
        return payload;
      }
    }
    return undefined;
  }
  for (const nested of value) {
    const payload = findContentFilterPayload(nested);
    if (payload) {
      return payload;
    }
  }
  return undefined;
}

/**
 * Agent generation admission returns a `started` envelope before the background
 * initialization finishes. `ResumableAgentController` maps a content-filter
 * initialization failure to HTTP 400 only when headers have not been sent
 * (`api/server/controllers/agents/request.js:3381-3449`); after a job has
 * started, it finalizes the job error for the status and stream endpoints
 * (`api/server/controllers/agents/request.js:3465-3496`).
 *
 * The stream route wraps each event with `JSON.stringify` (`api/server/routes/agents/index.js:264-271`),
 * while `GenerationJobManager` publishes the terminal error string as the event's `error`
 * field (`packages/api/src/stream/GenerationJobManager.ts:4158-4167`). The structured
 * content-filter response is therefore JSON nested inside the SSE event JSON, and its
 * quotes are escaped in the raw body.
 */
async function expectBlockedAgentStream(
  request: APIRequestContext,
  token: string,
  started: RequestResult,
  marker: string,
): Promise<void> {
  if (started.status === 400) {
    expectContentFilterBlock(started, {
      source: 'file',
      field: 'extracted_text',
      marker,
    });
    return;
  }

  expectSuccess(started, 200);
  const startBody = asObject(started.body);
  expect(startBody.status).toBe('started');
  const conversationId = requireString(startBody.conversationId, 'blocked conversation id');
  const streamId = requireString(startBody.streamId, 'blocked stream id');

  let terminalStatus: RequestResult | undefined;
  await expect
    .poll(
      async () => {
        const status = await requestResult(request, {
          path: `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
          token,
        });
        if (status.status === 503) {
          return { active: true, status: 'pending' };
        }
        expectSuccess(status, 200);
        terminalStatus = status;
        const body = asObject(status.body);
        return { active: body.active, status: body.status };
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toEqual({ active: false, status: 'error' });

  // `/chat/status/:conversationId` intentionally exposes lifecycle state, not
  // `job.error` (`api/server/routes/agents/index.js:541-559`); retain the poll
  // to wait for terminal persistence, then inspect the client-visible SSE.
  const statusPayload = findContentFilterPayload(terminalStatus?.body ?? terminalStatus?.text);
  if (statusPayload) {
    expect(statusPayload).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'file',
        field: 'extracted_text',
      }),
    );
  }
  expect(terminalStatus?.text).not.toContain(marker);

  const stream = await requestResult(request, {
    path: `/api/agents/chat/stream/${encodeURIComponent(streamId)}?resume=true`,
    token,
  });
  expectSuccess(stream, 200);
  expect(stream.text).toContain('event: error');
  const streamPayload = findContentFilterPayload(stream.text);
  expect(streamPayload).toEqual(
    expect.objectContaining({
      error: 'content_filter_block',
      source: 'file',
      field: 'extracted_text',
    }),
  );
  expect(stream.text).toContain('content_filter_block');
  expect(stream.text).not.toContain(marker);
}

async function deleteFiles(fileIds: string[]): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('files').deleteMany({ file_id: { $in: fileIds } });
  });
}

async function deleteProjectConversations(projectId: string): Promise<void> {
  await withMongo(async (db) => {
    const conversations = await db
      .collection('conversations')
      .find({ chatProjectId: projectId }, { projection: { conversationId: 1 } })
      .toArray();
    const conversationIds = conversations
      .map((conversation) => conversation.conversationId)
      .filter((conversationId): conversationId is string => typeof conversationId === 'string');
    if (conversationIds.length > 0) {
      await db.collection('messages').deleteMany({ conversationId: { $in: conversationIds } });
    }
    await db.collection('conversations').deleteMany({ chatProjectId: projectId });
  });
}

async function getPrimaryUserId(): Promise<string> {
  const { email } = getPrimaryE2EUser();
  return withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email }, { projection: { _id: 1 } });
    return requireString(user?._id?.toString(), 'primary user id');
  });
}

async function runCleanup(actions: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(actions.map((action) => action()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    throw failure.reason;
  }
}

test.describe.serial('project policy scenarios', () => {
  test('project instructions rejected by a content policy return a content-filter response, not a 500 @scenario:filtered-project-instructions-return-content-filter-not-500', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const token = await loginAdmin(request);
    const suffix = randomUUID();
    const marker = `E2E-PROJECT-INSTRUCTIONS-${suffix}`;
    let projectId: string | undefined;
    let agentId: string | undefined;
    let assistantId: string | undefined;
    try {
      const project = await requestResult(request, {
        path: '/api/projects',
        token,
        method: 'POST',
        data: { name: `E2E filtered project ${suffix}`, instructions: marker },
      });
      expectSuccess(project, 201);
      projectId = requireString(asObject(project.body)._id, 'project id');
      const assistant = await requestResult(request, {
        path: '/api/assistants/v2',
        token,
        method: 'POST',
        data: {
          endpoint: 'assistants',
          model: 'gpt-4o-mini',
          name: `E2E filtered project assistant ${suffix}`,
          tools: [],
        },
      });
      expectSuccess(assistant, 201);
      assistantId = requireString(asObject(assistant.body).id, 'assistant id');
      agentId = await createAgent(request, token, suffix);

      await setRuntimeFilters(request, token, {
        agentInstructions: { pii: pii(`project-instructions-${suffix}`, 'instructions', marker) },
      } as FiltersConfig);

      const messageId = randomUUID();
      const blocked = await requestResult(request, {
        path: '/api/agents/chat/agents',
        token,
        method: 'POST',
        data: {
          text: 'Apply the project instructions.',
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: 'new',
          clientRequestId: suffix,
          messageId,
          responseMessageId: `${messageId}_response`,
          endpoint: 'agents',
          endpointType: 'agents',
          agent_id: agentId,
          chatProjectId: projectId,
          files: [],
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      expectContentFilterBlock(blocked, {
        source: 'agent_instruction',
        field: 'instructions',
        marker,
      });
      await expectNoProjectTurn(projectId, messageId);
      const hostedMessageId = randomUUID();
      const hostedBlocked = await requestResult(request, {
        path: '/api/assistants/v2/chat',
        token,
        method: 'POST',
        data: {
          text: 'Apply the project instructions.',
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: null,
          messageId: hostedMessageId,
          responseMessageId: `${hostedMessageId}_response`,
          endpoint: 'assistants',
          endpointType: 'assistants',
          model: 'gpt-4o-mini',
          assistant_id: assistantId,
          chatProjectId: projectId,
          files: [],
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      expectContentFilterBlock(hostedBlocked, {
        source: 'agent_instruction',
        field: 'instructions',
        marker,
      });

      const provider = `http://127.0.0.1:${process.env.E2E_ASSISTANTS_PORT || '8890'}`;
      const recorded = await request.get(`${provider}/__e2e/requests`);
      expect(recorded.ok()).toBeTruthy();
      const history = (await recorded.json()) as {
        requests: Array<{ path: string; body?: { assistant_id?: string } }>;
      };
      expect(
        history.requests.filter(
          (entry) => entry.path.endsWith('/runs') && entry.body?.assistant_id === assistantId,
        ),
      ).toHaveLength(0);
    } finally {
      await runCleanup([
        async () => {
          if (assistantId) {
            await requestResult(request, {
              path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants&model=gpt-4o-mini`,
              token,
              method: 'DELETE',
              data: { endpoint: 'assistants' },
            });
          }
        },
        () => restoreRuntimeFilters(request, token),
        async () => {
          if (projectId) {
            await requestResult(request, {
              path: `/api/projects/${encodeURIComponent(projectId)}`,
              token,
              method: 'DELETE',
            });
          }
        },
        async () => {
          if (agentId) {
            await requestResult(request, {
              path: `/api/agents/${encodeURIComponent(agentId)}`,
              token,
              method: 'DELETE',
            });
          }
        },
      ]);
    }
  });
  test('a project file whose content violates an active policy is not searchable from the project @scenario:policy-violating-project-file-is-not-searchable', async ({
    request,
  }) => {
    test.setTimeout(180000);
    const token = await loginAdmin(request);
    const resetRag = await request.post(`${RAG_API_BASE}/__debug/reset`);
    expect(resetRag.ok()).toBeTruthy();
    const suffix = randomUUID();
    const marker = `E2E-PROJECT-FILE-${suffix}`;
    const fileIds: string[] = [];
    let projectId: string | undefined;
    let agentId: string | undefined;
    try {
      const upload = async (filename: string, content: string): Promise<{ fileId: string }> => {
        const result = await requestResult(request, {
          path: '/api/files',
          token,
          method: 'POST',
          multipart: {
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            message_file: 'true',
            tool_resource: 'context',
            file_id: randomUUID(),
            file: { name: filename, mimeType: 'text/plain', buffer: Buffer.from(content) },
          },
        });
        expectSuccess(result, 200);
        const body = asObject(result.body);
        const fileId = requireString(body.file_id, `${filename} file id`);
        fileIds.push(fileId);
        await withMongo(async (db) => {
          await db.collection('files').updateOne(
            { file_id: fileId },
            {
              $set: {
                embedded: true,
                context: 'message_attachment',
                // Keep the direct-upload fixture equivalent to a completed
                // text extraction, rather than relying on the upload worker's
                // asynchronous extraction state. The active policy resolves
                // the full record and inspects extracted_text.
                textFormat: 'text',
                status: 'ready',
                usage: 0,
                source: 'local',
                llmDeliveryPath: 'text',
                // resolveChatProjectPolicyFiles(..., includeContent: true)
                // returns this Mongo `text` field; extractFileContent maps
                // FileContentInput.text to the policy's extracted_text field
                // (packages/api/src/projects/resources.ts:172-181;
                // packages/api/src/protection/adapters/submissions.ts:1096-1127).
                extracted_text: content,
                text: content,
              },
            },
          );
        });
        return { fileId };
      };
      const benign = await upload(
        `project-benign-${suffix}.txt`,
        'Safe project reference content.',
      );
      const violating = await upload(`project-violating-${suffix}.txt`, marker);
      const project = await requestResult(request, {
        path: '/api/projects',
        token,
        method: 'POST',
        data: { name: `E2E project file policy ${suffix}` },
      });
      expectSuccess(project, 201);
      projectId = requireString(asObject(project.body)._id, 'project id');
      for (const fileId of [benign.fileId, violating.fileId]) {
        const attached = await requestResult(request, {
          path: `/api/projects/${encodeURIComponent(projectId)}/files`,
          token,
          method: 'POST',
          data: { file_id: fileId },
        });
        expectSuccess(attached, 200);
      }
      agentId = await createAgent(request, token, suffix, ['file_search']);

      await setRuntimeFilters(request, token, {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [
              {
                id: `project-file-${suffix}`,
                label: 'E2E violating file',
                regex: `^${marker}$`,
              },
            ],
            // No `uninspectable: 'block'` here: this scenario is about a file
            // whose extracted text matches the policy, not about fail-closing
            // on opaque inputs. Fail-close would reject the recovery turn for
            // unrelated opaque parts of the request envelope.
          },
        },
      } as FiltersConfig);

      const listed = await requestResult(request, {
        path: `/api/projects/${encodeURIComponent(projectId)}/files`,
        token,
      });
      expectSuccess(listed, 200);
      expect(listed.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file_id: benign.fileId, availability: 'ready' }),
          expect.objectContaining({ file_id: violating.fileId }),
        ]),
      );
      const searchText = `E2E_FILE_SEARCH:${suffix}`;

      const blockedMessageId = randomUUID();
      const blocked = await requestResult(request, {
        path: '/api/agents/chat/agents',
        token,
        method: 'POST',
        data: {
          text: searchText,
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: 'new',
          clientRequestId: `${suffix}-blocked`,
          messageId: blockedMessageId,
          responseMessageId: `${blockedMessageId}_response`,
          endpoint: 'agents',
          endpointType: 'agents',
          agent_id: agentId,
          chatProjectId: projectId,
          files: [],
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      await expectBlockedAgentStream(request, token, blocked, marker);
      // A late-bound file policy is deliberately persisted as an error turn after
      // the generation ACK; request.js:3478-3487 calls saveErrorTurn in that path.
      const blockedRagResponse = await request.get(`${RAG_API_BASE}/__debug/embedded`);
      expect(blockedRagResponse.ok()).toBeTruthy();
      const blockedRagBody = (await blockedRagResponse.json()) as {
        embedded?: Array<{ file_id?: string }>;
        queries?: Array<{ file_id?: string }>;
      };
      const blockedRagFileIds = [
        ...(blockedRagBody.embedded ?? []).map((record) => record.file_id),
        ...(blockedRagBody.queries ?? []).map((query) => query.file_id),
      ];
      expect(blockedRagFileIds).not.toContain(violating.fileId);

      const removed = await requestResult(request, {
        path: `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(violating.fileId)}`,
        token,
        method: 'DELETE',
      });
      expectSuccess(removed, 200);

      const resetAfterRemoval = await request.post(`${RAG_API_BASE}/__debug/reset`);
      expect(resetAfterRemoval.ok()).toBeTruthy();
      const messageId = randomUUID();
      const started = await requestResult(request, {
        path: '/api/agents/chat/agents',
        token,
        method: 'POST',
        data: {
          text: searchText,
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: 'new',
          clientRequestId: `${suffix}-benign`,
          messageId,
          responseMessageId: `${messageId}_response`,
          endpoint: 'agents',
          endpointType: 'agents',
          agent_id: agentId,
          chatProjectId: projectId,
          files: [],
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      await completeAgentStream(request, token, started);

      const ragResponse = await request.get(`${RAG_API_BASE}/__debug/embedded`);
      expect(ragResponse.ok()).toBeTruthy();
      const ragBody = (await ragResponse.json()) as {
        embedded?: Array<{ file_id?: string }>;
        queries?: Array<{ file_id?: string }>;
      };
      const queriedFileIds = (ragBody.queries ?? []).map((query) => query.file_id);
      const embeddedFileIds = (ragBody.embedded ?? []).map((record) => record.file_id);
      expect(queriedFileIds).toContain(benign.fileId);
      expect(embeddedFileIds).not.toContain(violating.fileId);
      expect(queriedFileIds).not.toContain(violating.fileId);
    } finally {
      await runCleanup([
        () => restoreRuntimeFilters(request, token),
        async () => {
          if (projectId) {
            await deleteProjectConversations(projectId);
            await requestResult(request, {
              path: `/api/projects/${encodeURIComponent(projectId)}`,
              token,
              method: 'DELETE',
            });
          }
        },
        async () => {
          if (agentId) {
            await requestResult(request, {
              path: `/api/agents/${encodeURIComponent(agentId)}`,
              token,
              method: 'DELETE',
            });
          }
        },
        () => deleteFiles(fileIds),
      ]);
    }
  });

  test('a low-balance user is refused before the hosted Assistant provider runs @scenario:low-balance-refused-before-hosted-assistant-run', async ({
    request,
  }) => {
    test.setTimeout(180000);
    const token = await loginAdmin(request);
    const userId = await getPrimaryUserId();
    const suffix = randomUUID();
    const headers = { Authorization: `Bearer ${token}` };
    const longInstructions = `E2E balance project policy ${suffix} ${'inflate prompt '.repeat(200)}`;
    let projectId: string | undefined;
    let assistantId: string | undefined;
    let balanceSeeded = false;
    const balanceUserId = new ObjectId(userId);
    try {
      // The assistants router installs configMiddleware before /v2/chat
      // (api/server/routes/assistants/index.js:10-17); it resolves options from
      // req.user.id (`packages/api/src/app/service.ts:100-112`), and getBalanceConfig
      // overlays that per-user balance section (`packages/api/src/app/config.ts:20-32`).
      // Polling /api/config proves the override is visible before the chat request.
      const override = await request.put(`/api/admin/config/user/${encodeURIComponent(userId)}`, {
        headers,
        data: { overrides: { balance: { enabled: true } } },
      });
      expect(override.ok(), await override.text()).toBe(true);
      await expect
        .poll(
          async () => {
            const config = await requestResult(request, { path: '/api/config', token });
            const body = asObject(config.body);
            return asObject(body.balance).enabled;
          },
          { timeout: 30000, intervals: [250, 500, 1000] },
        )
        .toBe(true);

      // checkBalanceRecord reads balances by user and compares tokenCredits with
      // the calculated prompt cost (packages/api/src/middleware/checkBalance.ts:48-146).
      // The production Balance schema stores `user` as ObjectId and credits as Number
      // (packages/data-schemas/src/schema/balance.ts:5-16), matching this seeded document.
      balanceSeeded = true;
      await withMongo(async (db) => {
        await db.collection('balances').deleteMany({ user: balanceUserId });
        await db.collection('balances').insertOne({ user: balanceUserId, tokenCredits: 1 });
      });

      const project = await requestResult(request, {
        path: '/api/projects',
        token,
        method: 'POST',
        data: { name: `E2E low balance project ${suffix}`, instructions: longInstructions },
      });
      expectSuccess(project, 201);
      projectId = requireString(asObject(project.body)._id, 'project id');

      const assistant = await requestResult(request, {
        path: '/api/assistants/v2',
        token,
        method: 'POST',
        data: {
          endpoint: 'assistants',
          model: 'gpt-4o-mini',
          name: `E2E low balance assistant ${suffix}`,
          tools: [],
        },
      });
      expectSuccess(assistant, 201);
      assistantId = requireString(asObject(assistant.body).id, 'assistant id');

      const messageId = randomUUID();
      const refused = await requestResult(request, {
        path: '/api/assistants/v2/chat',
        token,
        method: 'POST',
        data: {
          text: 'Run the hosted assistant.',
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: null,
          messageId,
          responseMessageId: `${messageId}_response`,
          endpoint: 'assistants',
          endpointType: 'assistants',
          model: 'gpt-4o-mini',
          assistant_id: assistantId,
          chatProjectId: projectId,
          files: [],
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      // chatV2 runs checkBalanceBeforeRun alongside thread initialization and
      // before the hosted run dispatch; its catch path sends the thrown balance
      // JSON through the Assistant error response (chatV2.js:191-236,436-437,631-637).
      // sendResponse serializes this branch as exactly HTTP 500 + `{ error }`
      // (`api/server/middleware/error.js:94-99`).
      expect(refused.status).toBe(500);
      expect(refused.body).toEqual({ error: expect.any(String) });
      const errorText = requireString(asObject(refused.body).error, 'balance error');
      const balanceError = JSON.parse(errorText) as {
        type?: string;
        balance?: number;
        tokenCost?: number;
        promptTokens?: number;
      };
      expect(balanceError).toEqual(expect.objectContaining({ type: 'token_balance', balance: 1 }));
      expect(balanceError.tokenCost).toBeGreaterThan(1);
      expect(balanceError.promptTokens).toBeGreaterThan(1);

      // The fake provider records every request; a balance refusal must happen
      // before the hosted Assistants POST /threads/:id/runs call.
      const provider = `http://127.0.0.1:${process.env.E2E_ASSISTANTS_PORT || '8890'}`;
      const recorded = await request.get(`${provider}/__e2e/requests`);
      expect(recorded.ok()).toBeTruthy();
      const history = (await recorded.json()) as {
        requests: Array<{ path: string; body?: { assistant_id?: string } }>;
      };
      expect(
        history.requests.filter(
          (entry) => entry.path.endsWith('/runs') && entry.body?.assistant_id === assistantId,
        ),
      ).toHaveLength(0);
    } finally {
      await runCleanup([
        async () => {
          if (assistantId) {
            await requestResult(request, {
              path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants&model=gpt-4o-mini`,
              token,
              method: 'DELETE',
              data: { endpoint: 'assistants' },
            });
          }
        },
        async () => {
          if (projectId) {
            await deleteProjectConversations(projectId);
            await requestResult(request, {
              path: `/api/projects/${encodeURIComponent(projectId)}`,
              token,
              method: 'DELETE',
            });
          }
        },
        async () => {
          if (balanceSeeded) {
            await withMongo(async (db) => {
              await db.collection('balances').deleteMany({ user: balanceUserId });
            });
          }
        },
        async () => {
          const removed = await request.delete(
            `/api/admin/config/user/${encodeURIComponent(userId)}`,
            {
              headers,
              failOnStatusCode: false,
            },
          );
          expect([200, 404], await removed.text()).toContain(removed.status());
        },
        () => restoreRuntimeFilters(request, token),
      ]);
    }
  });
});
