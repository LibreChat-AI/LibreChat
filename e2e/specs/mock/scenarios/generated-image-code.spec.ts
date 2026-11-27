import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  uniqueName,
  requestJson,
  getCodeExecs,
  messagesView,
  getAccessToken,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * An image an agent's tool generates is an input for the code it runs next. The fake model calls
 * the real Flux tool against `e2e/setup/fake-flux-server.js` and then bash_tool, and the fake code
 * server records which files it mounted for each exec, which is what the sandbox lists in
 * /mnt/data.
 */

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

/** Generated images are saved as `<file_id>-<tool>_img_<id>.png`. */
const GENERATED_IMAGE = /^[\w-]+-flux_img_[\w-]+\.png$/;

async function createAgent(page: Page): Promise<AgentDetail> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const token = await getAccessToken(page);
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Image Code Agent'),
      description: 'Generates an image with Flux and runs code over it.',
      instructions: 'Follow the scenario the test requests.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: { maxContextTokens: 128000 },
      tools: ['flux', 'execute_code'],
    },
  });
  expect(agent.tools).toEqual(expect.arrayContaining(['flux', 'execute_code']));
  return agent;
}

async function selectAgent(page: Page, agent: AgentDetail) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name ?? '');
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

/** The files the fake code server mounted for this scenario's bash call. */
async function mountedFiles(page: Page, label: string): Promise<string[]> {
  const exec = (await getCodeExecs(page)).find((entry) =>
    entry.code.includes(`E2E_IMAGE_CODE:${label}`),
  );
  expect(exec, 'the bash call reaches the sandbox').toBeDefined();
  return exec?.fileNames ?? [];
}

async function withAgent(page: Page, run: () => Promise<void>) {
  const agent = await createAgent(page);
  try {
    await selectAgent(page, agent);
    await run();
  } finally {
    await cleanupAgent(page, agent.id);
  }
}

test('a generated image is mounted for the code call that follows it in the same turn @scenario:generated-image-reaches-code-same-turn', async ({
  page,
}) => {
  test.setTimeout(120000);
  await withAgent(page, async () => {
    const label = uniqueName('image-same-turn');
    await sendMessageAndWaitForCompletion(page, `E2E_IMAGE_CODE:both:${label}`);
    await expect(messagesView(page).getByText(`E2E image code complete: ${label}`)).toBeVisible({
      timeout: 30000,
    });

    const mounted = await mountedFiles(page, label);
    expect(mounted.filter((name) => GENERATED_IMAGE.test(name))).toHaveLength(1);
  });
});

test('an image generated on an earlier turn is mounted for a later code call @scenario:generated-image-reaches-code-later-turn', async ({
  page,
}) => {
  test.setTimeout(120000);
  await withAgent(page, async () => {
    const label = uniqueName('image-later-turn');
    const chat = messagesView(page);
    await sendMessageAndWaitForCompletion(page, `E2E_FLUX_IMAGE:generate:polling:${label}`);
    await expect(chat.getByText(`Flux image ready for ${label}.`)).toBeVisible({ timeout: 30000 });

    await sendMessageAndWaitForCompletion(page, `E2E_IMAGE_CODE:code:${label}`);
    await expect(chat.getByText(`E2E image code complete: ${label}`)).toBeVisible({
      timeout: 30000,
    });

    const mounted = await mountedFiles(page, label);
    expect(mounted.filter((name) => GENERATED_IMAGE.test(name))).toHaveLength(1);
  });
});
