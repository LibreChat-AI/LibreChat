import logger from '~/config/winston';

export const CANCEL_RATE = 1.15;

const TRANSACTION_PROBE_COLLECTION = '__transaction_test__';

async function probeTransaction(mongoose: typeof import('mongoose')): Promise<boolean> {
  try {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();

      await mongoose.connection.db
        ?.collection(TRANSACTION_PROBE_COLLECTION)
        .findOne({}, { session });

      await session.commitTransaction();
      logger.debug('MongoDB transactions are supported');
      return true;
    } catch (transactionError: unknown) {
      try {
        await session.abortTransaction();
      } catch (transactionError) {
        /** best-effort abort */
        logger.error(`[supportsTransactions] Error aborting transaction:`, transactionError);
      }
      logger.debug(
        'MongoDB transactions not supported (transaction error):',
        (transactionError as Error)?.message || 'Unknown error',
      );
      return false;
    } finally {
      await session.endSession();
    }
  } catch (error) {
    logger.debug(
      'MongoDB transactions not supported (session error):',
      (error as Error)?.message || 'Unknown error',
    );
    return false;
  }
}

/**
 * Checks if the connected MongoDB deployment supports transactions
 * This requires a MongoDB replica set configuration
 *
 * Amazon DocumentDB rejects a transaction that touches a collection which does
 * not exist ("Feature not supported: non-existent collection in transaction"),
 * so a failed first probe materializes the canary and probes once more —
 * otherwise engines that fully support transactions would report unsupported
 * and silently drop every caller to the non-transactional path. MongoDB allows
 * transactional reads of missing collections, so deployments that pass the
 * first probe never pay the create and never gain the canary collection. A
 * failed create is logged rather than swallowed: on a hardened role it is the
 * only visible explanation for a wrong "unsupported" verdict.
 *
 * @returns True if transactions are supported, false otherwise
 */
export const supportsTransactions = async (
  mongoose: typeof import('mongoose'),
): Promise<boolean> => {
  if (await probeTransaction(mongoose)) {
    return true;
  }
  try {
    await mongoose.connection.db?.createCollection(TRANSACTION_PROBE_COLLECTION);
  } catch (error) {
    const message = (error as Error)?.message ?? '';
    if (!/already exists|NamespaceExists/i.test(message)) {
      logger.warn(
        `[supportsTransactions] Could not create the "${TRANSACTION_PROBE_COLLECTION}" probe collection; ` +
          'if this deployment is Amazon DocumentDB, the transaction-support verdict below may be a false negative:',
        error,
      );
    }
  }
  return probeTransaction(mongoose);
};

let inflightProbe: Promise<boolean> | null = null;

/**
 * Gets whether the current MongoDB deployment supports transactions
 * Caches the result for performance
 *
 * Concurrent first callers share one in-flight probe instead of each paying
 * the session/transaction round trips before the caller-side cache fills.
 *
 * @returns True if transactions are supported, false otherwise
 */
export const getTransactionSupport = async (
  mongoose: typeof import('mongoose'),
  transactionSupportCache: boolean | null,
): Promise<boolean> => {
  if (transactionSupportCache !== null) {
    return transactionSupportCache;
  }
  if (inflightProbe == null) {
    inflightProbe = supportsTransactions(mongoose).finally(() => {
      inflightProbe = null;
    });
  }
  return await inflightProbe;
};
