import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Collection } from 'mongodb';
import { isFieldNameRejection } from './fields';

let mongoServer: MongoMemoryServer;
let collection: Collection;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  collection = mongoose.connection.db!.collection('field_name_probe');
  await collection.createIndex({ key: 1 }, { unique: true });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

async function rejectionOf(write: () => Promise<unknown>): Promise<unknown> {
  return write().then(
    () => {
      throw new Error('expected the write to be rejected');
    },
    (error: unknown) => error,
  );
}

/** What an engine that still refuses a field name sends back, in MongoDB's own wording. */
function engineRejection(code: number, errmsg: string): Error {
  return new mongoose.mongo.MongoServerError({ ok: 0, code, errmsg });
}

function bsonKeyError(document: Record<string, unknown>): unknown {
  try {
    mongoose.mongo.BSON.serialize(document, { checkKeys: true });
  } catch (error) {
    return error;
  }
  throw new Error('expected the key check to throw');
}

describe('isFieldNameRejection', () => {
  it('recognizes the server refusing a field name in an update', async () => {
    const error = await rejectionOf(() =>
      collection.updateOne({ key: 'empty' }, { $set: { 'overrides.a..b': 1 } }, { upsert: true }),
    );

    expect(error).toBeInstanceOf(mongoose.mongo.MongoServerError);
    expect(isFieldNameRejection(error)).toBe(true);
  });

  it.each([
    [52, "The dollar ($) prefixed field '$where' in 'overrides.$where' is not valid for storage."],
    [
      57,
      "The dotted field 'us.anthropic.x' in 'overrides.us.anthropic.x' is not valid for storage.",
    ],
    [2, "The dotted field 'gpt-4.1' in 'overrides.models.gpt-4.1' is not valid for storage."],
    [2, "Field names cannot contain '.'"],
  ])('recognizes an engine refusing a field name with code %d: %s', (code, errmsg) => {
    expect(isFieldNameRejection(engineRejection(code, errmsg))).toBe(true);
  });

  it("recognizes the driver's client-side key check", () => {
    expect(isFieldNameRejection(bsonKeyError({ 'us.anthropic.x': 1 }))).toBe(true);
    expect(isFieldNameRejection(bsonKeyError({ $where: 1 }))).toBe(true);
  });

  it('leaves other database failures alone', async () => {
    await collection.insertOne({ key: 'taken' });
    const duplicate = await rejectionOf(() => collection.insertOne({ key: 'taken' }));

    expect(duplicate).toBeInstanceOf(mongoose.mongo.MongoServerError);
    expect(isFieldNameRejection(duplicate)).toBe(false);
    expect(isFieldNameRejection(engineRejection(2, 'Invalid $set: expected an object'))).toBe(
      false,
    );
    expect(isFieldNameRejection(new Error('connection reset'))).toBe(false);
  });

  it.each([null, undefined, 'not valid for storage', 57])('is false for %p', (value) => {
    expect(isFieldNameRejection(value)).toBe(false);
  });
});
