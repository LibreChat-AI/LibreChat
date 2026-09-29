import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent } from './agents.helpers';
import {
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessageAndWaitForCompletion,
} from './helpers';

/**
 * Opt-in coverage for uploaded files reaching the code sandbox — the one leg
 * the credential-free mock suite cannot fake, so it requires a live Code API
 * and skips otherwise. Run with:
 *
 *   E2E_CODE_BASEURL=http://localhost:3112/v1 \
 *   E2E_CODE_API_KEY=dummy \
 *   npx playwright test --config=e2e/playwright.config.mock.ts code-upload
 *
 * The fake model maps the E2E_EXEC_UPLOADED:/E2E_EXEC_PERSIST: markers to real
 * `execute_code` bash calls, so everything between the browser and the sandbox
 * is the production path: attaching the file uploads it to the Code API,
 * turn 1's exec reads it back from /mnt/data and drops a marker file no upload
 * ever contained, and turn 2 (sent WITHOUT an attachment) reads both — which
 * only works when the run reuses the same stateful runtime session.
 */

const CODE_BASEURL = process.env.E2E_CODE_BASEURL?.trim() ?? '';
const FILE_NAME = 'e2e-sandbox-data.csv';
const FILE_CONTENT = 'name,value\nalpha,1\nbeta,2\n';
const EXEC_FINAL_TEXT = 'E2E code exec complete';
const PERSIST_FINAL_TEXT = 'E2E code persistence complete';
/* Produced only by sandbox command OUTPUT (the fake model's commands keep
 * these strings out of the tool args via printf formats), so matching the
 * conversation transcript cannot be satisfied by the commands themselves. */
const TURN1_OUTPUT_NEEDLE = 'alpha,1';
const TURN2_LINES_NEEDLE = 'LINES=3';
const TURN2_MARKER_NEEDLE = 'turn1-proof-42';

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const modelTrigger = (page: Page) => page.getByRole('button', { name: 'Select a model' }).first();

async function startFresh(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await page.evaluate(() => localStorage.clear());
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
}

type AgentResponse = { id: string };

async function createCodeAgent(page: Page, name: string): Promise<AgentResponse> {
  const token = await getAccessToken(page);
  return requestJson<AgentResponse>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
      tools: ['execute_code'],
      stateful_code_sessions: true,
      stateful_code_environment: 'conversation',
    },
  });
}

async function selectAgent(page: Page, agentName: string) {
  await modelTrigger(page).click();
  await page.getByRole('option', { name: 'My Agents' }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(modelTrigger(page)).toContainText(agentName);
}

/** Attaches a CSV through the real attach menu → Code Environment target,
 *  which uploads it to the live Code API before the message is ever sent. */
async function attachCodeFile(page: Page) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      await page.getByRole('button', { name: 'Attach File Options' }).click();
      await page.getByRole('menuitem', { name: 'Upload to Code Environment' }).click();
    })(),
  ]);
  const [upload] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/files' && response.request().method() === 'POST',
      { timeout: 60_000 },
    ),
    chooser.setFiles({
      name: FILE_NAME,
      mimeType: 'text/csv',
      buffer: Buffer.from(FILE_CONTENT),
    }),
  ]);
  expect(upload.ok(), `code file upload returned ${upload.status()}`).toBeTruthy();
  await expect(page.getByText(FILE_NAME).first()).toBeVisible();
}

async function conversationIncludes(
  page: Page,
  conversationId: string,
  needle: string,
): Promise<boolean> {
  const token = await getAccessToken(page);
  const messages = await requestJson<unknown[]>(page, {
    path: `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
  });
  return JSON.stringify(messages).includes(needle);
}

test.describe('stateful code sandbox uploads', () => {
  test.skip(
    !CODE_BASEURL,
    'Requires a live Code API: set E2E_CODE_BASEURL (and optionally E2E_CODE_API_KEY)',
  );

  test('uploaded file reaches /mnt/data and the session persists across turns', async ({
    page,
  }) => {
    /* Two real sandbox execs, each possibly paying a cold VM boot. */
    test.setTimeout(600_000);

    await startFresh(page);
    const agentName = uniqueName('E2E Code Sandbox');
    let agentId: string | undefined;
    try {
      const agent = await createCodeAgent(page, agentName);
      agentId = agent.id;
      await selectAgent(page, agentName);

      await attachCodeFile(page);
      await sendMessageAndWaitForCompletion(page, `E2E_EXEC_UPLOADED:${FILE_NAME}`, {
        timeout: 180_000,
      });
      await expect(messagesView(page).getByText(`${EXEC_FINAL_TEXT}: ${FILE_NAME}`)).toBeVisible();

      await page.waitForURL(/\/c\/(?!new$)[^/?]+/, { timeout: 10_000 });
      const conversationId = new URL(page.url()).pathname.split('/').pop() as string;

      /* The exec's stdout — the uploaded bytes read back from /mnt/data. */
      await expect
        .poll(() => conversationIncludes(page, conversationId, TURN1_OUTPUT_NEEDLE), {
          timeout: 30_000,
        })
        .toBe(true);

      /* Turn 2 carries NO attachment: the line count re-reads the uploaded file
       * and the marker file exists only inside the prior turn's session. */
      await sendMessageAndWaitForCompletion(page, `E2E_EXEC_PERSIST:${FILE_NAME}`, {
        timeout: 180_000,
      });
      await expect(
        messagesView(page).getByText(`${PERSIST_FINAL_TEXT}: ${FILE_NAME}`),
      ).toBeVisible();

      await expect
        .poll(() => conversationIncludes(page, conversationId, TURN2_LINES_NEEDLE), {
          timeout: 30_000,
        })
        .toBe(true);
      await expect
        .poll(() => conversationIncludes(page, conversationId, TURN2_MARKER_NEEDLE), {
          timeout: 30_000,
        })
        .toBe(true);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
