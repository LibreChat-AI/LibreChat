import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { FileContext } from 'librechat-data-provider';
import { getE2EUser } from '../../../setup/user';
import { MOCK_ENDPOINTS, RAG_API_BASE } from '../helpers';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';
import { loginAdmin, requestResult } from '../content-filters.helpers';
import type { RequestResult } from '../content-filters.helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const MCP_SERVER_NAME = 'e2e-memory';
const MCP_SERVER_TOOL_ID = `sys__server__sys_mcp_${MCP_SERVER_NAME}`;
const APPROVAL_TOOL_ID = `approval_probe_mcp_${MCP_SERVER_NAME}`;
const APPROVAL_MARKER = 'E2E_TOOL_APPROVAL:';
const PROJECT_CONTEXT_CHANGED = 'Project context changed; start a new turn.';

interface JsonObject {
  [key: string]: unknown;
}

interface ProjectFileFixture {
  projectId: string;
  fileId: string;
}

interface AgentFixture {
  id: string;
  tools?: string[];
}

interface SkillResponse {
  _id: string;
}

interface PendingAction {
  actionId?: string;
  conversationId?: string;
  streamId?: string;
  payload?: {
    type?: string;
    action_requests?: Array<{ tool_call_id?: string }>;
  };
}

interface StatusResponse {
  active?: boolean;
  status?: string;
  streamId?: string;
  pendingAction?: PendingAction;
}

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

function expectSuccess(result: RequestResult, status: number): void {
  expect(result.ok, result.text).toBe(true);
  expect(result.status, result.text).toBe(status);
}

async function seedProjectFile(
  request: APIRequestContext,
  token: string,
  suffix: string,
): Promise<ProjectFileFixture> {
  const project = await requestResult(request, {
    path: '/api/projects',
    token,
    method: 'POST',
    data: { name: `E2E Resume Project ${suffix}` },
  });
  // api/server/routes/projects.js:22 and createProjectHandlers return 201.
  expectSuccess(project, 201);
  const projectId = requireString(
    asObject(project.body)._id ?? asObject(project.body).id,
    'project id',
  );
  const fileId = randomUUID();
  const filename = `project-resume-${suffix}.txt`;
  const fileText = `Project corpus fixture ${suffix}`;

  try {
    // This direct fixture matches project-files-ui.spec.ts:53-89; these scenarios
    // exercise project fingerprinting and file_search, not multipart parsing.
    await withMongo(async (db) => {
      const owner = await db.collection('users').findOne({ email: getE2EUser().email });
      if (!owner) {
        throw new Error('The authenticated e2e user was not found while seeding files');
      }
      const now = new Date();
      await db.collection('files').insertOne({
        _id: new ObjectId(),
        user: owner._id,
        ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
        file_id: fileId,
        bytes: Buffer.byteLength(fileText),
        filename,
        filepath: `/tmp/${fileId}.txt`,
        object: 'file',
        embedded: true,
        type: 'text/plain',
        text: fileText,
        extracted_text: fileText,
        textFormat: 'text',
        status: 'ready',
        usage: 0,
        source: 'local',
        context: FileContext.message_attachment,
        createdAt: now,
        updatedAt: now,
      });
    });

    const attached = await requestResult(request, {
      path: `/api/projects/${encodeURIComponent(projectId)}/files`,
      token,
      method: 'POST',
      data: { file_id: fileId },
    });
    // api/server/routes/projects.js:26 and addProjectFile return 2xx for an owned file.
    expectSuccess(attached, 200);
    return { projectId, fileId };
  } catch (error) {
    await requestResult(request, {
      path: `/api/projects/${encodeURIComponent(projectId)}`,
      token,
      method: 'DELETE',
    }).catch(() => undefined);
    await deleteProjectFile(fileId);
    throw error;
  }
}

async function deleteProjectFile(fileId: string): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('files').deleteMany({ file_id: fileId });
  });
}

async function updateProjectFile(fileId: string, update: Record<string, unknown>): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('files').updateOne({ file_id: fileId }, { $set: update });
  });
}

async function createApprovalAgent(
  request: APIRequestContext,
  token: string,
  suffix: string,
): Promise<AgentFixture> {
  const result = await requestResult(request, {
    path: '/api/agents',
    token,
    method: 'POST',
    data: {
      name: `E2E Project Approval Agent ${suffix}`,
      description: 'Project context approval resume fixture.',
      instructions: 'Use the approval probe and report the result.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      /** `file_search` is what admits the project corpus into a run, and these
       *  scenarios pause a run whose context references a project file; an agent
       *  that cannot search never resolves those files, so their change would not
       *  be material to its resume. */
      tools: ['file_search', MCP_SERVER_TOOL_ID, APPROVAL_TOOL_ID],
    },
  });
  // api/server/routes/agents/management.js:153 and createAgentManagementCreateHandler return 201.
  expectSuccess(result, 201);
  return { id: requireString(asObject(result.body).id, 'agent id') };
}

