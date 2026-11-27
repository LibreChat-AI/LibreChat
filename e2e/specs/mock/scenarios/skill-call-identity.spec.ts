import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { Browser, Page, TestInfo } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import cleanupUser from '../../../setup/cleanupUser';
import { inOneProject, repoRoot } from './lint.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  enableSkills,
  escapeRegExp,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * A skill call is saved with the id of the skill it loaded, and its card finds the instructions
 * and the Open skill target by that id. Names are unique only per author, so a call that carries
 * no id, such as one in a conversation continued from a share link, keeps the output it recorded
 * even when the reader has a skill with the same name.
 */

type Skill = { _id: string; name: string; version: number };

const uniqueSkillName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
const loaded = (name: string) => `Skill "${name}" loaded. Follow the instructions below.`;

/** The fake model checks that the primed body starts with the skill's heading. */
async function createSkill(page: Page, token: string, name: string, instructions: string) {
  return requestJson<Skill>(page, {
    path: '/api/skills',
    token,
    method: 'POST',
    body: { name, description: `Instructions for ${name}.`, body: `# ${name}\n\n${instructions}` },
  });
}

async function deleteSkill(page: Page, token: string, id: string | undefined) {
  if (id == null) {
    return;
  }
  await requestJson(page, { path: `/api/skills/${id}`, token, method: 'DELETE' }).catch(
    () => undefined,
  );
}

/** Renames the skill, so a lookup by the name the call ran under no longer finds it. */
async function renameSkill(page: Page, token: string, skill: Skill) {
  await requestJson(page, {
    path: `/api/skills/${skill._id}`,
    token,
    method: 'PATCH',
    body: { name: `${skill.name}-renamed`, expectedVersion: skill.version },
  });
}

async function startSkillChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await enableSkills(page);
}

/** Opens the card of the skill call named `name` if it is folded. */
async function expandSkill(page: Page, name: string) {
  const row = messagesView(page)
    .getByRole('button', { name: new RegExp(`Loaded ${escapeRegExp(name)}`) })
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

function conversationIdOf(page: Page): string {
  const match = new URL(page.url()).pathname.match(/^\/c\/([^/]+)$/);
  expect(match?.[1], 'the reply should open a saved conversation').toBeTruthy();
  return match?.[1] ?? '';
}

type ToolCallPart = { type?: string; tool_call?: { name?: string; skillId?: string } };

/** The `skill` calls a conversation was saved with. */
async function savedSkillCalls(page: Page, token: string, conversationId: string) {
  const messages = await fetchJson<TMessage[]>(page, `/api/messages/${conversationId}`, token);
  return messages
    .flatMap((message) => (message.content ?? []) as ToolCallPart[])
    .filter((part) => part?.type === 'tool_call' && part.tool_call?.name === 'skill')
    .map((part) => part.tool_call);
}

/** A second reader in the project's device and color scheme. */
function readerContext(browser: Browser, testInfo: TestInfo) {
  const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, colorScheme } =
    testInfo.project.use;
  return browser.newContext({
    baseURL,
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    colorScheme,
    locale: 'en-US',
    storageState: { cookies: [], origins: [] },
  });
}

