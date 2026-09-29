import type {
  AssertResumeRuntimeContentAllowedInput,
  ResumeContentProtectionDependencies,
  ResumeRuntimeContentProtectionDependencies,
} from './protection';
import {
  assertAgentAttachmentLimits,
  AgentAttachmentLimitError,
  isModelBoundAttachmentFile,
} from '../attachments';
import { assertResumeContentAllowed, assertResumeRuntimeContentAllowed } from './protection';

const user = {
  id: 'user-1',
  role: 'USER',
  email: 'user@example.com',
  emailVerified: true,
  provider: 'local',
} as AssertResumeRuntimeContentAllowedInput['user'];

function createDependencies(): ResumeRuntimeContentProtectionDependencies & {
  getAgentCheckpointer: jest.Mock;
  getMessages: jest.Mock;
  getFiles: jest.Mock;
} {
  return {
    getAgentCheckpointer: jest.fn(),
    getMessages: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([]),
  };
}

function createInput(appConfig: unknown): AssertResumeRuntimeContentAllowedInput {
  return {
    appConfig: appConfig as AssertResumeRuntimeContentAllowedInput['appConfig'],
    conversationId: 'conversation-1',
    targetMessageId: null,
    user,
    storedMessages: [],
    seedContent: [],
    liveFiles: [],
    isTemporary: true,
    agents: [],
    files: [],
  };
}

