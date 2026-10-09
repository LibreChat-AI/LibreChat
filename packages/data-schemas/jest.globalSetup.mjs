import { MongoBinary } from 'mongodb-memory-server-core';

/**
 * Download the in-memory MongoDB binary ONCE, before jest forks its workers.
 *
 * Dozens of suites here spin up `MongoMemoryServer`, and on a cold binary cache
 * every worker starts its own download of the same archive. They then race on the
 * final `rename('<file>.tgz.downloading', '<file>.tgz')`, and whichever workers
 * lose that race fail their whole suite with
 * `ENOENT ... rename '.../mongodb-linux-...tgz.downloading'` — a beforeAll timeout
 * plus an unrelated-looking error, most visibly on CI where the cache starts empty.
 *
 * Pre-warming serially makes the download happen exactly once; every worker then
 * finds the extracted binary already present. Failures are swallowed: if the
 * download cannot happen here it will be retried by the first suite that needs it,
 * and a pre-warm problem must not fail the run on its own.
 */
export default async function globalSetup() {
  try {
    await MongoBinary.getPath({});
  } catch (error) {
    console.warn(
      '[data-schemas jest] Could not pre-warm the mongodb-memory-server binary:',
      error instanceof Error ? error.message : error,
    );
  }
}
