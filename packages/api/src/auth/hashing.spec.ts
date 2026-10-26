import path from 'node:path';
import { hashSync } from 'bcryptjs';
import { logger } from '@librechat/data-schemas';
import { createHashPool } from './hashing';

const workerPath = path.join(
  path.dirname(require.resolve('@librechat/api')),
  'auth/hash-worker.cjs',
);

describe('bcrypt hash pool', () => {
  const pool = createHashPool(workerPath, 2);
  afterAll(async () => pool.close());

  it('hashes and verifies a secret', async () => {
    const hash = await pool.hash('correct horse', 4);

    await expect(pool.compare('correct horse', hash)).resolves.toBe(true);
    await expect(pool.compare('wrong horse', hash)).resolves.toBe(false);
  });

  it('verifies hashes written before the pool existed', async () => {
    await expect(pool.compare('legacy', hashSync('legacy', 4))).resolves.toBe(true);
  });

  it('keeps the event loop responsive while several hashes run', async () => {
    let worstLagMs = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      worstLagMs = Math.max(worstLagMs, now - last - 5);
      last = now;
    }, 5);
    try {
      await Promise.all(Array.from({ length: 4 }, (_, i) => pool.hash(`secret-${i}`, 10)));
    } finally {
      clearInterval(timer);
    }
    /* A single cost-10 bcryptjs hash holds the main thread for roughly 70 ms or more. */
    expect(worstLagMs).toBeLessThan(50);
  });

  it('finishes a job on the main thread when its worker dies, warning once', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const crashing = createHashPool(
      path.join(__dirname, '__fixtures__', 'crashing-hash-worker.cjs'),
      1,
    );
    try {
      const hash = await crashing.hash('secret', 4);

      await expect(crashing.compare('secret', hash)).resolves.toBe(true);
      await expect(crashing.compare('other', hash)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await crashing.close();
    }
  });

  it('hashes on the main thread when the worker cannot start', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const missing = createHashPool(path.join(__dirname, '__fixtures__', 'missing-worker.cjs'), 1);
    try {
      const hash = await missing.hash('secret', 4);

      await expect(missing.compare('secret', hash)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await missing.close();
    }
  });
});