describe('assertResumeRuntimeContentAllowed', () => {
  it('reports locator failures from restored HITL content through its dependencies', async () => {
    const onTraversalFailure = jest.fn();
    const dependencies = { ...createDependencies(), onTraversalFailure };
    dependencies.getFiles.mockResolvedValue([{ file_id: 'owned', filename: 'safe.txt' }]);
    const input = createInput({
      filters: { files: { pii: { fields: ['name'], starterPatterns: ['sk_prefix'] } } },
    });
    await expect(
      assertResumeRuntimeContentAllowed(
        {
          ...input,
          storedMessages: [
            {
              messageId: 'source-message',
              isCreatedByUser: true,
              role: 'user',
              files: [{ file_id: 'owned' }],
              content: Array.from({ length: 4200 }, () => ({ type: 'text', text: 'safe' })),
            },
          ],
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(onTraversalFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'omit_resolved_file_locators',
        reason: 'array_length',
        messageCount: 1,
        resolvedFileCount: 1,
      }),
    );
  });

  it.each([
    { filters: { prompts: { pii: {} } } },
    {
      filters: {
        messages: {
          pii: { starterPatterns: [] },
          unattributedAssistantContent: 'inspect' as const,
        },
      },
    },
  ])(
    'reads only checkpoint state for unrelated or inert temporary policy %#',
    async (appConfig) => {
      const dependencies = createDependencies();

      await expect(
        assertResumeRuntimeContentAllowed(createInput(appConfig), dependencies),
      ).resolves.toEqual({ resolvedFiles: [], checkpointFiles: [] });
      expect(dependencies.getAgentCheckpointer).toHaveBeenCalledTimes(1);
      expect(dependencies.getMessages).not.toHaveBeenCalled();
      expect(dependencies.getFiles).not.toHaveBeenCalled();
    },
  );

  it('charges retained fallback text after settings change, using owner-hydrated records', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'human', additional_kwargs: { sourceMessageId: 'source-message' } }],
          },
        },
      }),
    });
    dependencies.getMessages.mockResolvedValue([
      { messageId: 'source-message', files: [{ file_id: 'fallback-file' }] },
    ]);
    const storedFile = {
      file_id: 'fallback-file',
      filename: 'sales.csv',
      type: 'text/csv',
      source: 'local',
      bytes: 20,
      text: 'region,total',
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false },
    };
    dependencies.getFiles.mockResolvedValue([storedFile]);
    const input = {
      ...createInput({ fileConfig: { textFallbackWithoutTools: false } }),
      isTemporary: false,
    };
    const projection = await assertResumeRuntimeContentAllowed(input, dependencies);
    expect(projection.checkpointFiles).toEqual([{ ...storedFile, llmDeliveryPath: 'text' }]);
    expect(storedFile.llmDeliveryPath).toBe('none');
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: projection.checkpointFiles.filter(isModelBoundAttachmentFile),
        fileConfig: { fileContextCharLimit: 3 },
        endpoint: 'openAI',
      }),
    ).toThrow(AgentAttachmentLimitError);
    expect(dependencies.getFiles).toHaveBeenCalledTimes(1);
  });

  it('hydrates checkpoint-bound files when content filters are inactive', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'human',
                additional_kwargs: { sourceMessageId: 'source-message' },
              },
            ],
          },
        },
      }),
    });
    dependencies.getMessages.mockResolvedValue([
      {
        messageId: 'source-message',
        files: [{ file_id: 'historical-file' }],
        attachments: [{ file_id: 'display-only-file' }],
      },
      {
        messageId: 'pre-summary-message',
        files: [{ file_id: 'pre-summary-file' }],
      },
    ]);
    dependencies.getFiles.mockResolvedValue([
      {
        file_id: 'historical-file',
        filename: 'history.txt',
        source: 'text',
        type: 'text/plain',
        text: 'historical context',
      },
    ]);
    const input = { ...createInput({}), isTemporary: false };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).resolves.toEqual({
      resolvedFiles: [],
      checkpointFiles: [expect.objectContaining({ file_id: 'historical-file' })],
    });
    expect(dependencies.getMessages).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      user: 'user-1',
    });
    expect(dependencies.getFiles).toHaveBeenCalledWith(
      { file_id: { $in: ['historical-file'] }, user: 'user-1' },
      {},
      {},
    );
  });

  it('reuses supplied checkpoint source rows when content filters are inactive', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'human',
                additional_kwargs: { sourceMessageId: 'source-message' },
              },
            ],
          },
        },
      }),
    });
    const resolvedFile = {
      file_id: 'historical-file',
      filename: 'history.txt',
      source: 'text',
      type: 'text/plain',
      text: 'historical context',
    };
    dependencies.getFiles.mockResolvedValue([resolvedFile]);
    const input = {
      ...createInput({}),
      isTemporary: false,
      storedMessages: [
        {
          messageId: 'source-message',
          files: [{ file_id: 'historical-file' }],
        },
      ],
    };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).resolves.toEqual({
      resolvedFiles: [],
      checkpointFiles: [resolvedFile],
    });
    expect(dependencies.getMessages).not.toHaveBeenCalled();
    expect(dependencies.getFiles).toHaveBeenCalledTimes(1);
  });

  it('hydrates files from every checkpoint source in plural lineage', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'human',
                additional_kwargs: { sourceMessageIds: ['source-one', 'source-two'] },
              },
            ],
          },
        },
      }),
    });
    const resolvedFiles = [
      { file_id: 'file-one', filename: 'one.txt', source: 'text', type: 'text/plain' },
      { file_id: 'file-two', filename: 'two.txt', source: 'text', type: 'text/plain' },
    ];
    dependencies.getFiles.mockResolvedValue(resolvedFiles);
    const input = {
      ...createInput({}),
      isTemporary: false,
      storedMessages: [
        { messageId: 'source-one', files: [{ file_id: 'file-one' }] },
        { messageId: 'source-two', files: [{ file_id: 'file-two' }] },
      ],
    };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).resolves.toEqual({
      resolvedFiles: [],
      checkpointFiles: resolvedFiles,
    });
    expect(dependencies.getMessages).not.toHaveBeenCalled();
    expect(dependencies.getFiles).toHaveBeenCalledWith(
      { file_id: { $in: ['file-one', 'file-two'] }, user: 'user-1' },
      {},
      {},
    );
  });

  it('hydrates files from user and tool checkpoint provenance lineage', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'human',
                additional_kwargs: {
                  provenance: {
                    parts: [
                      { attribution: 'user', sourceMessageId: 'source-user' },
                      { attribution: 'tool', sourceMessageId: 'source-tool' },
                      { attribution: 'synthetic', sourceMessageId: 'source-synthetic' },
                    ],
                  },
                },
              },
            ],
          },
        },
      }),
    });
    const resolvedFiles = [
      { file_id: 'file-user', filename: 'user.txt', source: 'text', type: 'text/plain' },
      { file_id: 'file-tool', filename: 'tool.txt', source: 'text', type: 'text/plain' },
    ];
    dependencies.getFiles.mockResolvedValue(resolvedFiles);
    const input = {
      ...createInput({}),
      storedMessages: [
        { messageId: 'source-user', files: [{ file_id: 'file-user' }] },
        { messageId: 'source-tool', files: [{ file_id: 'file-tool' }] },
      ],
    };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).resolves.toEqual({
      resolvedFiles: [],
      checkpointFiles: resolvedFiles,
    });
  });

  it('rejects a checkpoint source message that can no longer be loaded', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'human',
                additional_kwargs: { sourceMessageId: 'deleted-source' },
              },
            ],
          },
        },
      }),
    });
    dependencies.getMessages.mockResolvedValue([]);

    await expect(assertResumeRuntimeContentAllowed(createInput({}), dependencies)).rejects.toThrow(
      'checkpoint source message is no longer available',
    );
  });

  it('preserves repeated steer file injections in checkpoint projection', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'steer', files: [{ file_id: 'repeated-file' }] },
                  { type: 'steer', files: [{ file_id: 'repeated-file' }] },
                ],
              },
            ],
          },
        },
      }),
    });
    const resolvedFile = {
      file_id: 'repeated-file',
      filename: 'repeat.txt',
      source: 'text',
      type: 'text/plain',
      text: 'repeated context',
    };
    dependencies.getFiles.mockResolvedValue([resolvedFile]);

    await expect(assertResumeRuntimeContentAllowed(createInput({}), dependencies)).resolves.toEqual(
      {
        resolvedFiles: [],
        checkpointFiles: [resolvedFile, resolvedFile],
      },
    );
  });

  it('rejects a checkpoint file reference that can no longer be hydrated', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'human', files: [{ file_id: 'deleted-file' }] }],
          },
        },
      }),
    });

    await expect(
      assertResumeRuntimeContentAllowed(createInput({}), dependencies),
    ).rejects.toMatchObject({
      name: 'AttachmentObjectNotFoundError',
      fileId: 'deleted-file',
    });
  });

  it('checks initialized agent content without loading checkpoint history', async () => {
    const dependencies = createDependencies();
    const input = {
      ...createInput({
        filters: {
          agentInstructions: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
      }),
      agents: [{ instructions: 'Runtime PRIVATE-INSTRUCTION' }],
    };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'agent_instruction', field: 'instructions' },
    });
    expect(dependencies.getAgentCheckpointer).not.toHaveBeenCalled();
  });

  it('rechecks checkpoint user content for an active message policy', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'human', content: 'Checkpoint PRIVATE-MESSAGE' }],
          },
        },
      }),
    });
    const input = createInput({
      filters: {
        messages: {
          pii: {
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      },
    });

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message' },
    });
    expect(dependencies.getAgentCheckpointer).toHaveBeenCalledTimes(1);
    expect(dependencies.getMessages).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      user: 'user-1',
    });
  });

  it('does not apply messages policy to checkpoint or seed assistant output', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'assistant', content: 'Checkpoint PRIVATE-ASSISTANT' }],
          },
        },
      }),
    });
    const input = {
      ...createInput({
        filters: {
          messages: {
            pii: {
              fields: ['content_part'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
      }),
      seedContent: [{ type: 'text', text: 'Seed PRIVATE-ASSISTANT' }],
    };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).resolves.toEqual({
      resolvedFiles: [],
      checkpointFiles: [],
    });
  });

  it('returns owner-hydrated resume files for the frozen model callback', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue(null),
    });
    const resolvedFile = {
      file_id: 'resume-file',
      filename: 'resume.txt',
      type: 'text/plain',
      text: 'Safe resume file content',
    };
    dependencies.getFiles.mockResolvedValue([resolvedFile]);
    const input = {
      ...createInput({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              uninspectable: 'block' as const,
            },
          },
        },
      }),
      storedMessages: [
        {
          messageId: 'resume-message',
          role: 'user',
          isCreatedByUser: true,
          text: 'Use the resume file',
          files: [{ file_id: 'resume-file' }],
        },
      ],
    };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).resolves.toEqual({
      resolvedFiles: [resolvedFile],
      checkpointFiles: [],
    });
  });

  it('reuses active-policy message and file hydration for checkpoint projection', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'human',
                additional_kwargs: { sourceMessageId: 'source-message' },
              },
            ],
          },
        },
      }),
    });
    const resolvedFile = {
      file_id: 'historical-file',
      filename: 'history.txt',
      type: 'text/plain',
      text: 'Safe historical context',
    };
    dependencies.getMessages.mockResolvedValue([
      {
        messageId: 'source-message',
        role: 'user',
        isCreatedByUser: true,
        text: 'Use the historical file',
        files: [{ file_id: 'historical-file' }],
      },
    ]);
    dependencies.getFiles.mockResolvedValue([resolvedFile]);
    const input = {
      ...createInput({
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              starterPatterns: [],
              uninspectable: 'block' as const,
            },
          },
        },
      }),
      targetMessageId: 'source-message',
      isTemporary: false,
    };

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).resolves.toEqual({
      resolvedFiles: [resolvedFile],
      checkpointFiles: [resolvedFile],
    });
    expect(dependencies.getMessages).toHaveBeenCalledTimes(1);
    expect(dependencies.getFiles).toHaveBeenCalledTimes(1);
  });

  it('retains toolArguments coverage for checkpoint assistant tool calls', async () => {
    const dependencies = createDependencies();
    dependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'assistant',
                tool_calls: [{ name: 'lookup', args: 'PRIVATE-ARGUMENT' }],
              },
            ],
          },
        },
      }),
    });
    const input = createInput({
      filters: {
        toolArguments: {
          pii: {
            fields: ['arguments'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-ARGUMENT' }],
          },
        },
      },
    });

    await expect(assertResumeRuntimeContentAllowed(input, dependencies)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'tool_argument', field: 'arguments' },
    });
  });

  it('applies live ask answers only to the exact answer message field', async () => {
    const pattern = [{ id: 'private', label: 'private', regex: 'PRIVATE-ANSWER' }];
    const contentPartDependencies = createDependencies();
    contentPartDependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue(null),
    });
    const contentPartInput: AssertResumeRuntimeContentAllowedInput = {
      ...createInput({
        filters: {
          messages: {
            pii: { fields: ['content_part'], starterPatterns: [], customPatterns: pattern },
          },
        },
      }),
      resumeValue: { answer: 'PRIVATE-ANSWER' },
    };

    await expect(
      assertResumeRuntimeContentAllowed(contentPartInput, contentPartDependencies),
    ).resolves.toEqual({ resolvedFiles: [], checkpointFiles: [] });

    const answerDependencies = createDependencies();
    answerDependencies.getAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue(null),
    });
    const answerInput: AssertResumeRuntimeContentAllowedInput = {
      ...contentPartInput,
      appConfig: createInput({
        filters: {
          messages: {
            pii: { fields: ['answer'], starterPatterns: [], customPatterns: pattern },
          },
        },
      }).appConfig,
    };

    await expect(
      assertResumeRuntimeContentAllowed(answerInput, answerDependencies),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'answer' },
    });
  });

  it('does not load inactive action or memory siblings of an active agent policy', async () => {
    const dependencies: ResumeContentProtectionDependencies = {
      ...createDependencies(),
      checkAccess: jest.fn(),
      getAgent: jest.fn(),
      getActions: jest.fn().mockRejectedValue(new Error('inactive action policy was loaded')),
      getUserMemories: jest.fn().mockRejectedValue(new Error('inactive memory policy was loaded')),
      getRoleByName: jest.fn(),
      decryptMetadata: jest.fn().mockRejectedValue(new Error('inactive metadata was decrypted')),
      canAccessAgent: jest.fn().mockResolvedValue(true),
    };
    const input = {
      appConfig: {
        filters: {
          agentInstructions: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
          actionMetadata: { pii: { starterPatterns: [] } },
          toolArguments: { pii: { starterPatterns: [] } },
          memories: { pii: { starterPatterns: [] } },
        },
      },
      endpointOption: {
        agent: Promise.resolve({
          id: 'agent-1',
          provider: 'openai',
          model: 'test-model',
          instructions: 'Safe instructions',
          tools: ['lookup_action_example'],
        }),
      },
      conversationId: 'conversation-1',
      targetMessageId: null,
      user,
      storedMessages: [],
      seedContent: [],
      liveFiles: [],
      isTemporary: true,
    } as unknown as Parameters<typeof assertResumeContentAllowed>[0];

    await expect(assertResumeContentAllowed(input, dependencies)).resolves.toBeUndefined();
    expect(dependencies.getActions).not.toHaveBeenCalled();
    expect(dependencies.getUserMemories).not.toHaveBeenCalled();
    expect(dependencies.decryptMetadata).not.toHaveBeenCalled();
  });
});
