import mongoose from 'mongoose';
import { buildTree } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TMessage } from 'librechat-data-provider';
import type { IMessage } from '..';
import { createMessageMethods } from './message';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongod: InstanceType<typeof MongoMemoryServer>;
let Message: mongoose.Model<IMessage>;
let getMessages: ReturnType<typeof createMessageMethods>['getMessages'];
let bulkSaveMessages: ReturnType<typeof createMessageMethods>['bulkSaveMessages'];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);
  Message = mongoose.models.Message;

  const methods = createMessageMethods(mongoose);
  getMessages = methods.getMessages;
  bulkSaveMessages = methods.bulkSaveMessages;

  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
});

describe('Conversation Structure Tests', () => {
  test('Tree stays intact when inconsistent timestamps scramble retrieval order', async () => {
    const userId = 'testUser';
    const conversationId = 'testConversation';

    // Create messages with inconsistent timestamps
    const messages = [
      {
        messageId: 'message0',
        parentMessageId: null,
        text: 'Message 0',
        createdAt: new Date('2023-01-01T00:00:00Z'),
      },
      {
        messageId: 'message1',
        parentMessageId: 'message0',
        text: 'Message 1',
        createdAt: new Date('2023-01-01T00:02:00Z'),
      },
      {
        messageId: 'message2',
        parentMessageId: 'message1',
        text: 'Message 2',
        createdAt: new Date('2023-01-01T00:01:00Z'),
      }, // Note: Earlier than its parent
      {
        messageId: 'message3',
        parentMessageId: 'message1',
        text: 'Message 3',
        createdAt: new Date('2023-01-01T00:03:00Z'),
      },
      {
        messageId: 'message4',
        parentMessageId: 'message2',
        text: 'Message 4',
        createdAt: new Date('2023-01-01T00:04:00Z'),
      },
    ];

    // Add common properties to all messages
    messages.forEach((msg) => {
      Object.assign(msg, {
        conversationId,
        user: userId,
        isCreatedByUser: false,
        error: false,
        unfinished: false,
      });
    });

    // Save messages with overrideTimestamp omitted (default is false)
    await bulkSaveMessages(messages, true);

    // Retrieve messages (this will sort by createdAt, placing message2 BEFORE its parent message1)
    const retrievedMessages = await getMessages({ conversationId, user: userId });

    // Build tree
    const tree = buildTree({ messages: retrievedMessages as TMessage[] });

    // buildTree is order-robust: a child sorted before its parent must still
    // nest (the single-pass builder used to hoist it into a phantom root,
    // folding the visible thread).
    expect(tree!.length).toBe(1);
    const root = tree![0];
    expect(root.messageId).toBe('message0');
    const message1 = root.children![0];
    expect(message1.messageId).toBe('message1');
    expect(message1.children!.map((child) => child.messageId)).toEqual(['message2', 'message3']);
    expect(message1.children![0].children![0].messageId).toBe('message4');
  });

  test('Fix: Conversation structure maintained with more than 16 messages', async () => {
    const userId = 'testUser';
    const conversationId = 'testConversation';

    // Create more than 16 messages
    const messages = Array.from({ length: 20 }, (_, i) => ({
      messageId: `message${i}`,
      parentMessageId: i === 0 ? null : `message${i - 1}`,
      conversationId,
      user: userId,
      text: `Message ${i}`,
      createdAt: new Date(Date.now() + i * 1000),
    }));

    // Save messages preserving original timestamps so sort order is deterministic
    await bulkSaveMessages(messages, true);

    // Retrieve messages (this will sort by createdAt, but it shouldn't matter now)
    const retrievedMessages = await getMessages({ conversationId, user: userId });

    // Build tree
    const tree = buildTree({ messages: retrievedMessages as TMessage[] });

    // Check if the tree is correct
    expect(tree!.length).toBe(1); // Should have only one root message
    let currentNode = tree![0];
    for (let i = 1; i < 20; i++) {
      expect(currentNode.children!.length).toBe(1);
      currentNode = currentNode.children![0];
      expect(currentNode.text).toBe(`Message ${i}`);
    }
    expect(currentNode.children!.length).toBe(0); // Last message should have no children
  });

  test('Tree stays intact under MongoDB ordering churn with close timestamps', async () => {
    const userId = 'testUser';
    const conversationId = 'testConversation';

    // Create more than 16 messages with very close timestamps
    const messages = Array.from({ length: 20 }, (_, i) => ({
      messageId: `message${i}`,
      parentMessageId: i === 0 ? null : `message${i - 1}`,
      conversationId,
      user: userId,
      text: `Message ${i}`,
      createdAt: new Date(Date.now() + (i % 2 === 0 ? i * 1 : -i * 1)),
    }));

    // Add common properties to all messages
    messages.forEach((msg) => {
      Object.assign(msg, { isCreatedByUser: false, error: false, unfinished: false });
    });

    await bulkSaveMessages(messages, true);
    const retrievedMessages = await getMessages({ conversationId, user: userId });
    const tree = buildTree({ messages: retrievedMessages as TMessage[] });

    // Interleaved timestamps scramble retrieval order, but the order-robust
    // builder must still recover the single 20-message chain.
    expect(tree!.length).toBe(1);
    let currentNode = tree![0];
    for (let i = 1; i < 20; i++) {
      expect(currentNode.children!.length).toBe(1);
      currentNode = currentNode.children![0];
      expect(currentNode.text).toBe(`Message ${i}`);
    }
    expect(currentNode.children!.length).toBe(0);
  });

  test('Fix: Preserve order with more than 16 messages by maintaining original timestamps', async () => {
    const userId = 'testUser';
    const conversationId = 'testConversation';

    // Create more than 16 messages with distinct timestamps
    const messages = Array.from({ length: 20 }, (_, i) => ({
      messageId: `message${i}`,
      parentMessageId: i === 0 ? null : `message${i - 1}`,
      conversationId,
      user: userId,
      text: `Message ${i}`,
      createdAt: new Date(Date.now() + i * 1000), // Ensure each message has a distinct timestamp
    }));

    // Add common properties to all messages
    messages.forEach((msg) => {
      Object.assign(msg, { isCreatedByUser: false, error: false, unfinished: false });
    });

    // Save messages with overriding timestamps (preserve original timestamps)
    await bulkSaveMessages(messages, true);

    // Retrieve messages (this will sort by createdAt)
    const retrievedMessages = await getMessages({ conversationId, user: userId });

    // Build tree
    const tree = buildTree({ messages: retrievedMessages as TMessage[] });

    // Check if the tree is correct
    expect(tree!.length).toBe(1); // Should have only one root message
    let currentNode = tree![0];
    for (let i = 1; i < 20; i++) {
      expect(currentNode.children!.length).toBe(1);
      currentNode = currentNode.children![0];
      expect(currentNode.text).toBe(`Message ${i}`);
    }
    expect(currentNode.children!.length).toBe(0); // Last message should have no children
  });

  test('Random order dates between parent and children messages', async () => {
    const userId = 'testUser';
    const conversationId = 'testConversation';

    // Create messages with deliberately out-of-order timestamps but sequential creation
    const messages = [
      {
        messageId: 'parent',
        parentMessageId: null,
        text: 'Parent Message',
        createdAt: new Date('2023-01-01T00:00:00Z'), // Make parent earliest
      },
      {
        messageId: 'child1',
        parentMessageId: 'parent',
        text: 'Child Message 1',
        createdAt: new Date('2023-01-01T00:01:00Z'),
      },
      {
        messageId: 'child2',
        parentMessageId: 'parent',
        text: 'Child Message 2',
        createdAt: new Date('2023-01-01T00:02:00Z'),
      },
      {
        messageId: 'grandchild1',
        parentMessageId: 'child1',
        text: 'Grandchild Message 1',
        createdAt: new Date('2023-01-01T00:03:00Z'),
      },
    ];

    // Add common properties to all messages
    messages.forEach((msg) => {
      Object.assign(msg, {
        conversationId,
        user: userId,
        isCreatedByUser: false,
        error: false,
        unfinished: false,
      });
    });

    // Save messages with overrideTimestamp set to true
    await bulkSaveMessages(messages, true);

    // Retrieve messages
    const retrievedMessages = await getMessages({ conversationId, user: userId });

    // Debug log to see what's being returned
    console.log(
      'Retrieved Messages:',
      retrievedMessages.map((msg) => ({
        messageId: msg.messageId,
        parentMessageId: msg.parentMessageId,
        createdAt: msg.createdAt,
      })),
    );

    // Build tree
    const tree = buildTree({ messages: retrievedMessages as TMessage[] });

    // Debug log to see the tree structure
    console.log(
      'Tree structure:',
      tree!.map((root) => ({
        messageId: root.messageId,
        children: root.children!.map((child) => ({
          messageId: child.messageId,
          children: child.children!.map((grandchild) => ({
            messageId: grandchild.messageId,
          })),
        })),
      })),
    );

    // Verify the structure before making assertions
    expect(retrievedMessages.length).toBe(4); // Should have all 4 messages

    // Check if messages are properly linked
    const parentMsg = retrievedMessages.find((msg) => msg.messageId === 'parent');
    expect(parentMsg!.parentMessageId).toBeNull(); // Parent should have null parentMessageId

    const childMsg1 = retrievedMessages.find((msg) => msg.messageId === 'child1');
    expect(childMsg1!.parentMessageId).toBe('parent');

    // Then check tree structure
    expect(tree!.length).toBe(1); // Should have only one root message
    expect(tree![0].messageId).toBe('parent');
    expect(tree![0].children!.length).toBe(2); // Should have two children
  });
});
