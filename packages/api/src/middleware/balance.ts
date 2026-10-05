import { omit } from 'lodash';
import { logger } from '@librechat/data-schemas';
import type {
  IBalanceUpdate,
  BalanceConfig,
  AppConfig,
  ObjectId,
  IBalance,
  IUser,
} from '@librechat/data-schemas';
import type { NextFunction, Request as ServerRequest, Response as ServerResponse } from 'express';
import type { TBalanceResponse } from 'librechat-data-provider';
import type { BalanceUpdateFields } from '~/types';
import { getBalanceConfig } from '~/app/config';

export interface BalanceMiddlewareOptions {
  getAppConfig: (options?: {
    role?: string;
    userId?: string;
    tenantId?: string;
    refresh?: boolean;
  }) => Promise<AppConfig>;
  findBalanceByUser: (
    userId: string,
    options?: { includeReservedCredits?: boolean },
  ) => Promise<IBalance | null>;
  upsertBalanceFields: (
    userId: string,
    fields: IBalanceUpdate,
    insertOnly?: IBalanceUpdate,
  ) => Promise<IBalance | null>;
}

type BalanceLocals = {
  balanceData?: IBalance | null;
  balanceConfigEnabled?: boolean;
};

const balanceUpdateLocks = new Map<string, Promise<void>>();

async function runBalanceUpdate(userId: string, task: () => Promise<void>): Promise<void> {
  const previous = balanceUpdateLocks.get(userId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );

  balanceUpdateLocks.set(userId, tail);

  try {
    await current;
  } finally {
    if (balanceUpdateLocks.get(userId) === tail) {
      balanceUpdateLocks.delete(userId);
    }
  }
}

/**
 * Build an object containing fields that need updating
 * @param config - The balance configuration
 * @param userRecord - The user's current balance record, if any
 * @param userId - The user's ID
 * @returns Fields that need updating
 */
export function buildBalanceUpdateFields(
  config: BalanceConfig,
  userRecord: IBalance | null,
  userId: string,
): BalanceUpdateFields {
  const updateFields: BalanceUpdateFields = {};

  // Ensure user record has the required fields
  if (!userRecord) {
    updateFields.user = userId;
    updateFields.tokenCredits = config.startBalance;
  }

  if (userRecord?.tokenCredits == null && config.startBalance != null) {
    updateFields.tokenCredits = config.startBalance;
  }

  const isAutoRefillConfigValid =
    config.autoRefillEnabled &&
    config.refillIntervalValue != null &&
    config.refillIntervalUnit != null &&
    config.refillAmount != null;

  if (!isAutoRefillConfigValid) {
    return updateFields;
  }

  if (userRecord?.autoRefillEnabled !== config.autoRefillEnabled) {
    updateFields.autoRefillEnabled = config.autoRefillEnabled;
  }

  if (userRecord?.refillIntervalValue !== config.refillIntervalValue) {
    updateFields.refillIntervalValue = config.refillIntervalValue;
  }

  if (userRecord?.refillIntervalUnit !== config.refillIntervalUnit) {
    updateFields.refillIntervalUnit = config.refillIntervalUnit;
  }

  if (userRecord?.refillAmount !== config.refillAmount) {
    updateFields.refillAmount = config.refillAmount;
  }

  // Initialize lastRefill if it's missing when auto-refill is enabled
  if (config.autoRefillEnabled && !userRecord?.lastRefill) {
    updateFields.lastRefill = new Date();
  }

  return updateFields;
}

/**
 * Factory function to create middleware that synchronizes user balance settings with current balance configuration.
 * @param options - Options containing getBalanceConfig function and Balance model
 * @returns Express middleware function
 */
export function createSetBalanceConfig({
  getAppConfig,
  findBalanceByUser,
  upsertBalanceFields,
}: BalanceMiddlewareOptions): (
  req: ServerRequest,
  res: ServerResponse,
  next: NextFunction,
) => Promise<void> {
  return async (req: ServerRequest, res: ServerResponse, next: NextFunction): Promise<void> => {
    try {
      const balanceLocals = res.locals as BalanceLocals;
      const user = req.user as IUser & { _id: string | ObjectId };
      const appConfig = await getAppConfig({
        role: user?.role,
        userId: user?.id,
        tenantId: user?.tenantId,
      });
      const balanceConfig = getBalanceConfig(appConfig);
      balanceLocals.balanceConfigEnabled = balanceConfig?.enabled === true;
      if (!balanceConfig?.enabled) {
        return next();
      }
      if (balanceConfig.startBalance == null) {
        return next();
      }

      if (!user || !user._id) {
        return next();
      }
      const userId = typeof user._id === 'string' ? user._id : user._id.toString();
      await runBalanceUpdate(userId, async () => {
        const userBalanceRecord = await findBalanceByUser(userId, { includeReservedCredits: true });
        const updateFields = buildBalanceUpdateFields(balanceConfig, userBalanceRecord, userId);

        if (Object.keys(updateFields).length === 0) {
          balanceLocals.balanceData = userBalanceRecord;
          return;
        }

        if (userBalanceRecord == null) {
          const { tokenCredits, ...syncFields } = updateFields;
          balanceLocals.balanceData = await upsertBalanceFields(userId, syncFields, {
            tokenCredits,
          });
          return;
        }

        const updated = await upsertBalanceFields(userId, updateFields);
        balanceLocals.balanceData = updated
          ? ({
              ...updated,
              reservedCredits: userBalanceRecord.reservedCredits,
              mediaDebtCredits: userBalanceRecord.mediaDebtCredits,
              mediaHeldCredits: userBalanceRecord.mediaHeldCredits,
              availableCredits: userBalanceRecord.availableCredits,
            } as IBalance)
          : updated;
      });

      next();
    } catch (error) {
      logger.error('Error setting user balance:', error);
      next(error);
    }
  };
}

/** Serves the loaded balance snapshot, including held credits and debt, without another read. */
export function createBalanceController({
  findBalanceByUser,
}: {
  findBalanceByUser: (
    userId: string,
    options: { includeReservedCredits: true },
  ) => Promise<TBalanceResponse | null>;
}) {
  return async (req: ServerRequest, res: ServerResponse): Promise<void> => {
    const balanceLocals = res.locals as BalanceLocals;
    if (balanceLocals.balanceConfigEnabled === false) {
      res.sendStatus(204);
      return;
    }
    const balance =
      balanceLocals.balanceData ??
      (await findBalanceByUser(String((req.user as IUser)._id), { includeReservedCredits: true }));
    if (!balance) {
      res.status(404).json({ error: 'Balance not found' });
      return;
    }
    const result = omit(
      balance,
      '_id',
      ...(balance.autoRefillEnabled
        ? []
        : ['refillIntervalValue', 'refillIntervalUnit', 'lastRefill', 'refillAmount']),
    );
    res.status(200).json({
      ...result,
      reservedCredits: balance.reservedCredits ?? 0,
      mediaDebtCredits: balance.mediaDebtCredits ?? 0,
      mediaHeldCredits: balance.mediaHeldCredits ?? 0,
      availableCredits:
        balance.availableCredits ??
        Math.max(0, balance.tokenCredits - (balance.reservedCredits ?? 0)),
    });
  };
}
