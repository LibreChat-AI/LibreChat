import fs from 'fs';
import path from 'path';
import os from 'os';
import { Keyv } from 'keyv';
import KeyvRedis from '@keyv/redis';
import { expect, test } from '@playwright/test';
import { isAuthUserDocEvictionFenced } from '@librechat/data-schemas';
import {
  CacheKeys,
  AUTH_USER_DOC_BY_ID_PREFIX,
  AUTH_USER_DOC_CACHE_TTL_MS,
  AUTH_USER_DOC_MAX_AGE_MS,
  AUTH_USER_DOC_EVICTED_PREFIX,
  AUTH_USER_DOC_EVICTION_FENCE_TTL_MS,
} from 'librechat-data-provider';
import { spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { withMongo, seedPasskey, deleteUserByEmail } from '../db';

const PASSWORD = 'test1234!';
const NEW_PASSWORD = 'fresh-password-1';
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NO_AUTO_INDEX = path.join(__dirname, 'no-auto-index.cjs');

type RuntimeEnv = { MONGO_URI?: string };

function getMongoUri(): string {
  const runtimeEnvPath =
    process.env.E2E_RUNTIME_ENV_PATH ??
    path.resolve(__dirname, '../../.test-results/runtime-env.json');
  try {
    const env = JSON.parse(fs.readFileSync(runtimeEnvPath, 'utf8')) as RuntimeEnv;
    if (env.MONGO_URI) {
      return env.MONGO_URI;
    }
  } catch {
    /* fall through to env */
  }
  return process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/LibreChat-e2e';
}

/**
 * Drives the interactive reset CLI the way an administrator would, answering
 * each prompt as it appears rather than pre-loading stdin, which the prompt
 * loop would consume as one burst.
 */
function runResetCli(
  email: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  /** Milliseconds between confirming the new password and the CLI reporting success. */
  reportDelayMs?: number;
}> {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'config/reset-password.js')], {
    cwd,
    env: {
      ...env,
      MONGO_URI: getMongoUri(),
      /** The harness server already built the indexes; skip the module-scope rebuild. */
      NODE_OPTIONS: process.env.NODE_OPTIONS
        ? `${process.env.NODE_OPTIONS} --require ${NO_AUTO_INDEX}`
        : `--require ${NO_AUTO_INDEX}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const answers: Array<[string, string] | null> = [
    ['Enter user email: ', email],
    ['Enter new password: ', NEW_PASSWORD],
    ['Confirm new password: ', NEW_PASSWORD],
  ];
  let stdout = '';
  let confirmedAt: number | undefined;
  let reportedAt: number | undefined;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    answers.forEach((answer, index) => {
      if (answer !== null && stdout.includes(answer[0])) {
        child.stdin?.write(`${answer[1]}\n`);
        answers[index] = null;
        confirmedAt = Date.now();
      }
    });
    if (reportedAt === undefined && stdout.includes('Password successfully reset!')) {
      reportedAt = Date.now();
    }
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`reset CLI timed out; stdout: ${stdout.slice(-400)}`));
    }, 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin?.end();
      const reportDelayMs =
        confirmedAt !== undefined && reportedAt !== undefined
          ? reportedAt - confirmedAt
          : undefined;
      resolve({ code, stdout, stderr, reportDelayMs });
    });
  });
}

test.describe('CLI password reset', () => {
  test.skip(process.env.E2E_STREAM_STORE !== 'redis', 'Runs in the Redis integration lane');
  for (const [source, scenario] of [
    ['environment', '@scenario:cli-reset-revokes-old-tokens'],
    ['dotenv', '@scenario:cli-reset-loads-cache-env'],
  ]) {
    test(`evicts cached credentials with ${source} configuration ${scenario}`, async ({
      playwright,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      // The harness trusts one proxy; isolate each scenario's login rate-limit budget.
      const request = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: {
          'X-Forwarded-For': `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
        },
      });
      const email = `cli-reset-${randomUUID().slice(0, 8)}@example.com`;
      const expiresAt = source === 'dotenv' ? new Date(Date.now() + 604800_000) : undefined;
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reset-'));
      const redisUri = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
      const prefix = `cli-reset-${randomUUID()}`;
      const adapter = new KeyvRedis(redisUri, { throwOnErrors: true, connectionTimeout: 5000 });
      // Match standardCache's namespace layering without initializing app singletons in this worker.
      const cache = new Keyv(adapter, { namespace: CacheKeys.AUTH_USER_DOC });
      adapter.namespace = prefix;
      adapter.keyPrefixSeparator = '::';
      const keys: string[] = [];
      try {
        const register = await request.post('/api/auth/register', {
          data: { email, name: 'CLI Reset', password: PASSWORD, confirm_password: PASSWORD },
        });
        expect(register.ok()).toBeTruthy();
        const login = await request.post('/api/auth/login', {
          data: { email, password: PASSWORD },
        });
        expect(login.ok()).toBeTruthy();
        const { token, user } = (await login.json()) as { token: string; user: { _id: string } };
        const authorized = await request.get('/api/user', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(authorized.ok()).toBeTruthy();
        await seedPasskey(email, randomUUID(), 'Reset regression');
        await withMongo(async (db) => {
          if (expiresAt) {
            await db
              .collection('users')
              .updateOne({ email }, { $set: { expiresAt, emailVerified: false } });
          }
          const resetUser = await db.collection('users').findOne({ email });
          expect(await db.collection('passkeys').countDocuments({ user: resetUser!._id })).toBe(1);
          expect(
            await db.collection('sessions').countDocuments({ user: resetUser!._id }),
          ).toBeGreaterThan(0);
        });
        const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${user._id}`;
        const documentKeys = ['first', 'second'].map((suffix) => `auth-user-doc:${suffix}`);
        const controlKey = 'auth-user-doc:another-user';
        keys.push(indexKey, ...documentKeys, controlKey);
        // Keep fixtures alive beyond the test deadline so expiry cannot masquerade as eviction.
        await cache.set(indexKey, documentKeys, 120_000);
        for (const key of [...documentKeys, controlKey]) {
          await cache.set(key, { credentialsChangedAt: null }, 120_000);
          expect(await cache.get(key)).toEqual({ credentialsChangedAt: null });
        }
        expect(await cache.get(indexKey)).toEqual(documentKeys);

        const config = {
          USE_REDIS: 'true',
          USE_REDIS_CLUSTER: 'false',
          REDIS_URI: redisUri,
          REDIS_KEY_PREFIX: prefix,
          REDIS_KEY_PREFIX_VAR: '',
          AUTH_USER_CACHE_MODE: 'on',
          FORCED_IN_MEMORY_CACHE_NAMESPACES: '',
        };
        const env = { ...process.env };
        for (const key of Object.keys(config)) {
          delete env[key];
        }
        if (source === 'dotenv') {
          fs.writeFileSync(
            path.join(cwd, '.env'),
            Object.entries(config)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join('\n'),
            { mode: 0o600 },
          );
        } else {
          Object.assign(env, config);
        }

        const cli = await runResetCli(email, cwd, env);
        expect(cli.code, cli.stderr.slice(-400)).toBe(0);
        expect(cli.stdout, `reset CLI stderr: ${cli.stderr.slice(-400)}`).toContain(
          'Password successfully reset!',
        );
        expect(await cache.get(indexKey)).toBeUndefined();
        for (const key of documentKeys) {
          expect(await cache.get(key), `stale auth cache entry: ${key}`).toBeUndefined();
        }
        expect(await cache.get(controlKey)).toEqual({ credentialsChangedAt: null });
        await withMongo(async (db) => {
          const resetUser = await db.collection('users').findOne({ email });
          expect(resetUser?.credentialsChangedAt).toBeTruthy();
          expect(resetUser?.expiresAt).toEqual(expiresAt);
          if (expiresAt) {
            expect(resetUser?.emailVerified).toBe(false);
          }
          expect(await db.collection('passkeys').countDocuments({ user: resetUser!._id })).toBe(0);
          expect(await db.collection('sessions').countDocuments({ user: resetUser!._id })).toBe(0);
        });

        const rejected = await request.get('/api/user', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(rejected.status()).toBe(401);
        const oldLogin = await request.post('/api/auth/login', {
          data: { email, password: PASSWORD },
        });
        expect(oldLogin.status()).toBe(404);
        const newLogin = await request.post('/api/auth/login', {
          data: { email, password: NEW_PASSWORD },
        });
        if (expiresAt) {
          expect(newLogin.status()).toBe(422);
          expect(await newLogin.json()).toEqual({ message: 'Email not verified.' });
        } else {
          expect(newLogin.ok()).toBeTruthy();
        }
      } finally {
        try {
          await Promise.all(keys.map((key) => cache.delete(key)));
        } finally {
          await cache.disconnect();
          await request.dispose();
          fs.rmSync(cwd, { recursive: true, force: true });
          await deleteUserByEmail(email);
        }
      }
    });
  }

  test('hides pre-reset documents the eviction could not name @scenario:cli-reset-fences-stale-cache-writes', async ({
    playwright,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        'X-Forwarded-For': `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
      },
    });
    const email = `cli-fence-${randomUUID().slice(0, 8)}@example.com`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reset-'));
    const redisUri = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    const prefix = `cli-fence-${randomUUID()}`;
    const adapter = new KeyvRedis(redisUri, { throwOnErrors: true, connectionTimeout: 5000 });
    const cache = new Keyv(adapter, { namespace: CacheKeys.AUTH_USER_DOC });
    adapter.namespace = prefix;
    adapter.keyPrefixSeparator = '::';
    const keys: string[] = [];
    try {
      const register = await request.post('/api/auth/register', {
        data: { email, name: 'CLI Fence', password: PASSWORD, confirm_password: PASSWORD },
      });
      expect(register.ok()).toBeTruthy();
      const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
      expect(login.ok()).toBeTruthy();
      const { user } = (await login.json()) as { user: { _id: string } };
      const otherUserId = randomUUID();
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${user._id}`;
      const fenceKey = `${AUTH_USER_DOC_EVICTED_PREFIX}:${user._id}`;
      /** Indexed, so the eviction deletes it; and one a concurrent index write dropped. */
      const indexedKey = 'auth-user-doc:indexed';
      const unindexedKey = 'auth-user-doc:unindexed';
      const stale = { version: 2, cachedAt: Date.now(), user: { _id: user._id, id: user._id } };
      keys.push(indexKey, fenceKey, indexedKey, unindexedKey);
      await cache.set(indexKey, [indexedKey], 120_000);
      await cache.set(indexedKey, stale, 120_000);
      await cache.set(unindexedKey, stale, 120_000);

      const cli = await runResetCli(email, cwd, {
        ...process.env,
        USE_REDIS: 'true',
        USE_REDIS_CLUSTER: 'false',
        REDIS_URI: redisUri,
        REDIS_KEY_PREFIX: prefix,
        REDIS_KEY_PREFIX_VAR: '',
        AUTH_USER_CACHE_MODE: 'on',
        FORCED_IN_MEMORY_CACHE_NAMESPACES: '',
      });
      expect(cli.code, cli.stderr.slice(-400)).toBe(0);
      expect(cli.stdout).toContain('Password successfully reset!');
      /** The fence proves the eviction, so the CLI no longer waits out the cache TTL. */
      expect(cli.reportDelayMs).toBeLessThan(AUTH_USER_DOC_CACHE_TTL_MS);

      /** A document written after the eviction by a request that read the user before it. */
      const lateKey = 'auth-user-doc:late';
      keys.push(lateKey);
      await cache.set(lateKey, stale, 120_000);

      expect(await cache.get(indexedKey)).toBeUndefined();
      expect(await cache.get(unindexedKey)).toEqual(stale);
      expect(await isAuthUserDocEvictionFenced(cache, user._id)).toBe(true);
      expect(await isAuthUserDocEvictionFenced(cache, otherUserId)).toBe(false);
      const client = await adapter.getClient();
      const fenceTtl = await client.pTTL(`${prefix}::${CacheKeys.AUTH_USER_DOC}:${fenceKey}`);
      /** Still standing once a document cached before the reset has expired. */
      expect(fenceTtl).toBeGreaterThan(AUTH_USER_DOC_CACHE_TTL_MS);
      expect(fenceTtl).toBeLessThanOrEqual(AUTH_USER_DOC_EVICTION_FENCE_TTL_MS);
    } finally {
      try {
        await Promise.all(keys.map((key) => cache.delete(key)));
      } finally {
        await cache.disconnect();
        await request.dispose();
        fs.rmSync(cwd, { recursive: true, force: true });
        await deleteUserByEmail(email);
      }
    }
  });

  test('reports the reset only after unevictable cached credentials expire @scenario:cli-reset-outlasts-failed-cache-eviction', async ({
    playwright,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        'X-Forwarded-For': `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
      },
    });
    const email = `cli-evict-${randomUUID().slice(0, 8)}@example.com`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reset-'));
    const redisUri = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    const prefix = `cli-evict-${randomUUID()}`;
    const adapter = new KeyvRedis(redisUri, { throwOnErrors: true, connectionTimeout: 5000 });
    const cache = new Keyv(adapter, { namespace: CacheKeys.AUTH_USER_DOC });
    adapter.namespace = prefix;
    adapter.keyPrefixSeparator = '::';
    const keys: string[] = [];
    try {
      const register = await request.post('/api/auth/register', {
        data: { email, name: 'CLI Evict', password: PASSWORD, confirm_password: PASSWORD },
      });
      expect(register.ok()).toBeTruthy();
      const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
      expect(login.ok()).toBeTruthy();
      const { token, user } = (await login.json()) as { token: string; user: { _id: string } };
      await seedPasskey(email, randomUUID(), 'Eviction regression');

      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${user._id}`;
      const controlKey = 'auth-user-doc:another-user';
      keys.push(indexKey, controlKey);
      await cache.set(controlKey, { credentialsChangedAt: null }, 120_000);
      /** A hash where the index string belongs makes the CLI's GET fail with WRONGTYPE. */
      const client = await adapter.getClient();
      await client.hSet(`${prefix}::${CacheKeys.AUTH_USER_DOC}:${indexKey}`, 'unreadable', '1');
      await client.pExpire(`${prefix}::${CacheKeys.AUTH_USER_DOC}:${indexKey}`, 120_000);

      const env = { ...process.env };
      Object.assign(env, {
        USE_REDIS: 'true',
        USE_REDIS_CLUSTER: 'false',
        REDIS_URI: redisUri,
        REDIS_KEY_PREFIX: prefix,
        REDIS_KEY_PREFIX_VAR: '',
        AUTH_USER_CACHE_MODE: 'on',
        FORCED_IN_MEMORY_CACHE_NAMESPACES: '',
      });

      const cli = await runResetCli(email, cwd, env);
      expect(cli.code, cli.stderr.slice(-400)).toBe(0);
      expect(cli.stdout).toContain('Password successfully reset!');
      expect(cli.reportDelayMs).toBeGreaterThanOrEqual(AUTH_USER_DOC_MAX_AGE_MS);
      expect(await cache.get(controlKey)).toEqual({ credentialsChangedAt: null });
      await withMongo(async (db) => {
        const resetUser = await db.collection('users').findOne({ email });
        expect(resetUser?.credentialsChangedAt).toBeTruthy();
        expect(await db.collection('passkeys').countDocuments({ user: resetUser!._id })).toBe(0);
        expect(await db.collection('sessions').countDocuments({ user: resetUser!._id })).toBe(0);
      });
      const rejected = await request.get('/api/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(rejected.status()).toBe(401);
      const newLogin = await request.post('/api/auth/login', {
        data: { email, password: NEW_PASSWORD },
      });
      expect(newLogin.ok()).toBeTruthy();
    } finally {
      try {
        await Promise.all(keys.map((key) => cache.delete(key)));
      } finally {
        await cache.disconnect();
        await request.dispose();
        fs.rmSync(cwd, { recursive: true, force: true });
        await deleteUserByEmail(email);
      }
    }
  });
});