function startBody({
  messageId,
  text,
  agentId,
  projectId,
  clientRequestId,
}: {
  messageId: string;
  text: string;
  agentId: string;
  projectId: string;
  clientRequestId: string;
}): JsonObject {
  return {
    text,
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
  };
}

async function startAgentTurn(
  request: APIRequestContext,
  token: string,
  body: JsonObject,
): Promise<{ conversationId: string; streamId: string }> {
  const result = await requestResult(request, {
    path: '/api/agents/chat/agents',
    token,
    method: 'POST',
    data: body,
  });
  // api/server/controllers/agents/request.js:1880 sends the started envelope with HTTP 200.
  expectSuccess(result, 200);
  const response = asObject(result.body);
  return {
    conversationId: requireString(response.conversationId, 'conversation id'),
    streamId: requireString(response.streamId, 'stream id'),
  };
}

async function waitForPendingAction(
  request: APIRequestContext,
  token: string,
  conversationId: string,
): Promise<{ status: StatusResponse; streamId: string }> {
  let latest: StatusResponse | undefined;
  await expect
    .poll(
      async () => {
        const result = await requestResult(request, {
          path: `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
          token,
        });
        if (result.status === 503) {
          return 'pending';
        }
        // api/server/routes/agents/index.js:541-559 publishes lifecycle status and pendingAction.
        expectSuccess(result, 200);
        latest = asObject(result.body) as StatusResponse;
        if (latest.status === 'requires_action' && latest.pendingAction) {
          return 'requires_action';
        }
        return latest.status ?? 'pending';
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toBe('requires_action');

  if (!latest?.pendingAction) {
    throw new Error('The generation became requires_action without publishing pendingAction');
  }
  return { status: latest, streamId: requireString(latest.streamId, 'status stream id') };
}

function resumeBody(pending: PendingAction, agentId: string, projectId: string): JsonObject {
  const actionId = requireString(pending.actionId, 'pending action id');
  const conversationId = requireString(pending.conversationId, 'pending conversation id');
  const actionRequests = pending.payload?.action_requests ?? [];
  const decisions = actionRequests.map((action) => ({
    // The status projection is the source of truth for the paused tool-call ids.
    tool_call_id: requireString(action.tool_call_id, 'pending tool call id'),
    decision: 'approve',
  }));
  if (decisions.length === 0) {
    throw new Error('The pending approval did not publish any tool calls');
  }
  return {
    actionId,
    agent_id: agentId,
    conversationId,
    endpoint: 'agents',
    endpointType: 'agents',
    chatProjectId: projectId,
    decisions,
  };
}
async function resumeApproval(
  request: APIRequestContext,
  token: string,
  pending: PendingAction,
  agentId: string,
  projectId: string,
): Promise<RequestResult> {
  const result = await requestResult(request, {
    path: '/api/agents/chat/resume',
    token,
    method: 'POST',
    data: resumeBody(pending, agentId, projectId),
  });
  return result;
}

async function completeStream(
  request: APIRequestContext,
  token: string,
  conversationId: string,
  streamId: string,
  expectedText?: string,
): Promise<RequestResult> {
  await expect
    .poll(
      async () => {
        const result = await requestResult(request, {
          path: `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
          token,
        });
        if (result.status === 503) {
          return { active: true, status: 'pending' };
        }
        // api/server/routes/agents/index.js:541-549 exposes terminal status after persistence.
        expectSuccess(result, 200);
        const body = asObject(result.body);
        return { active: body.active, status: body.status };
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toEqual({ active: false, status: 'complete' });

  const stream = await requestResult(request, {
    path: `/api/agents/chat/stream/${encodeURIComponent(streamId)}?resume=true`,
    token,
  });
  // api/server/routes/agents/index.js:264-271 serializes the completed SSE stream with HTTP 200.
  expectSuccess(stream, 200);
  // Callers assert fake-model.js:1573-1610 approval outcomes or 2414-2431 file_search completion.
  if (expectedText) {
    expect(stream.text).toContain(expectedText);
  }
  return stream;
}

async function createSearchSkill(
  request: APIRequestContext,
  token: string,
  suffix: string,
): Promise<SkillResponse> {
  const result = await requestResult(request, {
    path: '/api/skills',
    token,
    method: 'POST',
    data: {
      // packages/api/src/skills/handlers.ts validates kebab-case skill names.
      name: `e2e-project-search-skill-${suffix.toLowerCase()}`,
      description: 'Contributes project file search to an agent.',
      body: '# Search project files\n\nUse file_search for project corpus questions.',
      frontmatter: { 'allowed-tools': ['file_search'] },
      alwaysApply: true,
    },
  });
  // api/server/routes/skills.js:280-281 and handlers.ts:411-488 return the created skill.
  expectSuccess(result, 201);
  return { _id: requireString(asObject(result.body)._id, 'skill id') };
}

async function createSkillAgent(
  request: APIRequestContext,
  token: string,
  skill: SkillResponse,
  suffix: string,
): Promise<AgentFixture> {
  const result = await requestResult(request, {
    path: '/api/agents',
    token,
    method: 'POST',
    data: {
      name: `E2E Skill Project Search Agent ${suffix}`,
      description: 'Project search skill fixture.',
      instructions: 'Search the project corpus and report the result.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [],
      skills: [skill._id],
      skills_enabled: true,
      skills_scope: 'selected',
    },
  });
  // api/server/routes/agents/management.js:153 and createAgentManagementCreateHandler return 201.
  expectSuccess(result, 201);
  const body = asObject(result.body);
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  // initialize.ts:1211-1261 retains configured agent tools before skill augmentation.
  expect(tools).not.toContain('file_search');
  return { id: requireString(body.id, 'agent id'), tools };
}

async function cleanup(
  request: APIRequestContext,
  token: string,
  resources: {
    agentId?: string;
    projectId?: string;
    fileId?: string;
    skillId?: string;
    conversationId?: string;
  },
): Promise<void> {
  if (resources.conversationId) {
    await deleteMessagesByConversation([resources.conversationId]);
    await deleteConversations([resources.conversationId]);
  }
  if (resources.agentId) {
    await requestResult(request, {
      path: `/api/agents/${encodeURIComponent(resources.agentId)}`,
      token,
      method: 'DELETE',
    }).catch(() => undefined);
  }
  if (resources.skillId) {
    await requestResult(request, {
      path: `/api/skills/${encodeURIComponent(resources.skillId)}`,
      token,
      method: 'DELETE',
    }).catch(() => undefined);
  }
  if (resources.projectId) {
    await requestResult(request, {
      path: `/api/projects/${encodeURIComponent(resources.projectId)}`,
      token,
      method: 'DELETE',
    }).catch(() => undefined);
  }
  if (resources.fileId) {
    await requestResult(request, {
      path: '/api/files',
      token,
      method: 'DELETE',
      data: { files: [{ file_id: resources.fileId }] },
    }).catch(() => undefined);
    await deleteProjectFile(resources.fileId);
  }
}

test.describe.serial('project-scoped approval resume', () => {
  test('resuming a paused approval after a project file changed is refused as changed context @scenario:resume-rejected-after-project-file-changes', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const token = await loginAdmin(request);
    const suffix = randomUUID();
    const resources: {
      agentId?: string;
      projectId?: string;
      fileId?: string;
      conversationId?: string;
    } = {};

    try {
      const fixture = await seedProjectFile(request, token, suffix);
      resources.projectId = fixture.projectId;
      resources.fileId = fixture.fileId;
      const agent = await createApprovalAgent(request, token, suffix);
      resources.agentId = agent.id;
      const messageId = randomUUID();
      const started = await startAgentTurn(
        request,
        token,
        startBody({
          messageId,
          text: `${APPROVAL_MARKER}${suffix}`,
          agentId: agent.id,
          projectId: fixture.projectId,
          clientRequestId: suffix,
        }),
      );
      resources.conversationId = started.conversationId;
      const paused = await waitForPendingAction(request, token, started.conversationId);

      // packages/api/src/projects/context.ts:138-150 fingerprints availability/version;
      // packages/api/src/projects/resources.ts:43-58 and 118-141 make expiredAt unavailable.
      await updateProjectFile(fixture.fileId, { expiredAt: new Date(Date.now() - 1000) });
      const resumed = await resumeApproval(
        request,
        token,
        paused.status.pendingAction!,
        agent.id,
        fixture.projectId,
      );
      // api/server/controllers/agents/resume.js:292-300 sends this 409 body.
      expect(resumed.status).toBe(409);
      expect(resumed.body).toEqual(
        expect.objectContaining({
          code: 'PROJECT_CONTEXT_CHANGED',
          error: PROJECT_CONTEXT_CHANGED,
        }),
      );
    } finally {
      await cleanup(request, token, resources);
    }
  });

  test("resuming a paused approval still works after a file's signed URL rotates @scenario:resume-succeeds-after-signed-url-rotation", async ({
    request,
  }) => {
    test.setTimeout(120000);
    const token = await loginAdmin(request);
    const suffix = randomUUID();
    const resources: {
      agentId?: string;
      projectId?: string;
      fileId?: string;
      conversationId?: string;
    } = {};

    try {
      const fixture = await seedProjectFile(request, token, suffix);
      resources.projectId = fixture.projectId;
      resources.fileId = fixture.fileId;
      const agent = await createApprovalAgent(request, token, suffix);
      resources.agentId = agent.id;
      const messageId = randomUUID();
      const started = await startAgentTurn(
        request,
        token,
        startBody({
          messageId,
          text: `${APPROVAL_MARKER}${suffix}`,
          agentId: agent.id,
          projectId: fixture.projectId,
          clientRequestId: suffix,
        }),
      );
      resources.conversationId = started.conversationId;
      const paused = await waitForPendingAction(request, token, started.conversationId);

      // packages/api/src/projects/context.ts:138-150 keys resource identity/availability/version;
      // packages/api/src/projects/resources.ts:118-141 omits filepath from the canonical version.
      await updateProjectFile(fixture.fileId, {
        filepath: `https://signed.example/${fixture.fileId}?signature=${suffix}`,
      });
      const resumed = await resumeApproval(
        request,
        token,
        paused.status.pendingAction!,
        agent.id,
        fixture.projectId,
      );
      // api/server/controllers/agents/resume.js:1941-1943 sends the successful resume body.
      expect(resumed.status).toBe(200);
      expect(resumed.body).toEqual(
        expect.objectContaining({
          status: 'resuming',
          conversationId: started.conversationId,
          streamId: started.conversationId,
        }),
      );
      await completeStream(
        request,
        token,
        started.conversationId,
        started.streamId,
        'E2E approval outcomes:',
      );
    } finally {
      await cleanup(request, token, resources);
    }
  });

  test('a skill-contributed file_search tool searches the project corpus @scenario:skill-file-search-searches-project-files', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const token = await loginAdmin(request);
    const suffix = randomUUID();
    const resources: {
      agentId?: string;
      projectId?: string;
      fileId?: string;
      skillId?: string;
      conversationId?: string;
    } = {};

    try {
      const resetRag = await request.post(`${RAG_API_BASE}/__debug/reset`);
      // e2e/setup/fake-rag-server.js:123-128 resets the query recorder for this scenario.
      expect(resetRag.ok()).toBeTruthy();
      const fixture = await seedProjectFile(request, token, suffix);
      resources.projectId = fixture.projectId;
      resources.fileId = fixture.fileId;
      const skill = await createSearchSkill(request, token, suffix);
      resources.skillId = skill._id;
      const agent = await createSkillAgent(request, token, skill, suffix);
      resources.agentId = agent.id;
      const marker = `corpus-${suffix}`;
      const messageId = randomUUID();
      const started = await startAgentTurn(
        request,
        token,
        startBody({
          messageId,
          text: `E2E_FILE_SEARCH:${marker}`,
          agentId: agent.id,
          projectId: fixture.projectId,
          clientRequestId: suffix,
        }),
      );
      resources.conversationId = started.conversationId;
      const stream = await completeStream(
        request,
        token,
        started.conversationId,
        started.streamId,
        `E2E file_search complete: ${marker}`,
      );
      // fake-model.js:2414-2431 emits completion only after file_search is advertised;
      // initialize.ts:1214-1261 unions skill allowed-tools into the runtime tool set.
      expect(stream.text).not.toContain('E2E file_search unavailable');

      const ragResponse = await request.get(`${RAG_API_BASE}/__debug/embedded`);
      // e2e/setup/fake-rag-server.js:118-120 publishes recorded queries.
      expect(ragResponse.ok()).toBeTruthy();
      const ragBody = (await ragResponse.json()) as {
        queries?: Array<{ file_id?: string }>;
      };
      const queriedFileIds = (ragBody.queries ?? []).map((query) => query.file_id);
      expect(queriedFileIds).toContain(fixture.fileId);
    } finally {
      await cleanup(request, token, resources);
    }
  });
});
