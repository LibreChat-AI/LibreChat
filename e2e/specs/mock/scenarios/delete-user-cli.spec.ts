import fs from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { Db } from 'mongodb';
import { withMongo } from '../db';

const PASSWORD = 'Erasure-Scenario-1!';
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NO_AUTO_INDEX = path.join(__dirname, 'no-auto-index.cjs');

function getMongoUri(): string {
  const runtimeEnvPath =
    process.env.E2E_RUNTIME_ENV_PATH ??
    path.resolve(__dirname, '../../.test-results/runtime-env.json');
  try {
    const env = JSON.parse(fs.readFileSync(runtimeEnvPath, 'utf8')) as { MONGO_URI?: string };
    if (env.MONGO_URI) {
      return env.MONGO_URI;
    }
  } catch {
    /* fall through to env */
  }
  return process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/LibreChat-e2e';
}

/** A seeded account and the upload it owns on local storage. */
interface Seeded {
  userId: string;
  uploadPath: string;
}

async function register(request: APIRequestContext, prefix: string): Promise<string> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
  const response = await request.post('/api/auth/register', {
    data: { email, name: 'Erasure Scenario', password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  return email;
}

async function seedOwnedData(email: string): Promise<Seeded> {
  return withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email });
    if (!user) {
      throw new Error(`seed: user ${email} not found`);
    }
    const userObjectId = user._id as ObjectId;
    const userId = userObjectId.toString();
    const fileName = `${randomUUID()}.txt`;
    const uploadDir = path.join(REPO_ROOT, 'uploads', userId);
    fs.mkdirSync(uploadDir, { recursive: true });
    const uploadPath = path.join(uploadDir, fileName);
    fs.writeFileSync(uploadPath, 'erasure scenario upload');

    await Promise.all([
      db.collection('files').insertOne({
        user: userObjectId,
        file_id: randomUUID(),
        filename: fileName,
        filepath: `/uploads/${userId}/${fileName}`,
        source: 'local',
        type: 'text/plain',
        bytes: 23,
        object: 'file',
        usage: 0,
      }),
      db.collection('agentapikeys').insertOne({
        userId: userObjectId,
        name: 'scenario key',
        keyHash: randomUUID(),
        keyPrefix: 'sk-scn',
      }),
      db.collection('mcpservers').insertOne({
        serverName: `erasure-${userId}`,
        author: userObjectId,
        config: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
      }),
      db
        .collection('toolfavorites')
        .insertOne({ user: userObjectId, itemType: 'tool', itemId: 'web' }),
      db.collection('chatprojects').insertOne({ user: userId, name: `project-${userId}` }),
      db
        .collection('transactions')
        .insertOne({ user: userObjectId, tokenType: 'prompt', rawAmount: -1 }),
    ]);
    return { userId, uploadPath };
  });
}

/** Removes the bystander's upload directory so local storage does not grow across runs. */
function removeUploads(seeded: Seeded | undefined) {
  if (seeded) {
    fs.rmSync(path.dirname(seeded.uploadPath), { recursive: true, force: true });
  }
}

async function countOwned(db: Db, userId: string): Promise<Record<string, number>> {
  const userObjectId = new ObjectId(userId);
  const [users, files, agentApiKeys, mcpServers, toolFavorites, chatProjects, transactions] =
    await Promise.all([
      db.collection('users').countDocuments({ _id: userObjectId }),
      db.collection('files').countDocuments({ user: userObjectId }),
      db.collection('agentapikeys').countDocuments({ userId: userObjectId }),
      db.collection('mcpservers').countDocuments({ author: userObjectId }),
      db.collection('toolfavorites').countDocuments({ user: userObjectId }),
      db.collection('chatprojects').countDocuments({ user: userId }),
      db.collection('transactions').countDocuments({ user: userObjectId }),
    ]);
  return { users, files, agentApiKeys, mcpServers, toolFavorites, chatProjects, transactions };
}

