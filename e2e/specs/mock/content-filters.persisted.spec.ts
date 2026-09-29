import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import type { Document, Filter } from 'mongodb';
import type { FiltersConfig } from 'librechat-data-provider';
import { withMongo } from './db';
import { MOCK_ENDPOINTS, replyPrompt, replyText, selectMockEndpoint, sendMessage } from './helpers';
import {
  expectContentFilterBlock,
  loginAdmin,
  requestResult,
  restoreRuntimeFilters,
  setRuntimeMessageFilterPii,
  setRuntimeFilters,
} from './content-filters.helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const OPAQUE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNwaDjwnxLMMGrA/9EwODAaBg3DIgwACY9/HwbtciYAAAAASUVORK5CYII=',
  'base64',
);

type JsonObject = Record<string, unknown>;
type RequestResult = Awaited<ReturnType<typeof requestResult>>;
type MongoSnapshotSelector = {
  key: string;
  collection: string;
  filter: Filter<Document>;
};
type MongoSnapshot = Record<string, Document[]>;
type CustomPattern = { id: string; label: string; regex: string };

type StoredFixtures = {
  conversationIds: string[];
  agentIds: string[];
  messageConversationId?: string;
  messageId?: string;
  messageShareId?: string;
  titleConversationId?: string;
  feedbackConversationId?: string;
  toolConversationId?: string;
  promptGroupId?: string;
  metadataPromptGroupId?: string;
  promptId?: string;
  presetId?: string;
  instructionAgentId?: string;
  starterAgentId?: string;
  modelParameterAgentId?: string;
  skillAgentId?: string;
  memoryAgentId?: string;
  fileAgentId?: string;
  opaqueFileAgentId?: string;
  actionAgentId?: string;
  skillId?: string;
  skillName?: string;
  skillVersion?: number;
  memoryKey?: string;
  file?: { file_id: string; filepath: string };
  opaqueFile?: { file_id: string; filepath: string };
  actionId?: string;
};

const asObject = (value: unknown): JsonObject =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const expectSuccess = (result: RequestResult, status?: number): void => {
  expect(result.ok, result.text).toBe(true);
  if (status != null) {
    expect(result.status, result.text).toBe(status);
  }
};

const expectStoredMarker = (result: RequestResult, marker: string): void => {
  expectSuccess(result);
  expect(result.text).toContain(marker);
};

const requireString = (value: unknown, label: string): string => {
  expect(typeof value, `Expected ${label} to be a string`).toBe('string');
  expect(value, `Expected ${label} not to be empty`).not.toBe('');
  return value as string;
};

const requireNumber = (value: unknown, label: string): number => {
  expect(typeof value, `Expected ${label} to be a number`).toBe('number');
  return value as number;
};

const requireObjectId = (value: string, label: string): ObjectId => {
  expect(ObjectId.isValid(value), `Expected ${label} to be a MongoDB ObjectId`).toBe(true);
  return new ObjectId(value);
};

async function captureMongoSnapshot(selectors: MongoSnapshotSelector[]): Promise<MongoSnapshot> {
  return withMongo(async (db) => {
    const entries = await Promise.all(
      selectors.map(async ({ key, collection, filter }) => [
        key,
        await db.collection(collection).find(filter).sort({ _id: 1 }).toArray(),
      ]),
    );
    return Object.fromEntries(entries) as MongoSnapshot;
  });
}

async function expectNoMongoSideEffects<T>(
  collections: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const selectors = collections.map((collection) => ({
    key: collection,
    collection,
    filter: {},
  }));
  const before = await captureMongoSnapshot(selectors);
  const result = await operation();
  expect(await captureMongoSnapshot(selectors)).toEqual(before);
  return result;
}

function getFixtureSnapshotSelectors(fixtures: StoredFixtures): MongoSnapshotSelector[] {
  const conversationIds = [...fixtures.conversationIds];
  const agentIds = [...fixtures.agentIds];
  const promptGroupIds = [fixtures.promptGroupId, fixtures.metadataPromptGroupId].map((id, index) =>
    requireObjectId(requireString(id, `snapshot prompt group ${index + 1}`), 'id'),
  );

  return [
    {
      key: 'conversations',
      collection: 'conversations',
      filter: { conversationId: { $in: conversationIds } },
    },
    {
      key: 'messages',
      collection: 'messages',
      filter: { conversationId: { $in: conversationIds } },
    },
    {
      key: 'sharedlinks',
      collection: 'sharedlinks',
      filter: { shareId: requireString(fixtures.messageShareId, 'snapshot share id') },
    },
    {
      key: 'prompts',
      collection: 'prompts',
      filter: { groupId: { $in: promptGroupIds } },
    },
    {
      key: 'promptgroups',
      collection: 'promptgroups',
      filter: { _id: { $in: promptGroupIds } },
    },
    {
      key: 'presets',
      collection: 'presets',
      filter: { presetId: requireString(fixtures.presetId, 'snapshot preset id') },
    },
    { key: 'agents', collection: 'agents', filter: { id: { $in: agentIds } } },
    {
      key: 'skills',
      collection: 'skills',
      filter: {
        _id: requireObjectId(requireString(fixtures.skillId, 'snapshot skill id'), 'skill id'),
      },
    },
    {
      key: 'memoryentries',
      collection: 'memoryentries',
      filter: {
        key: requireString(fixtures.memoryKey, 'snapshot memory key'),
        agentId: requireString(fixtures.memoryAgentId, 'snapshot memory agent id'),
      },
    },
    {
      key: 'files',
      collection: 'files',
      filter: {
        file_id: {
          $in: [
            requireString(fixtures.file?.file_id, 'snapshot text file id'),
            requireString(fixtures.opaqueFile?.file_id, 'snapshot opaque file id'),
          ],
        },
      },
    },
    {
      key: 'actions',
      collection: 'actions',
      filter: { action_id: requireString(fixtures.actionId, 'snapshot action id') },
    },
  ];
}

const createAgentPayload = (suffix: string, overrides: JsonObject = {}): JsonObject => ({
  name: `E2E persisted-filter agent ${suffix}`,
  description: 'Safe agent used for post-policy persisted-content coverage.',
  instructions: 'Use only safe deterministic instructions.',
  provider: MOCK_ENDPOINTS[0].label,
  model: MOCK_ENDPOINTS[0].model,
  model_parameters: {},
  tools: [],
  conversation_starters: ['Ask a safe question'],
  ...overrides,
});

