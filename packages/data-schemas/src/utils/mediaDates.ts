import type { Collection, Types } from 'mongoose';

type TimestampRow = { _id: Types.ObjectId } & Record<string, unknown>;

/** Renames the existing retirement identity marker without casting it as a timestamp. */
export async function migrateMediaUnlinkMarker(collection: Collection): Promise<void> {
  await collection.updateMany(
    { mediaUnlinkedAt: { $exists: true }, mediaUnlinkedBy: { $exists: false } },
    { $rename: { mediaUnlinkedAt: 'mediaUnlinkedBy' } },
  );
}

function pathValue(row: TimestampRow, path: string): unknown {
  let value: unknown = row;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !(key in value)) return;
    value = Reflect.get(value, key);
  }
  return value;
}

/** Preserves prerelease records while changing indexed lifecycle fields from ISO strings to BSON dates. */
export async function migrateMediaDates(collection: Collection, paths: string[]): Promise<void> {
  const filter = { $or: paths.map((path) => ({ [path]: { $type: 'string' } })) };
  // This bounds migration memory, not the number of records an owner may keep.
  const projection = Object.fromEntries(paths.map((path) => [path, 1]));
  for (;;) {
    const rows = await collection.find<TimestampRow>(filter, { projection }).limit(100).toArray();
    if (rows.length === 0) return;
    const writes = rows.map((row) => {
      const previous: Record<string, string> = {};
      const dates: Record<string, Date> = {};
      for (const path of paths) {
        const value = pathValue(row, path);
        if (typeof value !== 'string') continue;
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
          throw new Error(`Invalid stored media timestamp in ${collection.name}.${path}`);
        }
        previous[path] = value;
        dates[path] = date;
      }
      return { updateOne: { filter: { _id: row._id, ...previous }, update: { $set: dates } } };
    });
    // eslint-disable-next-line no-restricted-syntax -- Startup migration must read raw BSON; every write compares the same record ID and original values.
    await collection.bulkWrite(writes, { ordered: false });
  }
}

export async function migrateMediaHoldDates(collection: Collection): Promise<void> {
  for (;;) {
    const rows = await collection
      .find<{
        _id: Types.ObjectId;
        mediaHolds: Array<{ reviewAt: Date | string }>;
      }>({ 'mediaHolds.reviewAt': { $type: 'string' } }, { projection: { mediaHolds: 1 } })
      .limit(100)
      .toArray();
    if (rows.length === 0) return;
    const writes = rows.map((row) => {
      const mediaHolds = row.mediaHolds.map((hold) => {
        const reviewAt = new Date(hold.reviewAt);
        if (!Number.isFinite(reviewAt.getTime()))
          throw new Error('Invalid stored media hold timestamp');
        return { ...hold, reviewAt };
      });
      return {
        updateOne: {
          filter: { _id: row._id, mediaHolds: row.mediaHolds },
          update: { $set: { mediaHolds } },
        },
      };
    });
    // eslint-disable-next-line no-restricted-syntax -- Startup migration compares the complete original hold array before replacing only its timestamp representation.
    await collection.bulkWrite(writes, { ordered: false });
  }
}
