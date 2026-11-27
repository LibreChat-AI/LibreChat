import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { ModelBoundContentInput } from './middleware/modelBoundContent';
import type { GetCanonicalFilesForInspection } from './protection/files';
import { ContentTraversalLimitError } from './protection/adapters/nested';
import { assertConversationImportContentAllowed } from './imports';

const pattern = {
  id: 'import-secret',
  label: 'restricted import value',
  regex: 'IMPORT-SECRET',
};

function messageFilters(
  fields: NonNullable<NonNullable<FiltersConfig['messages']>['pii']>['fields'],
) {
  return {
    messages: {
      pii: {
        fields,
        starterPatterns: [],
        customPatterns: [pattern],
      },
    },
  } satisfies FiltersConfig;
}

function deepValue(depth = 30): string | { nested: ReturnType<typeof deepValue> } {
  let value: string | { nested: ReturnType<typeof deepValue> } = 'safe';
  for (let index = 0; index < depth; index++) {
    value = { nested: value };
  }
  return value;
}

describe('conversation import protection', () => {
  it('reports incomplete locator hydration through the import context', async () => {
    const onTraversalFailure = jest.fn();
    await assertConversationImportContentAllowed(
      { files: { pii: { fields: ['name'], starterPatterns: ['sk_prefix'] } } },
      {
        conversations: [],
        messages: [
          {
            files: [{ file_id: 'owned' }],
            content: Array.from({ length: 4200 }, () => ({ type: 'text', text: 'safe' })),
          },
        ],
      },
      {
        user: { id: 'user-1' },
        onTraversalFailure,
        getFiles: jest.fn().mockResolvedValue([{ file_id: 'owned', filename: 'safe.txt' }]),
      },
    );
    expect(onTraversalFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'omit_resolved_file_locators',
        reason: 'array_length',
        messageCount: 1,
        resolvedFileCount: 1,
      }),
    );
  });

  it('returns without resolving or revalidating when protection is disabled', async () => {
    const getFiles = jest.fn<
      ReturnType<GetCanonicalFilesForInspection>,
      Parameters<GetCanonicalFilesForInspection>
    >();
    const assertModelBoundContent = jest.fn<void, [ModelBoundContentInput]>();

    await assertConversationImportContentAllowed(
      undefined,
      {
        conversations: [{ title: 'IMPORT-SECRET' }],
        messages: [{ isCreatedByUser: true, text: 'IMPORT-SECRET' }],
      },
      { getFiles, assertModelBoundContent },
    );

    expect(getFiles).not.toHaveBeenCalled();
    expect(assertModelBoundContent).not.toHaveBeenCalled();
  });

  it('extracts and blocks normalized conversation metadata before message revalidation', async () => {
    const assertModelBoundContent = jest.fn<void, [ModelBoundContentInput]>();
    const filters = {
      conversationTitles: {
        pii: {
          fields: ['title'],
          starterPatterns: [],
          customPatterns: [pattern],
        },
      },
    } satisfies FiltersConfig;

    await expect(
      assertConversationImportContentAllowed(
        filters,
        {
          conversations: [{ title: 'Imported IMPORT-SECRET' }],
          messages: [{ isCreatedByUser: true, text: 'safe' }],
        },
        { assertModelBoundContent },
      ),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'conversation_title', field: 'title' },
    });
    expect(assertModelBoundContent).not.toHaveBeenCalled();
  });

  it('uses partial conversation fragments before enforcing a selected traversal scope', async () => {
    const filters = {
      prompts: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [pattern],
        },
      },
    } satisfies FiltersConfig;

    await expect(
      assertConversationImportContentAllowed(filters, {
        conversations: [
          {
            presetOverride: { instructions: 'later IMPORT-SECRET prompt' },
            options: { provider_option: deepValue() },
          },
        ],
        messages: [],
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'prompt', field: 'instructions' },
    });
  });

  it('fails closed when a selected conversation traversal scope is incomplete', async () => {
    const filters = {
      modelParameters: {
        pii: {
          fields: ['request_fields'],
          starterPatterns: [],
          customPatterns: [pattern],
        },
      },
    } satisfies FiltersConfig;

    await expect(
      assertConversationImportContentAllowed(filters, {
        conversations: [{ options: { provider_option: deepValue() } }],
        messages: [],
      }),
    ).rejects.toBeInstanceOf(ContentTraversalLimitError);
  });

  it('resolves canonical files for the owner without mutating the pending snapshot', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          uninspectable: 'block',
        },
      },
    } satisfies FiltersConfig;
    const snapshot = {
      conversations: [{ title: 'safe' }],
      messages: [
        {
          isCreatedByUser: true,
          text: 'safe',
          files: [{ file_id: 'owner-file-1' }],
        },
      ],
    };
    const originalSnapshot = structuredClone(snapshot);
    const canonicalFile = {
      file_id: 'owner-file-1',
      filename: 'notes.txt',
      text: 'safe extracted text',
    };
    const getFiles = jest
      .fn<ReturnType<GetCanonicalFilesForInspection>, Parameters<GetCanonicalFilesForInspection>>()
      .mockResolvedValue([canonicalFile]);
    const assertModelBoundContent = jest.fn<void, [ModelBoundContentInput]>();

    await assertConversationImportContentAllowed(filters, snapshot, {
      user: { id: 'user-123', tenantId: 'tenant-1' },
      getFiles,
      assertModelBoundContent,
    });

    expect(getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['owner-file-1'] },
        user: 'user-123',
        tenantId: 'tenant-1',
      },
      {},
      {},
    );
    expect(assertModelBoundContent).toHaveBeenNthCalledWith(1, {
      filters,
      resolvedFiles: [canonicalFile],
    });
    expect(assertModelBoundContent).toHaveBeenNthCalledWith(2, {
      filters,
      legacyPii: undefined,
      storedMessages: [expect.any(Object)],
    });
    expect(assertModelBoundContent.mock.calls[1][0].storedMessages).not.toEqual(snapshot.messages);
    expect(snapshot).toEqual(originalSnapshot);
  });

  it('keeps legacy-only inspection active for submitted imported rows', async () => {
    const legacyPii = {
      starterPatterns: [],
      customPatterns: [pattern],
    } satisfies MessageFilterPiiConfig;

    await expect(
      assertConversationImportContentAllowed(
        undefined,
        {
          conversations: [],
          messages: [{ isCreatedByUser: true, text: 'Imported IMPORT-SECRET' }],
        },
        { legacyPii },
      ),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'text' },
    });
  });

  it('inspects traversal partials from model-bound revalidation', async () => {
    const filters = messageFilters(['content_part']);
    const traversalError = new ContentTraversalLimitError(
      [
        {
          id: 'stored-message.content',
          path: '/content/0/text',
          text: 'nested IMPORT-SECRET',
          source: 'message',
          field: 'content_part',
          format: 'plain',
          treatment: 'inspect_only',
          provenance: 'user',
        },
      ],
      [{ source: 'message', fields: ['content_part'] }],
    );
    const assertModelBoundContent = jest.fn<void, [ModelBoundContentInput]>(() => {
      throw traversalError;
    });

    await expect(
      assertConversationImportContentAllowed(
        filters,
        {
          conversations: [],
          messages: [{ isCreatedByUser: true, content: [{ text: 'safe' }] }],
        },
        { assertModelBoundContent },
      ),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'content_part' },
    });
  });

  it('preserves exact HITL traversal scopes from model-bound revalidation', async () => {
    const filters = messageFilters(['answer']);
    const traversalError = new ContentTraversalLimitError(
      [],
      [{ source: 'message', fields: ['answer'] }],
    );
    const assertModelBoundContent = jest.fn<void, [ModelBoundContentInput]>(() => {
      throw traversalError;
    });

    await expect(
      assertConversationImportContentAllowed(
        filters,
        {
          conversations: [],
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_call', tool_call: { output: 'safe' } }],
              userSubmittedMessageFieldPaths: [
                { path: '/content/0/tool_call/output', field: 'answer' },
              ],
            },
          ],
        },
        { assertModelBoundContent },
      ),
    ).rejects.toBe(traversalError);
  });

  it('revalidates messages independently after the one-time file pass', async () => {
    const filters = messageFilters(['text']);
    const messages = [
      { isCreatedByUser: true, text: 'first safe message' },
      { isCreatedByUser: true, text: 'second safe message' },
    ];
    const assertModelBoundContent = jest.fn<void, [ModelBoundContentInput]>();

    await assertConversationImportContentAllowed(
      filters,
      { conversations: [], messages },
      { assertModelBoundContent },
    );

    expect(assertModelBoundContent.mock.calls).toEqual([
      [{ filters, legacyPii: undefined, storedMessages: [messages[0]] }],
      [{ filters, legacyPii: undefined, storedMessages: [messages[1]] }],
    ]);
  });
});
