import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import { withMongo } from '../db';

/**
 * Dead-lettered trigger deliveries carry an `expiresAt` deadline so the TTL index removes
 * them with their event payload once the review window passes. A row without a deadline
 * stays until an operator acts, which is what a requeue restores.
 */

const COLLECTION = 'agenttriggerdeliveries';

function deadRow(label: string, expiresAt?: Date) {
  const now = new Date();
  return {
    deliveryKey: `${label}-${randomUUID()}`,
    fingerprint: randomUUID(),
    orderingKey: `dead-retention-${randomUUID()}`,
    laneSequence: 1,
    envelope: { retentionProbe: label },
    user: new ObjectId(),
    status: 'dead',
    settledAt: now,
    createdAt: now,
    updatedAt: now,
    ...(expiresAt != null && { expiresAt }),
  };
}

test('a dead-lettered delivery is removed once its review window passes @scenario:dead-letter-expires-after-review-window', async () => {
  test.setTimeout(180_000);
  const expired = deadRow('expired', new Date(Date.now() - 60_000));
  const held = deadRow('held');
  const inWindow = deadRow('in-window', new Date(Date.now() + 24 * 60 * 60_000));
  await withMongo(async (db) => {
    await db.collection(COLLECTION).insertMany([expired, held, inWindow]);
  });

  try {
    await expect
      .poll(
        () =>
          withMongo((db) =>
            db.collection(COLLECTION).countDocuments({ deliveryKey: expired.deliveryKey }),
          ),
        { timeout: 150_000, intervals: [5_000] },
      )
      .toBe(0);

    const remaining = await withMongo((db) =>
      db
        .collection(COLLECTION)
        .find({ deliveryKey: { $in: [held.deliveryKey, inWindow.deliveryKey] } })
        .toArray(),
    );
    expect(remaining.map((row) => row.deliveryKey).sort()).toEqual(
      [held.deliveryKey, inWindow.deliveryKey].sort(),
    );
  } finally {
    await withMongo((db) =>
      db.collection(COLLECTION).deleteMany({
        deliveryKey: { $in: [expired.deliveryKey, held.deliveryKey, inWindow.deliveryKey] },
      }),
    );
  }
});
