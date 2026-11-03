import type { ClientSession, Connection } from 'mongoose';
import logger from '~/config/winston';

export const CANCEL_RATE = 1.15;
const TRANSACTION_PROBE_COLLECTION = '__transaction_test__';

function unsupportedTransaction(error: unknown, mongoose: typeof import('mongoose')): boolean {
  if (!(error instanceof mongoose.mongo.MongoServerError)) return false;
  return (
    (error.code === 20 &&
      /Transaction numbers are only allowed on a replica set member or mongos/i.test(
        error.message,
      )) ||
    (error.code === 59 && /^no such command: ['"]commitTransaction['"]$/i.test(error.message))
  );
}

async function probeTransaction(mongoose: typeof import('mongoose')): Promise<boolean> {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({ readPreference: 'primary' });
    const db = mongoose.connection.db;
    if (!db) throw new Error('Transaction capability probe requires a connected database');
    await db.collection(TRANSACTION_PROBE_COLLECTION).findOne({}, { session });
    await session.commitTransaction();
    return true;
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch {
      logger.debug('[supportsTransactions] Probe transaction abort failed');
    }
    if (unsupportedTransaction(error, mongoose)) return false;
    throw error;
  } finally {
    await session.endSession();
  }
}

/** Only confirmed transaction incompatibility is false; operational failures stay retryable. */
export const supportsTransactions = async (
  mongoose: typeof import('mongoose'),
): Promise<boolean> => {
  try {
    return await probeTransaction(mongoose);
  } catch (error) {
    // DocumentDB requires the probe collection to exist before a transaction can read it.
    if (
      !(error instanceof mongoose.mongo.MongoServerError) ||
      !/non-existent collection in transaction/i.test(error.message)
    )
      throw error;
    const db = mongoose.connection.db;
    if (!db) throw error;
    try {
      await db.createCollection(TRANSACTION_PROBE_COLLECTION);
    } catch (creationError) {
      if (!(creationError instanceof mongoose.mongo.MongoServerError) || creationError.code !== 48)
        throw creationError;
    }
    return probeTransaction(mongoose);
  }
};

const inflightProbes = new WeakMap<import('mongoose').Connection, Promise<boolean>>();

/** Share first probes per connection. Callers cache only a successful capability verdict. */
export const getTransactionSupport = async (
  mongoose: typeof import('mongoose'),
  transactionSupportCache: boolean | null,
): Promise<boolean> => {
  if (transactionSupportCache !== null) return transactionSupportCache;
  const connection = mongoose.connection;
  let probe = inflightProbes.get(connection);
  if (!probe) {
    probe = supportsTransactions(mongoose).finally(() => inflightProbes.delete(connection));
    inflightProbes.set(connection, probe);
  }
  return probe;
};

export class TransactionUnavailableError extends Error {
  readonly code = 'transactions_unavailable';
  constructor() {
    super('This operation requires transactional storage');
    this.name = 'TransactionUnavailableError';
  }
}

const requiredTransactionSupport = new WeakMap<
  Connection,
  {
    client: ReturnType<Connection['getClient']>;
    supported: boolean | null;
  }
>();

/** Probe before private writes: some unsupported engines fail only at commit. */
export async function startRequiredTransactionSession(
  mongoose: typeof import('mongoose'),
): Promise<ClientSession> {
  const connection = mongoose.connection;
  const client = connection.getClient();
  let state = requiredTransactionSupport.get(connection);
  if (!state || state.client !== client) {
    state = { client, supported: null };
    requiredTransactionSupport.set(connection, state);
  }
  // Assignment happens only on a confirmed verdict; operational failures remain retryable.
  state.supported = await getTransactionSupport(mongoose, state.supported);
  if (!state.supported) throw new TransactionUnavailableError();
  return mongoose.startSession({ defaultTransactionOptions: { readPreference: 'primary' } });
}
