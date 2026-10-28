import { randomUUID } from 'crypto';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { ObjectId } from 'mongodb';
import cleanupUser from '../../../setup/cleanupUser';
import { getPrimaryE2EUser, getSecondaryE2EUser } from '../../../setup/users.mock';
import type { User } from '../../../types';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  withMongo,
} from '../db';
import { loginAdmin } from '../content-filters.helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
// Project reads and file reads map an owner-scoped miss to this 404 body
// (packages/api/src/projects/handlers.ts:24,198-205,250-260,274-292).
const PROJECT_NOT_FOUND = 'Project not found';

type ProjectResponse = {
  _id?: string;
  name?: string;
  instructions?: string;
  file_ids?: string[];
};

type UserDocument = {
  _id: ObjectId;
  tenantId?: string;
};

type ConversationDocument = {
  conversationId?: string;
};

type ProjectFileView = {
  file_id?: string;
  availability?: string;
};

type ProjectConversationsResponse = {
  conversations?: Array<{ conversationId?: string; chatProjectId?: string }>;
  nextCursor?: string | null;
};

function requireProjectId(project: ProjectResponse): string {
  if (typeof project._id !== 'string' || project._id.length === 0) {
    throw new Error('Project response did not include an id');
  }
  return project._id;
}

async function responseDetails(response: APIResponse): Promise<{ status: number; text: string }> {
  const details = { status: response.status(), text: await response.text() };
  await response.dispose();
  return details;
}

async function createProject(
  request: APIRequestContext,
  token: string,
  name: string,
  instructions: string,
): Promise<string> {
  const response = await request.post('/api/projects', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, instructions },
    failOnStatusCode: false,
  });
  // The projects router mounts this handler at POST /api/projects and the handler returns 201
  // with the created project (api/server/routes/projects.js:21-22; packages/api/src/projects/handlers.ts:151-163).
  expect(response.status()).toBe(201);
  const project = (await response.json()) as ProjectResponse;
  await response.dispose();
  return requireProjectId(project);
}

async function registerAndLoginSecondary(
  baseURL: string,
  user: User,
  tenantId: string,
): Promise<{ api: APIRequestContext; token: string }> {
  await cleanupUser(user);
  const api = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'X-Tenant-Id': tenantId },
  });

  const register = await api.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
    failOnStatusCode: false,
  });
  expect(register.ok()).toBeTruthy();
  await register.dispose();

  const login = await api.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
    failOnStatusCode: false,
  });
  expect(login.ok()).toBeTruthy();
  const payload = (await login.json()) as { token?: unknown };
  await login.dispose();
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    await api.dispose();
    throw new Error('Secondary login response did not include a bearer token');
  }
  return { api, token: payload.token };
}

