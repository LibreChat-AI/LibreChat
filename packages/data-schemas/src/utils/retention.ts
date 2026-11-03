import type { FilterQuery, Model, ClientSession } from 'mongoose';
import { DEFAULT_RETENTION_HOURS } from './tempChatRetention';

export type RetentionFilterDocument = {
  isTemporary?: boolean | null;
  expiredAt?: Date | null;
};

/** BSON null sorts before Date, so $min alone cannot start a legacy deadline. */
export function initializeExpiration(
  filter: Record<string, unknown>,
  expiredAt: Date,
): {
  filter: Record<string, unknown>;
  update: { $set: { expiredAt: Date } };
  upsert: false;
  timestamps: false;
} {
  return {
    filter: { ...filter, expiredAt: null },
    update: { $set: { expiredAt } },
    upsert: false,
    timestamps: false,
  };
}

/** Initialize absent deadlines, then shorten without overwriting a concurrent earlier one. */
export async function shortenExpiration<T extends RetentionFilterDocument>(
  model: Model<T>,
  filter: FilterQuery<T>,
  expiredAt: Date,
  session?: ClientSession,
): Promise<void> {
  const initial = initializeExpiration(filter, expiredAt);
  await model.updateMany(initial.filter, initial.update, {
    upsert: false,
    timestamps: false,
    ...(session ? { session } : {}),
  });
  await model.updateMany(
    { ...filter, expiredAt: { $gt: expiredAt } },
    { $min: { expiredAt } },
    { upsert: false, ...(session ? { session } : {}) },
  );
}

export const activeExpirationFilter = <
  T extends RetentionFilterDocument = RetentionFilterDocument,
>(): FilterQuery<T> =>
  ({
    $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
  }) as FilterQuery<T>;

export const legacyPermanentExpirationFilter = <
  T extends RetentionFilterDocument = RetentionFilterDocument,
>(): FilterQuery<T> => ({ expiredAt: null }) as FilterQuery<T>;

export const buildRetentionVisibilityFilter = <
  T extends RetentionFilterDocument = RetentionFilterDocument,
>(): FilterQuery<T> =>
  ({
    $or: [
      { isTemporary: false, expiredAt: null },
      { isTemporary: false, expiredAt: { $gt: new Date() } },
      { isTemporary: null, expiredAt: null },
    ],
  }) as FilterQuery<T>;

export const createFallbackRetentionDate = (now: number = Date.now()): Date =>
  new Date(now + DEFAULT_RETENTION_HOURS * 60 * 60 * 1000);
