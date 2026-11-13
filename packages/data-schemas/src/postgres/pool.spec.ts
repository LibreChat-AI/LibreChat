import pg from 'pg';
import path from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import type { PostgresOptions } from './pool';
import { createPostgresDatabase } from './pool';

const postgres = process.env.PG_TEST_URL ? describe : describe.skip;
const options = (): PostgresOptions => ({
  connectionString: process.env.PG_TEST_URL ?? '',
  max: 1,
  maxWaiting: 10,
  acquireTimeoutMs: 2000,
  queryTimeoutMs: 10000,
  idleTimeoutMs: 1000,
});
const safeMessage = 'PostgreSQL connection unavailable';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

postgres('PostgreSQL borrowed connections', () => {
  it.each(['session', 'transaction'] as const)(
    'survives an idle %s disconnect in a disposable child process',
    async (kind) => {
      const source = `
      import pg from 'pg';
      import { createPostgresDatabase } from ${JSON.stringify(path.resolve(__dirname, 'pool.ts'))};
      const db = createPostgresDatabase({ ...${JSON.stringify({ ...options(), connectionString: undefined })}, connectionString: process.env.PG_TEST_URL });
      const killer = new pg.Client({ connectionString: process.env.PG_TEST_URL });
      await killer.connect();
      let openGate;
      const gate = new Promise(resolve => { openGate = resolve; });
      let session;
      let entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const operation = db[${JSON.stringify(kind)}](async sql => {
        session = sql;
        const { rows } = await sql.query('SELECT pg_backend_pid() AS pid');
        entered(rows[0].pid);
        await gate;
        return 'must not succeed';
      });
      const outcome = operation.then(() => 'success', error => error.message);
      await killer.query('SELECT pg_terminate_backend($1)', [await ready]);
      const observed = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('not reported'), 1000))]);
      if (observed !== ${JSON.stringify(safeMessage)}) throw new Error(observed);
      for (const attempt of [
        () => session.query('SELECT 1'),
        () => session.transaction(async () => 'must not succeed'),
      ]) {
        const message = await attempt().then(() => 'success', error => error.message);
        if (message !== ${JSON.stringify(safeMessage)}) throw new Error(message);
      }
      let closed = false;
      const closing = db.close().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      if (closed) throw new Error('close released an unfinished callback');
      openGate();
      await outcome;
      await closing;
      await killer.end();
      if (observed !== ${JSON.stringify(safeMessage)}) throw new Error(observed);
      console.log('borrowed-disconnect-safe');
    `;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '--eval', source],
        { timeout: 10000 },
      );
      expect(stdout).toContain('borrowed-disconnect-safe');
    },
  );

  it.each(['query', 'transaction'] as const)(
    'sanitizes an active %s disconnect and replaces the failed backend',
    async (kind) => {
      const db = createPostgresDatabase(options());
      const killer = new pg.Client({ connectionString: process.env.PG_TEST_URL });
      await killer.connect();
      try {
        const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const operation =
          kind === 'query'
            ? db.query('SELECT pg_sleep(5)')
            : db.transaction(async (sql) => {
                await sql.query('SELECT pg_sleep(5)');
              });
        const outcome = operation.catch((error: Error) => error);
        for (let i = 0; i < 100; i++) {
          const { rows } = await killer.query('SELECT state FROM pg_stat_activity WHERE pid=$1', [
            pid,
          ]);
          if (rows[0]?.state === 'active') break;
          await delay(10);
        }
        await killer.query('SELECT pg_terminate_backend($1)', [pid]);
        const error = await outcome;
        expect(error).toEqual(new Error(safeMessage));
        expect(error).not.toHaveProperty('cause');
        const next = await db.query('SELECT pg_backend_pid() AS pid');
        expect(next.rows[0].pid).not.toBe(pid);
      } finally {
        await db.close();
        await killer.end();
      }
    },
  );
});

