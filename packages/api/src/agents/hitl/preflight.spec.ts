import { FileSources, type Agents } from 'librechat-data-provider';
import type { ResumeContentProtectionDependencies } from './protection';
import type { PreflightResumeContentInput } from './preflight';
import { getResumeProvenance, preflightResumeContent } from './preflight';

const user = {
  id: 'user-1',
  role: 'USER',
  email: 'user@example.com',
  emailVerified: true,
  provider: 'local',
} as PreflightResumeContentInput['user'];

function createDependencies(): ResumeContentProtectionDependencies {
  return {
    getAgentCheckpointer: jest.fn().mockResolvedValue(undefined),
    checkAccess: jest.fn(),
    getMessages: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([]),
    getAgent: jest.fn().mockResolvedValue(null),
    getActions: jest.fn().mockResolvedValue([]),
    getUserMemories: jest.fn().mockResolvedValue([]),
    getRoleByName: jest.fn(),
    decryptMetadata: jest.fn(),
    canAccessAgent: jest.fn().mockResolvedValue(true),
  };
}

function createAskPendingAction(toolCallId = 'ask-2'): Agents.PendingAction {
  return {
    actionId: 'action-1',
    streamId: 'conversation-1',
    conversationId: 'conversation-1',
    createdAt: 1,
    payload: {
      type: 'ask_user_question',
      question: { question: 'Which environment?' },
      tool_call_id: toolCallId,
    },
  };
}

function createInput(
  overrides: Partial<PreflightResumeContentInput> = {},
): PreflightResumeContentInput {
  return {
    appConfig: undefined,
    endpointOption: undefined,
    conversationId: 'conversation-1',
    user,
    jobMetadata: {
      responseMessageId: 'assistant-1',
      userMessage: {
        messageId: 'user-message-1',
        parentMessageId: 'parent-1',
        text: 'Please continue',
      },
    },
    pendingAction: createAskPendingAction(),
    body: { answer: 'staging' },
    resumeValue: { answer: 'staging' },
    resumeState: {
      runSteps: [],
      aggregatedContent: [
        {
          type: 'tool_call',
          tool_call: { type: 'tool_call', id: 'ask-1', name: 'ask_user_question', args: '' },
        },
        {
          type: 'tool_call',
          tool_call: { type: 'tool_call', id: 'ask-2', name: 'ask_user_question', args: '' },
        },
      ],
    },
    liveFiles: [],
    isTemporary: false,
    checkpointNamespace: 'generation-1',
    resolvedAddedAgent: undefined,
    ...overrides,
  };
}

