import { getRefillEligibilityDate } from 'librechat-data-provider';
import type { AnyBulkWriteOperation, FilterQuery, Model, Types } from 'mongoose';
import type {
  BalanceReservationRequest,
  BalanceReservationRenewal,
  BalanceReservationRelease,
  BalanceReservationResult,
  IBalancePendingRefill,
  IBalanceReservation,
  IBalanceUpdate,
  TransactionData,
  IBalance,
} from '~/types';
import type { ITransaction } from '~/schema/transaction';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import logger from '~/config/winston';

const cancelRate = 1.15;
const maxReservationAttempts = 10;
/** Every balance read resolves a user to their oldest record, so duplicate records stay inert */
const oldestFirst = { _id: 1 } as const;

type MultiplierParams = {
  model?: string;
  valueKey?: string;
  tokenType?: 'prompt' | 'completion';
  inputTokenCount?: number;
  endpointTokenConfig?: Record<string, Record<string, number>>;
};

type CacheMultiplierParams = {
  cacheType?: 'write' | 'read';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>>;
  inputTokenCount?: number;
};

/** Fields read/written by the internal token value calculators */
interface InternalTxDoc {
  valueKey?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  rawAmount?: number;
  context?: string;
  rate?: number;
  tokenValue?: number;
  rateDetail?: Record<string, number>;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
}

/** Input data for creating a transaction */
export interface TxData {
  user: string | Types.ObjectId;
  conversationId?: string;
  model?: string;
  context?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  rawAmount?: number;
  valueKey?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  balance?: { enabled?: boolean };
  transactions?: { enabled?: boolean };
}

/** Return value from a successful transaction that also updates the balance */
export interface TransactionResult {
  rate: number;
  user: string;
  balance: number;
  prompt?: number;
  completion?: number;
  credits?: number;
}

