import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';

const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/LibreChat-e2e';

/**
 * e2e/setup/start-server.js writes the active Mongo URI (memory-Mongo port included)
 * here on boot. It honors `E2E_RUNTIME_ENV_PATH`, so resolve the same override the
 * server used before falling back to the default location.
 */
function getRuntimeEnvPath(): string {
  return (
    process.env.E2E_RUNTIME_ENV_PATH ?? path.resolve(__dirname, '../.test-results/runtime-env.json')
  );
}

function getMongoUri(): string {
  try {
    const env = JSON.parse(fs.readFileSync(getRuntimeEnvPath(), 'utf8')) as { MONGO_URI?: string };
    if (env.MONGO_URI) {
      return env.MONGO_URI;
    }
  } catch {
    /* fall through to env/default */
  }
  return process.env.MONGO_URI ?? DEFAULT_MONGO_URI;
}

async function resolveUserId(db: Db, userEmail: string): Promise<string> {
  const user = await db.collection('users').findOne({ email: userEmail });
  if (!user) {
    throw new Error(`E2E seed: user "${userEmail}" not found`);
  }
  return user._id.toString();
}

/** Connect to the e2e MongoDB, run `fn`, and always close the client. */
export async function withMongo<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(getMongoUri());
  await client.connect();
  try {
    return await fn(client.db());
  } finally {
    await client.close();
  }
}

export interface SeedConvo {
  conversationId: string;
  title: string;
  /** Drives the sidebar date group ("Today", "Previous 7 days", ...). */
  updatedAt: Date;
}

/**
 * Inserts conversation documents directly (bypassing mongoose timestamps) so their
 * `updatedAt` can be backdated into specific sidebar date groups.
 */
export async function seedConversations(userEmail: string, convos: SeedConvo[]): Promise<void> {
  await withMongo(async (db) => {
    const userId = await resolveUserId(db, userEmail);
    const docs = convos.map((convo) => ({
      conversationId: convo.conversationId,
      title: convo.title,
      user: userId,
      endpoint: 'openAI',
      isArchived: false,
      createdAt: convo.updatedAt,
      updatedAt: convo.updatedAt,
      __v: 0,
    }));
    await db.collection('conversations').insertMany(docs);
  });
}

export async function deleteConversations(conversationIds: string[]): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('conversations').deleteMany({ conversationId: { $in: conversationIds } });
  });
}

export interface SeedMessage {
  messageId: string;
  parentMessageId: string;
  text: string;
  isCreatedByUser: boolean;
  sender: string;
  /** Structured parts, for turns the mock model cannot produce: a summary a
   *  compaction persisted, an error part, an artifact. */
  content?: Record<string, unknown>[];
  /** Why the turn stopped; the hover Continue is offered only for some values. */
  finish_reason?: string;
  model?: string;
}

/**
 * Inserts message documents directly so specs can build conversations far larger
 * than the mock model could produce through the UI in reasonable time.
 */
export async function seedMessages(
  userEmail: string,
  conversationId: string,
  messages: SeedMessage[],
): Promise<void> {
  await withMongo(async (db) => {
    const userId = await resolveUserId(db, userEmail);
    const start = Date.now();
    const docs = messages.map((message, index) => ({
      ...message,
      conversationId,
      user: userId,
      endpoint: 'openAI',
      error: false,
      unfinished: false,
      createdAt: new Date(start + index * 1000),
      updatedAt: new Date(start + index * 1000),
      __v: 0,
    }));
    await db.collection('messages').insertMany(docs);
  });
}

export async function deleteMessagesByConversation(conversationIds: string[]): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('messages').deleteMany({ conversationId: { $in: conversationIds } });
  });
}

/** Clears every conversation for the user so the seeded date groups are not pushed
 *  below the virtualized viewport by rows left behind by other specs. */
export async function clearUserConversations(userEmail: string): Promise<void> {
  await withMongo(async (db) => {
    const userId = await resolveUserId(db, userEmail);
    await db.collection('conversations').deleteMany({ user: userId });
  });
}
