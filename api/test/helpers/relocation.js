/**
 * Fixtures and observations for the documents an operator who skipped the migration leaves behind:
 * auth-flow tokens in `tokens` and ban entries in `logs`.
 *
 * Seeding runs over a throwaway connection opened before the entrypoint is required, so the
 * documents are already in place across the whole boot window rather than appearing part way
 * through it. The ban entries carry Keyv's stored shape — a serialized `{ value, expires }`
 * envelope under a `<namespace>:<key>` document key — with a null `expires`, so nothing expires
 * out from under the assertions mid-boot.
 *
 * Document counts, not observed operations, are the primary evidence here: the ban stores reach
 * MongoDB through the raw driver rather than through a Mongoose model, so a copy made that way
 * would never appear in the connection's operation stream.
 */
const mongoose = require('mongoose');
const { CacheKeys, ViolationTypes } = require('librechat-data-provider');

/** Driver operations that mutate documents, excluding collection and index creation. */
const DOCUMENT_WRITE_METHODS = new Set([
  'bulkWrite',
  'deleteMany',
  'deleteOne',
  'findAndModify',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'insert',
  'insertMany',
  'insertOne',
  'remove',
  'replaceOne',
  'update',
  'updateMany',
  'updateOne',
]);

const LEGACY_IP = '198.51.100.9';
const LEGACY_EMAIL = 'pre-relocation@example.com';

const LEGACY_BAN_KEYS = Object.freeze([
  `${CacheKeys.BANS}:${LEGACY_IP}`,
  `${ViolationTypes.BAN}:${LEGACY_IP}`,
]);

/** One document of each class the auth token relocation moves: reset, verification, invite. */
function legacyTokenDocuments() {
  const userId = new mongoose.Types.ObjectId();
  const createdAt = new Date();
  const expiresAt = new Date(Date.now() + 3_600_000);

  return [
    { userId, type: 'password_reset', token: 'pre-relocation-reset-hash', createdAt, expiresAt },
    {
      userId,
      email: LEGACY_EMAIL,
      type: 'email_verification',
      token: 'pre-relocation-verification-hash',
      createdAt,
      expiresAt,
    },
    { userId, email: LEGACY_EMAIL, token: 'pre-relocation-invite-hash', createdAt, expiresAt },
  ];
}

/** One document for each of the two ban namespaces the Keyv relocation moves. */
function legacyLogDocuments() {
  const envelope = JSON.stringify({ value: { expiresAt: Date.now() + 3_600_000 }, expires: null });
  return LEGACY_BAN_KEYS.map((key) => ({ key, value: envelope, expiresAt: null }));
}

/**
 * Inserts the pre-relocation documents and returns them as stored, for later comparison.
 * Opens and closes its own connection so it can run before the entrypoint connects.
 */
async function seedLegacyDocuments(uri) {
  const connection = await mongoose.createConnection(uri).asPromise();

  await connection.db.collection('tokens').insertMany(legacyTokenDocuments());
  await connection.db.collection('logs').insertMany(legacyLogDocuments());

  const seeded = await readLegacyDocuments(connection.db);
  await connection.close();

  return seeded;
}

async function readLegacyDocuments(db) {
  const [tokens, logs] = await Promise.all([
    db.collection('tokens').find({}).sort({ _id: 1 }).toArray(),
    db
      .collection('logs')
      .find({ key: { $in: [...LEGACY_BAN_KEYS] } })
      .sort({ key: 1 })
      .toArray(),
  ]);

  return { tokens, logs };
}

/** Reads both collection pairs plus the materialized collection list from the live connection. */
async function readRelocationPairs() {
  const { db } = mongoose.connection;
  const [legacy, authtokens, bans, collections] = await Promise.all([
    readLegacyDocuments(db),
    db.collection('authtokens').find({}).toArray(),
    db.collection('bans').find({}).toArray(),
    db.listCollections().toArray(),
  ]);

  return {
    ...legacy,
    authtokens,
    bans,
    collectionNames: collections.map(({ name }) => name),
  };
}

const documentWrites = (operations, collectionName) =>
  operations.filter(
    (operation) =>
      operation.collectionName === collectionName && DOCUMENT_WRITE_METHODS.has(operation.method),
  );

module.exports = {
  documentWrites,
  readRelocationPairs,
  seedLegacyDocuments,
};