async function createStoredMessage(
  request: Parameters<typeof requestResult>[0],
  token: string,
  conversationId: string,
  body: JsonObject,
): Promise<JsonObject> {
  const result = await requestResult(request, {
    path: `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
    method: 'POST',
    data: {
      messageId: randomUUID(),
      parentMessageId: NO_PARENT,
      sender: 'User',
      endpoint: MOCK_ENDPOINTS[0].label,
      endpointType: 'custom',
      model: MOCK_ENDPOINTS[0].model,
      isCreatedByUser: true,
      ...body,
    },
  });
  expectSuccess(result, 201);
  return asObject(result.body);
}

async function createAgent(
  request: Parameters<typeof requestResult>[0],
  token: string,
  fixtures: StoredFixtures,
  suffix: string,
  overrides: JsonObject = {},
): Promise<JsonObject> {
  const result = await requestResult(request, {
    path: '/api/agents',
    token,
    method: 'POST',
    data: createAgentPayload(suffix, overrides),
  });
  expectSuccess(result, 201);
  const agent = asObject(result.body);
  fixtures.agentIds.push(requireString(agent.id, `${suffix} agent id`));
  return agent;
}

async function duplicateConversation(
  request: Parameters<typeof requestResult>[0],
  token: string,
  conversationId: string,
): Promise<RequestResult> {
  return requestResult(request, {
    path: '/api/convos/duplicate',
    token,
    method: 'POST',
    data: { conversationId, title: 'Safe copied conversation' },
  });
}

async function duplicateAgent(
  request: Parameters<typeof requestResult>[0],
  token: string,
  agentId: string,
): Promise<RequestResult> {
  return requestResult(request, {
    path: `/api/agents/${encodeURIComponent(agentId)}/duplicate`,
    token,
    method: 'POST',
  });
}

async function expectAsyncFilterStreamError(
  request: Parameters<typeof requestResult>[0],
  token: string,
  started: RequestResult,
  expectedLabel: string,
  marker: string,
): Promise<string> {
  expectSuccess(started, 200);
  const startBody = asObject(started.body);
  expect(startBody.status).toBe('started');
  const conversationId = requireString(startBody.conversationId, 'blocked stream conversation id');
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
        const statusBody = asObject(status.body);
        return { active: statusBody.active, status: statusBody.status };
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toEqual({ active: false, status: 'error' });
  expect(terminalStatus?.text).not.toContain(marker);

  const errorStream = await requestResult(request, {
    path: `/api/agents/chat/stream/${encodeURIComponent(streamId)}?resume=true`,
    token,
  });
  expectSuccess(errorStream, 200);
  expect(errorStream.text).toContain('event: error');
  expect(errorStream.text).toContain(expectedLabel);
  expect(errorStream.text).not.toContain(marker);
  return conversationId;
}

async function expectAsyncStreamCompleted(
  request: Parameters<typeof requestResult>[0],
  token: string,
  started: RequestResult,
): Promise<string> {
  expectSuccess(started, 200);
  const startBody = asObject(started.body);
  expect(startBody.status).toBe('started');
  const conversationId = requireString(
    startBody.conversationId,
    'completed stream conversation id',
  );
  const streamId = requireString(startBody.streamId, 'completed stream id');

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
        const statusBody = asObject(status.body);
        return { active: statusBody.active, status: statusBody.status };
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toEqual({ active: false, status: 'complete' });

  const stream = await requestResult(request, {
    path: `/api/agents/chat/stream/${encodeURIComponent(streamId)}?resume=true`,
    token,
  });
  expectSuccess(stream, 200);
  expect(stream.text).not.toContain('event: error');
  return conversationId;
}

async function cleanupFixtures(
  request: Parameters<typeof requestResult>[0],
  token: string,
  fixtures: StoredFixtures,
): Promise<void> {
  if (fixtures.actionId && fixtures.actionAgentId) {
    await requestResult(request, {
      path: `/api/agents/actions/${encodeURIComponent(fixtures.actionAgentId)}/${encodeURIComponent(
        fixtures.actionId,
      )}`,
      token,
      method: 'DELETE',
    });
  }
  if (fixtures.messageShareId) {
    await requestResult(request, {
      path: `/api/share/${encodeURIComponent(fixtures.messageShareId)}`,
      token,
      method: 'DELETE',
    });
  }
  await Promise.all(
    fixtures.agentIds.map((agentId) =>
      requestResult(request, {
        path: `/api/agents/${encodeURIComponent(agentId)}`,
        token,
        method: 'DELETE',
      }),
    ),
  );
  const files = [fixtures.file, fixtures.opaqueFile].filter(
    (file): file is NonNullable<StoredFixtures['file']> => file != null,
  );
  if (files.length > 0) {
    await requestResult(request, {
      path: '/api/files',
      token,
      method: 'DELETE',
      data: { files },
    });
  }
  if (fixtures.skillId) {
    await requestResult(request, {
      path: `/api/skills/${encodeURIComponent(fixtures.skillId)}`,
      token,
      method: 'DELETE',
    });
  }
  if (fixtures.memoryKey && fixtures.memoryAgentId) {
    await requestResult(request, {
      path: `/api/memories/${encodeURIComponent(fixtures.memoryKey)}?agentId=${encodeURIComponent(
        fixtures.memoryAgentId!,
      )}`,
      token,
      method: 'DELETE',
    });
  }
  await Promise.all(
    [fixtures.promptGroupId, fixtures.metadataPromptGroupId]
      .filter((groupId): groupId is string => groupId != null)
      .map((groupId) =>
        requestResult(request, {
          path: `/api/prompts/groups/${encodeURIComponent(groupId)}`,
          token,
          method: 'DELETE',
        }),
      ),
  );
  if (fixtures.presetId) {
    await requestResult(request, {
      path: '/api/presets/delete',
      token,
      method: 'POST',
      data: { presetId: fixtures.presetId },
    });
  }
  await Promise.all(
    fixtures.conversationIds.map((conversationId) =>
      requestResult(request, {
        path: '/api/convos',
        token,
        method: 'DELETE',
        data: { arg: { conversationId } },
      }),
    ),
  );
}

test.describe('persisted source-aware content filters', () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test('rechecks records created before all twelve filters are activated', async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const markers = {
      messages: `E2E-PERSISTED-MESSAGE-${suffix}`,
      prompts: `E2E-PERSISTED-PROMPT-${suffix}`,
      promptGroupName: `E2E-PERSISTED-PROMPT-GROUP-${suffix}`,
      agentInstructions: `E2E-PERSISTED-AGENT-INSTRUCTION-${suffix}`,
      conversationStarters: `E2E-PERSISTED-CONVERSATION-STARTER-${suffix}`,
      conversationTitles: `E2E-PERSISTED-CONVERSATION-TITLE-${suffix}`,
      feedback: `E2E-PERSISTED-FEEDBACK-${suffix}`,
      skills: `E2E-PERSISTED-SKILL-${suffix}`,
      memories: `E2E-PERSISTED-MEMORY-${suffix}`,
      files: `E2E-PERSISTED-FILE-${suffix}`,
      toolArguments: `E2E-PERSISTED-TOOL-ARGUMENT-${suffix}`,
      modelParameters: `E2E-PERSISTED-MODEL-PARAMETER-${suffix}`,
      actionMetadata: `E2E-PERSISTED-ACTION-METADATA-${suffix}`,
    } as const;
    const memoryKeySuffix = Array.from(randomUUID().replace(/-/g, ''), (character) =>
      String.fromCharCode(97 + Number.parseInt(character, 16)),
    ).join('');
    const pii = (id: string, field: string, marker: string) => ({
      fields: [field],
      starterPatterns: [],
      customPatterns: [
        {
          id: `e2e-persisted-${id}-${suffix}`,
          label: `E2E persisted ${id.replace(/-/g, ' ')} value`,
          regex: `^${marker}$`,
        },
      ],
    });
    const filters = {
      messages: { pii: pii('messages', 'text', markers.messages) },
      prompts: {
        pii: {
          fields: ['name', 'text', 'preset_text'],
          starterPatterns: [],
          customPatterns: [
            {
              id: `e2e-persisted-prompts-${suffix}`,
              label: 'E2E persisted protected prompt',
              regex: `^${markers.prompts}$`,
            },
            {
              id: `e2e-persisted-prompt-group-${suffix}`,
              label: 'E2E persisted protected prompt group',
              regex: `^${markers.promptGroupName}$`,
            },
          ],
        },
      },
      agentInstructions: {
        pii: pii('agent-instructions', 'instructions', markers.agentInstructions),
      },
      conversationStarters: {
        pii: pii('conversation-starters', 'text', markers.conversationStarters),
      },
      conversationTitles: {
        pii: pii('conversation-titles', 'title', markers.conversationTitles),
      },
      feedback: { pii: pii('feedback', 'text', markers.feedback) },
      skills: { pii: pii('skills', 'instructions', markers.skills) },
      memories: { pii: pii('memories', 'value', markers.memories) },
      files: {
        pii: {
          ...pii('files', 'extracted_text', markers.files),
          uninspectable: 'block',
        },
      },
      toolArguments: { pii: pii('tool-arguments', 'arguments', markers.toolArguments) },
      modelParameters: { pii: pii('model-parameters', 'stop', markers.modelParameters) },
      actionMetadata: {
        pii: pii('action-metadata', 'privacy_policy_url', markers.actionMetadata),
      },
    } as FiltersConfig;
    const fixtures: StoredFixtures = { conversationIds: [], agentIds: [] };
    const token = await loginAdmin(request);
    let filtersAttempted = false;
    let filtersActive = false;

    try {
      await restoreRuntimeFilters(request, token);

      await test.step('create every fixture before policy activation', async () => {
        const seedLabel = `persisted-filter-seed-${suffix}`;
        await page.goto('/c/new', { timeout: 10000 });
        await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
        const seedResponse = await sendMessage(page, replyPrompt(seedLabel));
        expect(seedResponse.ok()).toBe(true);
        await expect(
          page.getByTestId('messages-view').getByText(replyText(seedLabel), { exact: true }),
        ).toBeVisible({ timeout: 30000 });
        await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
        const seedMatch = new URL(page.url()).pathname.match(/^\/c\/([0-9a-fA-F-]{36})$/);
        fixtures.messageConversationId = requireString(
          seedMatch?.[1],
          'persisted message conversation id',
        );
        fixtures.conversationIds.push(fixtures.messageConversationId);

        const cloneSafeConversation = async (label: string): Promise<string> => {
          const cloned = await duplicateConversation(
            request,
            token,
            fixtures.messageConversationId!,
          );
          expectSuccess(cloned, 201);
          const conversationId = requireString(
            asObject(asObject(cloned.body).conversation).conversationId,
            label,
          );
          fixtures.conversationIds.push(conversationId);
          return conversationId;
        };
        fixtures.titleConversationId = await cloneSafeConversation(
          'persisted title conversation id',
        );
        fixtures.feedbackConversationId = await cloneSafeConversation(
          'persisted feedback conversation id',
        );
        fixtures.toolConversationId = await cloneSafeConversation('persisted tool conversation id');

        const storedMessage = await createStoredMessage(
          request,
          token,
          fixtures.messageConversationId,
          {
            text: markers.messages,
          },
        );
        fixtures.messageId = requireString(storedMessage.messageId, 'persisted marker message id');
        const share = await requestResult(request, {
          path: `/api/share/${encodeURIComponent(fixtures.messageConversationId)}`,
          token,
          method: 'POST',
          data: {},
        });
        expectSuccess(share, 200);
        fixtures.messageShareId = requireString(
          asObject(share.body).shareId,
          'persisted message share id',
        );

        const title = await requestResult(request, {
          path: '/api/convos/update',
          token,
          method: 'POST',
          data: {
            arg: {
              conversationId: fixtures.titleConversationId,
              title: markers.conversationTitles,
            },
          },
        });
        expectSuccess(title, 201);

        const feedbackMessage = await createStoredMessage(
          request,
          token,
          fixtures.feedbackConversationId,
          { text: 'Safe feedback target message.' },
        );
        const feedbackMessageId = requireString(feedbackMessage.messageId, 'feedback message id');
        const feedback = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(
            fixtures.feedbackConversationId,
          )}/${encodeURIComponent(feedbackMessageId)}/feedback`,
          token,
          method: 'PUT',
          data: {
            feedback: { rating: 'thumbsDown', tag: 'other', text: markers.feedback },
          },
        });
        expectSuccess(feedback, 200);

        await createStoredMessage(request, token, fixtures.toolConversationId, {
          content: [
            {
              type: 'tool_call',
              tool_call: {
                id: `call_${suffix}`,
                name: 'safe_lookup',
                args: markers.toolArguments,
              },
            },
          ],
        });

        const prompt = await requestResult(request, {
          path: '/api/prompts',
          token,
          method: 'POST',
          data: {
            prompt: { prompt: markers.prompts, type: 'text' },
            group: { name: `E2E persisted prompt ${suffix}` },
          },
        });
        expectSuccess(prompt, 200);
        const promptBody = asObject(prompt.body);
        const promptRecord = asObject(promptBody.prompt);
        const promptGroup = asObject(promptBody.group);
        fixtures.promptId = requireString(promptRecord._id, 'persisted prompt id');
        fixtures.promptGroupId = requireString(
          promptGroup._id ?? promptRecord.groupId,
          'persisted prompt group id',
        );

        const metadataPrompt = await requestResult(request, {
          path: '/api/prompts',
          token,
          method: 'POST',
          data: {
            prompt: { prompt: 'Safe prompt for protected group metadata.', type: 'text' },
            group: { name: markers.promptGroupName },
          },
        });
        expectSuccess(metadataPrompt, 200);
        const metadataPromptBody = asObject(metadataPrompt.body);
        const metadataPromptRecord = asObject(metadataPromptBody.prompt);
        fixtures.metadataPromptGroupId = requireString(
          asObject(metadataPromptBody.group)._id ?? metadataPromptRecord.groupId,
          'persisted protected-metadata prompt group id',
        );

        const preset = await requestResult(request, {
          path: '/api/presets',
          token,
          method: 'POST',
          data: {
            title: `E2E persisted preset ${suffix}`,
            promptPrefix: markers.prompts,
            endpoint: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
          },
        });
        expectSuccess(preset, 201);
        fixtures.presetId = requireString(asObject(preset.body).presetId, 'persisted preset id');

        fixtures.skillName = `e2e-persisted-skill-${suffix}`;
        const skill = await requestResult(request, {
          path: '/api/skills',
          token,
          method: 'POST',
          data: {
            name: fixtures.skillName,
            description: 'Skill created before runtime policy activation.',
            body: markers.skills,
          },
        });
        expectSuccess(skill, 201);
        fixtures.skillId = requireString(asObject(skill.body)._id, 'persisted skill id');
        fixtures.skillVersion = requireNumber(
          asObject(skill.body).version,
          'persisted skill version',
        );

        fixtures.memoryKey = `e_to_e_persisted_memory_${memoryKeySuffix}`;
        const memoryAgent = await createAgent(request, token, fixtures, `${suffix}-memory`, {
          memory_scope: 'agent',
        });
        fixtures.memoryAgentId = requireString(memoryAgent.id, 'memory agent id');
        const memory = await requestResult(request, {
          path: '/api/memories',
          token,
          method: 'POST',
          data: {
            key: fixtures.memoryKey,
            value: markers.memories,
            agentId: fixtures.memoryAgentId,
          },
        });
        expectSuccess(memory, 201);

        const fileAgent = await createAgent(request, token, fixtures, `${suffix}-file`);
        fixtures.fileAgentId = requireString(fileAgent.id, 'file agent id');

        const file = await requestResult(request, {
          path: '/api/files',
          token,
          method: 'POST',
          multipart: {
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            agent_id: fixtures.fileAgentId,
            tool_resource: 'context',
            file_id: randomUUID(),
            file: {
              name: `e2e-persisted-${suffix}.txt`,
              mimeType: 'text/plain',
              buffer: Buffer.from(markers.files),
            },
          },
        });
        expectSuccess(file, 200);
        const fileBody = asObject(file.body);
        fixtures.file = {
          file_id: requireString(fileBody.file_id, 'persisted file id'),
          filepath: requireString(fileBody.filepath, 'persisted file path'),
        };

        const opaqueFile = await requestResult(request, {
          path: '/api/files',
          token,
          method: 'POST',
          multipart: {
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            message_file: 'true',
            file_id: randomUUID(),
            file: {
              name: `e2e-persisted-opaque-${suffix}.png`,
              mimeType: 'image/png',
              buffer: OPAQUE_PNG,
            },
          },
        });
        expectSuccess(opaqueFile, 200);
        const opaqueFileBody = asObject(opaqueFile.body);
        fixtures.opaqueFile = {
          file_id: requireString(opaqueFileBody.file_id, 'persisted opaque file id'),
          filepath: requireString(opaqueFileBody.filepath, 'persisted opaque file path'),
        };

        const instructionAgent = await createAgent(
          request,
          token,
          fixtures,
          `${suffix}-instruction`,
          { instructions: markers.agentInstructions },
        );
        fixtures.instructionAgentId = requireString(instructionAgent.id, 'instruction agent id');

        const starterAgent = await createAgent(request, token, fixtures, `${suffix}-starter`, {
          conversation_starters: [markers.conversationStarters],
        });
        fixtures.starterAgentId = requireString(starterAgent.id, 'starter agent id');

        const modelParameterAgent = await createAgent(
          request,
          token,
          fixtures,
          `${suffix}-model-parameter`,
          { model_parameters: { stop: [markers.modelParameters] } },
        );
        fixtures.modelParameterAgentId = requireString(
          modelParameterAgent.id,
          'model-parameter agent id',
        );

        const skillAgent = await createAgent(request, token, fixtures, `${suffix}-skill`, {
          skills_enabled: true,
          skills: [fixtures.skillId],
        });
        fixtures.skillAgentId = requireString(skillAgent.id, 'skill agent id');

        const opaqueFileAgent = await createAgent(
          request,
          token,
          fixtures,
          `${suffix}-opaque-file`,
          { tool_resources: { context: { file_ids: [fixtures.opaqueFile.file_id] } } },
        );
        fixtures.opaqueFileAgentId = requireString(opaqueFileAgent.id, 'opaque file agent id');

        const actionAgent = await createAgent(request, token, fixtures, `${suffix}-action`);
        fixtures.actionAgentId = requireString(actionAgent.id, 'action agent id');
        const action = await requestResult(request, {
          path: `/api/agents/actions/${encodeURIComponent(fixtures.actionAgentId)}`,
          token,
          method: 'POST',
          data: {
            functions: [
              {
                type: 'function',
                function: {
                  name: `persisted_lookup_${suffix.replace(/-/g, '_')}`,
                  description: 'Return a safe deterministic lookup result.',
                  parameters: { type: 'object', properties: {} },
                },
              },
            ],
            metadata: {
              domain: 'https://example.com',
              privacy_policy_url: markers.actionMetadata,
            },
          },
        });
        expectSuccess(action, 200);
        const actionItems = Array.isArray(action.body) ? action.body : [];
        fixtures.actionId = requireString(
          asObject(actionItems[1]).action_id,
          'persisted action id',
        );
      });

      const fixtureSnapshotSelectors = getFixtureSnapshotSelectors(fixtures);
      const preActivationSnapshot = await captureMongoSnapshot(fixtureSnapshotSelectors);
      filtersAttempted = true;
      filtersActive = true;
      await setRuntimeFilters(request, token, filters);
      expect(await captureMongoSnapshot(fixtureSnapshotSelectors)).toEqual(preActivationSnapshot);

      await test.step('messages remain manageable but old shares are blocked on read', async () => {
        const visible = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(fixtures.messageConversationId!)}`,
          token,
        });
        expectStoredMarker(visible, markers.messages);

        const expectMessageBlock = (result: RequestResult): void => {
          expectContentFilterBlock(result, {
            source: 'message',
            field: 'text',
            marker: markers.messages,
          });
        };

        const blockedShareRead = await expectNoMongoSideEffects(
          ['conversations', 'messages', 'sharedlinks'],
          () =>
            requestResult(request, {
              path: `/api/share/${encodeURIComponent(fixtures.messageShareId!)}`,
            }),
        );
        expectMessageBlock(blockedShareRead);

        const blockedDuplicate = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
          duplicateConversation(request, token, fixtures.messageConversationId!),
        );
        expectMessageBlock(blockedDuplicate);

        const blockedFork = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
          requestResult(request, {
            path: '/api/convos/fork',
            token,
            method: 'POST',
            data: {
              conversationId: fixtures.messageConversationId,
              messageId: fixtures.messageId,
              option: 'directPath',
            },
          }),
        );
        expectMessageBlock(blockedFork);

        const blockedSharedFork = await expectNoMongoSideEffects(
          ['conversations', 'messages', 'sharedlinks'],
          () =>
            requestResult(request, {
              path: `/api/share/${encodeURIComponent(fixtures.messageShareId!)}/fork`,
              token,
              method: 'POST',
              data: {},
            }),
        );
        expectMessageBlock(blockedSharedFork);
      });

      await test.step('prompts are redacted or omitted and cannot be promoted', async () => {
        const versions = await requestResult(request, {
          path: `/api/prompts?groupId=${encodeURIComponent(fixtures.promptGroupId!)}`,
          token,
        });
        expectSuccess(versions, 200);
        const versionItems = Array.isArray(versions.body) ? versions.body : [];
        const blockedVersion = versionItems
          .map(asObject)
          .find((prompt) => prompt._id === fixtures.promptId);
        expect(blockedVersion).toEqual(
          expect.objectContaining({
            _id: fixtures.promptId,
            groupId: fixtures.promptGroupId,
            prompt: '',
            contentFilterBlocked: true,
          }),
        );
        expect(blockedVersion).not.toHaveProperty('name');
        expect(versions.text).not.toContain(markers.prompts);

        const directGroup = await requestResult(request, {
          path: `/api/prompts/groups/${encodeURIComponent(fixtures.promptGroupId!)}`,
          token,
        });
        expectSuccess(directGroup, 200);
        const directGroupBody = asObject(directGroup.body);
        const directProductionPrompt = asObject(directGroupBody.productionPrompt);
        expect(directGroupBody._id).toBe(fixtures.promptGroupId);
        expect(directProductionPrompt).toEqual(
          expect.objectContaining({
            _id: fixtures.promptId,
            groupId: fixtures.promptGroupId,
            prompt: '',
            contentFilterBlocked: true,
          }),
        );
        expect(directGroup.text).not.toContain(markers.prompts);

        const blockedMetadataGroup = await requestResult(request, {
          path: `/api/prompts/groups/${encodeURIComponent(fixtures.metadataPromptGroupId!)}`,
          token,
        });
        expectContentFilterBlock(blockedMetadataGroup, {
          source: 'prompt',
          field: 'name',
          marker: markers.promptGroupName,
        });

        const paginatedGroups = await requestResult(request, {
          path: `/api/prompts/groups?name=${encodeURIComponent(
            `E2E persisted prompt ${suffix}`,
          )}&limit=10`,
          token,
        });
        expectSuccess(paginatedGroups, 200);
        const paginatedGroup = (
          Array.isArray(asObject(paginatedGroups.body).promptGroups)
            ? (asObject(paginatedGroups.body).promptGroups as unknown[])
            : []
        )
          .map(asObject)
          .find((group) => group._id === fixtures.promptGroupId);
        expect(paginatedGroup?._id).toBe(fixtures.promptGroupId);
        expect(asObject(paginatedGroup?.productionPrompt)).toEqual(
          expect.objectContaining({
            _id: fixtures.promptId,
            prompt: '',
            contentFilterBlocked: true,
          }),
        );
        expect(paginatedGroups.text).not.toContain(markers.prompts);

        const metadataPaginatedGroups = await requestResult(request, {
          path: `/api/prompts/groups?name=${encodeURIComponent(markers.promptGroupName)}&limit=10`,
          token,
        });
        expectSuccess(metadataPaginatedGroups, 200);
        const metadataGroupItems = Array.isArray(
          asObject(metadataPaginatedGroups.body).promptGroups,
        )
          ? (asObject(metadataPaginatedGroups.body).promptGroups as unknown[]).map(asObject)
          : [];
        expect(
          metadataGroupItems.some((group) => group._id === fixtures.metadataPromptGroupId),
        ).toBe(false);
        expect(metadataPaginatedGroups.text).not.toContain(markers.promptGroupName);

        const reusable = await requestResult(request, { path: '/api/prompts/all', token });
        expectSuccess(reusable, 200);
        const reusableGroups = Array.isArray(reusable.body) ? reusable.body.map(asObject) : [];
        expect(reusableGroups.some((group) => group._id === fixtures.promptGroupId)).toBe(false);
        expect(reusableGroups.some((group) => group._id === fixtures.metadataPromptGroupId)).toBe(
          false,
        );
        expect(reusable.text).not.toContain(markers.prompts);
        expect(reusable.text).not.toContain(markers.promptGroupName);

        const blocked = await expectNoMongoSideEffects(['prompts', 'promptgroups'], () =>
          requestResult(request, {
            path: `/api/prompts/${encodeURIComponent(fixtures.promptId!)}/tags/production`,
            token,
            method: 'PATCH',
          }),
        );
        expectContentFilterBlock(blocked, {
          source: 'prompt',
          field: 'text',
          marker: markers.prompts,
        });

        const presets = await requestResult(request, { path: '/api/presets', token });
        expectSuccess(presets, 200);
        const presetItems = Array.isArray(presets.body) ? presets.body : [];
        const blockedPreset = presetItems
          .map(asObject)
          .find((preset) => preset.presetId === fixtures.presetId);
        expect(blockedPreset).toEqual(
          expect.objectContaining({
            presetId: fixtures.presetId,
            title: '',
            endpoint: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
            contentFilterBlocked: true,
          }),
        );
        expect(blockedPreset).not.toHaveProperty('promptPrefix');
        expect(presets.text).not.toContain(markers.prompts);
      });

      await test.step('agent instructions stay visible, safe partial edits work, and reuse fails', async () => {
        const visible = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(fixtures.instructionAgentId!)}/expanded`,
          token,
        });
        expectStoredMarker(visible, markers.agentInstructions);
        const safeEdit = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(fixtures.instructionAgentId!)}`,
          token,
          method: 'PATCH',
          data: { description: 'Safe remediation metadata edit.' },
        });
        expectSuccess(safeEdit, 200);
        const blocked = await expectNoMongoSideEffects(['agents', 'actions'], () =>
          duplicateAgent(request, token, fixtures.instructionAgentId!),
        );
        expectContentFilterBlock(blocked, {
          source: 'agent_instruction',
          field: 'instructions',
          marker: markers.agentInstructions,
        });
      });

      await test.step('conversation starters stay visible but prevent agent reuse', async () => {
        const visible = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(fixtures.starterAgentId!)}/expanded`,
          token,
        });
        expectStoredMarker(visible, markers.conversationStarters);
        const blocked = await expectNoMongoSideEffects(['agents', 'actions'], () =>
          duplicateAgent(request, token, fixtures.starterAgentId!),
        );
        expectContentFilterBlock(blocked, {
          source: 'conversation_starter',
          field: 'text',
          marker: markers.conversationStarters,
        });
      });

      await test.step('conversation titles stay visible, allow a safe override, and block stored-title reuse', async () => {
        const visible = await requestResult(request, {
          path: `/api/convos/${encodeURIComponent(fixtures.titleConversationId!)}`,
          token,
        });
        expectStoredMarker(visible, markers.conversationTitles);

        const safeOverride = await duplicateConversation(
          request,
          token,
          fixtures.titleConversationId!,
        );
        expectSuccess(safeOverride, 201);
        fixtures.conversationIds.push(
          requireString(
            asObject(asObject(safeOverride.body).conversation).conversationId,
            'safe-title override copied conversation id',
          ),
        );

        const blocked = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
          requestResult(request, {
            path: '/api/convos/duplicate',
            token,
            method: 'POST',
            data: { conversationId: fixtures.titleConversationId },
          }),
        );
        expectContentFilterBlock(blocked, {
          source: 'conversation_title',
          field: 'title',
          marker: markers.conversationTitles,
        });
      });

      await test.step('feedback stays visible but prevents conversation reuse', async () => {
        const visible = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(fixtures.feedbackConversationId!)}`,
          token,
        });
        expectStoredMarker(visible, markers.feedback);
        const blocked = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
          duplicateConversation(request, token, fixtures.feedbackConversationId!),
        );
        expectContentFilterBlock(blocked, {
          source: 'feedback',
          field: 'text',
          marker: markers.feedback,
        });
      });

      await test.step('skills stay visible, allow safe partial edits, and reject protected edits', async () => {
        const visible = await requestResult(request, {
          path: `/api/skills/${encodeURIComponent(fixtures.skillId!)}`,
          token,
        });
        expectStoredMarker(visible, markers.skills);
        const safeEdit = await requestResult(request, {
          path: `/api/skills/${encodeURIComponent(fixtures.skillId!)}`,
          token,
          method: 'PATCH',
          data: {
            expectedVersion: fixtures.skillVersion,
            description: 'Safe skill metadata remediation edit.',
          },
        });
        expectSuccess(safeEdit, 200);
        fixtures.skillVersion = requireNumber(
          asObject(safeEdit.body).version,
          'updated persisted skill version',
        );
        const stillVisible = await requestResult(request, {
          path: `/api/skills/${encodeURIComponent(fixtures.skillId!)}`,
          token,
        });
        expectStoredMarker(stillVisible, markers.skills);
        const blocked = await expectNoMongoSideEffects(['skills'], () =>
          requestResult(request, {
            path: `/api/skills/${encodeURIComponent(fixtures.skillId!)}`,
            token,
            method: 'PATCH',
            data: { expectedVersion: fixtures.skillVersion, body: markers.skills },
          }),
        );
        expectContentFilterBlock(blocked, {
          source: 'skill',
          field: 'instructions',
          marker: markers.skills,
        });
        const copiedAgent = await duplicateAgent(request, token, fixtures.skillAgentId!);
        expectSuccess(copiedAgent, 201);
        fixtures.agentIds.push(
          requireString(asObject(asObject(copiedAgent.body).agent).id, 'copied skill agent id'),
        );

        const skillMessageId = randomUUID();
        const startedSkill = await requestResult(request, {
          path: '/api/agents/chat/agents',
          token,
          method: 'POST',
          data: {
            text: `Safe persisted-skill runtime request ${suffix}`,
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId: NO_PARENT,
            conversationId: 'new',
            messageId: skillMessageId,
            responseMessageId: `${skillMessageId}_response`,
            endpoint: 'agents',
            endpointType: 'agents',
            agent_id: fixtures.skillAgentId,
            manualSkills: [fixtures.skillName],
            isTemporary: false,
            isRegenerate: false,
            error: false,
          },
        });
        fixtures.conversationIds.push(
          await expectAsyncFilterStreamError(
            request,
            token,
            startedSkill,
            'E2E persisted skills value',
            markers.skills,
          ),
        );
        await withMongo(async (db) => {
          expect(
            await db.collection('messages').countDocuments({
              messageId: { $in: [skillMessageId, `${skillMessageId}_response`] },
            }),
          ).toBe(0);
        });
      });

      await test.step('message continuation rechecks stored history before model use', async () => {
        const continueMessageId = randomUUID();
        const continueResponseMessageId = `${continueMessageId}_response`;
        const startedContinue = await requestResult(request, {
          path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
          token,
          method: 'POST',
          data: {
            text: `Safe persisted-message continuation ${suffix}`,
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId: fixtures.messageId,
            conversationId: fixtures.messageConversationId,
            messageId: continueMessageId,
            responseMessageId: continueResponseMessageId,
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            model: MOCK_ENDPOINTS[0].model,
            isTemporary: false,
            isRegenerate: false,
            error: false,
          },
        });
        const continuedConversationId = await expectAsyncFilterStreamError(
          request,
          token,
          startedContinue,
          'E2E persisted messages value',
          markers.messages,
        );
        expect(continuedConversationId).toBe(fixtures.messageConversationId);

        await withMongo(async (db) => {
          const attemptedRows = await db
            .collection('messages')
            .find({
              conversationId: fixtures.messageConversationId,
              messageId: { $in: [continueMessageId, continueResponseMessageId] },
            })
            .toArray();
          expect(attemptedRows).toHaveLength(0);

          const original = await db.collection('messages').findOne({
            conversationId: fixtures.messageConversationId,
            messageId: fixtures.messageId,
          });
          expect(original).toEqual(
            expect.objectContaining({
              messageId: fixtures.messageId,
              text: markers.messages,
              isCreatedByUser: true,
            }),
          );
        });
      });

      await test.step('files stay previewable but prevent reuse by an agent', async () => {
        const visible = await requestResult(request, {
          path: `/api/files/${encodeURIComponent(fixtures.file!.file_id)}/preview`,
          token,
        });
        expectSuccess(visible, 200);
        expect(asObject(visible.body)).toEqual(
          expect.objectContaining({
            file_id: fixtures.file!.file_id,
            status: 'ready',
            text: markers.files,
          }),
        );
        expectStoredMarker(visible, markers.files);
        const blocked = await expectNoMongoSideEffects(['agents', 'actions'], () =>
          duplicateAgent(request, token, fixtures.fileAgentId!),
        );
        expectContentFilterBlock(blocked, {
          source: 'file',
          field: 'extracted_text',
          marker: markers.files,
        });

        const opaquePreview = await requestResult(request, {
          path: `/api/files/${encodeURIComponent(fixtures.opaqueFile!.file_id)}/preview`,
          token,
        });
        expectSuccess(opaquePreview, 200);
        expect(opaquePreview.body).toEqual({
          file_id: fixtures.opaqueFile!.file_id,
          status: 'ready',
        });

        const opaqueBlocked = await expectNoMongoSideEffects(['agents', 'actions'], () =>
          duplicateAgent(request, token, fixtures.opaqueFileAgentId!),
        );
        expect(opaqueBlocked.status).toBe(400);
        expect(opaqueBlocked.body).toEqual({
          error: 'content_filter_uninspectable',
          message: 'Submitted file content could not be inspected before processing.',
          source: 'file',
          field: 'extracted_text',
        });
        expect(opaqueBlocked.text).not.toContain(fixtures.opaqueFile!.filepath);
      });

      await test.step('stored tool arguments stay visible but prevent conversation reuse', async () => {
        const visible = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(fixtures.toolConversationId!)}`,
          token,
        });
        expectStoredMarker(visible, markers.toolArguments);
        const blocked = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
          duplicateConversation(request, token, fixtures.toolConversationId!),
        );
        expectContentFilterBlock(blocked, {
          source: 'tool_argument',
          field: 'arguments',
          marker: markers.toolArguments,
        });
      });

      await test.step('model parameters stay visible but prevent agent reuse', async () => {
        const visible = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(fixtures.modelParameterAgentId!)}/expanded`,
          token,
        });
        expectStoredMarker(visible, markers.modelParameters);
        const blocked = await expectNoMongoSideEffects(['agents', 'actions'], () =>
          duplicateAgent(request, token, fixtures.modelParameterAgentId!),
        );
        expectContentFilterBlock(blocked, {
          source: 'model_parameter',
          field: 'stop',
          marker: markers.modelParameters,
        });
      });

      await test.step('action metadata is blocked on read and prevents agent reuse', async () => {
        const readBlocked = await requestResult(request, { path: '/api/agents/actions', token });
        expectContentFilterBlock(readBlocked, {
          source: 'action_metadata',
          field: 'privacy_policy_url',
          marker: markers.actionMetadata,
        });
        const blocked = await expectNoMongoSideEffects(['agents', 'actions'], () =>
          duplicateAgent(request, token, fixtures.actionAgentId!),
        );
        expectContentFilterBlock(blocked, {
          source: 'action_metadata',
          field: 'privacy_policy_url',
          marker: markers.actionMetadata,
        });
      });

      await test.step('memories redact blocked fields, reject resubmission, and fail closed at runtime', async () => {
        const visible = await requestResult(request, { path: '/api/memories', token });
        expectSuccess(visible);
        expect(visible.text).not.toContain(markers.memories);
        const visibleMemoryItems = Array.isArray(asObject(visible.body).memories)
          ? (asObject(visible.body).memories as unknown[]).map(asObject)
          : [];
        expect(visibleMemoryItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: fixtures.memoryKey,
              value: '',
              agentId: fixtures.memoryAgentId,
              contentFilterBlocked: true,
            }),
          ]),
        );
        const blocked = await expectNoMongoSideEffects(['memoryentries'], () =>
          requestResult(request, {
            path: `/api/memories/${encodeURIComponent(
              fixtures.memoryKey!,
            )}?agentId=${encodeURIComponent(fixtures.memoryAgentId!)}`,
            token,
            method: 'PATCH',
            data: { value: markers.memories },
          }),
        );
        expectContentFilterBlock(blocked, {
          source: 'memory',
          field: 'value',
          marker: markers.memories,
        });

        const memoryMessageId = randomUUID();
        const startedMemory = await requestResult(request, {
          path: '/api/agents/chat/agents',
          token,
          method: 'POST',
          data: {
            text: `Safe persisted-memory runtime request ${suffix}`,
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId: NO_PARENT,
            conversationId: 'new',
            messageId: memoryMessageId,
            responseMessageId: `${memoryMessageId}_response`,
            endpoint: 'agents',
            endpointType: 'agents',
            agent_id: fixtures.memoryAgentId,
            isTemporary: false,
            isRegenerate: false,
            error: false,
          },
        });
        fixtures.conversationIds.push(
          await expectAsyncFilterStreamError(
            request,
            token,
            startedMemory,
            'E2E persisted memories value',
            markers.memories,
          ),
        );
        await withMongo(async (db) => {
          expect(
            await db.collection('messages').countDocuments({
              messageId: { $in: [memoryMessageId, `${memoryMessageId}_response`] },
            }),
          ).toBe(0);
        });
      });

      await test.step('deactivation restores stored values without destructive mutation', async () => {
        const preDeactivationSnapshot = await captureMongoSnapshot(fixtureSnapshotSelectors);
        await restoreRuntimeFilters(request, token);
        filtersActive = false;
        expect(await captureMongoSnapshot(fixtureSnapshotSelectors)).toEqual(
          preDeactivationSnapshot,
        );

        const trackConversation = (
          result: RequestResult,
          label: string,
          expectedStatus: number,
        ): void => {
          expectSuccess(result, expectedStatus);
          fixtures.conversationIds.push(
            requireString(asObject(asObject(result.body).conversation).conversationId, label),
          );
        };
        const trackAgent = (result: RequestResult, label: string): void => {
          expectSuccess(result, 201);
          fixtures.agentIds.push(requireString(asObject(asObject(result.body).agent).id, label));
        };
        const startRecoveredAgent = async (
          agentId: string,
          label: string,
          extra: JsonObject = {},
        ): Promise<void> => {
          const messageId = randomUUID();
          const started = await requestResult(request, {
            path: '/api/agents/chat/agents',
            token,
            method: 'POST',
            data: {
              text: `Safe post-deactivation ${label} request ${suffix}`,
              sender: 'User',
              clientTimestamp: new Date().toISOString(),
              isCreatedByUser: true,
              parentMessageId: NO_PARENT,
              conversationId: 'new',
              messageId,
              responseMessageId: `${messageId}_response`,
              endpoint: 'agents',
              endpointType: 'agents',
              agent_id: agentId,
              isTemporary: false,
              isRegenerate: false,
              error: false,
              ...extra,
            },
          });
          fixtures.conversationIds.push(await expectAsyncStreamCompleted(request, token, started));
        };

        const restoredVersions = await requestResult(request, {
          path: `/api/prompts?groupId=${encodeURIComponent(fixtures.promptGroupId!)}`,
          token,
        });
        expectStoredMarker(restoredVersions, markers.prompts);
        const restoredPrompt = (Array.isArray(restoredVersions.body) ? restoredVersions.body : [])
          .map(asObject)
          .find((prompt) => prompt._id === fixtures.promptId);
        expect(restoredPrompt).toEqual(
          expect.objectContaining({
            _id: fixtures.promptId,
            groupId: fixtures.promptGroupId,
            prompt: markers.prompts,
          }),
        );
        expect(restoredPrompt).not.toHaveProperty('contentFilterBlocked');

        const restoredPromptGroup = await requestResult(request, {
          path: `/api/prompts/groups/${encodeURIComponent(fixtures.promptGroupId!)}`,
          token,
        });
        expectStoredMarker(restoredPromptGroup, markers.prompts);
        expect(asObject(asObject(restoredPromptGroup.body).productionPrompt)).toEqual(
          expect.objectContaining({
            _id: fixtures.promptId,
            groupId: fixtures.promptGroupId,
            prompt: markers.prompts,
          }),
        );

        const restoredReusablePrompts = await requestResult(request, {
          path: '/api/prompts/all',
          token,
        });
        expectStoredMarker(restoredReusablePrompts, markers.prompts);
        expectStoredMarker(restoredReusablePrompts, markers.promptGroupName);
        const restoredReusableGroups = Array.isArray(restoredReusablePrompts.body)
          ? restoredReusablePrompts.body.map(asObject)
          : [];
        expect(restoredReusableGroups).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              _id: fixtures.promptGroupId,
              productionPrompt: expect.objectContaining({
                _id: fixtures.promptId,
                prompt: markers.prompts,
              }),
            }),
            expect.objectContaining({
              _id: fixtures.metadataPromptGroupId,
              name: markers.promptGroupName,
            }),
          ]),
        );

        const restoredPromotion = await requestResult(request, {
          path: `/api/prompts/${encodeURIComponent(fixtures.promptId!)}/tags/production`,
          token,
          method: 'PATCH',
        });
        expectSuccess(restoredPromotion, 200);

        const restoredMetadataGroup = await requestResult(request, {
          path: `/api/prompts/groups/${encodeURIComponent(fixtures.metadataPromptGroupId!)}`,
          token,
        });
        expectStoredMarker(restoredMetadataGroup, markers.promptGroupName);
        expect(asObject(restoredMetadataGroup.body)._id).toBe(fixtures.metadataPromptGroupId);

        const restoredPresets = await requestResult(request, { path: '/api/presets', token });
        expectStoredMarker(restoredPresets, markers.prompts);
        const restoredPreset = (Array.isArray(restoredPresets.body) ? restoredPresets.body : [])
          .map(asObject)
          .find((preset) => preset.presetId === fixtures.presetId);
        expect(restoredPreset).toEqual(
          expect.objectContaining({
            presetId: fixtures.presetId,
            title: `E2E persisted preset ${suffix}`,
            promptPrefix: markers.prompts,
          }),
        );
        expect(restoredPreset).not.toHaveProperty('contentFilterBlocked');

        const restoredSkill = await requestResult(request, {
          path: `/api/skills/${encodeURIComponent(fixtures.skillId!)}`,
          token,
        });
        expectStoredMarker(restoredSkill, markers.skills);
        expect(asObject(restoredSkill.body)).toEqual(
          expect.objectContaining({
            _id: fixtures.skillId,
            body: markers.skills,
            version: fixtures.skillVersion,
          }),
        );
        await startRecoveredAgent(fixtures.skillAgentId!, 'persisted skill', {
          manualSkills: [fixtures.skillName],
        });

        const restoredMemories = await requestResult(request, { path: '/api/memories', token });
        expectStoredMarker(restoredMemories, markers.memories);
        const restoredMemoryItems = Array.isArray(asObject(restoredMemories.body).memories)
          ? (asObject(restoredMemories.body).memories as unknown[]).map(asObject)
          : [];
        expect(restoredMemoryItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: fixtures.memoryKey,
              value: markers.memories,
              agentId: fixtures.memoryAgentId,
            }),
          ]),
        );
        await startRecoveredAgent(fixtures.memoryAgentId!, 'persisted memory');

        const restoredAgent = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(fixtures.instructionAgentId!)}/expanded`,
          token,
        });
        expectStoredMarker(restoredAgent, markers.agentInstructions);
        expect(asObject(restoredAgent.body)).toEqual(
          expect.objectContaining({
            id: fixtures.instructionAgentId,
            instructions: markers.agentInstructions,
          }),
        );
        trackAgent(
          await duplicateAgent(request, token, fixtures.instructionAgentId!),
          'post-deactivation copied instruction agent id',
        );

        const restoredStarterAgent = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(fixtures.starterAgentId!)}/expanded`,
          token,
        });
        expectStoredMarker(restoredStarterAgent, markers.conversationStarters);
        trackAgent(
          await duplicateAgent(request, token, fixtures.starterAgentId!),
          'post-deactivation copied starter agent id',
        );

        const restoredTitleConversation = await requestResult(request, {
          path: `/api/convos/${encodeURIComponent(fixtures.titleConversationId!)}`,
          token,
        });
        expectStoredMarker(restoredTitleConversation, markers.conversationTitles);
        const restoredTitleCopy = await requestResult(request, {
          path: '/api/convos/duplicate',
          token,
          method: 'POST',
          data: { conversationId: fixtures.titleConversationId },
        });
        trackConversation(
          restoredTitleCopy,
          'post-deactivation copied stored-title conversation id',
          201,
        );

        const restoredFeedback = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(fixtures.feedbackConversationId!)}`,
          token,
        });
        expectStoredMarker(restoredFeedback, markers.feedback);
        trackConversation(
          await duplicateConversation(request, token, fixtures.feedbackConversationId!),
          'post-deactivation copied feedback conversation id',
          201,
        );

        const restoredFile = await requestResult(request, {
          path: `/api/files/${encodeURIComponent(fixtures.file!.file_id)}/preview`,
          token,
        });
        expectSuccess(restoredFile, 200);
        expect(asObject(restoredFile.body)).toEqual(
          expect.objectContaining({
            file_id: fixtures.file!.file_id,
            status: 'ready',
            text: markers.files,
          }),
        );
        expectStoredMarker(restoredFile, markers.files);
        const restoredFileAgentCopy = await duplicateAgent(request, token, fixtures.fileAgentId!);
        trackAgent(restoredFileAgentCopy, 'post-deactivation copied file agent id');

        const restoredOpaqueFile = await requestResult(request, {
          path: `/api/files/${encodeURIComponent(fixtures.opaqueFile!.file_id)}/preview`,
          token,
        });
        expectSuccess(restoredOpaqueFile, 200);
        expect(restoredOpaqueFile.body).toEqual({
          file_id: fixtures.opaqueFile!.file_id,
          status: 'ready',
        });
        trackAgent(
          await duplicateAgent(request, token, fixtures.opaqueFileAgentId!),
          'post-deactivation copied opaque-file agent id',
        );

        const restoredToolArguments = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(fixtures.toolConversationId!)}`,
          token,
        });
        expectStoredMarker(restoredToolArguments, markers.toolArguments);
        trackConversation(
          await duplicateConversation(request, token, fixtures.toolConversationId!),
          'post-deactivation copied tool-argument conversation id',
          201,
        );

        const restoredModelParameters = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(fixtures.modelParameterAgentId!)}/expanded`,
          token,
        });
        expectStoredMarker(restoredModelParameters, markers.modelParameters);
        trackAgent(
          await duplicateAgent(request, token, fixtures.modelParameterAgentId!),
          'post-deactivation copied model-parameter agent id',
        );

        const restoredActions = await requestResult(request, {
          path: '/api/agents/actions',
          token,
        });
        expectStoredMarker(restoredActions, markers.actionMetadata);
        const restoredActionItems = Array.isArray(restoredActions.body)
          ? restoredActions.body.map(asObject)
          : [];
        expect(restoredActionItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action_id: fixtures.actionId,
              agent_id: fixtures.actionAgentId,
              metadata: expect.objectContaining({
                privacy_policy_url: markers.actionMetadata,
              }),
            }),
          ]),
        );
        trackAgent(
          await duplicateAgent(request, token, fixtures.actionAgentId!),
          'post-deactivation copied action agent id',
        );

        const restoredMessages = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(fixtures.messageConversationId!)}`,
          token,
        });
        expectStoredMarker(restoredMessages, markers.messages);

        const restoredShare = await requestResult(request, {
          path: `/api/share/${encodeURIComponent(fixtures.messageShareId!)}`,
        });
        expectStoredMarker(restoredShare, markers.messages);

        const reusableCopy = await duplicateConversation(
          request,
          token,
          fixtures.messageConversationId!,
        );
        trackConversation(reusableCopy, 'post-deactivation copied message conversation id', 201);

        const restoredFork = await requestResult(request, {
          path: '/api/convos/fork',
          token,
          method: 'POST',
          data: {
            conversationId: fixtures.messageConversationId,
            messageId: fixtures.messageId,
            option: 'directPath',
          },
        });
        trackConversation(restoredFork, 'post-deactivation message fork id', 200);

        const restoredSharedFork = await requestResult(request, {
          path: `/api/share/${encodeURIComponent(fixtures.messageShareId!)}/fork`,
          token,
          method: 'POST',
          data: {},
        });
        trackConversation(restoredSharedFork, 'post-deactivation shared-message fork id', 201);
      });
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        await cleanupFixtures(request, token, fixtures);
      }
    }
  });

  test('changes one message field or pattern without weakening other active sources', async ({
    page,
    request,
  }) => {
    test.setTimeout(240000);

    const token = await loginAdmin(request);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const firstMessageMarker = `E2E-GRANULAR-MESSAGE-ONE-${suffix}`;
    const secondMessageMarker = `E2E-GRANULAR-MESSAGE-TWO-${suffix}`;
    const instructionMarker = `E2E-GRANULAR-INSTRUCTION-${suffix}`;
    const fixtures: StoredFixtures = { conversationIds: [], agentIds: [] };
    let firstConversationId: string | undefined;
    let secondConversationId: string | undefined;
    let firstMessageId: string | undefined;
    let instructionAgentId: string | undefined;
    let filtersAttempted = false;
    let filtersActive = false;

    const pattern = (id: string, label: string, regex: string): CustomPattern => ({
      id,
      label,
      regex,
    });
    const filtersFor = (
      field: 'text' | 'summary',
      messagePattern: CustomPattern,
    ): FiltersConfig => ({
      messages: {
        pii: {
          fields: [field],
          starterPatterns: [],
          customPatterns: [messagePattern],
        },
      },
      agentInstructions: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [
            pattern(
              `e2e-granular-instruction-${suffix}`,
              'E2E granular agent instruction',
              `^${instructionMarker}$`,
            ),
          ],
        },
      },
    });
    const firstPattern = pattern(
      `e2e-granular-message-one-${suffix}`,
      'E2E granular first message',
      `^${firstMessageMarker}$`,
    );
    const secondPattern = pattern(
      `e2e-granular-message-two-${suffix}`,
      'E2E granular second message',
      `^${secondMessageMarker}$`,
    );
    const applyFilters = async (filters: FiltersConfig): Promise<void> => {
      filtersAttempted = true;
      await setRuntimeFilters(request, token, filters);
      filtersActive = true;
    };
    const expectInstructionStillBlocked = async (): Promise<void> => {
      const blocked = await expectNoMongoSideEffects(['agents', 'actions'], () =>
        duplicateAgent(request, token, instructionAgentId!),
      );
      expectContentFilterBlock(blocked, {
        source: 'agent_instruction',
        field: 'instructions',
        marker: instructionMarker,
      });
    };
    const trackConversationCopy = (result: RequestResult, label: string): void => {
      expectSuccess(result, 201);
      fixtures.conversationIds.push(
        requireString(asObject(asObject(result.body).conversation).conversationId, label),
      );
    };

    try {
      await restoreRuntimeFilters(request, token);

      await page.goto('/c/new', { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      const seedResponse = await sendMessage(page, replyPrompt(`granular-filter-seed-${suffix}`));
      expect(seedResponse.ok()).toBe(true);
      await expect(
        page
          .getByTestId('messages-view')
          .getByText(replyText(`granular-filter-seed-${suffix}`), { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
      firstConversationId = requireString(
        new URL(page.url()).pathname.match(/^\/c\/([0-9a-fA-F-]{36})$/)?.[1],
        'granular first conversation id',
      );
      fixtures.conversationIds.push(firstConversationId);

      const secondConversation = await duplicateConversation(request, token, firstConversationId);
      expectSuccess(secondConversation, 201);
      secondConversationId = requireString(
        asObject(asObject(secondConversation.body).conversation).conversationId,
        'granular second conversation id',
      );
      fixtures.conversationIds.push(secondConversationId);

      const firstMessage = await createStoredMessage(request, token, firstConversationId, {
        text: firstMessageMarker,
      });
      firstMessageId = requireString(firstMessage.messageId, 'granular first message id');
      await createStoredMessage(request, token, secondConversationId, {
        text: secondMessageMarker,
      });

      const instructionAgent = await createAgent(
        request,
        token,
        fixtures,
        `${suffix}-granular-instruction`,
        { instructions: instructionMarker },
      );
      instructionAgentId = requireString(instructionAgent.id, 'granular instruction agent id');

      const persistedSelectors: MongoSnapshotSelector[] = [
        {
          key: 'conversations',
          collection: 'conversations',
          filter: { conversationId: { $in: [firstConversationId, secondConversationId] } },
        },
        {
          key: 'messages',
          collection: 'messages',
          filter: { conversationId: { $in: [firstConversationId, secondConversationId] } },
        },
        {
          key: 'agents',
          collection: 'agents',
          filter: { id: instructionAgentId },
        },
      ];
      const originalSnapshot = await captureMongoSnapshot(persistedSelectors);

      await applyFilters(filtersFor('text', firstPattern));
      expect(await captureMongoSnapshot(persistedSelectors)).toEqual(originalSnapshot);
      const firstPatternBlock = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
        duplicateConversation(request, token, firstConversationId!),
      );
      expectContentFilterBlock(firstPatternBlock, {
        source: 'message',
        field: 'text',
        marker: firstMessageMarker,
      });
      await expectInstructionStillBlocked();

      await applyFilters(filtersFor('summary', firstPattern));
      expect(await captureMongoSnapshot(persistedSelectors)).toEqual(originalSnapshot);
      trackConversationCopy(
        await duplicateConversation(request, token, firstConversationId),
        'field-transition conversation copy id',
      );
      await expectInstructionStillBlocked();

      await applyFilters(filtersFor('text', secondPattern));
      expect(await captureMongoSnapshot(persistedSelectors)).toEqual(originalSnapshot);
      trackConversationCopy(
        await duplicateConversation(request, token, firstConversationId),
        'pattern-transition conversation copy id',
      );
      const secondPatternBlock = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
        duplicateConversation(request, token, secondConversationId!),
      );
      expectContentFilterBlock(secondPatternBlock, {
        source: 'message',
        field: 'text',
        marker: secondMessageMarker,
      });
      await expectInstructionStillBlocked();

      const allowedFork = await requestResult(request, {
        path: '/api/convos/fork',
        token,
        method: 'POST',
        data: {
          conversationId: firstConversationId,
          messageId: firstMessageId,
          option: 'directPath',
        },
      });
      expectSuccess(allowedFork, 200);
      fixtures.conversationIds.push(
        requireString(
          asObject(asObject(allowedFork.body).conversation).conversationId,
          'pattern-transition fork id',
        ),
      );
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        await cleanupFixtures(request, token, fixtures);
      }
    }
  });

  test('rechecks persisted history when legacy messageFilter.pii is activated and deactivated', async ({
    page,
    request,
  }) => {
    test.setTimeout(240000);

    const token = await loginAdmin(request);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const marker = `E2E-LEGACY-PERSISTED-MESSAGE-${suffix}`;
    const fixtures: StoredFixtures = { conversationIds: [], agentIds: [] };
    let filtersAttempted = false;
    let filtersActive = false;

    try {
      await restoreRuntimeFilters(request, token);

      await page.goto('/c/new', { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      const seedResponse = await sendMessage(page, replyPrompt(`legacy-filter-seed-${suffix}`));
      expect(seedResponse.ok()).toBe(true);
      await expect(
        page
          .getByTestId('messages-view')
          .getByText(replyText(`legacy-filter-seed-${suffix}`), { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
      fixtures.messageConversationId = requireString(
        new URL(page.url()).pathname.match(/^\/c\/([0-9a-fA-F-]{36})$/)?.[1],
        'legacy persisted conversation id',
      );
      fixtures.conversationIds.push(fixtures.messageConversationId);

      const storedMessage = await createStoredMessage(
        request,
        token,
        fixtures.messageConversationId,
        { text: marker },
      );
      fixtures.messageId = requireString(storedMessage.messageId, 'legacy persisted message id');
      const share = await requestResult(request, {
        path: `/api/share/${encodeURIComponent(fixtures.messageConversationId)}`,
        token,
        method: 'POST',
        data: {},
      });
      expectSuccess(share, 200);
      fixtures.messageShareId = requireString(
        asObject(share.body).shareId,
        'legacy persisted share id',
      );

      const persistedSelectors: MongoSnapshotSelector[] = [
        {
          key: 'conversations',
          collection: 'conversations',
          filter: { conversationId: fixtures.messageConversationId },
        },
        {
          key: 'messages',
          collection: 'messages',
          filter: { conversationId: fixtures.messageConversationId },
        },
        {
          key: 'sharedlinks',
          collection: 'sharedlinks',
          filter: { shareId: fixtures.messageShareId },
        },
      ];
      const preActivationSnapshot = await captureMongoSnapshot(persistedSelectors);

      filtersAttempted = true;
      await setRuntimeMessageFilterPii(request, token, {
        starterPatterns: [],
        customPatterns: [
          {
            id: `e2e-legacy-persisted-${suffix}`,
            label: 'E2E legacy persisted message',
            regex: `^${marker}$`,
          },
        ],
      });
      filtersActive = true;
      expect(await captureMongoSnapshot(persistedSelectors)).toEqual(preActivationSnapshot);

      const visible = await requestResult(request, {
        path: `/api/messages/${encodeURIComponent(fixtures.messageConversationId)}`,
        token,
      });
      expectStoredMarker(visible, marker);

      const expectLegacyBlock = (result: RequestResult): void => {
        expectContentFilterBlock(result, { source: 'message', field: 'text', marker });
      };
      const blockedShare = await expectNoMongoSideEffects(
        ['conversations', 'messages', 'sharedlinks'],
        () =>
          requestResult(request, {
            path: `/api/share/${encodeURIComponent(fixtures.messageShareId!)}`,
          }),
      );
      expectLegacyBlock(blockedShare);

      const blockedDuplicate = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
        duplicateConversation(request, token, fixtures.messageConversationId!),
      );
      expectLegacyBlock(blockedDuplicate);

      const blockedFork = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
        requestResult(request, {
          path: '/api/convos/fork',
          token,
          method: 'POST',
          data: {
            conversationId: fixtures.messageConversationId,
            messageId: fixtures.messageId,
            option: 'directPath',
          },
        }),
      );
      expectLegacyBlock(blockedFork);

      const continuationMessageId = randomUUID();
      const continuationText = `Safe legacy persisted continuation ${suffix}`;
      const startedContinuation = await requestResult(request, {
        path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
        token,
        method: 'POST',
        data: {
          text: continuationText,
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: fixtures.messageId,
          conversationId: fixtures.messageConversationId,
          messageId: continuationMessageId,
          responseMessageId: `${continuationMessageId}_response`,
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          model: MOCK_ENDPOINTS[0].model,
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      expect(
        await expectAsyncFilterStreamError(
          request,
          token,
          startedContinuation,
          'E2E legacy persisted message',
          marker,
        ),
      ).toBe(fixtures.messageConversationId);
      await withMongo(async (db) => {
        expect(
          await db.collection('messages').countDocuments({
            conversationId: fixtures.messageConversationId,
            parentMessageId: fixtures.messageId,
            isCreatedByUser: true,
            text: continuationText,
          }),
        ).toBe(0);
      });
      expect(await captureMongoSnapshot(persistedSelectors)).toEqual(preActivationSnapshot);

      const preDeactivationSnapshot = await captureMongoSnapshot(persistedSelectors);
      await restoreRuntimeFilters(request, token);
      filtersActive = false;
      expect(await captureMongoSnapshot(persistedSelectors)).toEqual(preDeactivationSnapshot);

      const restoredShare = await requestResult(request, {
        path: `/api/share/${encodeURIComponent(fixtures.messageShareId)}`,
      });
      expectStoredMarker(restoredShare, marker);

      const restoredDuplicate = await duplicateConversation(
        request,
        token,
        fixtures.messageConversationId,
      );
      expectSuccess(restoredDuplicate, 201);
      fixtures.conversationIds.push(
        requireString(
          asObject(asObject(restoredDuplicate.body).conversation).conversationId,
          'legacy post-deactivation duplicate id',
        ),
      );

      const restoredFork = await requestResult(request, {
        path: '/api/convos/fork',
        token,
        method: 'POST',
        data: {
          conversationId: fixtures.messageConversationId,
          messageId: fixtures.messageId,
          option: 'directPath',
        },
      });
      expectSuccess(restoredFork, 200);
      fixtures.conversationIds.push(
        requireString(
          asObject(asObject(restoredFork.body).conversation).conversationId,
          'legacy post-deactivation fork id',
        ),
      );
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        await cleanupFixtures(request, token, fixtures);
      }
    }
  });

  test('rechecks a provider-backed Assistant created before policy activation', async ({
    request,
  }) => {
    test.setTimeout(240000);

    const token = await loginAdmin(request);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const marker = `E2E-PERSISTED-ASSISTANT-INSTRUCTION-${suffix}`;
    const blockedChatText = `Safe existing Assistant invocation ${suffix}`;
    const assistantProviderURL = `http://127.0.0.1:${process.env.E2E_ASSISTANTS_PORT || '8890'}`;
    const conversationIds = new Set<string>();
    let assistantId: string | undefined;
    let filtersAttempted = false;
    let filtersActive = false;

    const filters = {
      agentInstructions: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [
            {
              id: `e2e-persisted-assistant-${suffix}`,
              label: 'E2E persisted Assistant instruction',
              regex: `^${marker}$`,
            },
          ],
        },
      },
    } as FiltersConfig;
    const assistantChat = async (text: string): Promise<RequestResult> => {
      const messageId = randomUUID();
      return requestResult(request, {
        path: '/api/assistants/v2/chat',
        token,
        method: 'POST',
        data: {
          text,
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
          files: [],
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
    };
    const expectAssistantChatCompleted = (
      result: RequestResult,
      expectedReply: string,
      label: string,
    ): void => {
      expectSuccess(result, 200);
      expect(result.text).toContain(expectedReply);
      expect(result.text).not.toContain('event: error');
      const conversationId = result.text.match(/"conversationId":"([^"]+)"/)?.[1];
      conversationIds.add(requireString(conversationId, label));
    };

    try {
      await restoreRuntimeFilters(request, token);
      const resetProvider = await requestResult(request, {
        path: `${assistantProviderURL}/__e2e/reset`,
        method: 'POST',
      });
      expectSuccess(resetProvider, 200);

      const created = await requestResult(request, {
        path: '/api/assistants/v2',
        token,
        method: 'POST',
        data: {
          endpoint: 'assistants',
          model: 'gpt-4o-mini',
          name: `E2E persisted Assistant ${suffix}`,
          description: 'Created before persisted-content policy activation.',
          instructions: marker,
          tools: [],
          conversation_starters: ['Ask a safe question'],
        },
      });
      expectSuccess(created, 201);
      assistantId = requireString(asObject(created.body).id, 'persisted Assistant id');

      const preActivationRead = await requestResult(request, {
        path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants`,
        token,
      });
      expectStoredMarker(preActivationRead, marker);
      expect(asObject(preActivationRead.body)).toEqual(
        expect.objectContaining({
          id: assistantId,
          instructions: marker,
          model: 'gpt-4o-mini',
        }),
      );

      filtersAttempted = true;
      await setRuntimeFilters(request, token, filters);
      filtersActive = true;

      const safePartialEdit = await requestResult(request, {
        path: `/api/assistants/v2/${encodeURIComponent(assistantId)}`,
        token,
        method: 'PATCH',
        data: {
          endpoint: 'assistants',
          description: 'Safe remediation metadata edit while policy is active.',
        },
      });
      expectSuccess(safePartialEdit, 200);
      expect(asObject(safePartialEdit.body)).toEqual(
        expect.objectContaining({
          id: assistantId,
          description: 'Safe remediation metadata edit while policy is active.',
          instructions: marker,
        }),
      );

      const activePolicyRead = await requestResult(request, {
        path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants`,
        token,
      });
      expectStoredMarker(activePolicyRead, marker);

      const blockedInvocation = await assistantChat(blockedChatText);
      expectContentFilterBlock(blockedInvocation, {
        source: 'agent_instruction',
        field: 'instructions',
        marker,
      });

      await withMongo(async (db) => {
        expect(await db.collection('messages').countDocuments({ text: blockedChatText })).toBe(0);
      });
      const blockedProviderRequests = await requestResult(request, {
        path: `${assistantProviderURL}/__e2e/requests`,
      });
      expectSuccess(blockedProviderRequests, 200);
      const blockedProviderRequestItems = Array.isArray(
        asObject(blockedProviderRequests.body).requests,
      )
        ? (asObject(blockedProviderRequests.body).requests as unknown[]).map(asObject)
        : [];
      expect(
        blockedProviderRequestItems.some((item) =>
          String(item.path).match(/^\/v1\/threads(?:\/|$)/),
        ),
      ).toBe(false);

      await restoreRuntimeFilters(request, token);
      filtersActive = false;

      const rollbackRead = await requestResult(request, {
        path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants`,
        token,
      });
      expectStoredMarker(rollbackRead, marker);
      expectAssistantChatCompleted(
        await assistantChat('E2E_REPLY:rollback'),
        'E2E assistant reply rollback',
        'post-deactivation Assistant conversation id',
      );

      await setRuntimeFilters(request, token, filters);
      filtersActive = true;
      const remediated = await requestResult(request, {
        path: `/api/assistants/v2/${encodeURIComponent(assistantId)}`,
        token,
        method: 'PATCH',
        data: {
          endpoint: 'assistants',
          instructions: 'Safe recovered Assistant instructions.',
        },
      });
      expectSuccess(remediated, 200);
      expect(asObject(remediated.body)).toEqual(
        expect.objectContaining({
          id: assistantId,
          instructions: 'Safe recovered Assistant instructions.',
        }),
      );
      expectAssistantChatCompleted(
        await assistantChat('E2E_REPLY:remediation'),
        'E2E assistant reply remediation',
        'post-remediation Assistant conversation id',
      );
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        if (assistantId) {
          const deleted = await requestResult(request, {
            path: `/api/assistants/v2/${encodeURIComponent(
              assistantId,
            )}?endpoint=assistants&model=gpt-4o-mini`,
            token,
            method: 'DELETE',
            data: { endpoint: 'assistants' },
          });
          expectSuccess(deleted, 200);
          expect(deleted.body).toEqual(expect.objectContaining({ id: assistantId, deleted: true }));
        }
        for (const conversationId of conversationIds) {
          await requestResult(request, {
            path: '/api/convos',
            token,
            method: 'DELETE',
            data: { arg: { conversationId } },
          });
        }
      }
    }
  });

  test('applies configurable attribution to pre-upgrade assistant messages', async ({
    request,
  }) => {
    test.setTimeout(240000);

    const token = await loginAdmin(request);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const marker = `E2E-PERSISTED-UNATTRIBUTED-ASSISTANT-${suffix}`;
    const legacyMessageId = randomUUID();
    const explicitModelMessageId = randomUUID();
    const seedMessageId = randomUUID();
    const seedResponseMessageId = randomUUID();
    const createdConversationIds = new Set<string>();
    let sourceConversationId: string | undefined;
    let sourceUser: unknown;
    let filtersAttempted = false;
    let filtersActive = false;

    const customPattern = {
      id: `e2e-unattributed-assistant-${suffix}`,
      label: 'E2E unattributed assistant content',
      regex: `^${marker}$`,
    };
    const filtersFor = (
      unattributedAssistantContent?: 'model_output' | 'inspect',
    ): FiltersConfig => ({
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [customPattern],
        },
        ...(unattributedAssistantContent ? { unattributedAssistantContent } : {}),
      },
    });
    const applyFilters = async (filters: FiltersConfig): Promise<void> => {
      filtersAttempted = true;
      await setRuntimeFilters(request, token, filters);
      filtersActive = true;
    };
    const trackFork = (result: RequestResult, label: string): void => {
      expectSuccess(result, 200);
      createdConversationIds.add(
        requireString(asObject(asObject(result.body).conversation).conversationId, label),
      );
    };
    const forkBranch = async (messageId: string): Promise<RequestResult> =>
      requestResult(request, {
        path: '/api/convos/fork',
        token,
        method: 'POST',
        data: {
          conversationId: sourceConversationId,
          messageId,
          option: 'directPath',
        },
      });

    try {
      await restoreRuntimeFilters(request, token);

      const startedSeed = await requestResult(request, {
        path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
        token,
        method: 'POST',
        data: {
          text: replyPrompt(`legacy-attribution-seed-${suffix}`),
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: 'new',
          messageId: seedMessageId,
          responseMessageId: seedResponseMessageId,
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          model: MOCK_ENDPOINTS[0].model,
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      sourceConversationId = await expectAsyncStreamCompleted(request, token, startedSeed);
      createdConversationIds.add(sourceConversationId);

      await expect
        .poll(
          async () => {
            const messages = await requestResult(request, {
              path: `/api/messages/${encodeURIComponent(sourceConversationId!)}`,
              token,
            });
            expectSuccess(messages, 200);
            return (Array.isArray(messages.body) ? messages.body : [])
              .map(asObject)
              .some((message) => message.messageId === seedResponseMessageId);
          },
          { timeout: 30000, intervals: [100, 250, 500, 1000] },
        )
        .toBe(true);

      await withMongo(async (db) => {
        const seed = await db.collection('messages').findOne({
          conversationId: sourceConversationId,
          messageId: seedResponseMessageId,
        });
        if (!seed) {
          throw new Error('Expected completed seed response in MongoDB');
        }
        expect(seed).toEqual(
          expect.objectContaining({
            messageId: seedResponseMessageId,
            isCreatedByUser: false,
            isUserSubmitted: false,
          }),
        );
        sourceUser = seed.user;
        const now = Date.now();
        const shared = {
          conversationId: sourceConversationId,
          user: seed.user,
          ...(typeof seed.tenantId === 'string' ? { tenantId: seed.tenantId } : {}),
          endpoint: seed.endpoint,
          model: seed.model,
          parentMessageId: seedResponseMessageId,
          sender: 'Assistant',
          text: marker,
          isCreatedByUser: false,
          isTemporary: false,
          unfinished: false,
          error: false,
        };
        await db.collection('messages').insertMany([
          {
            ...shared,
            messageId: legacyMessageId,
            createdAt: new Date(now + 1),
            updatedAt: new Date(now + 1),
          },
          {
            ...shared,
            messageId: explicitModelMessageId,
            isUserSubmitted: false,
            createdAt: new Date(now + 2),
            updatedAt: new Date(now + 2),
          },
        ]);
      });

      await applyFilters(filtersFor());
      trackFork(await forkBranch(legacyMessageId), 'default-attribution legacy assistant fork id');

      await applyFilters(filtersFor('model_output'));
      trackFork(
        await forkBranch(legacyMessageId),
        'explicit-model-output legacy assistant fork id',
      );

      await applyFilters(filtersFor('inspect'));
      trackFork(
        await forkBranch(explicitModelMessageId),
        'strict-attribution explicit model-output fork id',
      );
      const blockedLegacy = await forkBranch(legacyMessageId);
      expectContentFilterBlock(blockedLegacy, {
        source: 'message',
        field: 'text',
        marker,
      });

      const strictContinuationMessageId = randomUUID();
      const startedStrictContinuation = await requestResult(request, {
        path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
        token,
        method: 'POST',
        data: {
          text: `Safe strict legacy continuation ${suffix}`,
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: legacyMessageId,
          conversationId: sourceConversationId,
          messageId: strictContinuationMessageId,
          responseMessageId: `${strictContinuationMessageId}_response`,
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          model: MOCK_ENDPOINTS[0].model,
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      const strictContinuationConversationId = await expectAsyncFilterStreamError(
        request,
        token,
        startedStrictContinuation,
        'E2E unattributed assistant content',
        marker,
      );
      expect(strictContinuationConversationId).toBe(sourceConversationId);

      await restoreRuntimeFilters(request, token);
      filtersActive = false;
      trackFork(await forkBranch(legacyMessageId), 'post-deactivation legacy assistant fork id');

      await withMongo(async (db) => {
        const rows = await db
          .collection('messages')
          .find({
            conversationId: sourceConversationId,
            messageId: { $in: [legacyMessageId, explicitModelMessageId] },
          })
          .toArray();
        expect(rows).toHaveLength(2);
        const legacy = rows.find((row) => row.messageId === legacyMessageId);
        const explicitModel = rows.find((row) => row.messageId === explicitModelMessageId);
        expect(legacy).toEqual(expect.objectContaining({ text: marker, isCreatedByUser: false }));
        expect(legacy).not.toHaveProperty('isUserSubmitted');
        expect(legacy).not.toHaveProperty('userSubmittedPaths');
        expect(explicitModel).toEqual(
          expect.objectContaining({
            text: marker,
            isCreatedByUser: false,
            isUserSubmitted: false,
          }),
        );
        expect(explicitModel).not.toHaveProperty('userSubmittedPaths');
      });
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        for (const conversationId of createdConversationIds) {
          await requestResult(request, {
            path: '/api/convos',
            token,
            method: 'DELETE',
            data: { arg: { conversationId } },
          });
        }
        if (sourceConversationId && sourceUser != null) {
          await withMongo(async (db) => {
            const scope = { conversationId: sourceConversationId, user: sourceUser };
            await db.collection('messages').deleteMany(scope);
            await db.collection('conversations').deleteMany(scope);
          });
        } else {
          await withMongo(async (db) => {
            await db.collection('messages').deleteMany({
              messageId: { $in: [legacyMessageId, explicitModelMessageId] },
            });
          });
        }
      }
    }
  });

  test('rechecks every persisted message field across policy transitions', async ({ request }) => {
    test.setTimeout(300000);

    type PersistedMessageField =
      | 'name'
      | 'text'
      | 'summary'
      | 'quote'
      | 'answer'
      | 'decision_response'
      | 'decision_reason'
      | 'content_part'
      | 'attachment_reference'
      | 'assembled_context';
    type PersistedMessageCase = {
      field: PersistedMessageField;
      source: 'message' | 'assembled_context';
      marker: string;
      label: string;
      messageId: string;
    };

    const token = await loginAdmin(request);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const assembledParts = [`E2E-ASSEMBLED-A-${suffix}`, `E2E-ASSEMBLED-B-${suffix}`] as const;
    const semanticPath = '/content/0/tool_call/output';
    const createdConversationIds = new Set<string>();
    const attemptedRuntimeMessages: Array<{
      parentMessageId: string;
      responseMessageId: string;
      text: string;
    }> = [];
    let sourceConversationId: string | undefined;
    let filtersAttempted = false;
    let filtersActive = false;

    const staticCases: (PersistedMessageCase & { body: JsonObject })[] = [
      {
        field: 'name',
        source: 'message',
        marker: `E2E-PERSISTED-NAME-${suffix}`,
        label: 'E2E persisted message name',
        messageId: randomUUID(),
        body: { sender: `E2E-PERSISTED-NAME-${suffix}`, text: 'Safe persisted name row.' },
      },
      {
        field: 'text',
        source: 'message',
        marker: `E2E-PERSISTED-TEXT-${suffix}`,
        label: 'E2E persisted message text',
        messageId: randomUUID(),
        body: { text: `E2E-PERSISTED-TEXT-${suffix}` },
      },
      {
        field: 'summary',
        source: 'message',
        marker: `E2E-PERSISTED-SUMMARY-${suffix}`,
        label: 'E2E persisted message summary',
        messageId: randomUUID(),
        body: {
          text: 'Safe persisted summary row.',
          summary: `E2E-PERSISTED-SUMMARY-${suffix}`,
        },
      },
      {
        field: 'quote',
        source: 'message',
        marker: `E2E-PERSISTED-QUOTE-${suffix}`,
        label: 'E2E persisted message quote',
        messageId: randomUUID(),
        body: {
          text: 'Safe persisted quote row.',
          quotes: [`E2E-PERSISTED-QUOTE-${suffix}`],
        },
      },
      {
        field: 'content_part',
        source: 'message',
        marker: `E2E-PERSISTED-CONTENT-PART-${suffix}`,
        label: 'E2E persisted message content part',
        messageId: randomUUID(),
        body: {
          text: '',
          content: [{ type: 'text', text: `E2E-PERSISTED-CONTENT-PART-${suffix}` }],
        },
      },
      {
        field: 'attachment_reference',
        source: 'message',
        marker: `https://e2e.invalid/persisted-attachment-${suffix}`,
        label: 'E2E persisted message attachment reference',
        messageId: randomUUID(),
        body: {
          text: 'Safe persisted attachment row.',
          content: [
            {
              type: 'image_url',
              image_url: `https://e2e.invalid/persisted-attachment-${suffix}`,
            },
          ],
        },
      },
      {
        field: 'assembled_context',
        source: 'assembled_context',
        marker: assembledParts.join(''),
        label: 'E2E persisted assembled context',
        messageId: randomUUID(),
        body: {
          text: '',
          content: assembledParts.map((text) => ({ type: 'text', text })),
        },
      },
    ];
    const semanticCases: PersistedMessageCase[] = [
      {
        field: 'answer',
        source: 'message',
        marker: `E2E-PERSISTED-ANSWER-${suffix}`,
        label: 'E2E persisted HITL answer',
        messageId: randomUUID(),
      },
      {
        field: 'decision_response',
        source: 'message',
        marker: `E2E-PERSISTED-DECISION-RESPONSE-${suffix}`,
        label: 'E2E persisted HITL decision response',
        messageId: randomUUID(),
      },
      {
        field: 'decision_reason',
        source: 'message',
        marker: `E2E-PERSISTED-DECISION-REASON-${suffix}`,
        label: 'E2E persisted HITL decision reason',
        messageId: randomUUID(),
      },
    ];
    const allCases = [...staticCases, ...semanticCases];
    const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filtersFor = (
      fields: readonly PersistedMessageField[],
      cases: readonly PersistedMessageCase[],
    ): FiltersConfig => ({
      messages: {
        pii: {
          fields: [...fields],
          starterPatterns: [],
          customPatterns: cases.map(({ field, label, marker }) => ({
            id: `e2e-persisted-${field}-${suffix}`,
            label,
            regex: `^${escapeRegex(marker)}$`,
          })),
        },
      },
    });
    const applyFilters = async (filters: FiltersConfig): Promise<void> => {
      filtersAttempted = true;
      await setRuntimeFilters(request, token, filters);
      filtersActive = true;
    };
    const forkBranch = (messageId: string): Promise<RequestResult> =>
      requestResult(request, {
        path: '/api/convos/fork',
        token,
        method: 'POST',
        data: {
          conversationId: sourceConversationId,
          messageId,
          option: 'directPath',
        },
      });
    const trackFork = (result: RequestResult, label: string): JsonObject[] => {
      expectSuccess(result, 200);
      const body = asObject(result.body);
      createdConversationIds.add(
        requireString(asObject(body.conversation).conversationId, `${label} conversation id`),
      );
      return Array.isArray(body.messages) ? body.messages.map(asObject) : [];
    };
    const startContinuation = (parentMessageId: string, label: string): Promise<RequestResult> => {
      const messageId = randomUUID();
      const responseMessageId = randomUUID();
      const text = `Safe persisted ${label} continuation ${suffix}`;
      /** The resumable controller does not use the request's `messageId` as
       * BaseClient's persisted user ID. Track that row by its unique content
       * and parent, while the response ID remains stable. */
      attemptedRuntimeMessages.push({ parentMessageId, responseMessageId, text });
      return requestResult(request, {
        path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
        token,
        method: 'POST',
        data: {
          text,
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId,
          conversationId: sourceConversationId,
          messageId,
          responseMessageId,
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          model: MOCK_ENDPOINTS[0].model,
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
    };

    try {
      await restoreRuntimeFilters(request, token);

      const seedMessageId = randomUUID();
      const seedResponseMessageId = randomUUID();
      sourceConversationId = await expectAsyncStreamCompleted(
        request,
        token,
        await requestResult(request, {
          path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
          token,
          method: 'POST',
          data: {
            text: replyPrompt(`persisted-message-fields-seed-${suffix}`),
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId: NO_PARENT,
            conversationId: 'new',
            messageId: seedMessageId,
            responseMessageId: seedResponseMessageId,
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            model: MOCK_ENDPOINTS[0].model,
            isTemporary: false,
            isRegenerate: false,
            error: false,
          },
        }),
      );
      createdConversationIds.add(sourceConversationId);

      for (const testCase of staticCases) {
        const stored = await createStoredMessage(request, token, sourceConversationId, {
          ...testCase.body,
          messageId: testCase.messageId,
        });
        expect(stored.messageId).toBe(testCase.messageId);
      }

      await withMongo(async (db) => {
        const owner = await db.collection('messages').findOne({
          conversationId: sourceConversationId,
          messageId: staticCases[0].messageId,
        });
        if (owner?.user == null) {
          throw new Error('Expected the persisted message-field fixture to have an owner');
        }
        const ownership = {
          user: owner.user,
          ...(owner.tenantId == null ? {} : { tenantId: owner.tenantId }),
        };
        const now = Date.now();
        await db.collection('messages').insertMany(
          semanticCases.map((testCase, index) => ({
            ...ownership,
            conversationId: sourceConversationId,
            messageId: testCase.messageId,
            parentMessageId: NO_PARENT,
            sender: 'Assistant',
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            model: MOCK_ENDPOINTS[0].model,
            text: '',
            content: [
              {
                type: 'tool_call',
                tool_call: {
                  id: `e2e-${testCase.field}-${suffix}`,
                  name: 'conditional_transfer',
                  args: '{}',
                  output: testCase.marker,
                },
              },
            ],
            isCreatedByUser: false,
            isUserSubmitted: false,
            userSubmittedMessageFieldPaths: [{ path: semanticPath, field: testCase.field }],
            isTemporary: false,
            unfinished: false,
            error: false,
            createdAt: new Date(now + index),
            updatedAt: new Date(now + index),
          })),
        );
      });

      const sourceSelectors: MongoSnapshotSelector[] = [
        {
          key: 'conversation',
          collection: 'conversations',
          filter: { conversationId: sourceConversationId },
        },
        {
          key: 'messages',
          collection: 'messages',
          filter: { conversationId: sourceConversationId },
        },
      ];
      const preActivationSnapshot = await captureMongoSnapshot(sourceSelectors);
      await withMongo(async (db) => {
        const rows = await db
          .collection('messages')
          .find({ messageId: { $in: allCases.map(({ messageId }) => messageId) } })
          .toArray();
        expect(rows).toHaveLength(allCases.length);
        for (const testCase of staticCases) {
          const row = rows.find(({ messageId }) => messageId === testCase.messageId);
          expect(row).toEqual(
            expect.objectContaining({
              conversationId: sourceConversationId,
              isCreatedByUser: true,
              isUserSubmitted: true,
            }),
          );
          if (testCase.field === 'name') {
            expect(row?.sender).toBe(testCase.marker);
          } else if (testCase.field === 'text' || testCase.field === 'summary') {
            expect(row?.[testCase.field]).toBe(testCase.marker);
          } else if (testCase.field === 'quote') {
            expect(row?.quotes).toEqual([testCase.marker]);
          } else if (testCase.field === 'content_part') {
            expect(row?.content).toEqual([{ type: 'text', text: testCase.marker }]);
          } else if (testCase.field === 'attachment_reference') {
            expect(row?.content).toEqual([{ type: 'image_url', image_url: testCase.marker }]);
          } else {
            expect(row?.content).toEqual(assembledParts.map((text) => ({ type: 'text', text })));
          }
        }
        for (const testCase of semanticCases) {
          const row = rows.find(({ messageId }) => messageId === testCase.messageId);
          expect(row).toEqual(
            expect.objectContaining({
              conversationId: sourceConversationId,
              isCreatedByUser: false,
              isUserSubmitted: false,
              userSubmittedMessageFieldPaths: [{ path: semanticPath, field: testCase.field }],
            }),
          );
          expect(row).not.toHaveProperty('userSubmittedPaths');
          expect(asObject(asObject((row?.content as unknown[])?.[0]).tool_call).output).toBe(
            testCase.marker,
          );
        }
      });

      await applyFilters(
        filtersFor(
          staticCases.map(({ field }) => field),
          staticCases,
        ),
      );
      expect(await captureMongoSnapshot(sourceSelectors)).toEqual(preActivationSnapshot);
      for (const testCase of staticCases) {
        const blocked = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
          forkBranch(testCase.messageId),
        );
        expectContentFilterBlock(blocked, {
          source: testCase.source,
          field: testCase.field,
          marker: testCase.marker,
        });
      }

      await applyFilters(filtersFor(['content_part'], semanticCases));
      trackFork(
        await forkBranch(semanticCases.find(({ field }) => field === 'answer')!.messageId),
        'semantic answer while only content_part is selected',
      );
      expect(await captureMongoSnapshot(sourceSelectors)).toEqual(preActivationSnapshot);

      await applyFilters(
        filtersFor(
          semanticCases.map(({ field }) => field),
          semanticCases,
        ),
      );
      expect(await captureMongoSnapshot(sourceSelectors)).toEqual(preActivationSnapshot);
      trackFork(
        await forkBranch(staticCases.find(({ field }) => field === 'summary')!.messageId),
        'static sibling while semantic fields are selected',
      );
      for (const testCase of semanticCases) {
        const blocked = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
          forkBranch(testCase.messageId),
        );
        expectContentFilterBlock(blocked, {
          source: 'message',
          field: testCase.field,
          marker: testCase.marker,
        });
      }

      const beforeRuntimeBlocks = await captureMongoSnapshot(sourceSelectors);
      for (const testCase of semanticCases) {
        expect(
          await expectAsyncFilterStreamError(
            request,
            token,
            await startContinuation(testCase.messageId, testCase.field),
            testCase.label,
            testCase.marker,
          ),
        ).toBe(sourceConversationId);
      }
      await withMongo(async (db) => {
        expect(
          await db.collection('messages').countDocuments({
            $or: attemptedRuntimeMessages.flatMap(
              ({ parentMessageId, responseMessageId, text }) => [
                {
                  conversationId: sourceConversationId,
                  parentMessageId,
                  isCreatedByUser: true,
                  text,
                },
                { messageId: responseMessageId },
              ],
            ),
          }),
        ).toBe(0);
      });
      expect(await captureMongoSnapshot(sourceSelectors)).toEqual(beforeRuntimeBlocks);

      await applyFilters(filtersFor(['answer'], semanticCases));
      const answerCase = semanticCases.find(({ field }) => field === 'answer')!;
      const answerBlocked = await expectNoMongoSideEffects(['conversations', 'messages'], () =>
        forkBranch(answerCase.messageId),
      );
      expectContentFilterBlock(answerBlocked, {
        source: 'message',
        field: 'answer',
        marker: answerCase.marker,
      });
      for (const testCase of semanticCases.filter(({ field }) => field !== 'answer')) {
        trackFork(
          await forkBranch(testCase.messageId),
          `${testCase.field} sibling while only answer is selected`,
        );
      }
      expect(await captureMongoSnapshot(sourceSelectors)).toEqual(preActivationSnapshot);

      await restoreRuntimeFilters(request, token);
      filtersActive = false;
      expect(await captureMongoSnapshot(sourceSelectors)).toEqual(preActivationSnapshot);
      for (const testCase of allCases) {
        const copiedMessages = trackFork(
          await forkBranch(testCase.messageId),
          `post-deactivation ${testCase.field} fork`,
        );
        if (semanticCases.includes(testCase)) {
          expect(copiedMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                userSubmittedMessageFieldPaths: [{ path: semanticPath, field: testCase.field }],
              }),
            ]),
          );
          const semanticCopy = copiedMessages.find((message) =>
            Array.isArray(message.userSubmittedMessageFieldPaths),
          );
          expect(semanticCopy).toBeDefined();
          expect(semanticCopy).not.toHaveProperty('userSubmittedPaths');
        }
      }
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        for (const conversationId of createdConversationIds) {
          await requestResult(request, {
            path: '/api/convos',
            token,
            method: 'DELETE',
            data: { arg: { conversationId } },
          });
        }
        await withMongo(async (db) => {
          await db.collection('messages').deleteMany({
            messageId: { $in: allCases.map(({ messageId }) => messageId) },
          });
        });
      }
    }
  });
});