describe('PostgreSQL lease lifecycle', () => {
  function setup() {
    const client = new EventEmitter();
    const idle = () => undefined;
    client.on('error', idle);
    const query = jest.fn(async (_text: string) => ({ rows: [], rowCount: 0 }));
    const release = jest.fn((_discard: boolean) => {
      client.on('error', idle);
    });
    Object.assign(client, { query, release });
    const pool = new EventEmitter();
    let onHandoff: () => void = () => undefined;
    const connect = jest.fn((callback: (error: Error | undefined, client: unknown) => void) => {
      client.removeListener('error', idle);
      callback(undefined, client);
      onHandoff();
    });
    const end = jest.fn(async () => undefined);
    Object.assign(pool, { connect, end, waitingCount: 0 });
    jest.spyOn(pg, 'Pool').mockImplementation(() => pool as pg.Pool);
    const db = createPostgresDatabase(options());
    return {
      db,
      connect,
      client,
      query,
      release,
      onHandoff: (callback: () => void) => {
        onHandoff = callback;
      },
    };
  }

  it.each(['callback', 'throw'] as const)('sanitizes a driver connect %s failure', async (kind) => {
    const { db, connect, release } = setup();
    connect.mockImplementation((callback) => {
      const original = new Error('postgresql://private:secret@host/private');
      if (kind === 'throw') throw original;
      callback(original, undefined);
    });
    const error = await db.query('SELECT 1').catch((error: Error) => error);
    expect(error).toEqual(new Error(safeMessage));
    expect(error).not.toHaveProperty('cause');
    expect(release).not.toHaveBeenCalled();
    await db.close();
  });

  it('protects the synchronous connect handoff and releases exactly once', async () => {
    const fixture = setup();
    fixture.onHandoff(() => fixture.client.emit('error', new Error('private DSN')));
    await expect(fixture.db.query('private query')).rejects.toThrow(safeMessage);
    expect(fixture.query).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenCalledWith(true);
    expect(fixture.client.listenerCount('error')).toBe(1);
    await fixture.db.close();
  });

  it('leaves only the pool idle listener across successful leases', async () => {
    const { db, client, release } = setup();
    for (let i = 0; i < 20; i++) {
      await db.session(async (sql) => {
        expect(client.listenerCount('error')).toBe(1);
        await sql.query('SELECT 1');
      });
      expect(client.listenerCount('error')).toBe(1);
    }
    expect(release).toHaveBeenCalledTimes(20);
    expect(release).toHaveBeenLastCalledWith(false);
    await db.close();
  });

  it('handles an error racing release without returning success or leaking listeners', async () => {
    const { db, client, release } = setup();
    release.mockImplementation(() => {
      client.on('error', () => undefined);
      client.emit('error', new Error('private release fault'));
    });
    await expect(db.query('SELECT 1')).rejects.toThrow(safeMessage);
    expect(release).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('error')).toBe(1);
    await db.close();
  });

  it('retains local SQL and callback exception identity', async () => {
    const { db, query, release } = setup();
    const sqlError = Object.assign(new Error('local constraint'), { code: '23505' });
    query.mockRejectedValueOnce(sqlError);
    await expect(db.query('INSERT')).rejects.toBe(sqlError);
    const original = new Error('local callback');
    await expect(
      db.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(query.mock.calls.map(([text]) => text)).toEqual(['INSERT', 'BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenLastCalledWith(false);
    await db.close();
  });

  it('discards on rollback failure while preserving the original callback exception', async () => {
    const { db, query, release } = setup();
    const original = new Error('local callback');
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    query.mockRejectedValueOnce(Object.assign(new Error('rollback fault'), { code: 'XX000' }));
    await expect(
      db.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(release).toHaveBeenCalledWith(true);
    await db.close();
  });

  it('reports a lost COMMIT acknowledgement without issuing a misleading ROLLBACK', async () => {
    const { db, query, release } = setup();
    query.mockImplementation(async (text) => {
      if (text === 'COMMIT')
        throw Object.assign(new Error('private commit detail'), { code: 'ECONNRESET' });
      return { rows: [], rowCount: 0 };
    });
    await expect(db.transaction(async () => 'value')).rejects.toThrow(safeMessage);
    expect(query.mock.calls.map(([text]) => text)).toEqual(['BEGIN', 'COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(true);
    await db.close();
  });
});