test.describe('skill call identity', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a skill call opens the skill it loaded, live and after that skill is renamed @scenario:skill-call-opens-the-skill-it-loaded', async ({
    page,
  }) => {
    const name = uniqueSkillName('e2e-skill-identity');
    const instructions = `Steps written for ${name}.`;
    await startSkillChat(page);
    const token = await getAccessToken(page);
    const skill = await createSkill(page, token, name, instructions);
    try {
      const response = await sendMessage(page, `E2E_INVOKE_SKILL:${name}`);
      expect(response.ok()).toBeTruthy();
      const view = messagesView(page);
      await expect(view.getByText(`E2E skill tool assertion passed: ${name}`)).toBeVisible({
        timeout: 30_000,
      });

      await expandSkill(page, name);
      await expect(view.getByText(instructions)).toBeVisible();
      expect(await savedSkillCalls(page, token, conversationIdOf(page))).toEqual([
        expect.objectContaining({ skillId: skill._id }),
      ]);

      await renameSkill(page, token, skill);
      await page.reload();
      await expect(view.getByText(`E2E skill tool assertion passed: ${name}`)).toBeVisible({
        timeout: 20_000,
      });
      await expandSkill(page, name);
      await expect(view.getByText(instructions)).toBeVisible();
      await view.getByRole('button', { name: 'Open skill' }).click();
      await expect(page).toHaveURL(new RegExp(`/skills/${skill._id}`));
    } finally {
      await deleteSkill(page, token, skill._id);
    }
  });

  test('a skill picked with $ opens the skill on its card, after that skill is renamed @scenario:manual-skill-card-opens-the-skill', async ({
    page,
  }) => {
    const name = uniqueSkillName('e2e-skill-manual');
    const instructions = `Steps picked for ${name}.`;
    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    const token = await getAccessToken(page);
    const skill = await createSkill(page, token, name, instructions);
    try {
      /** The picker lists the library as the chat loads, so the skill exists first. */
      await startSkillChat(page);
      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.click();
      await input.fill('');
      await input.pressSequentially('$');
      const search = page.getByPlaceholder('Select a Skill by name');
      await expect(search).toBeVisible();
      await search.fill(name);
      await page.locator('button[id^="skill-item-"]').filter({ hasText: name }).click();
      await expect(search).toBeHidden();
      await expect(
        page.getByTestId('composer-tray').getByTestId('composer-chip-skill').filter({
          hasText: name,
        }),
      ).toBeVisible();

      const response = await sendMessage(page, `E2E_ASSERT_MANUAL_SKILL:${name}`);
      expect(response.ok()).toBeTruthy();
      const view = messagesView(page);
      await expect(view.getByText(`E2E manual skill assertion passed: ${name}`)).toBeVisible({
        timeout: 30_000,
      });
      expect(await savedSkillCalls(page, token, conversationIdOf(page))).toEqual([
        expect.objectContaining({ skillId: skill._id }),
      ]);

      await renameSkill(page, token, skill);
      await page.reload();
      await expect(view.getByText(`E2E manual skill assertion passed: ${name}`)).toBeVisible({
        timeout: 20_000,
      });
      await expandSkill(page, name);
      await expect(view.getByText(instructions)).toBeVisible();
      await view.getByRole('button', { name: 'Open skill' }).click();
      await expect(page).toHaveURL(new RegExp(`/skills/${skill._id}`));
    } finally {
      await deleteSkill(page, token, skill._id);
    }
  });

  test("a conversation continued from a share link keeps a skill call's output, not the reader's same-named skill @scenario:continued-share-skill-call-keeps-output", async ({
    page,
    browser,
  }, testInfo) => {
    const name = uniqueSkillName('e2e-skill-continued');
    const authorInstructions = `The author wrote ${name}.`;
    const readerInstructions = `The reader wrote ${name}.`;
    const reader = {
      email: `${name}@example.com`,
      name: 'Skill Reader',
      password: 'securepassword789',
    };
    await startSkillChat(page);
    const token = await getAccessToken(page);
    const authorSkill = await createSkill(page, token, name, authorInstructions);
    const context = await readerContext(browser, testInfo);
    const readerPage = await context.newPage();
    let shareId: string | undefined;
    let readerToken: string | undefined;
    let readerSkill: Skill | undefined;
    try {
      const response = await sendMessage(page, `E2E_INVOKE_SKILL:${name}`);
      expect(response.ok()).toBeTruthy();
      await expect(
        messagesView(page).getByText(`E2E skill tool assertion passed: ${name}`),
      ).toBeVisible({ timeout: 30_000 });
      const share = await requestJson<{ shareId: string }>(page, {
        path: `/api/share/${conversationIdOf(page)}`,
        token,
        method: 'POST',
        body: {},
      });
      shareId = share.shareId;

      const registered = await context.request.post('/api/auth/register', {
        data: { ...reader, confirm_password: reader.password },
      });
      expect(registered.ok(), await registered.text()).toBeTruthy();
      const signedIn = await context.request.post('/api/auth/login', {
        data: { email: reader.email, password: reader.password },
      });
      expect(signedIn.ok(), await signedIn.text()).toBeTruthy();

      await readerPage.goto(`/share/${shareId}`, { timeout: 30_000 });
      readerToken = await getAccessToken(readerPage);
      readerSkill = await createSkill(readerPage, readerToken, name, readerInstructions);
      await readerPage.getByRole('button', { name: 'Continue this chat' }).click();
      await expect(readerPage).toHaveURL(/\/c\/[^/]+$/, { timeout: 30_000 });
      const view = messagesView(readerPage);
      await expect(view.getByText(`E2E skill tool assertion passed: ${name}`)).toBeVisible({
        timeout: 30_000,
      });

      /** A lookup by name would start as the card opens and the reader's library answers at once,
       *  so waiting out a short window for it lets the checks below fail against the old card. */
      const lookup = readerPage
        .waitForRequest(
          (request) => {
            const url = new URL(request.url());
            return (
              url.pathname === `/api/skills/${readerSkill?._id}` ||
              (url.pathname === '/api/skills' && url.searchParams.get('search') === name)
            );
          },
          { timeout: 2_000 },
        )
        .then(
          () => true,
          () => false,
        );
      await expandSkill(readerPage, name);
      const lookedUp = await lookup;
      if (lookedUp) {
        /** Let the lookup's answer render, so the capture shows what replaced the output. */
        await view
          .getByText(readerInstructions)
          .waitFor({ timeout: 5_000 })
          .catch(() => undefined);
      }
      await view.screenshot({ path: testInfo.outputPath('continued-copy.png') });
      expect(lookedUp).toBe(false);
      await expect(view.getByText(loaded(name))).toBeVisible();
      await expect(view.getByText(readerInstructions)).toHaveCount(0);
      await expect(view.getByText(authorInstructions)).toHaveCount(0);
      await expect(view.getByRole('button', { name: 'Open skill' })).toHaveCount(0);
    } finally {
      if (readerToken != null) {
        await deleteSkill(readerPage, readerToken, readerSkill?._id);
      }
      await context.close();
      await cleanupUser(reader);
      if (shareId != null) {
        await requestJson(page, { path: `/api/share/${shareId}`, token, method: 'DELETE' }).catch(
          () => undefined,
        );
      }
      await deleteSkill(page, token, authorSkill._id);
    }
  });
});

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const CALLBACKS_SPEC = 'server/controllers/agents/__tests__/callbacks.spec.js';
const SUITE = 'skill call identity';

/**
 * A subagent's calls reach the browser and the saved transcript through the host's subagent
 * aggregation, which the mock model has no child skill call to drive, so its verdict comes from
 * one run of the callbacks spec on the real handlers and the SDK's aggregator.
 */
function subagentResults(): JestAssertion[] {
  const result = spawnSync(
    resolve(repoRoot, 'node_modules/.bin/jest'),
    [CALLBACKS_SPEC, '-t', SUITE, '--json', '--maxWorkers=1'],
    {
      cwd: resolve(repoRoot, 'api'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 150_000,
    },
  );
  const stdout = result.stdout ?? '';
  const output = `${stdout}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`jest did not pass (${result.error?.message ?? result.status}):\n${output}`);
  }
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`jest printed no JSON report:\n${output}`);
  }
  const report = JSON.parse(stdout.slice(start)) as JestReport;
  return report.testResults.flatMap((file) => file.assertionResults);
}

test("a subagent's skill call is sent and saved with the skill it loaded @scenario:subagent-skill-call-keeps-its-skill", () => {
  inOneProject();
  test.setTimeout(180_000);
  const fullName = `${SUITE} stamps a subagent's skill call in the update sent on and the saved transcript`;
  const assertion = subagentResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no callbacks spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
});
