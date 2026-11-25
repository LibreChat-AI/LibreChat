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

type TransactionClient = ReturnType<Connection['getClient']>;
const inflightProbes = new WeakMap<Connection, WeakMap<TransactionClient, Promise<boolean>>>();

function assertTransactionClient(
  mongoose: typeof import('mongoose'),
  connection: Connection,
  client: TransactionClient,
): void {
  if (mongoose.connection !== connection || connection.getClient() !== client) {
    throw new mongoose.mongo.MongoNetworkError('MongoDB client changed during transaction setup');
  }
}

/** Share first probes only for the same connection and client. */
export const getTransactionSupport = async (
  mongoose: typeof import('mongoose'),
  transactionSupportCache: boolean | null,
): Promise<boolean> => {
  if (transactionSupportCache !== null) return transactionSupportCache;
  const connection = mongoose.connection;
  const client = connection.getClient();
  let probes = inflightProbes.get(connection);
  if (!probes) {
    probes = new WeakMap();
    inflightProbes.set(connection, probes);
  }
  let probe = probes.get(client);
  if (!probe) {
    const pending = probes;
    probe = supportsTransactions(mongoose).finally(() => pending.delete(client));
    probes.set(client, probe);
  }
  const supported = await probe;
  assertTransactionClient(mongoose, connection, client);
  return supported;
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
    client: TransactionClient;
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
  assertTransactionClient(mongoose, connection, client);
  if (!state.supported) throw new TransactionUnavailableError();
  // The driver's synchronous call binds the session to the client we just checked.
  return client.startSession({
    defaultTransactionOptions: { readPreference: 'primary' },
  });
}

/** Prepare indexes outside the transaction, after confirming storage capability. */
export async function withRequiredTransaction<T>(
  mongoose: typeof import('mongoose'),
  write: (session: ClientSession) => Promise<T>,
  prepare?: () => Promise<void>,
): Promise<T> {
  const session = await startRequiredTransactionSession(mongoose);
  try {
    await prepare?.();
    const result = await session.withTransaction(() => write(session));
    if (result === undefined) throw new Error('Required transaction did not commit');
    return result;
  } finally {
    await session.endSession();
  }
}