export function createTransactionMethods(
  mongoose: typeof import('mongoose'),
  txMethods: {
    getMultiplier: (params: MultiplierParams) => number;
    getCacheMultiplier: (params: CacheMultiplierParams) => number | null;
  },
): {
  updateBalance: ({
    user,
    incrementValue,
    setValues,
  }: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }) => Promise<IBalance>;
  bulkInsertTransactions: (docs: TransactionData[]) => Promise<void>;
  findBalanceByUser: (
    user: string,
    options?: { includeReservedCredits?: boolean },
  ) => Promise<IBalance | null>;
  upsertBalanceFields: (
    user: string,
    fields: IBalanceUpdate,
    insertOnly?: IBalanceUpdate,
  ) => Promise<IBalance | null>;
  getTransactions: (filter: FilterQuery<ITransaction>) => Promise<ITransaction[]>;
  deleteTransactions: (
    filter: FilterQuery<ITransaction>,
  ) => Promise<import('mongodb').DeleteResult>;
  deleteBalances: (filter: FilterQuery<IBalance>) => Promise<import('mongodb').DeleteResult>;
  createTransaction: (_txData: TxData) => Promise<TransactionResult | undefined>;
  reserveBalance: (request: BalanceReservationRequest) => Promise<BalanceReservationResult | null>;
  renewBalanceReservation: (params: BalanceReservationRenewal) => Promise<void>;
  releaseBalanceReservation: (params: BalanceReservationRelease) => Promise<void>;
  createStructuredTransaction: (_txData: TxData) => Promise<TransactionResult | undefined>;
} {
  /** Calculate and set the tokenValue for a transaction */
  function calculateTokenValue(txn: InternalTxDoc) {
    const { valueKey, tokenType, model, endpointTokenConfig, inputTokenCount } = txn;
    const multiplier = Math.abs(
      txMethods.getMultiplier({
        valueKey,
        tokenType: tokenType as 'prompt' | 'completion' | undefined,
        model,
        endpointTokenConfig: endpointTokenConfig ?? undefined,
        inputTokenCount,
      }),
    );
    txn.rate = multiplier;
    txn.tokenValue = (txn.rawAmount ?? 0) * multiplier;
    if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
      txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * cancelRate);
      txn.rate = (txn.rate ?? 0) * cancelRate;
    }
  }

  /** Calculate token value for structured tokens */
  function calculateStructuredTokenValue(txn: InternalTxDoc) {
    if (!txn.tokenType) {
      txn.tokenValue = txn.rawAmount;
      return;
    }

    const { model, endpointTokenConfig, inputTokenCount } = txn;
    const etConfig = endpointTokenConfig ?? undefined;

    if (txn.tokenType === 'prompt') {
      const inputMultiplier = txMethods.getMultiplier({
        tokenType: 'prompt',
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      });
      const writeMultiplier =
        txMethods.getCacheMultiplier({
          cacheType: 'write',
          model,
          endpointTokenConfig: etConfig,
          inputTokenCount,
        }) ?? inputMultiplier;
      const readMultiplier =
        txMethods.getCacheMultiplier({
          cacheType: 'read',
          model,
          endpointTokenConfig: etConfig,
          inputTokenCount,
        }) ?? inputMultiplier;

      txn.rateDetail = {
        input: inputMultiplier,
        write: writeMultiplier,
        read: readMultiplier,
      };

      const totalPromptTokens =
        Math.abs(txn.inputTokens ?? 0) +
        Math.abs(txn.writeTokens ?? 0) +
        Math.abs(txn.readTokens ?? 0);

      if (totalPromptTokens > 0) {
        txn.rate =
          (Math.abs(inputMultiplier * (txn.inputTokens ?? 0)) +
            Math.abs(writeMultiplier * (txn.writeTokens ?? 0)) +
            Math.abs(readMultiplier * (txn.readTokens ?? 0))) /
          totalPromptTokens;
      } else {
        txn.rate = Math.abs(inputMultiplier);
      }

      txn.tokenValue = -(
        Math.abs(txn.inputTokens ?? 0) * inputMultiplier +
        Math.abs(txn.writeTokens ?? 0) * writeMultiplier +
        Math.abs(txn.readTokens ?? 0) * readMultiplier
      );

      txn.rawAmount = -totalPromptTokens;
    } else if (txn.tokenType === 'completion') {
      const multiplier = txMethods.getMultiplier({
        tokenType: txn.tokenType,
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      });
      txn.rate = Math.abs(multiplier);
      txn.tokenValue = -Math.abs(txn.rawAmount ?? 0) * multiplier;
      txn.rawAmount = -Math.abs(txn.rawAmount ?? 0);
    }

    if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
      txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * cancelRate);
      txn.rate = (txn.rate ?? 0) * cancelRate;
      if (txn.rateDetail) {
        txn.rateDetail = Object.fromEntries(
          Object.entries(txn.rateDetail).map(([k, v]) => [k, v * cancelRate]),
        );
      }
    }
  }

  /**
   * Updates a user's token balance using optimistic concurrency control.
   * Always returns an IBalance or throws after exhausting retries.
   */
  async function updateBalance({
    user,
    incrementValue,
    setValues,
  }: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }): Promise<IBalance> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    const maxRetries = 10;
    let delay = 50;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let currentBalanceDoc: IBalance | null;
      try {
        currentBalanceDoc = await Balance.findOne({ user }).sort(oldestFirst).lean<IBalance>();
        const currentCredits = currentBalanceDoc ? currentBalanceDoc.tokenCredits : 0;
        const potentialNewCredits = currentCredits + incrementValue;
        const newCredits = Math.max(0, potentialNewCredits);

        const updatePayload = {
          $set: {
            tokenCredits: newCredits,
            ...(setValues ?? {}),
          },
        };

        let updatedBalance: IBalance | null = null;
        if (currentBalanceDoc) {
          updatedBalance = await Balance.findOneAndUpdate(
            { _id: currentBalanceDoc._id, tokenCredits: currentCredits },
            updatePayload,
            { new: true },
          ).lean<IBalance>();

          if (updatedBalance) {
            return updatedBalance;
          }
          lastError = new Error(`Concurrency conflict for user ${user} on attempt ${attempt}.`);
        } else {
          await upsertBalanceRecord(user, {}, { tokenCredits: 0 });
          continue;
        }
      } catch (error) {
        logger.error(`[updateBalance] Error during attempt ${attempt} for user ${user}:`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < maxRetries) {
        const jitter = Math.random() * delay * 0.5;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay = Math.min(delay * 2, 2000);
      }
    }

    logger.error(
      `[updateBalance] Failed to update balance for user ${user} after ${maxRetries} attempts.`,
    );
    throw (
      lastError ??
      new Error(
        `Failed to update balance for user ${user} after maximum retries due to persistent conflicts.`,
      )
    );
  }

  function isAutoRefillDue(record: IBalance, now: Date): boolean {
    if (!record.autoRefillEnabled || !(record.refillAmount > 0)) {
      return false;
    }
    const lastRefill = new Date(record.lastRefill ?? 0);
    if (isNaN(lastRefill.getTime())) {
      return true;
    }
    return (
      now >=
      getRefillEligibilityDate(
        lastRefill,
        record.refillIntervalValue ?? 0,
        record.refillIntervalUnit ?? 'days',
      )
    );
  }

  function isDuplicateKeyError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error as { code: number }).code === 11000;
  }

  /**
   * Records the ledger transaction of an applied auto-refill, then clears its marker. The
   * transaction id is fixed when the refill is applied, so replaying a marker left by a failed or
   * interrupted attempt records the transaction at most once.
   */
  async function settleAutoRefill(
    balanceId: unknown,
    user: Types.ObjectId,
    { transactionId, rawAmount }: IBalancePendingRefill,
  ): Promise<boolean> {
    try {
      const Transaction = mongoose.models.Transaction;
      const transaction = new Transaction({
        _id: transactionId,
        user,
        tokenType: 'credits',
        context: 'autoRefill',
        rawAmount,
      });
      calculateTokenValue(transaction);
      await transaction.save();
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        logger.error('[Balance.reserve] Failed to record auto-refill transaction', error);
        return false;
      }
    }

    try {
      const Balance = mongoose.models.Balance as Model<IBalance>;
      await Balance.updateOne(
        { _id: balanceId, 'pendingRefill.transactionId': transactionId },
        { $unset: { pendingRefill: 1 } },
      );
      return true;
    } catch (error) {
      logger.error('[Balance.reserve] Failed to clear recorded auto-refill', error);
      return false;
    }
  }

  /**
   * Applies a due auto-refill with a write fenced on every value the refill decision read, and
   * leaves a ledger marker in that same write. Returns false when the fence missed.
   */
  async function applyAutoRefill(record: IBalance, now: Date): Promise<boolean> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    const pendingRefill: IBalancePendingRefill = {
      transactionId: new mongoose.Types.ObjectId(),
      rawAmount: record.refillAmount,
    };
    const result = await Balance.updateOne(
      {
        _id: record._id,
        tokenCredits: record.tokenCredits ?? null,
        reservedCredits: record.reservedCredits ?? null,
        lastRefill: record.lastRefill ?? null,
        pendingRefill: null,
        autoRefillEnabled: record.autoRefillEnabled,
        refillAmount: record.refillAmount,
        refillIntervalValue: record.refillIntervalValue ?? null,
        refillIntervalUnit: record.refillIntervalUnit ?? null,
      },
      {
        $set: {
          tokenCredits: Math.max(0, (record.tokenCredits ?? 0) + record.refillAmount),
          lastRefill: now,
          pendingRefill,
        },
      },
    );
    if (result.matchedCount !== 1) {
      return false;
    }
    logger.debug('[Balance.reserve] Auto-refill applied', {
      user: record.user,
      rawAmount: record.refillAmount,
    });
    await settleAutoRefill(record._id, record.user, pendingRefill);
    return true;
  }

  /**
   * Removes reservations and their credits from the running total, one atomic update per
   * reservation sent as a single bulk write, so each is removed only while it is still held at the
   * amount read and the rest proceed when one has changed. With `expiredBy`, a reservation is
   * removed only while it is still expired at that instant, so one renewed after it was read
   * survives.
   */
  async function removeReservations(
    filter: FilterQuery<IBalance>,
    reservations: Array<Pick<IBalanceReservation, 'id' | 'amount'>>,
    expiredBy?: Date,
  ): Promise<void> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    const expiry = expiredBy ? { expiresAt: { $lte: expiredBy } } : {};
    const removals: AnyBulkWriteOperation<IBalance>[] = reservations.map(({ id, amount }) => ({
      updateOne: {
        filter: { ...filter, reservations: { $elemMatch: { id, amount, ...expiry } } },
        update: { $pull: { reservations: { id } }, $inc: { reservedCredits: -amount } },
      },
    }));
    await tenantSafeBulkWrite(Balance, removals as AnyBulkWriteOperation[], { ordered: false });
  }

  /**
   * Applies `fields` to the user's balance record, creating the record when the user has none.
   * A created record is keyed by the user id, so creators racing on a missing record converge on
   * one document instead of each inserting their own; `insertOnly` applies only on creation.
   */
  async function upsertBalanceRecord(
    user: string,
    fields: IBalanceUpdate,
    insertOnly: IBalanceUpdate = {},
  ): Promise<IBalance | null> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    const { user: _fieldsUser, ...set } = fields;
    const setOnInsert = Object.fromEntries(
      Object.entries(insertOnly).filter(([key]) => key !== 'user' && !(key in set)),
    );
    const updatesExisting = Object.keys(set).length > 0;

    const existing = updatesExisting
      ? await Balance.findOneAndUpdate(
          { user },
          { $set: set },
          { new: true, sort: oldestFirst },
        ).lean<IBalance>()
      : await Balance.findOne({ user }).sort(oldestFirst).lean<IBalance>();
    if (existing) {
      return existing;
    }

    const create = () =>
      Balance.findOneAndUpdate(
        { _id: user },
        { ...(updatesExisting ? { $set: set } : {}), $setOnInsert: { ...setOnInsert, user } },
        { upsert: true, new: true },
      ).lean<IBalance>();
    try {
      return await create();
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      return create();
    }
  }

  /**
   * Admits one request against the credits that in-flight requests have not reserved, and holds
   * its amount until released or expired.
   *
   * Admission is one conditional `$push`/`$inc`: it matches only while `tokenCredits` is at least
   * the value read and `reservedCredits` still leaves room for the amount, so concurrent
   * admissions of a funded balance all commit, and an admission that lost the credits re-reads.
   * A due auto-refill is applied first by its own fenced write, at most once per admission, so a
   * refill interval that is due again the instant it is applied still refills once. Returns null
   * when the user has no balance record and no `initialBalance` was given.
   */
  async function reserveBalance({
    user,
    reservationId,
    amount,
    expiresAt,
    initialBalance,
  }: BalanceReservationRequest): Promise<BalanceReservationResult | null> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    let delay = 10;
    let refilled = false;

    for (let attempt = 1; attempt <= maxReservationAttempts; attempt++) {
      const record = await Balance.findOne({ user })
        .sort(oldestFirst)
        .select('+reservations +reservedCredits +pendingRefill')
        .lean<IBalance>();
      if (!record) {
        if (!initialBalance) {
          return null;
        }
        await upsertBalanceRecord(user, {}, initialBalance);
        continue;
      }

      const now = new Date();
      const refillSettled =
        record.pendingRefill == null ||
        (await settleAutoRefill(record._id, record.user, record.pendingRefill));

      const expired = (record.reservations ?? []).filter(
        (reservation) => reservation.expiresAt <= now,
      );
      if (expired.length > 0) {
        await removeReservations({ _id: record._id }, expired, now);
        continue;
      }

      const credits = record.tokenCredits ?? 0;
      const balance = credits - (record.reservedCredits ?? 0);
      if (refillSettled && !refilled && balance - amount <= 0 && isAutoRefillDue(record, now)) {
        refilled = await applyAutoRefill(record, now);
        continue;
      }

      const reserved = balance >= amount;
      if (!reserved || !(amount > 0)) {
        return { reserved, balance };
      }

      const held = Math.ceil(amount);
      let result: Awaited<ReturnType<typeof Balance.updateOne>>;
      try {
        result = await Balance.updateOne(
          {
            _id: record._id,
            tokenCredits: { $gte: credits },
            $or: [
              { reservedCredits: { $lte: credits - amount } },
              { reservedCredits: { $exists: false } },
            ],
          },
          {
            $push: { reservations: { id: reservationId, amount: held, expiresAt } },
            $inc: { reservedCredits: held },
          },
        );
      } catch (error) {
        /** The write may have committed before its acknowledgement was lost; the caller never
         * receives a handle to release it, so remove it here rather than leave it to expire. */
        await removeReservations({ _id: record._id }, [{ id: reservationId, amount: held }]).catch(
          (cleanupError) => {
            logger.error('[Balance.reserve] Failed to remove an unacknowledged reservation', {
              user,
              error: cleanupError,
            });
          },
        );
        throw error;
      }
      if (result.matchedCount === 1) {
        return { reserved, balance };
      }

      if (attempt < maxReservationAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * delay));
        delay = Math.min(delay * 2, 500);
      }
    }

    throw new Error(`Balance reservation for user ${user} exceeded its retry bound.`);
  }

  /** Extends an in-flight reservation's expiry; a reservation already released or pruned stays gone. */
  async function renewBalanceReservation({
    user,
    reservationId,
    expiresAt,
  }: BalanceReservationRenewal): Promise<void> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    await Balance.updateOne(
      { user, 'reservations.id': reservationId },
      { $set: { 'reservations.$[held].expiresAt': expiresAt } },
      { arrayFilters: [{ 'held.id': reservationId }] },
    );
  }

  /** Releases an in-flight reservation; releasing an unknown or already pruned id is a no-op. */
  async function releaseBalanceReservation({
    user,
    reservationId,
    amount,
  }: BalanceReservationRelease): Promise<void> {
    if (!(amount > 0)) {
      return;
    }
    await removeReservations({ user }, [{ id: reservationId, amount: Math.ceil(amount) }]);
  }

  /**
   * Creates a transaction and updates the balance.
   */
  async function createTransaction(_txData: TxData): Promise<TransactionResult | undefined> {
    const { balance, transactions, ...txData } = _txData;
    if (txData.rawAmount != null && isNaN(txData.rawAmount)) {
      return;
    }

    if (transactions?.enabled === false) {
      return;
    }

    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction(txData);
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;
    calculateTokenValue(transaction);

    await transaction.save();
    if (!balance?.enabled) {
      return;
    }

    const incrementValue = transaction.tokenValue as number;
    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: balanceResponse.tokenCredits,
      [transaction.tokenType as string]: incrementValue,
    } as TransactionResult;
  }

  /**
   * Creates a structured transaction and updates the balance.
   */
  async function createStructuredTransaction(
    _txData: TxData,
  ): Promise<TransactionResult | undefined> {
    const { balance, transactions, ...txData } = _txData;
    if (transactions?.enabled === false) {
      return;
    }

    const Transaction = mongoose.models.Transaction;
    const transaction = new Transaction(txData);
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;

    calculateStructuredTokenValue(transaction);

    await transaction.save();

    if (!balance?.enabled) {
      return;
    }

    const incrementValue = transaction.tokenValue as number;

    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return {
      rate: transaction.rate as number,
      user: transaction.user.toString() as string,
      balance: balanceResponse.tokenCredits,
      [transaction.tokenType as string]: incrementValue,
    } as TransactionResult;
  }

  /**
   * Queries and retrieves transactions based on a given filter.
   */
  async function getTransactions(filter: FilterQuery<ITransaction>): Promise<ITransaction[]> {
    try {
      const Transaction = mongoose.models.Transaction;
      return await Transaction.find(filter).lean<ITransaction[]>();
    } catch (error) {
      logger.error('Error querying transactions:', error);
      throw error;
    }
  }

  /**
   * Retrieves a user's balance record. With `includeReservedCredits`, `reservedCredits` is the
   * total of the reservations that have not expired, so a reservation left by a crashed request
   * stops counting at its expiry even before a reservation write prunes it.
   */
  async function findBalanceByUser(
    user: string,
    options?: { includeReservedCredits?: boolean },
  ): Promise<IBalance | null> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    const query = Balance.findOne({ user }).sort(oldestFirst);
    if (!options?.includeReservedCredits) {
      return query.lean<IBalance>();
    }
    const record = await query.select('+reservations').lean<IBalance>();
    if (!record) {
      return null;
    }
    const now = new Date();
    const { reservations, ...balance } = record;
    const reservedCredits = (reservations ?? []).reduce(
      (sum, reservation) => (reservation.expiresAt > now ? sum + reservation.amount : sum),
      0,
    );
    return { ...balance, reservedCredits } as IBalance;
  }

  /** Upserts balance fields for a user; `insertOnly` fields apply only when the record is created. */
  async function upsertBalanceFields(
    user: string,
    fields: IBalanceUpdate,
    insertOnly?: IBalanceUpdate,
  ): Promise<IBalance | null> {
    return upsertBalanceRecord(user, fields, insertOnly);
  }

  /** Deletes transactions matching a filter. */
  async function deleteTransactions(
    filter: FilterQuery<ITransaction>,
  ): Promise<import('mongodb').DeleteResult> {
    const Transaction = mongoose.models.Transaction;
    return Transaction.deleteMany(filter);
  }

  /** Deletes balance records matching a filter. */
  async function deleteBalances(
    filter: FilterQuery<IBalance>,
  ): Promise<import('mongodb').DeleteResult> {
    const Balance = mongoose.models.Balance as Model<IBalance>;
    return Balance.deleteMany(filter);
  }

  async function bulkInsertTransactions(docs: TransactionData[]): Promise<void> {
    if (!docs.length) {
      return;
    }
    try {
      const Transaction = mongoose.models.Transaction;
      await Transaction.insertMany(docs);
    } catch (error) {
      logger.error('[bulkInsertTransactions] Error inserting transaction docs:', error);
      throw error;
    }
  }

  return {
    updateBalance,
    bulkInsertTransactions,
    findBalanceByUser,
    upsertBalanceFields,
    getTransactions,
    deleteTransactions,
    deleteBalances,
    createTransaction,
    reserveBalance,
    renewBalanceReservation,
    releaseBalanceReservation,
    createStructuredTransaction,
  };
}

export type TransactionMethods = ReturnType<typeof createTransactionMethods>;
