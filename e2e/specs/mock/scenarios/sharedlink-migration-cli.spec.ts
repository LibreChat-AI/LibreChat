import path from 'path';
import { MongoClient, ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { getMongoUri } from '../db';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'config/migrate-shared-link-permissions.js');
const NO_AUTO_INDEX = path.join(__dirname, 'no-auto-index.cjs');

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Points the harness URI at another database on the same server. */
function uriForDatabase(name: string): string {
  const url = new URL(getMongoUri());
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Runs each case against its own database so the shared harness database, whose
 * sharedlinks collection other scenarios write to, cannot make "empty" untrue.
 * The migration requires the seeded sharedLink roles, so they are copied over.
 */
async function withIsolatedDb<T>(fn: (db: Db, uri: string) => Promise<T>): Promise<T> {
  const name = `sharedlink-migration-${randomUUID().slice(0, 8)}`;
  const uri = uriForDatabase(name);
  const client = new MongoClient(getMongoUri());
  await client.connect();
  try {
    const roles = await client.db().collection('accessroles').find({}).toArray();
    expect(roles.some((role) => role.accessRoleId === 'sharedLink_owner')).toBe(true);
    const db = client.db(name);
    await db.collection('accessroles').insertMany(roles);
    return await fn(db, uri);
  } finally {
    await client.db(name).dropDatabase();
    await client.close();
  }
}

function runMigrationCli(uri: string, args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MONGO_URI: uri,
      NODE_OPTIONS: process.env.NODE_OPTIONS
        ? `${process.env.NODE_OPTIONS} --require ${NO_AUTO_INDEX}`
        : `--require ${NO_AUTO_INDEX}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`migration CLI timed out; stdout: ${stdout.slice(-400)}`));
    }, 90_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test.describe('SharedLink permissions migration CLI', () => {
  test.describe.configure({ mode: 'serial' });

  test('a dry run with no shared links prints a zeroed summary and exits 0 @scenario:sharedlink-migration-dry-run-empty-zero-summary', async () => {
    test.setTimeout(120_000);
    await withIsolatedDb(async (db, uri) => {
      const result = await runMigrationCli(uri, ['--dry-run']);

      expect(result.code, result.stderr.slice(-800)).toBe(0);
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stdout).toContain('=== DRY RUN RESULTS ===');
      expect(result.stdout).toContain('Total SharedLink documents: 0');
      expect(result.stdout).toContain('- With isPublic field present: 0');
      expect(result.stdout).toContain('Already migrated (OWNER AclEntries): 0');
      expect(result.stdout).toContain('Already migrated (PUBLIC AclEntries): 0');
      expect(await db.collection('aclentries').countDocuments({})).toBe(0);
    });
  });

  test('a live run with no shared links is a successful no-op @scenario:sharedlink-migration-live-run-empty-noop', async () => {
    test.setTimeout(120_000);
    await withIsolatedDb(async (db, uri) => {
      const result = await runMigrationCli(uri, []);

      expect(result.code, result.stderr.slice(-800)).toBe(0);
      expect(result.stdout).toContain('=== MIGRATION RESULTS ===');
      expect(result.stdout).toContain('"migrated": 0');
      expect(result.stdout).toContain('"errors": 0');
      expect(await db.collection('aclentries').countDocuments({})).toBe(0);
    });
  });

  test('a dry run over legacy shared links reports their counts and writes nothing @scenario:sharedlink-migration-dry-run-legacy-counts', async () => {
    test.setTimeout(120_000);
    await withIsolatedDb(async (db, uri) => {
      const user = new ObjectId();
      await db.collection('sharedlinks').insertMany([
        { shareId: randomUUID(), conversationId: 'c1', messages: [], user, isPublic: true },
        { shareId: randomUUID(), conversationId: 'c2', messages: [], user, isPublic: false },
        { shareId: randomUUID(), conversationId: 'c3', messages: [], isPublic: true },
      ]);

      const result = await runMigrationCli(uri, ['--dry-run']);

      expect(result.code, result.stderr.slice(-800)).toBe(0);
      expect(result.stdout).toContain('Total SharedLink documents: 3');
      expect(result.stdout).toContain('- With user field: 2');
      expect(result.stdout).toContain('- Without user field: 1');
      expect(result.stdout).toContain('- With isPublic: true: 2');
      expect(result.stdout).toContain('- With isPublic: false: 1');
      expect(await db.collection('aclentries').countDocuments({})).toBe(0);
      expect(
        await db.collection('sharedlinks').countDocuments({ isPublic: { $exists: true } }),
      ).toBe(3);
    });
  });
});