describe('preflightResumeContent', () => {
  it('stamps and attributes an ask answer to the exact tool call', async () => {
    const input = createInput();
    const originalContent = input.resumeState?.aggregatedContent;

    const result = await preflightResumeContent(input, createDependencies());

    expect(result.seedContent).toEqual([
      {
        type: 'tool_call',
        tool_call: { type: 'tool_call', id: 'ask-1', name: 'ask_user_question', args: '' },
      },
      {
        type: 'tool_call',
        tool_call: {
          type: 'tool_call',
          id: 'ask-2',
          name: 'ask_user_question',
          args: JSON.stringify({ question: 'Which environment?' }),
          output: 'staging',
          progress: 1,
        },
      },
    ]);
    expect(originalContent?.[1]).toEqual({
      type: 'tool_call',
      tool_call: { type: 'tool_call', id: 'ask-2', name: 'ask_user_question', args: '' },
    });
    expect(result.userSubmittedMessageFieldPaths).toEqual([
      { path: '/content/1/tool_call/output', field: 'answer' },
    ]);
    expect(result.storedMessages).toEqual([
      expect.objectContaining({ messageId: 'user-message-1', isCreatedByUser: true, role: 'user' }),
      expect.objectContaining({
        messageId: 'assistant-1',
        parentMessageId: 'user-message-1',
        isCreatedByUser: false,
        role: 'assistant',
        content: result.seedContent,
        userSubmittedMessageFieldPaths: result.userSubmittedMessageFieldPaths,
      }),
    ]);
  });

  it('falls back to the newest unanswered ask when the interrupt has no tool-call id', async () => {
    const pendingAction: Agents.PendingAction = {
      actionId: 'action-legacy',
      streamId: 'conversation-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Which environment?' },
      },
    };
    const result = await preflightResumeContent(
      createInput({
        pendingAction,
        body: { answer: 'production' },
        resumeValue: { answer: 'production' },
        resumeState: {
          runSteps: [],
          aggregatedContent: [
            {
              type: 'tool_call',
              tool_call: {
                type: 'tool_call',
                id: 'ask-1',
                name: 'ask_user_question',
                args: '{}',
                output: 'staging',
              },
            },
            {
              type: 'tool_call',
              tool_call: {
                type: 'tool_call',
                id: 'ask-2',
                name: 'ask_user_question',
                args: '',
              },
            },
          ],
        },
      }),
      createDependencies(),
    );

    expect(result.seedContent[0]?.tool_call?.output).toBe('staging');
    expect(result.seedContent[1]?.tool_call?.output).toBe('production');
    expect(result.userSubmittedMessageFieldPaths).toEqual([
      { path: '/content/1/tool_call/output', field: 'answer' },
    ]);
  });

  it('does not attribute an ID-less current answer to an older unanswered ask', () => {
    const pendingAction: Agents.PendingAction = {
      actionId: 'action-legacy',
      streamId: 'conversation-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Which environment?' },
      },
    };
    const content = [
      {
        type: 'tool_call',
        tool_call: {
          id: 'ask-1',
          name: 'ask_user_question',
          args: JSON.stringify({ question: 'Earlier question?' }),
          output: '',
        },
      },
      {
        type: 'tool_call',
        tool_call: {
          id: 'ask-2',
          name: 'ask_user_question',
          args: JSON.stringify({ question: 'Which environment?' }),
          output: 'production',
        },
      },
    ];

    expect(
      getResumeProvenance({
        content,
        pendingAction,
        body: { answer: 'production' },
      }).userSubmittedMessageFieldPaths,
    ).toEqual([{ path: '/content/1/tool_call/output', field: 'answer' }]);
  });

  it('deduplicates accumulated edit, response, reject, and steer provenance', () => {
    const content = [
      { type: 'tool_call', tool_call: { id: 'edit-1', name: 'edit_tool', args: '{}' } },
      { type: 'tool_call', tool_call: { id: 'respond-1', name: 'respond_tool', args: '{}' } },
      { type: 'tool_call', tool_call: { id: 'reject-1', name: 'reject_tool', args: '{}' } },
      { type: 'steer', text: 'Please change course' },
    ];
    const pendingAction: Agents.PendingAction = {
      actionId: 'action-2',
      streamId: 'conversation-1',
      createdAt: 2,
      payload: {
        type: 'tool_approval',
        action_requests: [],
        review_configs: [],
      },
    };

    expect(
      getResumeProvenance({
        content,
        pendingAction,
        body: {
          decisions: [
            { tool_call_id: 'edit-1', decision: 'edit', editedArguments: { query: 'new' } },
            { tool_call_id: 'respond-1', decision: 'respond', responseText: 'response' },
            { tool_call_id: 'reject-1', decision: 'reject', reason: 'reason' },
          ],
        },
        existingPaths: ['/content/0/tool_call/args'],
        existingMessageFieldPaths: [
          { path: '/content/1/tool_call/output', field: 'decision_response' },
        ],
      }),
    ).toEqual({
      userSubmittedPaths: ['/content/0/tool_call/args', '/content/3'],
      userSubmittedMessageFieldPaths: [
        { path: '/content/1/tool_call/output', field: 'decision_response' },
        { path: '/content/2/tool_call/output', field: 'decision_reason' },
      ],
    });
  });

  it('does not synthesize stored messages when paused user metadata is unavailable', async () => {
    const result = await preflightResumeContent(
      createInput({ jobMetadata: { responseMessageId: 'assistant-1' } }),
      createDependencies(),
    );

    expect(result.storedMessages).toEqual([]);
  });

  it('rejects a protected ask answer before returning prepared content', async () => {
    const pattern = [{ id: 'private', label: 'private', regex: 'PRIVATE-ANSWER' }];
    const input = createInput({
      appConfig: {
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'webp',
        filters: {
          messages: {
            pii: { fields: ['answer'], starterPatterns: [], customPatterns: pattern },
          },
        },
      },
      body: { answer: 'PRIVATE-ANSWER' },
      resumeValue: { answer: 'PRIVATE-ANSWER' },
      isTemporary: true,
    });

    await expect(preflightResumeContent(input, createDependencies())).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'answer' },
    });
  });

  it('inspects user-attributed seed content when a legacy job has no response id', async () => {
    const pattern = [{ id: 'private', label: 'private', regex: 'PRIVATE-SEED' }];
    const input = createInput({
      appConfig: {
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'webp',
        filters: {
          messages: {
            pii: { fields: ['content_part'], starterPatterns: [], customPatterns: pattern },
          },
        },
      },
      jobMetadata: {
        userMessage: {
          messageId: 'user-message-1',
          parentMessageId: 'parent-1',
          text: 'Please continue',
        },
        userSubmittedPaths: ['/content/0'],
      },
      pendingAction: {
        actionId: 'action-legacy',
        streamId: 'conversation-1',
        createdAt: 1,
        payload: { type: 'tool_approval', action_requests: [], review_configs: [] },
      },
      body: { decisions: [] },
      resumeValue: undefined,
      resumeState: {
        runSteps: [],
        aggregatedContent: [{ type: 'text', text: 'PRIVATE-SEED' }],
      },
      isTemporary: true,
    });

    await expect(preflightResumeContent(input, createDependencies())).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'content_part' },
    });
  });
});
