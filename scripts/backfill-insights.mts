import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { createModels, backfillInsightsAttribution } from '@librechat/data-schemas';

if (process.argv.includes('--help')) {
  console.log(`Usage: node scripts/backfill-insights.mts [--apply] [--collection=conversations|messages|transactions|all]
  [--batch-size=1000] [--after=OBJECT_ID]

Uses MONGO_URI from the environment or .env. Defaults to a read-only dry run.
--apply gives legacy agent conversations a fixed root agent, creates the Insights indexes
and updates attribution hints. The default runs conversations, messages, then transactions.
--after resumes one collection after a printed cursor.`);
  process.exit(0);
}

const value = (name: string, fallback?: string) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const apply = process.argv.includes('--apply');
const batchSize = Number(value('batch-size', '1000'));
const selected = value('collection', 'all');
const after = value('after');
if (!Number.isInteger(batchSize) || batchSize < 1) {
  throw new Error('--batch-size must be a positive integer');
}
if (after && !mongoose.Types.ObjectId.isValid(after)) {
  throw new Error('--after must be an ObjectId');
}
if (!['conversations', 'messages', 'transactions', 'all'].includes(selected ?? '')) {
  throw new Error('Use --collection=conversations, messages, transactions or all');
}
if (after && selected === 'all') throw new Error('--after requires one --collection');
const config = existsSync('.env') ? dotenv.parse(readFileSync('.env')) : {};
const uri = process.env.MONGO_URI ?? config.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is required');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
try {
  await mongoose.connect(uri);
  createModels(mongoose);
  const collections =
    selected === 'all'
      ? (['conversations', 'messages', 'transactions'] as const)
      : [selected as 'conversations' | 'messages' | 'transactions'];
  for (const collection of collections) {
    if (apply && collection !== 'conversations') {
      await mongoose.connection.db
        ?.collection(collection)
        .createIndex(
          { tenantId: 1, insightsAgentId: 1, createdAt: 1 },
          { name: 'insights_root_period' },
        );
    }
    let cursor = after;
    do {
      const result = await backfillInsightsAttribution(mongoose, {
        collection,
        after: cursor,
        batchSize,
        apply,
      });
      console.log(JSON.stringify({ collection, mode: apply ? 'apply' : 'dry-run', ...result }));
      cursor = result.nextAfter;
    } while (cursor);
  }
} catch {
  console.error(
    'Insights backfill failed. Check database access, index compatibility, and the last printed cursor.',
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
