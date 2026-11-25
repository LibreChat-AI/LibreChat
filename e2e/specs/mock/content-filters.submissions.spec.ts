import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { FiltersConfig } from 'librechat-data-provider';
import { withMongo } from './db';
import { MOCK_ENDPOINTS } from './helpers';
import {
  expectContentFilterBlock,
  loginAdmin,
  requestResult,
  restoreRuntimeFilters,
  setRuntimeFilters,
} from './content-filters.helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

type JsonObject = Record<string, unknown>;
type RequestResult = Awaited<ReturnType<typeof requestResult>>;

const asObject = (value: unknown): JsonObject =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const expectSuccess = (result: RequestResult, status?: number) => {
  expect(result.ok, result.text).toBe(true);
  if (status != null) {
    expect(result.status, result.text).toBe(status);
  }
};

async function expectNoStoredDocument(
  collection: string,
  filter: JsonObject,
  label: string,
): Promise<void> {
  await withMongo(async (db) => {
    expect(await db.collection(collection).findOne(filter), label).toBeNull();
  });
}

async function expectAsyncStreamCompleted(
  request: APIRequestContext,
  token: string,
  started: RequestResult,
): Promise<string> {
  expectSuccess(started, 200);
  const startBody = asObject(started.body);
  expect(startBody.status).toBe('started');
  expect(typeof startBody.conversationId).toBe('string');
  expect(typeof startBody.streamId).toBe('string');
  const conversationId = startBody.conversationId as string;
  const streamId = startBody.streamId as string;

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

const createAgentPayload = (suffix: string, overrides: JsonObject = {}) => ({
  name: `E2E content-filter agent ${suffix}`,
  description: 'Safe agent used by the content-filter submission matrix.',
  instructions: 'Keep this reusable test agent safe and deterministic.',
  provider: MOCK_ENDPOINTS[0].label,
  model: MOCK_ENDPOINTS[0].model,
  model_parameters: {},
  tools: [],
  conversation_starters: ['Ask a safe question'],
  ...overrides,
});

test.describe.serial('source-aware content filters', () => {
  test('rejects fresh protected submissions for each configured source', async ({ request }) => {
    test.setTimeout(180000);

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const markers = {
      messages: `E2E-CF-MESSAGE-${suffix}`,
      prompts: `E2E-CF-PROMPT-${suffix}`,
      agentInstructions: `E2E-CF-AGENT-INSTRUCTION-${suffix}`,
      conversationStarters: `E2E-CF-CONVERSATION-STARTER-${suffix}`,
      conversationTitles: `E2E-CF-CONVERSATION-TITLE-${suffix}`,
      feedback: `E2E-CF-FEEDBACK-${suffix}`,
      skills: `E2E-CF-SKILL-${suffix}`,
      memories: `E2E-CF-MEMORY-${suffix}`,
      files: `E2E-CF-FILE-${suffix}`,
      toolArguments: `E2E-CF-TOOL-ARGUMENT-${suffix}`,
      modelParameters: `E2E-CF-MODEL-PARAMETER-${suffix}`,
      actionMetadata: `E2E-CF-ACTION-METADATA-${suffix}`,
    } as const;
    const memoryKeySuffix = Array.from(randomUUID().replace(/-/g, ''), (character) =>
      String.fromCharCode(97 + Number.parseInt(character, 16)),
    ).join('');

    const pii = (id: string, field: string, marker: string) => ({
      fields: [field],
      starterPatterns: [],
      customPatterns: [
        {
          id: `e2e-${id}-${suffix}`,
          label: 'E2E protected value',
          regex: `^${marker}$`,
        },
      ],
    });

    const filters = {
      messages: { pii: pii('messages', 'text', markers.messages) },
      prompts: { pii: pii('prompts', 'text', markers.prompts) },
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
      files: { pii: pii('files', 'content', markers.files) },
      toolArguments: {
        pii: pii('tool-arguments', 'arguments', markers.toolArguments),
      },
      modelParameters: {
        pii: pii('model-parameters', 'stop', markers.modelParameters),
      },
      actionMetadata: {
        pii: pii('action-metadata', 'privacy_policy_url', markers.actionMetadata),
      },
    } as FiltersConfig;

    const token = await loginAdmin(request);
    let filtersAttempted = false;
    let filtersActive = false;
    let conversationId: string | undefined;
    let safeUserMessageId: string | undefined;
    let promptGroupId: string | undefined;
    let agentId: string | undefined;
    let skillId: string | undefined;
    let memoryKey: string | undefined;
    let uploadedFile: { file_id: string; filepath: string } | undefined;
    let actionId: string | undefined;

    try {
      filtersAttempted = true;
      await setRuntimeFilters(request, token, filters);
      filtersActive = true;

      await test.step('messages', async () => {
        const blockedMessageId = randomUUID();
        const blocked = await requestResult(request, {
          path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
          token,
          method: 'POST',
          data: {
            text: markers.messages,
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId: NO_PARENT,
            conversationId: 'new',
            messageId: blockedMessageId,
            responseMessageId: `${blockedMessageId}_response`,
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            model: MOCK_ENDPOINTS[0].model,
            isTemporary: false,
            isRegenerate: false,
            error: false,
          },
        });
        expectContentFilterBlock(blocked, {
          source: 'message',
          field: 'text',
          marker: markers.messages,
        });
        await expectNoStoredDocument(
          'messages',
          { messageId: blockedMessageId },
          'Blocked chat message must not be persisted',
        );

        const chatMessageId = randomUUID();
        const chat = await requestResult(request, {
          path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
          token,
          method: 'POST',
          data: {
            text: `Safe content-filter conversation control ${suffix}`,
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId: NO_PARENT,
            conversationId: 'new',
            messageId: chatMessageId,
            responseMessageId: `${chatMessageId}_response`,
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            model: MOCK_ENDPOINTS[0].model,
            isTemporary: false,
            isRegenerate: false,
            error: false,
          },
        });
        conversationId = await expectAsyncStreamCompleted(request, token, chat);

        safeUserMessageId = randomUUID();
        const safe = await requestResult(request, {
          path: `/api/messages/${encodeURIComponent(conversationId!)}`,
          token,
          method: 'POST',
          data: {
            text: `Safe content-filter control ${suffix}`,
            name: markers.messages,
            sender: 'User',
            clientTimestamp: new Date().toISOString(),
            isCreatedByUser: true,
            parentMessageId: NO_PARENT,
            conversationId,
            messageId: safeUserMessageId,
            endpoint: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
            isTemporary: false,
            error: false,
          },
        });
        expectSuccess(safe, 201);
      });

      await test.step('prompts', async () => {
        const blockedGroupName = `E2E blocked prompt ${suffix}`;
        const blocked = await requestResult(request, {
          path: '/api/prompts',
          token,
          method: 'POST',
          data: {
            prompt: { prompt: markers.prompts, type: 'text' },
            group: { name: blockedGroupName },
          },
        });
        expectContentFilterBlock(blocked, {
          source: 'prompt',
          field: 'text',
          marker: markers.prompts,
        });
        await expectNoStoredDocument(
          'prompts',
          { prompt: markers.prompts },
          'Blocked prompt must not be persisted',
        );
        await expectNoStoredDocument(
          'promptgroups',
          { name: blockedGroupName },
          'Blocked prompt group must not be persisted',
        );

        const safe = await requestResult(request, {
          path: '/api/prompts',
          token,
          method: 'POST',
          data: {
            prompt: { prompt: 'A safe reusable prompt.', type: 'text' },
            group: { name: markers.prompts },
          },
        });
        expectSuccess(safe, 200);
        const safeBody = asObject(safe.body);
        const group = asObject(safeBody.group);
        const prompt = asObject(safeBody.prompt);
        promptGroupId = (group._id ?? prompt.groupId) as string | undefined;
        expect(promptGroupId).toBeTruthy();
      });

      await test.step('agent instructions', async () => {
        const blockedAgentName = `E2E content-filter agent ${suffix}-blocked-instructions`;
        const blocked = await requestResult(request, {
          path: '/api/agents',
          token,
          method: 'POST',
          data: createAgentPayload(`${suffix}-blocked-instructions`, {
            instructions: markers.agentInstructions,
          }),
        });
        expectContentFilterBlock(blocked, {
          source: 'agent_instruction',
          field: 'instructions',
          marker: markers.agentInstructions,
        });
        await expectNoStoredDocument(
          'agents',
          { name: blockedAgentName },
          'Blocked agent must not be persisted',
        );

        const blockedAssistantName = `E2E blocked assistant ${suffix}`;
        const blockedAssistant = await requestResult(request, {
          path: '/api/assistants/v1',
          token,
          method: 'POST',
          data: { name: blockedAssistantName, instructions: markers.agentInstructions },
        });
        expectContentFilterBlock(blockedAssistant, {
          source: 'agent_instruction',
          field: 'instructions',
          marker: markers.agentInstructions,
        });
        await expectNoStoredDocument(
          'assistants',
          { name: blockedAssistantName },
          'Blocked assistant must not be persisted',
        );

        const safe = await requestResult(request, {
          path: '/api/agents',
          token,
          method: 'POST',
          data: createAgentPayload(`${suffix}-safe`, {
            description: markers.agentInstructions,
          }),
        });
        expectSuccess(safe, 201);
        agentId = asObject(safe.body).id as string | undefined;
        expect(agentId).toBeTruthy();
      });

      await test.step('conversation starters', async () => {
        const blockedAgentName = `E2E content-filter agent ${suffix}-blocked-starter`;
        const blocked = await requestResult(request, {
          path: '/api/agents',
          token,
          method: 'POST',
          data: createAgentPayload(`${suffix}-blocked-starter`, {
            conversation_starters: [markers.conversationStarters],
          }),
        });
        expectContentFilterBlock(blocked, {
          source: 'conversation_starter',
          field: 'text',
          marker: markers.conversationStarters,
        });
        await expectNoStoredDocument(
          'agents',
          { name: blockedAgentName },
          'Agent with a blocked conversation starter must not be persisted',
        );

        const safe = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(agentId!)}`,
          token,
          method: 'PATCH',
          data: { conversation_starters: ['A safe conversation starter'] },
        });
        expectSuccess(safe, 200);
      });

      await test.step('conversation titles', async () => {
        const blocked = await requestResult(request, {
          path: '/api/convos/update',
          token,
          method: 'POST',
          data: { arg: { conversationId, title: markers.conversationTitles } },
        });
        expectContentFilterBlock(blocked, {
          source: 'conversation_title',
          field: 'title',
          marker: markers.conversationTitles,
        });
        await expectNoStoredDocument(
          'conversations',
          { conversationId, title: markers.conversationTitles },
          'Blocked conversation title must not be persisted',
        );

        const safe = await requestResult(request, {
          path: '/api/convos/update',
          token,
          method: 'POST',
          data: { arg: { conversationId, title: `E2E safe title ${suffix}` } },
        });
        expectSuccess(safe, 201);
      });

      await test.step('feedback', async () => {
        const path = `/api/messages/${encodeURIComponent(conversationId!)}/${encodeURIComponent(
          safeUserMessageId!,
        )}/feedback`;
        const blocked = await requestResult(request, {
          path,
          token,
          method: 'PUT',
          data: {
            feedback: { rating: 'thumbsDown', tag: 'other', text: markers.feedback },
          },
        });
        expectContentFilterBlock(blocked, {
          source: 'feedback',
          field: 'text',
          marker: markers.feedback,
        });
        await expectNoStoredDocument(
          'messages',
          { messageId: safeUserMessageId, 'feedback.text': markers.feedback },
          'Blocked feedback must not be persisted',
        );

        const safe = await requestResult(request, {
          path,
          token,
          method: 'PUT',
          data: {
            feedback: { rating: 'thumbsDown', tag: 'other', text: 'Safe feedback.' },
          },
        });
        expectSuccess(safe, 200);
      });

      await test.step('skills', async () => {
        const blockedSkillName = `e2e-blocked-skill-${suffix}`;
        const blocked = await requestResult(request, {
          path: '/api/skills',
          token,
          method: 'POST',
          data: {
            name: blockedSkillName,
            description: 'Blocked skill submission control.',
            body: markers.skills,
          },
        });
        expectContentFilterBlock(blocked, {
          source: 'skill',
          field: 'instructions',
          marker: markers.skills,
        });
        await expectNoStoredDocument(
          'skills',
          { name: blockedSkillName },
          'Blocked skill must not be persisted',
        );

        const safe = await requestResult(request, {
          path: '/api/skills',
          token,
          method: 'POST',
          data: {
            name: `e2e-safe-skill-${suffix}`,
            description: markers.skills,
            body: 'Use only safe deterministic content.',
          },
        });
        expectSuccess(safe, 201);
        skillId = asObject(safe.body)._id as string | undefined;
        expect(skillId).toBeTruthy();
      });

      await test.step('memories', async () => {
        const blockedMemoryKey = `e_to_e_blocked_memory_${memoryKeySuffix}`;
        const blocked = await requestResult(request, {
          path: '/api/memories',
          token,
          method: 'POST',
          data: {
            key: blockedMemoryKey,
            value: markers.memories,
          },
        });
        expectContentFilterBlock(blocked, {
          source: 'memory',
          field: 'value',
          marker: markers.memories,
        });
        await expectNoStoredDocument(
          'memoryentries',
          { key: blockedMemoryKey },
          'Blocked memory must not be persisted',
        );

        memoryKey = `e_to_e_safe_memory_${memoryKeySuffix}`;
        const safe = await requestResult(request, {
          path: '/api/memories',
          token,
          method: 'POST',
          data: { key: memoryKey, value: 'Safe memory value.' },
        });
        expectSuccess(safe, 201);
      });

      await test.step('files', async () => {
        const blockedFileId = randomUUID();
        const blocked = await requestResult(request, {
          path: '/api/files',
          token,
          method: 'POST',
          multipart: {
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            message_file: 'true',
            file_id: blockedFileId,
            file: {
              name: `e2e-blocked-${suffix}.txt`,
              mimeType: 'text/plain',
              buffer: Buffer.from(markers.files),
            },
          },
        });
        expectContentFilterBlock(blocked, {
          source: 'file',
          field: 'content',
          marker: markers.files,
        });
        await expectNoStoredDocument(
          'files',
          { file_id: blockedFileId },
          'Blocked file must not be persisted',
        );

        const safe = await requestResult(request, {
          path: '/api/files',
          token,
          method: 'POST',
          multipart: {
            endpoint: MOCK_ENDPOINTS[0].label,
            endpointType: 'custom',
            message_file: 'true',
            file_id: randomUUID(),
            file: {
              name: markers.files,
              mimeType: 'text/plain',
              buffer: Buffer.from('Safe file content.'),
            },
          },
        });
        expectSuccess(safe, 200);
        const safeBody = asObject(safe.body);
        if (typeof safeBody.file_id === 'string' && typeof safeBody.filepath === 'string') {
          uploadedFile = { file_id: safeBody.file_id, filepath: safeBody.filepath };
        }
        expect(uploadedFile).toBeTruthy();
      });

      await test.step('tool arguments', async () => {
        const messagePath = `/api/messages/${encodeURIComponent(conversationId!)}`;
        const blockedToolMessageId = randomUUID();
        const blocked = await requestResult(request, {
          path: messagePath,
          token,
          method: 'POST',
          data: {
            messageId: blockedToolMessageId,
            parentMessageId: safeUserMessageId,
            sender: 'User',
            endpoint: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
            isCreatedByUser: true,
            content: [
              {
                type: 'tool_call',
                tool_call: {
                  id: `call_blocked_${suffix}`,
                  name: 'safe_lookup',
                  args: markers.toolArguments,
                },
              },
            ],
          },
        });
        expectContentFilterBlock(blocked, {
          source: 'tool_argument',
          field: 'arguments',
          marker: markers.toolArguments,
        });
        await expectNoStoredDocument(
          'messages',
          { messageId: blockedToolMessageId },
          'Message with blocked tool arguments must not be persisted',
        );

        const safe = await requestResult(request, {
          path: messagePath,
          token,
          method: 'POST',
          data: {
            messageId: randomUUID(),
            parentMessageId: safeUserMessageId,
            sender: 'User',
            endpoint: MOCK_ENDPOINTS[0].label,
            model: MOCK_ENDPOINTS[0].model,
            isCreatedByUser: true,
            content: [
              {
                type: 'tool_call',
                tool_call: {
                  id: `call_safe_${suffix}`,
                  name: 'safe_lookup',
                  args: '{"query":"safe"}',
                },
              },
            ],
          },
        });
        expectSuccess(safe, 201);
      });

      await test.step('model parameters', async () => {
        const blockedAgentName = `E2E content-filter agent ${suffix}-blocked-model-parameters`;
        const blocked = await requestResult(request, {
          path: '/api/agents',
          token,
          method: 'POST',
          data: createAgentPayload(`${suffix}-blocked-model-parameters`, {
            model_parameters: { stop: [markers.modelParameters] },
          }),
        });
        expectContentFilterBlock(blocked, {
          source: 'model_parameter',
          field: 'stop',
          marker: markers.modelParameters,
        });
        await expectNoStoredDocument(
          'agents',
          { name: blockedAgentName },
          'Agent with blocked model parameters must not be persisted',
        );

        const safe = await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(agentId!)}`,
          token,
          method: 'PATCH',
          data: { model_parameters: { stop: ['SAFE-STOP-SEQUENCE'] } },
        });
        expectSuccess(safe, 200);
      });

      await test.step('action metadata', async () => {
        const actionPayload = (privacyPolicyUrl: string) => ({
          functions: [
            {
              type: 'function',
              function: {
                name: `safe_lookup_${suffix.replace(/-/g, '_')}`,
                description: 'Return a safe deterministic lookup result.',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          metadata: {
            domain: 'https://example.com',
            privacy_policy_url: privacyPolicyUrl,
          },
        });

        const blocked = await requestResult(request, {
          path: `/api/agents/actions/${encodeURIComponent(agentId!)}`,
          token,
          method: 'POST',
          data: actionPayload(markers.actionMetadata),
        });
        expectContentFilterBlock(blocked, {
          source: 'action_metadata',
          field: 'privacy_policy_url',
          marker: markers.actionMetadata,
        });
        await expectNoStoredDocument(
          'actions',
          { agent_id: agentId, 'metadata.privacy_policy_url': markers.actionMetadata },
          'Action with blocked metadata must not be persisted',
        );

        const safe = await requestResult(request, {
          path: `/api/agents/actions/${encodeURIComponent(agentId!)}`,
          token,
          method: 'POST',
          data: actionPayload('https://example.com/privacy'),
        });
        expectSuccess(safe, 200);
        const responseItems = Array.isArray(safe.body) ? safe.body : [];
        actionId = asObject(responseItems[1]).action_id as string | undefined;
        expect(actionId).toBeTruthy();
      });
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        if (actionId && agentId) {
          await requestResult(request, {
            path: `/api/agents/actions/${encodeURIComponent(agentId)}/${encodeURIComponent(actionId)}`,
            token,
            method: 'DELETE',
          });
        }
        if (uploadedFile) {
          await requestResult(request, {
            path: '/api/files',
            token,
            method: 'DELETE',
            data: { files: [uploadedFile] },
          });
        }
        if (memoryKey) {
          await requestResult(request, {
            path: `/api/memories/${encodeURIComponent(memoryKey)}`,
            token,
            method: 'DELETE',
          });
        }
        if (skillId) {
          await requestResult(request, {
            path: `/api/skills/${encodeURIComponent(skillId)}`,
            token,
            method: 'DELETE',
          });
        }
        if (agentId) {
          await requestResult(request, {
            path: `/api/agents/${encodeURIComponent(agentId)}`,
            token,
            method: 'DELETE',
          });
        }
        if (promptGroupId) {
          await requestResult(request, {
            path: `/api/prompts/groups/${encodeURIComponent(promptGroupId)}`,
            token,
            method: 'DELETE',
          });
        }
        if (conversationId) {
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

  test('honors omitted and explicit message filter selector defaults', async ({ request }) => {
    test.setTimeout(120000);

    const token = await loginAdmin(request);
    const marker = `E2E-CF-CONFIG-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const bearerValue = 'Authorization: Bearer e2e-config-contract-token';
    const nonmatchingCustomPatterns = [
      {
        id: `e2e-config-nonmatching-${Date.now()}`,
        label: 'E2E nonmatching config detector',
        regex: '^E2E-CF-NEVER-MATCH$',
      },
    ];
    let filtersAttempted = false;
    let filtersActive = false;
    let conversationId: string | undefined;

    const applyFilters = async (filters: FiltersConfig): Promise<void> => {
      filtersAttempted = true;
      await setRuntimeFilters(request, token, filters);
      filtersActive = true;
    };

    const submitMessage = async (text: string, name?: string) => {
      const messageId = randomUUID();
      const result = await requestResult(request, {
        path: `/api/agents/chat/${encodeURIComponent(MOCK_ENDPOINTS[0].label)}`,
        token,
        method: 'POST',
        data: {
          text,
          ...(name ? { name } : {}),
          sender: 'User',
          clientTimestamp: new Date().toISOString(),
          isCreatedByUser: true,
          parentMessageId: NO_PARENT,
          conversationId: 'new',
          messageId,
          responseMessageId: `${messageId}_response`,
          endpoint: MOCK_ENDPOINTS[0].label,
          endpointType: 'custom',
          model: MOCK_ENDPOINTS[0].model,
          isTemporary: false,
          isRegenerate: false,
          error: false,
        },
      });
      return { messageId, result };
    };

    try {
      await applyFilters({
        messages: {
          pii: {
            starterPatterns: [],
            customPatterns: [
              {
                id: `e2e-config-fields-${Date.now()}`,
                label: 'E2E config field selector',
                regex: `^${marker}$`,
              },
            ],
          },
        },
      });
      const omittedFields = await submitMessage('Safe field-selector control.', marker);
      expectContentFilterBlock(omittedFields.result, {
        source: 'message',
        field: 'name',
        marker,
      });
      await expectNoStoredDocument(
        'messages',
        { messageId: omittedFields.messageId },
        'Message blocked by the default field selection must not be persisted',
      );

      await applyFilters({
        messages: { pii: { fields: ['text'], customPatterns: nonmatchingCustomPatterns } },
      });
      const omittedStarters = await submitMessage(bearerValue);
      expectContentFilterBlock(omittedStarters.result, {
        source: 'message',
        field: 'text',
        marker: bearerValue,
      });
      await expectNoStoredDocument(
        'messages',
        { messageId: omittedStarters.messageId },
        'Message blocked by default starter patterns must not be persisted',
      );

      await applyFilters({
        messages: {
          pii: {
            fields: ['text'],
            starterPatterns: [],
            customPatterns: nonmatchingCustomPatterns,
          },
        },
      });
      const explicitEmptyStarters = await submitMessage(bearerValue);
      conversationId = await expectAsyncStreamCompleted(
        request,
        token,
        explicitEmptyStarters.result,
      );
    } finally {
      try {
        if (filtersAttempted || filtersActive) {
          await restoreRuntimeFilters(request, token);
          filtersActive = false;
        }
      } finally {
        if (conversationId) {
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
});
