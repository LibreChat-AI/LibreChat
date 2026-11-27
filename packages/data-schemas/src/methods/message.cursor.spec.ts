import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMessageMethods, CLIENT_MESSAGE_SELECT } from './message';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let server: MongoMemoryServer;
const methods = createMessageMethods(mongoose);

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  await mongoose.connect(server.getUri());
  await mongoose.models.Message.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await mongoose.models.Message.deleteMany({});
});

async function seedTied(conversationId: string, count: number, at: Date): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, index) => ({
    messageId: `m-${index}-${uuid()}`,
    conversationId,
    user: 'user-1',
    text: `message ${index}`,
    isCreatedByUser: false,
    createdAt: at,
    updatedAt: at,
  }));
  await mongoose.models.Message.collection.insertMany(rows);
  return rows.map((row) => row.messageId);
}

async function readAll(options: {
  sortField: string;
  sortOrder: 1 | -1;
  conversationId: string;
  limit: number;
}): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await methods.getMessagesByCursor(
      { conversationId: options.conversationId, user: 'user-1' },
      { sortField: options.sortField, sortOrder: options.sortOrder, limit: options.limit, cursor },
    );
    ids.push(...result.messages.map((message) => message.messageId));
    if (result.nextCursor == null) {
      return ids;
    }
    cursor = result.nextCursor;
  }
  throw new Error('cursor did not terminate');
}

