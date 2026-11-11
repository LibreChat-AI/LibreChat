import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { cleanupAgent } from './agents.helpers';
import { withMongo, seedConversations, seedMessages } from './db';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import {
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
  sendMessage,
  mockReply,
  isAgentGenerationStart,
  selectMockEndpoint,
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

for (const interaction of ['pointer', 'keyboard']) {
  test(`opening the selector by ${interaction} starts its catalogs without waiting for browser idle`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.requestIdleCallback = () => 1;
      window.cancelIdleCallback = () => {};
    });
    const catalogs = new Set<string>();
    page.on('request', (request) => {
      if (request.method() !== 'GET') return;
      const url = new URL(request.url());
      if (url.pathname === '/api/models') catalogs.add('models');
      if (url.pathname === '/api/agents') catalogs.add('agents');
      if (/^\/api\/assistants\/v[12]$/.test(url.pathname)) catalogs.add('assistants');
    });
    await page.goto(`${NEW_CHAT_PATH}?spec=e2e-soft-default`);
    await expect(trigger(page)).toContainText('E2E Soft Default');
    await expect(composer(page)).toBeEditable();
    expect([...catalogs]).toEqual([]);

    if (interaction === 'keyboard') {
      await trigger(page).focus();
      await page.keyboard.press('Enter');
    } else {
      await trigger(page).click();
    }
    await expect.poll(() => [...catalogs].sort()).toEqual(['agents', 'assistants', 'models']);
    await page.getByRole('option', { name: 'Mock Provider C', exact: true }).click();
    await page.getByRole('option', { name: 'mock-model-c', exact: true }).click();
    await expect(trigger(page)).toContainText('mock-model-c');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(composer(page)).toBeEditable();
  });
}

test('selecting a model waits for its catalog and closes the picker before composer tools', async ({
  page,
}) => {
  const catalogs = holdCatalogs(page);
  await catalogs.install;
  try {
    await page.goto(`${NEW_CHAT_PATH}?spec=e2e-soft-default`);
    await expect(trigger(page)).toContainText('E2E Soft Default');
    let selected = false;
    const selection = selectMockEndpoint(page, {
      label: 'Mock Provider C',
      model: 'mock-model-c',
    }).then(() => {
      selected = true;
    });
    await expect(page.getByRole('status', { name: 'Loading...' })).toBeVisible();
    expect(selected).toBe(false);
    catalogs.release();
    await selection;
    await expect(trigger(page)).toContainText('mock-model-c');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Attach and tools' }).click();
    await expect(page.getByRole('dialog', { name: 'Attach and tools' })).toBeVisible();
  } finally {
    await catalogs.dispose();
  }
});

test('the endpoint selection helper commits model specs without looking for a submenu', async ({
  page,
}) => {
  await page.goto(`${NEW_CHAT_PATH}?spec=e2e-soft-default`);
  for (const endpoint of [
    { label: 'Mock Provider A', model: 'mock-model-a' },
    { label: 'Mock Provider B', model: 'mock-model-b' },
  ]) {
    await selectMockEndpoint(page, endpoint);
    await expect(trigger(page)).toContainText(endpoint.label);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  }
});

test('cold history fetch starts while configuration is pending, without exposing the composer', async ({
  page,
}) => {
  const conversationId = '17692000-0000-4000-8000-000000000010';
  const marker = 'History started before configuration';
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await seedConversations(getPrimaryE2EUser().email, [
    { conversationId, title: marker, updatedAt: new Date() },
  ]);
  await seedMessages(getPrimaryE2EUser().email, conversationId, [
    {
      messageId: '17692000-0000-4000-8000-000000000011',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: marker,
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/config', async (route) => {
    await pending;
    await route.continue();
  });
  try {
    const history = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/messages/${conversationId}`,
    );
    await page.goto(`/c/${conversationId}`, { waitUntil: 'domcontentloaded' });
    expect((await history).ok()).toBeTruthy();
    await expect.poll(() => requests.includes('/api/files')).toBe(true);
    expect(requests.indexOf(`/api/convos/${conversationId}`)).toBeLessThan(
      requests.indexOf('/api/files'),
    );
    expect(requests.filter((path) => path === `/api/messages/${conversationId}`)).toHaveLength(1);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeHidden();
    release();
    await expect(page.getByText(marker, { exact: true }).last()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
