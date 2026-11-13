import mongoose from 'mongoose';
import type { Db } from 'mongodb';

export function isCheckpointDatabaseAvailable(): boolean {
  return mongoose.connection.readyState === 1 && mongoose.connection.db != null;
}

export function checkpointDatabase(): Db {
  if (!isCheckpointDatabaseAvailable()) throw new Error('Checkpoint database is unavailable');
  return mongoose.connection.db!;
}

export function checkpointModelCollectionName(modelName: string, fallback: string): string {
  const collection = mongoose.models[modelName]?.collection;
  return collection?.name ?? fallback;
}
