import type { FiltersConfig } from 'librechat-data-provider';
import type { AssistantContentInput } from '../protection/adapters/submissions';
import {
  loadThreadUserMessages,
  preflightAssistantRunContent,
  preflightAssistantUserMessageContent,
} from './protection';

interface ThreadMessage {
  id?: string;
  role?: string;
  name?: string;
  content?: Array<{
    type?: string;
    text?: string | { value?: string };
    image_file?: { file_id?: string };
  }>;
  file_ids?: string[];
}

interface ThreadPage {
  data?: ThreadMessage[];
  last_id?: string;
  has_more?: boolean;
  hasNextPage?: () => boolean;
  getNextPage?: () => Promise<ThreadPage | null | undefined>;
}

function createOpenAI({
  assistant,
  firstPage,
}: {
  assistant?: AssistantContentInput | null;
  firstPage?: ThreadPage | null;
}) {
  const retrieve = jest.fn().mockResolvedValue(assistant);
  const list = jest.fn().mockResolvedValue(firstPage);
  return {
    openai: {
      beta: {
        assistants: { retrieve },
        threads: { messages: { list } },
      },
    },
    retrieve,
    list,
  };
}

describe('Assistants model-bound content preflight', () => {
  it('reports incomplete user-file hydration through the supplied reporter', async () => {
    const onTraversalFailure = jest.fn();
    await preflightAssistantUserMessageContent({
      config: { filters: { files: { pii: { fields: ['name'], starterPatterns: ['sk_prefix'] } } } },
      user: { id: 'user-1' },
      message: {
        file_ids: ['owned'],
        metadata: {
          trace: Array.from({ length: 4200 }, () => ({ text: 'safe' })),
        },
      },
      getFiles: jest.fn().mockResolvedValue([{ file_id: 'owned', filename: 'safe.txt' }]),
      onTraversalFailure,
    });
    expect(onTraversalFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'omit_resolved_file_locators',
        reason: 'array_length',
        messageCount: 1,
        resolvedFileCount: 1,
      }),
    );
  });

  let getFiles: jest.Mock;

  beforeEach(() => {
    getFiles = jest.fn().mockResolvedValue([]);
  });

  it('inspects long remote thread history with one owner-file lookup', async () => {
    const { openai } = createOpenAI({
      assistant: {},
      firstPage: {
        data: Array.from({ length: 58 }, (_, index) => ({
          id: `history-${index}`,
          role: 'user',
          content: Array.from({ length: 80 }, () => ({
            type: 'text',
            text: { value: 'safe history' },
          })),
          file_ids: index === 57 ? ['owned-file'] : [],
        })),
        has_more: false,
      },
    });
    getFiles.mockResolvedValue([{ file_id: 'owned-file', text: 'safe extraction' }]);
    await expect(
      preflightAssistantRunContent({
        config: {
          messageFilter: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-LEGACY' }],
            },
          },
          filters: {
            files: {
              pii: { fields: ['extracted_text'], starterPatterns: [], uninspectable: 'block' },
            },
          },
        },
        openai,
        user: { id: 'owner' },
        assistantId: 'assistant',
        threadId: 'thread',
        getFiles,
      }),
    ).resolves.toEqual({});
    expect(getFiles).toHaveBeenCalledTimes(1);
  });

  it('does not perform remote reads when no applicable policy is configured', async () => {
    const { openai, retrieve, list } = createOpenAI({});

    await expect(
      preflightAssistantRunContent({
        config: {},
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        threadId: 'thread-1',
        getFiles,
      }),
    ).resolves.toBeUndefined();

    expect(retrieve).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('does not perform reads for explicitly empty pattern selections', async () => {
    const { openai, retrieve, list } = createOpenAI({});

    await expect(
      preflightAssistantRunContent({
        config: {
          messageFilter: {
            pii: {
              starterPatterns: [],
              customPatterns: [],
            },
          },
          filters: {
            messages: {
              pii: {
                starterPatterns: [],
                customPatterns: [],
              },
            },
            agentInstructions: {
              pii: {
                starterPatterns: [],
                customPatterns: [],
              },
            },
            files: {
              pii: {
                starterPatterns: [],
                customPatterns: [],
              },
            },
            toolArguments: {
              pii: {
                starterPatterns: [],
                customPatterns: [],
              },
            },
            modelParameters: {
              pii: {
                starterPatterns: [],
                customPatterns: [],
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        threadId: 'thread-1',
        getFiles,
      }),
    ).resolves.toBeUndefined();

    expect(retrieve).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('does not read assistant definitions for an output-only tool policy', async () => {
    const { openai, retrieve, list } = createOpenAI({});

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            toolArguments: {
              pii: {
                fields: ['output'],
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        getFiles,
      }),
    ).resolves.toBeUndefined();

    expect(retrieve).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('blocks persisted assistant instructions under a newly enabled policy', async () => {
    const { openai } = createOpenAI({
      assistant: {
        instructions: 'Previously stored PRIVATE-INSTRUCTION',
        tools: [],
      },
    });

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            agentInstructions: {
              pii: {
                fields: ['instructions'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' },
                ],
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        source: 'agent_instruction',
        field: 'instructions',
      },
    });
  });

  it.each<
    [
      string,
      AssistantContentInput,
      FiltersConfig,
      'tool_argument' | 'model_parameter',
      'arguments' | 'metadata',
    ]
  >([
    [
      'tool arguments',
      {
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: {
                type: 'object',
                description: 'Previously stored PRIVATE-TOOL',
              },
            },
          },
        ],
      } as AssistantContentInput,
      {
        toolArguments: {
          pii: {
            fields: ['arguments'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      },
      'tool_argument',
      'arguments',
    ],
    [
      'model parameters',
      {
        tools: [],
        metadata: {
          note: 'Previously stored PRIVATE-METADATA',
        },
      } as AssistantContentInput,
      {
        modelParameters: {
          pii: {
            fields: ['metadata'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      },
      'model_parameter',
      'metadata',
    ],
  ])(
    'blocks persisted assistant %s under its source policy',
    async (_label, assistant, filters, source, field) => {
      const { openai } = createOpenAI({ assistant });

      await expect(
        preflightAssistantRunContent({
          config: { filters },
          openai,
          user: { id: 'user-1' },
          assistantId: 'asst-1',
          getFiles,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: {
          source,
          field,
        },
      });
    },
  );

  it('fails closed when protected assistant state is missing', async () => {
    const { openai } = createOpenAI({ assistant: null });

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            agentInstructions: {
              pii: {
                fields: ['instructions'],
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
    });
  });

  it('pages remote history and inspects only user-authored messages', async () => {
    const secondPage: ThreadPage = {
      data: [
        {
          id: 'msg-user-blocked',
          role: 'user',
          content: [{ type: 'text', text: { value: 'Historical PRIVATE-MESSAGE' } }],
        },
      ],
      hasNextPage: () => false,
    };
    const firstPage: ThreadPage = {
      data: [
        {
          id: 'msg-model',
          role: 'assistant',
          content: [{ type: 'text', text: { value: 'PRIVATE-MODEL-OUTPUT' } }],
        },
        {
          id: 'msg-user-safe',
          role: 'user',
          content: [{ type: 'text', text: { value: 'Safe historical message' } }],
        },
      ],
      hasNextPage: () => true,
      getNextPage: jest.fn().mockResolvedValue(secondPage),
    };
    const { openai, retrieve, list } = createOpenAI({ firstPage });

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            messages: {
              pii: {
                fields: ['content_part'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' },
                ],
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        threadId: 'thread-1',
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        source: 'message',
        field: 'content_part',
      },
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith('thread-1', {
      limit: 100,
      order: 'asc',
    });
    expect(firstPage.getNextPage).toHaveBeenCalledTimes(1);
  });

  it('applies the active legacy policy to persisted user history', async () => {
    const { openai, retrieve } = createOpenAI({
      firstPage: {
        data: [
          {
            id: 'msg-user-blocked',
            role: 'user',
            content: [{ type: 'text', text: { value: 'Historical sk-proj-LEGACY' } }],
          },
        ],
        has_more: false,
      },
    });

    await expect(
      preflightAssistantRunContent({
        config: {
          messageFilter: {
            pii: {},
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        threadId: 'thread-1',
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        source: 'message',
        field: 'content_part',
      },
    });

    expect(retrieve).not.toHaveBeenCalled();
  });

  it('fail-closes historical user file references without inspecting model output', async () => {
    const firstPage: ThreadPage = {
      data: [
        {
          id: 'msg-model-file',
          role: 'assistant',
          content: [{ type: 'image_file', image_file: { file_id: 'file-model' } }],
        },
        {
          id: 'msg-user-file',
          role: 'user',
          content: [{ type: 'text', text: { value: 'User file attachment' } }],
          file_ids: ['file-user'],
        },
      ],
      hasNextPage: () => false,
    };
    const { openai } = createOpenAI({
      assistant: { instructions: 'Safe assistant', tools: [] },
      firstPage,
    });

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: [],
                uninspectable: 'block',
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        threadId: 'thread-1',
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'file',
        field: 'content',
      },
    });
  });

  it('does not treat remote assistant output as user-submitted history', async () => {
    const { openai } = createOpenAI({
      firstPage: {
        data: [
          {
            id: 'msg-model',
            role: 'assistant',
            content: [{ type: 'text', text: { value: 'PRIVATE-MODEL-OUTPUT' } }],
          },
        ],
        hasNextPage: () => false,
      },
    });

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            messages: {
              pii: {
                fields: ['content_part'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z-]+' },
                ],
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        threadId: 'thread-1',
        getFiles,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns canonical user-only history from plain cursor pages', async () => {
    const firstContent = [{ type: 'text', text: { value: 'first' } }];
    const secondContent = [{ type: 'text', text: { value: 'second' } }];
    const { openai, list } = createOpenAI({
      firstPage: {
        data: [
          { id: 'assistant-1', role: 'assistant', content: firstContent },
          { id: 'user-1', role: 'user', content: firstContent },
        ],
        has_more: true,
        last_id: 'user-1',
      },
    });
    list.mockResolvedValueOnce({
      data: [
        { id: 'assistant-1', role: 'assistant', content: firstContent },
        { id: 'user-1', role: 'user', content: firstContent },
      ],
      has_more: true,
      last_id: 'user-1',
    });
    list.mockResolvedValueOnce({
      data: [{ id: 'user-2', role: 'user', content: secondContent }],
      has_more: false,
    });

    await expect(loadThreadUserMessages(openai, 'thread-1')).resolves.toEqual([
      expect.objectContaining({ role: 'user', content: firstContent, isCreatedByUser: true }),
      expect.objectContaining({ role: 'user', content: secondContent, isCreatedByUser: true }),
    ]);
    expect(list).toHaveBeenLastCalledWith('thread-1', {
      limit: 100,
      order: 'asc',
      after: 'user-1',
    });
  });

  it('fails closed when an SDK paginator repeats a page cursor', async () => {
    const repeatedPage: ThreadPage = {
      data: [
        {
          id: 'message-1',
          role: 'user',
          content: [{ type: 'text', text: { value: 'first' } }],
        },
      ],
      hasNextPage: () => true,
    };
    repeatedPage.getNextPage = jest.fn().mockResolvedValue(repeatedPage);
    const { openai } = createOpenAI({ firstPage: repeatedPage });

    await expect(loadThreadUserMessages(openai, 'thread-1')).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: {
        source: 'message',
        field: 'content_part',
      },
    });
    expect(repeatedPage.getNextPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a null first page', null],
    ['an undefined first page', undefined],
    ['a page without data', { has_more: false } as ThreadPage],
    ['a page with non-array data', { data: {}, has_more: false } as ThreadPage],
    ['a page without pagination state', { data: [] } as ThreadPage],
    [
      'a page larger than the requested limit',
      {
        data: Array.from({ length: 101 }, (_, index) => ({
          id: `message-${index}`,
          role: 'assistant',
          content: [],
        })),
        has_more: false,
      } as ThreadPage,
    ],
    [
      'a cursor that disagrees with the final message',
      {
        data: [{ id: 'message-1', role: 'assistant', content: [] }],
        last_id: 'message-2',
        has_more: false,
      } as ThreadPage,
    ],
    [
      'contradictory SDK and cursor pagination',
      {
        data: [],
        has_more: true,
        hasNextPage: () => false,
      } as ThreadPage,
    ],
  ])('fails closed for %s', async (_label, firstPage) => {
    const { openai } = createOpenAI({ firstPage });

    await expect(loadThreadUserMessages(openai, 'thread-1')).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
    });
  });

  it('fails closed when an SDK paginator returns a null next page', async () => {
    const { openai } = createOpenAI({
      firstPage: {
        data: [
          {
            id: 'message-1',
            role: 'user',
            content: [{ type: 'text', text: { value: 'first' } }],
          },
        ],
        hasNextPage: () => true,
        getNextPage: jest.fn().mockResolvedValue(null),
      },
    });

    await expect(loadThreadUserMessages(openai, 'thread-1')).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
    });
  });

  it('owner-resolves assistant and user-history file references before strict assertion', async () => {
    const assistant = {
      instructions: 'Safe assistant',
      tools: [],
      tool_resources: {
        file_search: {
          file_ids: ['assistant-file'],
        },
      },
    } as AssistantContentInput & {
      tool_resources: { file_search: { file_ids: string[] } };
    };
    const { openai } = createOpenAI({
      assistant,
      firstPage: {
        data: [
          {
            id: 'message-1',
            role: 'user',
            content: [{ type: 'text', text: { value: 'Safe history' } }],
            file_ids: ['thread-file'],
          },
        ],
        has_more: false,
      },
    });
    getFiles.mockResolvedValue([
      {
        file_id: 'assistant-file',
        filename: 'assistant.txt',
        type: 'text/plain',
        source: 'text',
        text: 'Safe assistant file',
      },
      {
        file_id: 'thread-file',
        filename: 'thread.txt',
        type: 'text/plain',
        source: 'text',
        text: 'Safe thread file',
      },
    ]);

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: [],
                uninspectable: 'block',
              },
            },
          },
        },
        openai,
        user: { id: 'user-1', tenantId: 'tenant-1' },
        assistantId: 'asst-1',
        threadId: 'thread-1',
        getFiles,
      }),
    ).resolves.toBe(assistant);

    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(getFiles.mock.calls[0][0]).toMatchObject({
      user: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(new Set(getFiles.mock.calls[0][0].file_id.$in)).toEqual(
      new Set(['assistant-file', 'thread-file']),
    );
  });

  it('blocks pattern matches found in owner-resolved assistant files', async () => {
    const assistant = {
      instructions: 'Safe assistant',
      tools: [],
      tool_resources: {
        file_search: {
          file_ids: ['assistant-file'],
        },
      },
    } as AssistantContentInput & {
      tool_resources: { file_search: { file_ids: string[] } };
    };
    const { openai } = createOpenAI({ assistant });
    getFiles.mockResolvedValue([
      {
        file_id: 'assistant-file',
        filename: 'assistant.txt',
        type: 'text/plain',
        source: 'text',
        text: 'Stored PRIVATE-FILE',
      },
    ]);

    await expect(
      preflightAssistantRunContent({
        config: {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' },
                ],
                uninspectable: 'block',
              },
            },
          },
        },
        openai,
        user: { id: 'user-1' },
        assistantId: 'asst-1',
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        source: 'file',
        field: 'content',
      },
    });
  });

  it.each(['missing', 'foreign'])(
    'fails closed for a %s assistant file reference under strict policy',
    async () => {
      const assistant = {
        instructions: 'Safe assistant',
        tools: [],
        tool_resources: {
          file_search: {
            file_ids: ['unresolved-file'],
          },
        },
      } as AssistantContentInput & {
        tool_resources: { file_search: { file_ids: string[] } };
      };
      const { openai } = createOpenAI({ assistant });

      await expect(
        preflightAssistantRunContent({
          config: {
            filters: {
              files: {
                pii: {
                  fields: ['content'],
                  starterPatterns: [],
                  uninspectable: 'block',
                },
              },
            },
          },
          openai,
          user: { id: 'user-1' },
          assistantId: 'asst-1',
          getFiles,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: {
          source: 'file',
          field: 'content',
        },
      });
    },
  );

  it('does not resolve final message files when file policy is disabled', async () => {
    const getFiles = jest.fn();

    await expect(
      preflightAssistantUserMessageContent({
        config: {},
        user: { id: 'user-1' },
        message: { role: 'user', content: 'safe', file_ids: ['file-1'] },
        getFiles,
      }),
    ).resolves.toBeUndefined();

    expect(getFiles).not.toHaveBeenCalled();
  });

  it('owner-resolves and blocks canonical conversation file content', async () => {
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'file-1',
        filename: 'notes.txt',
        type: 'text/plain',
        source: 'text',
        text: 'Stored PRIVATE-FILE',
      },
    ]);

    await expect(
      preflightAssistantUserMessageContent({
        config: {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: [],
                customPatterns: [
                  { id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' },
                ],
              },
            },
          },
        },
        user: { id: 'user-1', tenantId: 'tenant-1' },
        message: { role: 'user', content: 'safe' },
        fileIds: ['file-1'],
        getFiles,
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        source: 'file',
        field: 'content',
      },
    });

    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['file-1'] },
        user: 'user-1',
        tenantId: 'tenant-1',
      },
      {},
      {},
    );
  });

  it.each(['missing', 'foreign'])(
    'fails closed when a final user message references a %s canonical file',
    async () => {
      const getFiles = jest.fn().mockResolvedValue([]);

      await expect(
        preflightAssistantUserMessageContent({
          config: {
            filters: {
              files: {
                pii: {
                  fields: ['content'],
                  starterPatterns: [],
                  uninspectable: 'block',
                },
              },
            },
          },
          user: { id: 'user-1' },
          message: { role: 'user', content: 'safe' },
          fileIds: ['file-unresolved'],
          getFiles,
        }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: {
          source: 'file',
          field: 'content',
        },
      });
    },
  );
});