const ERASED = {
  users: 0,
  files: 0,
  agentApiKeys: 0,
  mcpServers: 0,
  toolFavorites: 0,
  chatProjects: 0,
};
const KEPT = {
  users: 1,
  files: 1,
  agentApiKeys: 1,
  mcpServers: 1,
  toolFavorites: 1,
  chatProjects: 1,
  transactions: 1,
};

/**
 * Drives the interactive delete CLI the way an operator would: every confirmation is answered
 * "y" except the transaction-history prompt, which takes `deleteTransactions`.
 */
function runDeleteCli(
  email: string,
  deleteTransactions: boolean,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'config/delete-user.js'), email], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MONGO_URI: getMongoUri(),
      /** The harness server already built the indexes; skip the module-scope rebuild. */
      NODE_OPTIONS: process.env.NODE_OPTIONS
        ? `${process.env.NODE_OPTIONS} --require ${NO_AUTO_INDEX}`
        : `--require ${NO_AUTO_INDEX}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let answered = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    const prompts = stdout.split('(y/N)').length - 1;
    while (answered < prompts) {
      const preceding = stdout.split('(y/N)')[answered];
      const isLedgerPrompt = preceding.includes('transaction history');
      child.stdin?.write(isLedgerPrompt && !deleteTransactions ? 'n\n' : 'y\n');
      answered += 1;
    }
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`delete CLI timed out; stdout: ${stdout.slice(-400)}`));
    }, 90_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin?.end();
      resolve({ code, stdout, stderr });
    });
  });
}

test.describe('account erasure', () => {
  test.describe.configure({ mode: 'serial' });

  for (const [deleteTransactions, scenario] of [
    [true, '@scenario:cli-delete-user-erases-owned-data'],
    [false, '@scenario:cli-delete-user-keeps-declined-ledger'],
  ] as const) {
    test(`the delete-user CLI erases the account's data ${deleteTransactions ? 'and' : 'but keeps'} its ledger ${scenario}`, async ({
      playwright,
      baseURL,
    }) => {
      test.setTimeout(150_000);
      const request = await playwright.request.newContext({ baseURL });
      let kept: Seeded | undefined;
      try {
        const email = await register(request, 'cli-erase');
        const bystander = await register(request, 'cli-keep');
        const target = await seedOwnedData(email);
        kept = await seedOwnedData(bystander);

        const result = await runDeleteCli(email, deleteTransactions);
        expect(result.code, result.stderr.slice(-800)).toBe(0);
        expect(result.stdout).toContain('Successfully deleted user');

        await withMongo(async (db) => {
          expect(await countOwned(db, target.userId)).toEqual({
            ...ERASED,
            transactions: deleteTransactions ? 0 : 1,
          });
          expect(await countOwned(db, kept.userId)).toEqual(KEPT);
        });
        expect(fs.existsSync(target.uploadPath)).toBe(false);
        expect(fs.existsSync(kept.uploadPath)).toBe(true);
      } finally {
        removeUploads(kept);
        await request.dispose();
      }
    });
  }

  test('self-service deletion erases the same stores as the CLI @scenario:self-delete-erases-owned-data', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        'X-Forwarded-For': `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
      },
    });
    let kept: Seeded | undefined;
    try {
      const email = await register(request, 'self-erase');
      const bystander = await register(request, 'self-keep');
      const target = await seedOwnedData(email);
      kept = await seedOwnedData(bystander);
      const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
      expect(login.ok()).toBeTruthy();
      const { token } = (await login.json()) as { token: string };

      const deletion = await request.delete('/api/user/delete', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(deletion.status()).toBe(200);

      await withMongo(async (db) => {
        expect(await countOwned(db, target.userId)).toEqual({ ...ERASED, transactions: 0 });
        expect(await countOwned(db, kept.userId)).toEqual(KEPT);
      });
      expect(fs.existsSync(target.uploadPath)).toBe(false);
      expect(fs.existsSync(kept.uploadPath)).toBe(true);
    } finally {
      removeUploads(kept);
      await request.dispose();
    }
  });
});
