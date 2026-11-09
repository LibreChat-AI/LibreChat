import type { Model } from 'mongoose';
import type { INmbFileHold } from '~/schema/nmbFileHold';

export type NmbFileHoldRecord = {
  userId: string;
  sha256: string;
  reviewId: string;
};

export type NmbFileHoldMethods = {
  createNmbFileHold: (hold: NmbFileHoldRecord) => Promise<void>;
  /** Unreleased holds for one user's exact file, newest first. */
  findNmbFileHolds: (userId: string, sha256: string) => Promise<NmbFileHoldRecord[]>;
  /** Atomically consumes a hold; true only for the caller that released it. */
  consumeNmbFileHold: (reviewId: string, userId: string) => Promise<boolean>;
};

export function createNmbFileHoldMethods(mongoose: typeof import('mongoose')): NmbFileHoldMethods {
  const model = () => mongoose.models.NmbFileHold as Model<INmbFileHold>;

  async function createNmbFileHold(hold: NmbFileHoldRecord): Promise<void> {
    await model().create(hold);
  }

  async function findNmbFileHolds(userId: string, sha256: string): Promise<NmbFileHoldRecord[]> {
    const rows = await model()
      .find({ userId, sha256, releasedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    return rows.map((r) => ({ userId: r.userId, sha256: r.sha256, reviewId: r.reviewId }));
  }

  async function consumeNmbFileHold(reviewId: string, userId: string): Promise<boolean> {
    const res = await model().updateOne(
      { reviewId, userId, releasedAt: { $exists: false } },
      { $set: { releasedAt: new Date() } },
    );
    return res.modifiedCount === 1;
  }

  return { createNmbFileHold, findNmbFileHolds, consumeNmbFileHold };
}
