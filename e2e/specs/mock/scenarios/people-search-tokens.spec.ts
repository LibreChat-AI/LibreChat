import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { expect, test } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson, uniqueName } from '../helpers';
import { openAgentBuilder, uniqueAgentName, cleanupAgent } from '../agents.helpers';
import { withMongo, getMongoUri } from '../db';

/**
 * People search (`GET /api/permissions/search-principals`, the share dialog's
 * picker) matches word prefixes over the derived `nameTokens` / `emailTokens` /
 * `usernameTokens` arrays. These scenarios register users through the real
 * auth route, so the schema middleware writes the tokens, and drive the
 * backfill script (`npm run migrate:search-tokens`) against this run's database
 * for documents a writer left without tokens or with stale ones.
 *
 * The primary e2e user is the first one registered in the run, so it is ADMIN
 * and may search principals and share agents without seeding role permissions
 * (see `principal-type-labels.spec.ts`).
 */

const SEARCH_LABEL = 'Search for people or groups by name or email';
const SEARCH_PATH = '/api/permissions/search-principals';
const REPO_ROOT = path.resolve(__dirname, '../../../..');

type SearchResult = { name?: string; email?: string; type: string };

/** Letters only, so a suffix stays one search word. */
function suffix(): string {
  return Array.from({ length: 7 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
}

async function register(page: Page, name: string, email: string, username: string) {
  const password = 'Search-tokens-pass-1';
  const response = await page.request.post('/api/auth/register', {
    data: { name, email, username, password, confirm_password: password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function search(page: Page, token: string, q: string): Promise<SearchResult[]> {
  const body = await requestJson<{ results: SearchResult[] }>(page, {
    path: `${SEARCH_PATH}?q=${encodeURIComponent(q)}&limit=20`,
    token,
  });
  return body.results;
}

async function deleteUsers(emails: string[]): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('users').deleteMany({ email: { $in: emails } });
  });
}

async function openShareDialog(page: Page): Promise<{ dialog: Locator; agentId: string }> {
  const agentName = uniqueAgentName('E2E People Search');
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: { name: agentName, provider: MOCK_ENDPOINTS[0].label, model: MOCK_ENDPOINTS[0].model },
  });
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await page.getByRole('button', { name: `Share ${agentName}` }).click();
  const dialog = page.getByRole('dialog', { name: `Share ${agentName}` });
  await expect(dialog).toBeVisible();
  return { dialog, agentId: agent.id };
}

const execFileAsync = promisify(execFile);

/** Async so a stuck script fails the test on its timeout instead of blocking the worker. */
async function runBackfill(): Promise<void> {
  try {
    await execFileAsync('node', ['config/migrate-search-tokens.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, MONGO_URI: getMongoUri() },
      timeout: 60000,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    throw new Error(
      `Backfill failed: ${String(error)}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`,
    );
  }
}

test.describe('people search over word-prefix tokens', () => {
  test('@scenario:people-search-matches-word-prefixes the share dialog finds a user by the start of each name word, and not by a fragment inside a word', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const id = suffix();
    const user = { name: `Quill${id} Brightwater`, email: `${uniqueName('quill')}@search.test` };
    let agentId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await register(page, user.name, user.email, `quill${id}`);

      const opened = await openShareDialog(page);
      agentId = opened.agentId;
      const searchBox = opened.dialog.getByRole('combobox', { name: SEARCH_LABEL });
      await searchBox.fill(`brig quill${id.slice(0, 3)}`);
      await expect(opened.dialog.getByRole('option').filter({ hasText: user.name })).toBeVisible({
        timeout: 10000,
      });

      const token = await getAccessToken(page);
      expect((await search(page, token, `ill${id}`)).map((r) => r.email)).not.toContain(user.email);
      expect((await search(page, token, user.email.slice(0, 12))).map((r) => r.email)).toContain(
        user.email,
      );
    } finally {
      await cleanupAgent(page, agentId);
      await deleteUsers([user.email]);
    }
  });

  test('@scenario:people-search-folds-accents-and-ranks-exact-first an unaccented query finds an accented name and ranks its exact match above a longer prefix match', async ({
    page,
  }) => {
    const id = suffix();
    const exact = { name: `Zoë${id}`, email: `${uniqueName('zoe-exact')}@search.test` };
    const prefix = { name: `Zoe${id}x Park`, email: `${uniqueName('zoe-prefix')}@search.test` };
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await register(page, prefix.name, prefix.email, `zoep${id}`);
      await register(page, exact.name, exact.email, `zoee${id}`);

      const token = await getAccessToken(page);
      const results = await search(page, token, `zoe${id}`);
      expect(results.map((r) => r.name)).toEqual([exact.name, prefix.name]);
    } finally {
      await deleteUsers([exact.email, prefix.email]);
    }
  });

  test('@scenario:backfill-repairs-missing-and-stale-tokens a user saved without tokens is still found, a user whose tokens went stale is found under the new name once the backfill runs', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const id = suffix();
    const legacy = { name: `Legacy${id} Person`, email: `${uniqueName('legacy')}@search.test` };
    const renamed = { name: `Renamed${id} Person`, email: `${uniqueName('renamed')}@search.test` };
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const primary = await withMongo((db) =>
        db.collection('users').findOne({}, { sort: { createdAt: 1 } }),
      );
      /** Raw writes, as an older server would leave them: one user with no
       *  tokens at all, one renamed without its tokens being rewritten. */
      await withMongo(async (db) => {
        const now = new Date();
        await db.collection('users').insertMany([
          { ...legacy, tenantId: primary?.tenantId, createdAt: now, updatedAt: now },
          {
            ...renamed,
            tenantId: primary?.tenantId,
            nameTokens: [`original${id}`, 'person'],
            emailTokens: [renamed.email],
            usernameTokens: [],
            createdAt: now,
            updatedAt: now,
          },
        ]);
      });

      const token = await getAccessToken(page);
      const emails = async (q: string) => (await search(page, token, q)).map((r) => r.email);
      expect(await emails(`gacy${id}`)).toContain(legacy.email);
      expect(await emails(`renamed${id}`)).not.toContain(renamed.email);

      await runBackfill();

      expect(await emails(`renamed${id}`)).toContain(renamed.email);
      expect(await emails(`original${id}`)).not.toContain(renamed.email);
      expect(await emails(`legacy${id}`)).toContain(legacy.email);
      const stored = await withMongo((db) =>
        db.collection('users').findOne({ email: legacy.email }),
      );
      expect(stored?.nameTokens).toEqual([`legacy${id}`, 'person']);
    } finally {
      await deleteUsers([legacy.email, renamed.email]);
    }
  });

  test('@scenario:people-picker-searches-once-per-pause typing a query character by character sends one search request, not one per keystroke', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const id = suffix();
    const user = { name: `Pause${id} Typist`, email: `${uniqueName('pause')}@search.test` };
    let agentId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await register(page, user.name, user.email, `pause${id}`);
      const opened = await openShareDialog(page);
      agentId = opened.agentId;

      const queries: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === SEARCH_PATH) {
          queries.push(url.searchParams.get('q') ?? '');
        }
      });
      const searchBox = opened.dialog.getByRole('combobox', { name: SEARCH_LABEL });
      await searchBox.pressSequentially(`pause${id}`, { delay: 40 });
      await expect(opened.dialog.getByRole('option').filter({ hasText: user.name })).toBeVisible({
        timeout: 10000,
      });
      expect(queries).toEqual([`pause${id}`]);
    } finally {
      await cleanupAgent(page, agentId);
      await deleteUsers([user.email]);
    }
  });
});
