import type { FiltersConfig } from 'librechat-data-provider';
import {
  assertChatMutationAllowed,
  assertStoredMessageBranchAllowed,
  assertStoredMessageMutationAllowed,
} from './messageMutations';

const filters = {
  messages: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
} as FiltersConfig;

describe('typed message mutation policy', () => {
  it('rejects blocked stored-message mutations', () => {
    expect(() =>
      assertStoredMessageMutationAllowed(filters, { text: 'contains PRIVATE-TEXT' }),
    ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));
  });

  it('rejects persisted quotes through the chat projection', () => {
    expect(() =>
      assertChatMutationAllowed(filters, {
        text: 'safe edit',
        quotes: ['PRIVATE-QUOTE'],
      }),
    ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));
  });

  it('does not traverse message input when message policy is inactive', () => {
    const content = new Proxy([], {
      get() {
        throw new Error('inactive policy must not inspect');
      },
    });

    expect(() =>
      assertStoredMessageMutationAllowed(
        { skills: { pii: { starterPatterns: ['sk_prefix'] } } } as FiltersConfig,
        { content },
      ),
    ).not.toThrow();
  });

  it('fails closed when selected message content exceeds traversal bounds', () => {
    expect(() =>
      assertStoredMessageMutationAllowed(filters, {
        content: Array.from({ length: 4_200 }, (_, index) => ({
          type: 'text',
          text: `part ${index}`,
        })),
      }),
    ).toThrow(expect.objectContaining({ code: 'content_filter_uninspectable' }));
  });

  it('reports locator traversal failures through branch dependencies', async () => {
    const onTraversalFailure = jest.fn();
    const message = {
      isUserSubmitted: true,
      files: [{ file_id: 'owned' }],
      content: Array.from({ length: 4200 }, () => ({ type: 'text', text: 'safe' })),
    };
    await expect(
      assertStoredMessageBranchAllowed(
        {
          filters: { files: { pii: { fields: ['name'], starterPatterns: ['sk_prefix'] } } },
          user: { id: 'user-1' },
          message,
        },
        {
          getFiles: jest.fn().mockResolvedValue([{ file_id: 'owned', filename: 'safe.txt' }]),
          onTraversalFailure,
        },
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

  it('hydrates canonical files before admitting a branch message', async () => {
    const getFiles = jest.fn().mockResolvedValue([
      {
        file_id: 'file-1',
        filename: 'PRIVATE-FILE.txt',
        type: 'text/plain',
        source: 'text',
        text: 'safe body',
      },
    ]);
    const fileFilters = {
      files: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    } as FiltersConfig;

    await expect(
      assertStoredMessageBranchAllowed(
        {
          filters: fileFilters,
          message: { files: [{ file_id: 'file-1' }] },
          user: { id: 'user-1' },
        },
        { getFiles },
      ),
    ).rejects.toMatchObject({ code: 'content_filter_block' });
    expect(getFiles).toHaveBeenCalledTimes(1);
  });
});
