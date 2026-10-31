import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent } from './agents.helpers';
import { withMongo } from './db';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import {
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
  sendMessage,
  mockReply,
  isAgentGenerationStart,
} from './helpers';

function holdCatalogs(page: Page, selectedEndpoint?: string) {
  let release!: () => void;
  let released = false;
  const held = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      resolve();
    };
  });
  const install = page.route(/\/api\/(models|agents)(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (
      selectedEndpoint &&
      url.pathname.endsWith('/models') &&
      url.searchParams.get('endpoint') === selectedEndpoint
    ) {
      await route.continue();
      return;
    }
    if (!released) await held;
    await route.continue();
  });
  return {
    install,
    release,
    dispose: async () => {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    },
  };
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const trigger = (page: Page) => page.getByRole('button', { name: 'Select a model' }).first();

test('a configured spec renders and sends while every discovery catalog is pending', async ({
  page,
}) => {
  const catalogs = holdCatalogs(page);
  await catalogs.install;
  const started = Date.now();
  await page.goto(`${NEW_CHAT_PATH}?spec=e2e-soft-default`);
  try {
    await expect(trigger(page)).toContainText('E2E Soft Default');
    await expect(composer(page)).toBeEditable();
    await composer(page).fill('Written while all catalogs are pending');
    console.log(`startup spec editable after ${Date.now() - started} ms with discovery held`);
    const response = await sendMessage(page, 'configured target without discovery');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible();
    await composer(page).fill('Draft preserved after discovery');
    const node = await composer(page).elementHandle();
    catalogs.release();
    await expect(composer(page)).toHaveValue('Draft preserved after discovery');
    expect(await composer(page).evaluate((element, original) => element === original, node)).toBe(
      true,
    );
  } finally {
    await catalogs.dispose();
  }
});

test('a raw endpoint resolves without waiting for other endpoints or agents', async ({ page }) => {
  const catalogs = holdCatalogs(page, 'Mock Provider C');
  await catalogs.install;
  await page.goto(`${NEW_CHAT_PATH}?endpoint=Mock%20Provider%20C`);
  try {
    await expect(trigger(page)).toContainText('mock-model-c');
    await expect(composer(page)).toBeEditable();
    const response = await sendMessage(page, 'endpoint scoped discovery');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible();
  } finally {
    await catalogs.dispose();
  }
});

test('a selected agent loads by id independently of the agent catalog', async ({ page }) => {
  await page.goto(NEW_CHAT_PATH);
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: `Startup agent ${Date.now()}`,
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
    },
  });
  const catalogs = holdCatalogs(page);
  await catalogs.install;
  try {
    await page.goto(`${NEW_CHAT_PATH}?endpoint=agents&agent_id=${agent.id}`);
    await expect(composer(page)).toBeEditable();
    const response = await sendMessage(page, 'agent detail before its catalog');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible();
  } finally {
    await catalogs.dispose();
    await cleanupAgent(page, agent.id);
  }
});

test('URL settings replace an unavailable saved agent before checking send readiness', async ({
  page,
}) => {
  const conversationId = '17692000-0000-4000-8000-000000000009';
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: getPrimaryE2EUser().email });
    if (!user) throw new Error('Test user unavailable');
    await db.collection('conversations').insertOne({
      conversationId,
      user: user._id.toString(),
      title: 'Unavailable startup target',
      endpoint: 'agents',
      agent_id: 'agent_deleted_startup_target',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });
  });
  const catalogs = holdCatalogs(page);
  await catalogs.install;
  let admissions = 0;
  page.on('response', (response) => {
    if (isAgentGenerationStart(response)) admissions++;
  });
  try {
    const response = page.waitForResponse(isAgentGenerationStart);
    await page.goto(
      `/c/${conversationId}?endpoint=Mock%20Provider%20C&model=mock-model-c&q=recover%20saved%20target&submit=true`,
    );
    expect((await response).ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible();
    await expect(trigger(page)).toContainText('mock-model-c');
    expect(admissions).toBe(1);
  } finally {
    await catalogs.dispose();
  }
});