describe('getMessagesByCursor', () => {
  it.each([
    ['createdAt', -1],
    ['createdAt', 1],
    ['updatedAt', -1],
    ['updatedAt', 1],
  ] as const)(
    'pages through rows sharing one %s value without skips or repeats (order %i)',
    async (sortField, sortOrder) => {
      const conversationId = uuid();
      const seeded = await seedTied(conversationId, 7, new Date('2026-01-01T00:00:00.123Z'));
      const seen = await readAll({ sortField, sortOrder, conversationId, limit: 3 });
      expect(seen).toHaveLength(7);
      expect(new Set(seen)).toEqual(new Set(seeded));
    },
  );

  it('keeps millisecond precision in the cursor', async () => {
    const conversationId = uuid();
    await seedTied(conversationId, 3, new Date('2026-01-01T00:00:00.456Z'));
    const first = await methods.getMessagesByCursor(
      { conversationId, user: 'user-1' },
      { limit: 1 },
    );
    expect(first.nextCursor).toContain('2026-01-01T00:00:00.456Z|');
  });

  it('pages ties without skips under the client projection that omits _id', async () => {
    const conversationId = uuid();
    const seeded = await seedTied(conversationId, 7, new Date('2026-01-01T00:00:00.123Z'));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const result = await methods.getMessagesByCursor(
        { conversationId, user: 'user-1' },
        { limit: 3, cursor, select: CLIENT_MESSAGE_SELECT },
      );
      expect(result.messages.every((message) => message._id === undefined)).toBe(true);
      seen.push(...result.messages.map((message) => message.messageId));
      if (result.nextCursor == null) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(seeded));
  });

  it('pages past rows with a missing sort value without skips', async () => {
    const conversationId = uuid();
    const at = new Date('2026-01-01T00:00:00.000Z');
    const rows = Array.from({ length: 5 }, (_, index) => ({
      messageId: `blank-${index}-${uuid()}`,
      conversationId,
      user: 'user-1',
      text: 'x',
      isCreatedByUser: false,
      createdAt: at,
      updatedAt: at,
    }));
    await mongoose.models.Message.collection.insertMany(rows);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await methods.getMessagesByCursor(
        { conversationId, user: 'user-1' },
        { sortField: 'endpoint', sortOrder: 1, limit: 2, cursor },
      );
      seen.push(...result.messages.map((message) => message.messageId));
      if (result.nextCursor == null) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(rows.map((row) => row.messageId)));
  });

  it('descending past populated values still returns rows with a missing sort value', async () => {
    const conversationId = uuid();
    const at = new Date('2026-01-01T00:00:00.000Z');
    const rows = ['a', 'a', 'b', undefined, undefined].map((endpoint, index) => ({
      messageId: `mixed-${index}-${uuid()}`,
      conversationId,
      user: 'user-1',
      text: 'x',
      isCreatedByUser: false,
      createdAt: at,
      updatedAt: at,
      ...(endpoint ? { endpoint } : {}),
    }));
    await mongoose.models.Message.collection.insertMany(rows);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await methods.getMessagesByCursor(
        { conversationId, user: 'user-1' },
        { sortField: 'endpoint', sortOrder: -1, limit: 2, cursor },
      );
      seen.push(...result.messages.map((message) => message.messageId));
      if (result.nextCursor == null) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(rows.map((row) => row.messageId)));
  });

  it.each([
    [1, 1],
    [1, 2],
    [-1, 1],
    [-1, 2],
  ] as const)(
    'keeps missing, empty and populated sort values distinct (order %i, page size %i)',
    async (sortOrder, limit) => {
      const conversationId = uuid();
      const at = new Date('2026-01-01T00:00:00.000Z');
      const rows = [undefined, '', undefined, '', 'a', 'a', 'b', null].map((endpoint, index) => ({
        messageId: `mix-${index}-${uuid()}`,
        conversationId,
        user: 'user-1',
        text: 'x',
        isCreatedByUser: false,
        createdAt: at,
        updatedAt: at,
        ...(endpoint === undefined ? {} : { endpoint }),
      }));
      await mongoose.models.Message.collection.insertMany(rows);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const result = await methods.getMessagesByCursor(
          { conversationId, user: 'user-1' },
          { sortField: 'endpoint', sortOrder, limit, cursor },
        );
        seen.push(...result.messages.map((message) => message.messageId));
        if (result.nextCursor == null) {
          break;
        }
        cursor = result.nextCursor;
      }
      expect(seen).toHaveLength(rows.length);
      expect(new Set(seen)).toEqual(new Set(rows.map((row) => row.messageId)));
    },
  );

  it.each([1, -1] as const)(
    'pages past messages with a missing timestamp (order %i)',
    async (sortOrder) => {
      const conversationId = uuid();
      const at = new Date('2026-01-01T00:00:00.000Z');
      const rows = [at, undefined, at, undefined].map((updatedAt, index) => ({
        messageId: `ts-${index}-${uuid()}`,
        conversationId,
        user: 'user-1',
        text: 'x',
        isCreatedByUser: false,
        createdAt: at,
        ...(updatedAt ? { updatedAt } : {}),
      }));
      await mongoose.models.Message.collection.insertMany(rows);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const result = await methods.getMessagesByCursor(
          { conversationId, user: 'user-1' },
          { sortField: 'updatedAt', sortOrder, limit: 1, cursor },
        );
        seen.push(...result.messages.map((message) => message.messageId));
        if (result.nextCursor == null) {
          break;
        }
        cursor = result.nextCursor;
      }
      expect(new Set(seen)).toEqual(new Set(rows.map((row) => row.messageId)));
      expect(seen).toHaveLength(rows.length);
    },
  );

  it('still honors a legacy bare timestamp cursor', async () => {
    const conversationId = uuid();
    const newer = new Date('2026-02-01T00:00:00.000Z');
    const older = new Date('2026-01-01T00:00:00.000Z');
    await seedTied(conversationId, 1, newer);
    const [olderId] = await seedTied(conversationId, 1, older);
    const result = await methods.getMessagesByCursor(
      { conversationId, user: 'user-1' },
      { cursor: newer.toISOString(), limit: 10 },
    );
    expect(result.messages.map((message) => message.messageId)).toEqual([olderId]);
  });

  it('serves the default and updatedAt sorts from an index', async () => {
    const Message = mongoose.models.Message;
    const conversationId = uuid();
    await seedTied(conversationId, 3, new Date());
    for (const sortField of ['createdAt', 'updatedAt']) {
      const plan = (await Message.find({ conversationId, user: 'user-1' })
        .sort({ [sortField]: -1, _id: -1 })
        .explain('queryPlanner')) as unknown as { queryPlanner: { winningPlan: unknown } };
      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winning.includes('"stage":"IXSCAN"')).toBe(true);
      expect(winning.includes('"stage":"SORT"')).toBe(false);
      expect(winning.includes('COLLSCAN')).toBe(false);
    }
  });

  describe('with a byte budget', () => {
    /** Rows a second apart, oldest first, each holding `bytes` of text. */
    async function seedSized(conversationId: string, sizes: number[]): Promise<string[]> {
      const rows = sizes.map((bytes, index) => ({
        messageId: `m-${index}-${uuid()}`,
        conversationId,
        user: 'user-1',
        text: 'x'.repeat(bytes),
        isCreatedByUser: false,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      }));
      await mongoose.models.Message.collection.insertMany(rows);
      return rows.map((row) => row.messageId);
    }
    const KB = 1024;

    it('stops a page before the row that would pass the budget, and pages on without skips', async () => {
      const conversationId = uuid();
      const seeded = await seedSized(conversationId, Array(7).fill(200 * KB));
      const pages: string[][] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const result = await methods.getMessagesByCursor(
          { conversationId, user: 'user-1' },
          { limit: 50, cursor, select: CLIENT_MESSAGE_SELECT, maxBytes: 500 * KB },
        );
        pages.push(result.messages.map((message) => message.messageId));
        if (result.nextCursor == null) {
          break;
        }
        cursor = result.nextCursor;
      }

      /** Two rows of 200 KB fit 500 KB; a third does not. Newest first, nothing skipped. */
      expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 1]);
      expect(pages.flat()).toEqual([...seeded].reverse());
    });

    it('returns one row that is itself over the budget, and says more follow', async () => {
      const conversationId = uuid();
      const seeded = await seedSized(conversationId, [10 * KB, 900 * KB]);

      const first = await methods.getMessagesByCursor(
        { conversationId, user: 'user-1' },
        { limit: 50, maxBytes: 100 * KB },
      );
      expect(first.messages.map((message) => message.messageId)).toEqual([seeded[1]]);
      expect(first.nextCursor).not.toBeNull();

      const rest = await methods.getMessagesByCursor(
        { conversationId, user: 'user-1' },
        { limit: 50, maxBytes: 100 * KB, cursor: first.nextCursor },
      );
      expect(rest.messages.map((message) => message.messageId)).toEqual([seeded[0]]);
      expect(rest.nextCursor).toBeNull();
    });

    it('still stops at the row limit when the budget has room', async () => {
      const conversationId = uuid();
      await seedSized(conversationId, Array(5).fill(KB));

      const page = await methods.getMessagesByCursor(
        { conversationId, user: 'user-1' },
        { limit: 3, maxBytes: 500 * KB },
      );
      expect(page.messages).toHaveLength(3);
      expect(page.nextCursor).not.toBeNull();
    });

    it('reads a conversation whole when it fits both bounds', async () => {
      const conversationId = uuid();
      const seeded = await seedSized(conversationId, Array(4).fill(KB));

      const page = await methods.getMessagesByCursor(
        { conversationId, user: 'user-1' },
        { limit: 50, maxBytes: 500 * KB },
      );
      expect(page.messages.map((message) => message.messageId)).toEqual([...seeded].reverse());
      expect(page.nextCursor).toBeNull();
    });
  });
});