async function seedProjectFile({
  fileId,
  filename,
  ownerEmail,
  text,
}: {
  fileId: string;
  filename: string;
  ownerEmail: string;
  text: string;
}): Promise<void> {
  await withMongo(async (db) => {
    const owner = await db.collection<UserDocument>('users').findOne({ email: ownerEmail });
    if (!owner) {
      throw new Error(`Expected project owner ${ownerEmail} to exist`);
    }
    const now = new Date();
    await db.collection('files').insertOne({
      user: owner._id,
      file_id: fileId,
      bytes: Buffer.byteLength(text),
      filename,
      filepath: `/tmp/${fileId}.txt`,
      object: 'file',
      embedded: true,
      context: 'message_attachment',
      type: 'text/plain',
      text,
      textFormat: 'text',
      status: 'ready',
      usage: 0,
      source: 'local',
      ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function deleteSeededFile(fileId: string): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('files').deleteMany({ file_id: fileId });
  });
}

async function conversationIdsForUser(email: string): Promise<string[]> {
  return withMongo(async (db) => {
    const user = await db.collection<UserDocument>('users').findOne({ email });
    if (!user) {
      throw new Error(`Expected conversation owner ${email} to exist`);
    }
    const userId = user._id.toString();
    const conversations = await db
      .collection<ConversationDocument & { user?: unknown }>('conversations')
      .find({ $or: [{ user: userId }, { user: user._id }] })
      .project({ _id: 0, conversationId: 1 })
      .toArray();
    return conversations
      .map((conversation) => conversation.conversationId)
      .filter((conversationId): conversationId is string => typeof conversationId === 'string')
      .sort();
  });
}

function assertNoProjectSecrets(text: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

test.describe('project access', () => {
  test('a user from another tenant sees 404 for a project, its files and its file candidates @scenario:other-tenant-user-gets-404-for-project-and-files', async ({
    request,
    baseURL,
  }) => {
    test.setTimeout(60000);
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for project access tests');
    }

    const owner = getPrimaryE2EUser();
    const secondary = getSecondaryE2EUser();
    const suffix = randomUUID();
    const projectName = `Cross-tenant project ${suffix}`;
    const instructions = `Private project instructions ${suffix}`;
    const fileId = `cross-tenant-file-${suffix}`;
    const filename = `private-${suffix}.txt`;
    const ownerConversationId = randomUUID();
    const secondaryConversationId = randomUUID();
    const otherTenantId = `e2e-project-access-${suffix}`;
    const token = await loginAdmin(request);
    let projectId: string | undefined;
    let secondaryApi: APIRequestContext | undefined;
    try {
      projectId = await createProject(request, token, projectName, instructions);

      await seedProjectFile({
        fileId,
        filename,
        ownerEmail: owner.email,
        text: `Private file contents ${suffix}`,
      });
      const attach = await request.post(`/api/projects/${projectId}/files`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { file_id: fileId },
        failOnStatusCode: false,
      });
      // addProjectFile returns 200 with the updated project on success
      // (api/server/routes/projects.js:26; packages/api/src/projects/handlers.ts:314-329).
      expect(attach.status()).toBe(200);
      await attach.dispose();

      await seedConversations(owner.email, [
        {
          conversationId: ownerConversationId,
          title: `Owner chat ${suffix}`,
          updatedAt: new Date(),
        },
      ]);
      const secondaryAuth = await registerAndLoginSecondary(baseURL, secondary, otherTenantId);
      const foreignApi = secondaryAuth.api;
      const foreignToken = secondaryAuth.token;
      secondaryApi = foreignApi;
      // Register/login creates the secondary user in the per-test tenant via X-Tenant-Id above.
      // Store its API context before the test's remaining assertions so the outer finally always
      // disposes it and removes the secondary user even when a later assertion fails.
      await seedConversations(secondary.email, [
        {
          conversationId: secondaryConversationId,
          title: `Secondary chat ${suffix}`,
          updatedAt: new Date(),
        },
      ]);
      const secretValues = [projectName, instructions, fileId, filename];
      const foreignProject = await responseDetails(
        await foreignApi.get(`/api/projects/${projectId}`, {
          headers: { Authorization: `Bearer ${foreignToken}` },
          failOnStatusCode: false,
        }),
      );
      // Project reads are owner/tenant scoped and return the same 404 body without project data
      // (api/server/routes/projects.js:28; packages/api/src/projects/handlers.ts:196-210).
      expect(foreignProject.status, foreignProject.text).toBe(404);
      expect(JSON.parse(foreignProject.text)).toEqual({ error: PROJECT_NOT_FOUND });
      assertNoProjectSecrets(foreignProject.text, secretValues);

      const foreignFiles = await responseDetails(
        await foreignApi.get(`/api/projects/${projectId}/files`, {
          headers: { Authorization: `Bearer ${foreignToken}` },
          failOnStatusCode: false,
        }),
      );
      // Project file listing is owner/tenant scoped and returns the same 404 body
      // (api/server/routes/projects.js:25; packages/api/src/projects/handlers.ts:250-270).
      expect(foreignFiles.status, foreignFiles.text).toBe(404);
      expect(JSON.parse(foreignFiles.text)).toEqual({ error: PROJECT_NOT_FOUND });
      assertNoProjectSecrets(foreignFiles.text, secretValues);

      const foreignAvailable = await responseDetails(
        await foreignApi.get(`/api/projects/${projectId}/files/available`, {
          headers: { Authorization: `Bearer ${foreignToken}` },
          failOnStatusCode: false,
        }),
      );
      // Available-file candidates use the same owner/tenant project check and 404 body
      // (api/server/routes/projects.js:24; packages/api/src/projects/handlers.ts:274-292).
      expect(foreignAvailable.status, foreignAvailable.text).toBe(404);
      expect(JSON.parse(foreignAvailable.text)).toEqual({ error: PROJECT_NOT_FOUND });
      assertNoProjectSecrets(foreignAvailable.text, secretValues);

      const foreignAssignment = await responseDetails(
        await foreignApi.put('/api/projects/conversations/' + secondaryConversationId, {
          headers: { Authorization: `Bearer ${foreignToken}` },
          data: { projectId },
          failOnStatusCode: false,
        }),
      );
      // This route delegates to assignConversationToProject (api/server/routes/projects.js:19,23).
      // Its database method checks conversation ownership before project ownership
      // (packages/data-schemas/src/methods/chatProject.ts:610-635), so this foreign caller
      // legitimately receives the non-leaking conversation miss from the handler
      // (packages/api/src/projects/handlers.ts:166-190).
      expect(foreignAssignment.status, foreignAssignment.text).toBe(404);
      expect(JSON.parse(foreignAssignment.text)).toEqual({ error: 'Conversation not found' });
      assertNoProjectSecrets(foreignAssignment.text, secretValues);

      const foreignConversations = await responseDetails(
        await foreignApi.get(`/api/convos?projectId=${encodeURIComponent(projectId)}`, {
          headers: { Authorization: `Bearer ${foreignToken}` },
          failOnStatusCode: false,
        }),
      );
      // The conversations route returns 200 and filters by the authenticated user before the
      // project id (api/server/routes/convos.js:146-180; packages/data-schemas/src/methods/conversation.ts:2699-2722).
      expect(foreignConversations.status, foreignConversations.text).toBe(200);
      const foreignConversationBody = JSON.parse(
        foreignConversations.text,
      ) as ProjectConversationsResponse;
      expect(foreignConversationBody.conversations).toEqual([]);
      assertNoProjectSecrets(foreignConversations.text, secretValues);

      const ownerAssignment = await request.put(
        `/api/projects/conversations/${ownerConversationId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          data: { projectId },
          failOnStatusCode: false,
        },
      );
      // Successful assignment returns 200 from the same handler (packages/api/src/projects/handlers.ts:177-186).
      expect(ownerAssignment.status()).toBe(200);
      await ownerAssignment.dispose();

      const ownerProject = await request.get(`/api/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      // A project read returns the owner-scoped project body with status 200
      // (api/server/routes/projects.js:28; packages/api/src/projects/handlers.ts:196-207).
      expect(ownerProject.status()).toBe(200);
      const ownerProjectBody = (await ownerProject.json()) as ProjectResponse;
      expect(ownerProjectBody.name).toBe(projectName);
      expect(ownerProjectBody.instructions).toBe(instructions);
      expect(ownerProjectBody.file_ids).toContain(fileId);
      await ownerProject.dispose();

      const ownerFiles = await request.get(`/api/projects/${projectId}/files`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      // Owner-scoped project file listing returns 200 (api/server/routes/projects.js:25;
      // packages/api/src/projects/handlers.ts:250-267).
      expect(ownerFiles.status()).toBe(200);
      const ownerFileBody = (await ownerFiles.json()) as ProjectFileView[];
      expect(ownerFileBody.some((file) => file.file_id === fileId)).toBe(true);
      await ownerFiles.dispose();

      const ownerAvailable = await request.get(`/api/projects/${projectId}/files/available`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      // Available project files return 200 after the owner/tenant check
      // (api/server/routes/projects.js:24; packages/api/src/projects/handlers.ts:286-303).
      expect(ownerAvailable.status()).toBe(200);
      await ownerAvailable.dispose();

      const ownerConversations = await request.get(
        `/api/convos?projectId=${encodeURIComponent(projectId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          failOnStatusCode: false,
        },
      );
      // The conversations route serializes a successful owner query as 200
      // (api/server/routes/convos.js:168-180).
      expect(ownerConversations.status()).toBe(200);
      const ownerConversationBody =
        (await ownerConversations.json()) as ProjectConversationsResponse;
      expect(
        ownerConversationBody.conversations?.some(
          (conversation) => conversation.conversationId === ownerConversationId,
        ),
      ).toBe(true);

      await ownerConversations.dispose();
    } finally {
      if (projectId && token) {
        const deleted = await request.delete(`/api/projects/${projectId}`, {
          headers: { Authorization: `Bearer ${token}` },
          failOnStatusCode: false,
        });
        await deleted.dispose();
      }
      await deleteMessagesByConversation([ownerConversationId, secondaryConversationId]);
      await deleteConversations([ownerConversationId, secondaryConversationId]);
      await deleteSeededFile(fileId);
      if (secondaryApi) {
        await secondaryApi.dispose();
      }
      await cleanupUser(secondary);
    }
  });

  test('a turn naming a deleted project fails with 404 and leaves no error conversation @scenario:turn-on-deleted-project-404s-without-error-turn', async ({
    request,
  }) => {
    test.setTimeout(60000);
    const token = await loginAdmin(request);
    const suffix = randomUUID();
    const projectName = `Deleted project ${suffix}`;
    const agentName = `Deleted project agent ${suffix}`;
    const clientRequestId = `deleted-project-turn-${suffix}`;
    const messageId = randomUUID();
    let projectId: string | undefined;
    let agentId: string | undefined;

    try {
      projectId = await createProject(request, token, projectName, 'Deleted project instructions');
      const agentResponse = await request.post('/api/agents', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          name: agentName,
          description: 'Agent for deleted-project admission coverage.',
          instructions: 'Use safe deterministic instructions.',
          provider: 'Mock Provider A',
          model: 'mock-model-a',
          model_parameters: {},
          tools: [],
          conversation_starters: [],
        },
        failOnStatusCode: false,
      });
      // Agent creation is mounted at POST /agents and returns 201 on success
      // (api/server/routes/agents/v1.js:42-47; api/server/controllers/agents/v1.js:913-914).
      expect(agentResponse.status()).toBe(201);
      const agent = (await agentResponse.json()) as { id?: unknown };
      await agentResponse.dispose();
      if (typeof agent.id !== 'string' || agent.id.length === 0) {
        throw new Error('Agent response did not include an id');
      }
      agentId = agent.id;

      const deleted = await request.delete(`/api/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
        failOnStatusCode: false,
      });
      // Project deletion returns 200 when the owner-scoped delete succeeds
      // (api/server/routes/projects.js:30; packages/api/src/projects/handlers.ts:363-374).
      expect(deleted.status()).toBe(200);

      const beforeConversationIds = await conversationIdsForUser(getPrimaryE2EUser().email);
      const failedTurn = await request.post('/api/agents/chat/agents', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          text: 'This turn must not create an error conversation.',
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: 'new',
          clientRequestId,
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
          generationProtocolVersion: 2,
        },
        failOnStatusCode: false,
      });
      // resolveChatProjectContext signals the unavailable sentinel (packages/api/src/projects/context.ts:42,101-107).
      // getInitializationFailure maps it to status 404 and this error string, then
      // sendGenerationJson spreads that status and appends generationProtocolVersion
      // (api/server/controllers/agents/request.js:96-118).
      expect(failedTurn.status()).toBe(404);
      const failedBody = (await failedTurn.json()) as unknown;
      expect(failedBody).toEqual({
        error: 'Conversation context unavailable',
        generationProtocolVersion: 2,
        status: 404,
      });

      const afterConversationIds = await conversationIdsForUser(getPrimaryE2EUser().email);
      expect(afterConversationIds).toEqual(beforeConversationIds);
      await withMongo(async (db) => {
        expect(await db.collection('messages').countDocuments({ messageId })).toBe(0);
      });
    } finally {
      if (agentId) {
        const deletedAgent = await request.delete(`/api/agents/${encodeURIComponent(agentId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          failOnStatusCode: false,
        });
        await deletedAgent.dispose();
      }
      // Cleanup repeats the owner-scoped delete and is intentionally safe after the project was
      // already deleted (api/server/routes/projects.js:30; packages/api/src/projects/handlers.ts:363-374).
      if (projectId) {
        const deletedProject = await request.delete(`/api/projects/${projectId}`, {
          headers: { Authorization: `Bearer ${token}` },
          failOnStatusCode: false,
        });
        await deletedProject.dispose();
      }
    }
  });
});
