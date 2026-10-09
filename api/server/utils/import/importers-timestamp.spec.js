const { logger } = require('@librechat/data-schemas');
const { Constants } = require('librechat-data-provider');
const { ImportBatchBuilder } = require('./importBatchBuilder');
const { getImporter } = require('./importers');

// Mock the database methods
jest.mock('~/models', () => ({
  bulkSaveConvos: jest.fn(),
  bulkSaveMessages: jest.fn(),
  bulkIncrementTagCounts: jest.fn(),
}));

const mockGetEndpointsConfig = jest.fn().mockResolvedValue(null);
jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: (...args) => mockGetEndpointsConfig(...args),
}));

describe('Import Timestamp Ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEndpointsConfig.mockResolvedValue(null);
  });

  describe('LibreChat Import - Timestamp Issues', () => {
    test('should maintain proper timestamp order between parent and child messages', async () => {
      // Create a LibreChat export with out-of-order timestamps
      const jsonData = {
        conversationId: 'test-convo-123',
        title: 'Test Conversation',
        messages: [
          {
            messageId: 'parent-1',
            parentMessageId: Constants.NO_PARENT,
            text: 'Parent Message',
            sender: 'user',
            isCreatedByUser: true,
            createdAt: '2023-01-01T00:02:00Z', // Parent created AFTER child
          },
          {
            messageId: 'child-1',
            parentMessageId: 'parent-1',
            text: 'Child Message',
            sender: 'assistant',
            isCreatedByUser: false,
            createdAt: '2023-01-01T00:01:00Z', // Child created BEFORE parent
          },
          {
            messageId: 'grandchild-1',
            parentMessageId: 'child-1',
            text: 'Grandchild Message',
            sender: 'user',
            isCreatedByUser: true,
            createdAt: '2023-01-01T00:00:30Z', // Even earlier
          },
        ],
      };

      const requestUserId = 'user-123';
      const importBatchBuilder = new ImportBatchBuilder(requestUserId);
      jest.spyOn(importBatchBuilder, 'saveMessage');

      const importer = getImporter(jsonData);
      await importer(jsonData, requestUserId, () => importBatchBuilder);

      // Check the actual messages stored in the builder
      const savedMessages = importBatchBuilder.messages;

      const parent = savedMessages.find((msg) => msg.text === 'Parent Message');
      const child = savedMessages.find((msg) => msg.text === 'Child Message');
      const grandchild = savedMessages.find((msg) => msg.text === 'Grandchild Message');

      // Verify all messages were found
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(grandchild).toBeDefined();

      // FIXED behavior: timestamps ARE corrected
      expect(new Date(child.createdAt).getTime()).toBeGreaterThan(
        new Date(parent.createdAt).getTime(),
      );
      expect(new Date(grandchild.createdAt).getTime()).toBeGreaterThan(
        new Date(child.createdAt).getTime(),
      );
    });

    test('should handle complex multi-branch scenario with out-of-order timestamps', async () => {
      const jsonData = {
        conversationId: 'complex-test-123',
        title: 'Complex Test',
        messages: [
          // Branch 1: Root -> A -> B with reversed timestamps
          {
            messageId: 'root-1',
            parentMessageId: Constants.NO_PARENT,
            text: 'Root 1',
            sender: 'user',
            isCreatedByUser: true,
            createdAt: '2023-01-01T00:03:00Z',
          },
          {
            messageId: 'a-1',
            parentMessageId: 'root-1',
            text: 'A1',
            sender: 'assistant',
            isCreatedByUser: false,
            createdAt: '2023-01-01T00:02:00Z', // Before parent
          },
          {
            messageId: 'b-1',
            parentMessageId: 'a-1',
            text: 'B1',
            sender: 'user',
            isCreatedByUser: true,
            createdAt: '2023-01-01T00:01:00Z', // Before grandparent
          },
          // Branch 2: Root -> C -> D with mixed timestamps
          {
            messageId: 'root-2',
            parentMessageId: Constants.NO_PARENT,
            text: 'Root 2',
            sender: 'user',
            isCreatedByUser: true,
            createdAt: '2023-01-01T00:00:30Z', // Earlier than branch 1
          },
          {
            messageId: 'c-2',
            parentMessageId: 'root-2',
            text: 'C2',
            sender: 'assistant',
            isCreatedByUser: false,
            createdAt: '2023-01-01T00:04:00Z', // Much later
          },
          {
            messageId: 'd-2',
            parentMessageId: 'c-2',
            text: 'D2',
            sender: 'user',
            isCreatedByUser: true,
            createdAt: '2023-01-01T00:02:30Z', // Between root and parent
          },
        ],
      };

      const requestUserId = 'user-123';
      const importBatchBuilder = new ImportBatchBuilder(requestUserId);
      jest.spyOn(importBatchBuilder, 'saveMessage');

      const importer = getImporter(jsonData);
      await importer(jsonData, requestUserId, () => importBatchBuilder);

      const savedMessages = importBatchBuilder.messages;

      // Verify that timestamps are preserved as-is (not corrected)
      const root1 = savedMessages.find((msg) => msg.text === 'Root 1');
      const a1 = savedMessages.find((msg) => msg.text === 'A1');
      const b1 = savedMessages.find((msg) => msg.text === 'B1');
      const root2 = savedMessages.find((msg) => msg.text === 'Root 2');
      const c2 = savedMessages.find((msg) => msg.text === 'C2');
      const d2 = savedMessages.find((msg) => msg.text === 'D2');

      // Branch 1: timestamps should now be in correct order
      expect(new Date(a1.createdAt).getTime()).toBeGreaterThan(new Date(root1.createdAt).getTime());
      expect(new Date(b1.createdAt).getTime()).toBeGreaterThan(new Date(a1.createdAt).getTime());

      // Branch 2: all timestamps should be properly ordered
      expect(new Date(c2.createdAt).getTime()).toBeGreaterThan(new Date(root2.createdAt).getTime());
      expect(new Date(d2.createdAt).getTime()).toBeGreaterThan(new Date(c2.createdAt).getTime());
    });

    test('recursive format should NOW have timestamp protection', async () => {
      // Create a recursive LibreChat export with out-of-order timestamps
      const jsonData = {
        conversationId: 'recursive-test-123',
        title: 'Recursive Test',
        recursive: true,
        messages: [
          {
            messageId: 'parent-1',
            parentMessageId: Constants.NO_PARENT,
            text: 'Parent Message',
            sender: 'User',
            isCreatedByUser: true,
            createdAt: '2023-01-01T00:02:00Z', // Parent created AFTER child
            children: [
              {
                messageId: 'child-1',
                parentMessageId: 'parent-1',
                text: 'Child Message',
                sender: 'Assistant',
                isCreatedByUser: false,
                createdAt: '2023-01-01T00:01:00Z', // Child created BEFORE parent
                children: [
                  {
                    messageId: 'grandchild-1',
                    parentMessageId: 'child-1',
                    text: 'Grandchild Message',
                    sender: 'User',
                    isCreatedByUser: true,
                    createdAt: '2023-01-01T00:00:30Z', // Even earlier
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      };

      const requestUserId = 'user-123';
      const importBatchBuilder = new ImportBatchBuilder(requestUserId);

      const importer = getImporter(jsonData);
      await importer(jsonData, requestUserId, () => importBatchBuilder);

      const savedMessages = importBatchBuilder.messages;

      // Messages should be saved
      expect(savedMessages).toHaveLength(3);

      // In recursive format, timestamps are NOT included in the saved messages
      // The saveMessage method doesn't receive createdAt for recursive imports
      const parent = savedMessages.find((msg) => msg.text === 'Parent Message');
      const child = savedMessages.find((msg) => msg.text === 'Child Message');
      const grandchild = savedMessages.find((msg) => msg.text === 'Grandchild Message');

      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(grandchild).toBeDefined();

      // Recursive imports NOW preserve and correct timestamps
      expect(parent.createdAt).toBeDefined();
      expect(child.createdAt).toBeDefined();
      expect(grandchild.createdAt).toBeDefined();

      // Timestamps should be corrected to maintain proper order
      expect(new Date(child.createdAt).getTime()).toBeGreaterThan(
        new Date(parent.createdAt).getTime(),
      );
      expect(new Date(grandchild.createdAt).getTime()).toBeGreaterThan(
        new Date(child.createdAt).getTime(),
      );
    });
  });

  describe('ChatGPT Import - Timestamp Issues', () => {
    test('should correct timestamp inversions (child before parent)', async () => {
      // Simulate ChatGPT export with timestamp inversion (like tool call results)
      const jsonData = [
        {
          title: 'Timestamp Inversion Test',
          create_time: 1000,
          mapping: {
            'root-node': {
              id: 'root-node',
              message: null,
              parent: null,
              children: ['parent-msg'],
            },
            'parent-msg': {
              id: 'parent-msg',
              message: {
                id: 'parent-msg',
                author: { role: 'user' },
                create_time: 1000.1, // Parent: 1000.1
                content: { content_type: 'text', parts: ['Parent message'] },
                metadata: {},
              },
              parent: 'root-node',
              children: ['child-msg'],
            },
            'child-msg': {
              id: 'child-msg',
              message: {
                id: 'child-msg',
                author: { role: 'assistant' },
                create_time: 1000.095, // Child: 1000.095 (5ms BEFORE parent)
                content: { content_type: 'text', parts: ['Child message'] },
                metadata: {},
              },
              parent: 'parent-msg',
              children: [],
            },
          },
        },
      ];

      const requestUserId = 'user-123';
      const importBatchBuilder = new ImportBatchBuilder(requestUserId);
      jest.spyOn(importBatchBuilder, 'saveMessage');

      const importer = getImporter(jsonData);
      await importer(jsonData, requestUserId, () => importBatchBuilder);

      const savedMessages = importBatchBuilder.messages;
      const parent = savedMessages.find((msg) => msg.text === 'Parent message');
      const child = savedMessages.find((msg) => msg.text === 'Child message');

      expect(parent).toBeDefined();
      expect(child).toBeDefined();

      // Child timestamp should be adjusted to be after parent
      expect(new Date(child.createdAt).getTime()).toBeGreaterThan(
        new Date(parent.createdAt).getTime(),
      );
    });

    test('should use conv.create_time for null message timestamps', async () => {
      const convCreateTime = 1500000000; // Conversation create time
      const jsonData = [
        {
          title: 'Null Timestamp Test',
          create_time: convCreateTime,
          mapping: {
            'root-node': {
              id: 'root-node',
              message: null,
              parent: null,
              children: ['msg-with-null-time'],
            },
            'msg-with-null-time': {
              id: 'msg-with-null-time',
              message: {
                id: 'msg-with-null-time',
                author: { role: 'user' },
                create_time: null, // Null timestamp
                content: { content_type: 'text', parts: ['Message with null time'] },
                metadata: {},
              },
              parent: 'root-node',
              children: ['msg-with-valid-time'],
            },
            'msg-with-valid-time': {
              id: 'msg-with-valid-time',
              message: {
                id: 'msg-with-valid-time',
                author: { role: 'assistant' },
                create_time: convCreateTime + 10, // Valid timestamp
                content: { content_type: 'text', parts: ['Message with valid time'] },
                metadata: {},
              },
              parent: 'msg-with-null-time',
              children: [],
            },
          },
        },
      ];

      const requestUserId = 'user-123';
      const importBatchBuilder = new ImportBatchBuilder(requestUserId);
      jest.spyOn(importBatchBuilder, 'saveMessage');

      const importer = getImporter(jsonData);
      await importer(jsonData, requestUserId, () => importBatchBuilder);

      const savedMessages = importBatchBuilder.messages;
      const nullTimeMsg = savedMessages.find((msg) => msg.text === 'Message with null time');
      const validTimeMsg = savedMessages.find((msg) => msg.text === 'Message with valid time');

      expect(nullTimeMsg).toBeDefined();
      expect(validTimeMsg).toBeDefined();

      // Null timestamp should fall back to conv.create_time
      expect(nullTimeMsg.createdAt).toEqual(new Date(convCreateTime * 1000));

      // Child should still be after parent (timestamp adjustment)
      expect(new Date(validTimeMsg.createdAt).getTime()).toBeGreaterThan(
        new Date(nullTimeMsg.createdAt).getTime(),
      );
    });

    test('should terminate on cyclic parent relationships and break cycles before saving', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');
      const jsonData = [
        {
          title: 'Cycle Test',
          create_time: 1700000000,
          mapping: {
            'root-node': {
              id: 'root-node',
              message: null,
              parent: null,
              children: ['message-a'],
            },
            'message-a': {
              id: 'message-a',
              message: {
                id: 'message-a',
                author: { role: 'user' },
                create_time: 1700000000,
                content: { content_type: 'text', parts: ['Message A'] },
                metadata: {},
              },
              parent: 'message-b',
              children: ['message-b'],
            },
            'message-b': {
              id: 'message-b',
              message: {
                id: 'message-b',
                author: { role: 'assistant' },
                create_time: 1700000000,
                content: { content_type: 'text', parts: ['Message B'] },
                metadata: {},
              },
              parent: 'message-a',
              children: ['message-a'],
            },
          },
        },
      ];

      const requestUserId = 'user-123';
      const importBatchBuilder = new ImportBatchBuilder(requestUserId);

      const importer = getImporter(jsonData);
      await importer(jsonData, requestUserId, () => importBatchBuilder);

      const { messages } = importBatchBuilder;
      expect(messages).toHaveLength(2);

      const msgA = messages.find((m) => m.text === 'Message A');
      const msgB = messages.find((m) => m.text === 'Message B');
      expect(msgA).toBeDefined();
      expect(msgB).toBeDefined();

      const roots = messages.filter((m) => m.parentMessageId === Constants.NO_PARENT);
      expect(roots).toHaveLength(1);

      const [root] = roots;
      const nonRoot = messages.find((m) => m.parentMessageId !== Constants.NO_PARENT);
      expect(nonRoot.parentMessageId).toBe(root.messageId);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cyclic parent relationships'));
      warnSpy.mockRestore();
    });

    test('should not hang when findValidParent encounters a skippable-message cycle', async () => {
      const jsonData = [
        {
          title: 'Skippable Cycle Test',
          create_time: 1700000000,
          mapping: {
            'root-node': {
              id: 'root-node',
              message: null,
              parent: null,
              children: ['real-msg'],
            },
            'sys-a': {
              id: 'sys-a',
              message: {
                id: 'sys-a',
                author: { role: 'system' },
                create_time: 1700000000,
                content: { content_type: 'text', parts: ['system a'] },
                metadata: {},
              },
              parent: 'sys-b',
              children: ['real-msg'],
            },
            'sys-b': {
              id: 'sys-b',
              message: {
                id: 'sys-b',
                author: { role: 'system' },
                create_time: 1700000000,
                content: { content_type: 'text', parts: ['system b'] },
                metadata: {},
              },
              parent: 'sys-a',
              children: [],
            },
            'real-msg': {
              id: 'real-msg',
              message: {
                id: 'real-msg',
                author: { role: 'user' },
                create_time: 1700000001,
                content: { content_type: 'text', parts: ['Hello'] },
                metadata: {},
              },
              parent: 'sys-a',
              children: [],
            },
          },
        },
      ];

      const importBatchBuilder = new ImportBatchBuilder('user-123');
      const importer = getImporter(jsonData);
      await importer(jsonData, 'user-123', () => importBatchBuilder);

      const realMsg = importBatchBuilder.messages.find((m) => m.text === 'Hello');
      expect(realMsg).toBeDefined();
      expect(realMsg.parentMessageId).toBe(Constants.NO_PARENT);
    });
  });

  describe('Comparison with Fork Functionality', () => {
    test('fork functionality correctly handles timestamp issues (for comparison)', async () => {
      const { cloneMessagesWithTimestamps } = require('./fork');

      const messagesToClone = [
        {
          messageId: 'parent',
          parentMessageId: Constants.NO_PARENT,
          text: 'Parent Message',
          createdAt: '2023-01-01T00:02:00Z', // Parent created AFTER child
        },
        {
          messageId: 'child',
          parentMessageId: 'parent',
          text: 'Child Message',
          createdAt: '2023-01-01T00:01:00Z', // Child created BEFORE parent
        },
      ];

      const importBatchBuilder = new ImportBatchBuilder('user-123');
      jest.spyOn(importBatchBuilder, 'saveMessage');

      cloneMessagesWithTimestamps(messagesToClone, importBatchBuilder);

      const savedMessages = importBatchBuilder.messages;
      const parent = savedMessages.find((msg) => msg.text === 'Parent Message');
      const child = savedMessages.find((msg) => msg.text === 'Child Message');

      // Fork functionality DOES correct the timestamps
      expect(new Date(child.createdAt).getTime()).toBeGreaterThan(
        new Date(parent.createdAt).getTime(),
      );
    });
  });

  describe('Large exports', () => {
    const baseTime = 1700000000;
    const chatGptNode = (parent, role) => ({
      parent,
      children: [],
      message: {
        author: { role },
        create_time: baseTime,
        content: { content_type: 'text', parts: [role] },
        metadata: {},
      },
    });

    /** These sizes import in a few hundred milliseconds; a per-message scan takes ten seconds or more. */
    const importBudgetMs = 3000;

    const importJson = async (jsonData) => {
      const importBatchBuilder = new ImportBatchBuilder('user-123');
      const startedAt = performance.now();
      await getImporter(jsonData)(jsonData, 'user-123', () => importBatchBuilder);
      return { messages: importBatchBuilder.messages, elapsedMs: performance.now() - startedAt };
    };

    test('imports a flat LibreChat export whose messages all name an absent parent', async () => {
      const count = 60000;
      const { messages, elapsedMs } = await importJson({
        conversationId: 'large-flat',
        title: 'Large flat export',
        messages: Array.from({ length: count }, (_, index) => ({
          messageId: `m${index}`,
          parentMessageId: 'absent-root',
          text: 'x',
          sender: 'user',
          isCreatedByUser: true,
        })),
      });

      expect(elapsedMs).toBeLessThan(importBudgetMs);
      expect(messages).toHaveLength(count);
    });

    test('orders a long LibreChat chain whose timestamps all collide', async () => {
      const count = 60000;
      const createdAt = '2024-01-01T00:00:00.000Z';
      const { messages, elapsedMs } = await importJson({
        conversationId: 'large-chain',
        title: 'Large chain export',
        messages: Array.from({ length: count }, (_, index) => ({
          messageId: `m${index}`,
          parentMessageId: index === 0 ? Constants.NO_PARENT : `m${index - 1}`,
          text: 'x',
          sender: 'user',
          isCreatedByUser: true,
          createdAt,
        })),
      });

      expect(elapsedMs).toBeLessThan(importBudgetMs);
      expect(messages).toHaveLength(count);
      expect(messages[count - 1].parentMessageId).toBe(messages[count - 2].messageId);
      expect(messages[count - 1].createdAt.getTime()).toBe(
        new Date(createdAt).getTime() + count - 1,
      );
    });

    test('orders a long ChatGPT branch listed deepest-first', async () => {
      const count = 10000;
      const mapping = {};
      for (let depth = count - 1; depth >= 0; depth--) {
        mapping[`n${depth}`] = chatGptNode(
          depth === 0 ? null : `n${depth - 1}`,
          depth % 2 ? 'assistant' : 'user',
        );
      }

      const { messages, elapsedMs } = await importJson([
        { title: 'Deep branch', create_time: baseTime, mapping },
      ]);

      const byId = new Map(messages.map((message) => [message.messageId, message]));
      const root = messages.find((message) => message.parentMessageId === Constants.NO_PARENT);
      const leaf = messages[0];
      expect(elapsedMs).toBeLessThan(importBudgetMs);
      expect(messages).toHaveLength(count);
      expect(root.createdAt.getTime()).toBe(baseTime * 1000);
      expect(leaf.createdAt.getTime()).toBe(baseTime * 1000 + count - 1);
      expect(leaf.createdAt.getTime()).toBeGreaterThan(
        byId.get(leaf.parentMessageId).createdAt.getTime(),
      );
    });

    test('attaches many ChatGPT replies behind one long run of system messages', async () => {
      const systemCount = 10000;
      const replyCount = 10000;
      const mapping = { root: chatGptNode(null, 'user') };
      for (let index = 0; index < systemCount; index++) {
        mapping[`s${index}`] = chatGptNode(index === 0 ? 'root' : `s${index - 1}`, 'system');
      }
      for (let index = 0; index < replyCount; index++) {
        mapping[`r${index}`] = chatGptNode(`s${systemCount - 1}`, 'assistant');
      }

      const { messages, elapsedMs } = await importJson([
        { title: 'System run', create_time: baseTime, mapping },
      ]);

      const root = messages.find((message) => message.parentMessageId === Constants.NO_PARENT);
      expect(elapsedMs).toBeLessThan(importBudgetMs);
      expect(messages).toHaveLength(replyCount + 1);
      expect(messages.filter((message) => message.parentMessageId === root.messageId)).toHaveLength(
        replyCount,
      );
    });
  });
});
