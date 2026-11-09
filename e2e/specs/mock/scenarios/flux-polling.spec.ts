import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
} from '../helpers';

/**
 * The fake model calls the real Flux tool for `E2E_FLUX_IMAGE:<action>:<mode>:<label>`, and
 * `FLUX_API_BASE_URL` points at `e2e/setup/fake-flux-server.js`, which routes each task the
 * way the prompt's mode asks and records where every request went and whether it carried the
 * API key. `polling` mirrors the global `api.bfl.ai`: the task only exists at the returned
 * `polling_url`, and `/v1/get_result` on the base answers 404.
 */

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

const FLUX_TOOL_ID = 'flux';
const FLUX_PORT = process.env.E2E_FLUX_PORT || '8794';
const FLUX_ORIGIN = `http://127.0.0.1:${FLUX_PORT}`;
const RETRIEVAL_ERROR = 'An error occurred while retrieving';

type FluxRequest = { method: string; path: string; host: string; hasKey: boolean };

async function createAgent(page: Page): Promise<AgentDetail> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const token = await getAccessToken(page);
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Flux Agent'),
      description: 'Generates an image with the Flux tool.',
      instructions: 'Generate the image the test requests.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [FLUX_TOOL_ID],
    },
  });
  expect(agent.tools).toEqual(expect.arrayContaining([FLUX_TOOL_ID]));
  return agent;
}

async function selectAgent(page: Page, agent: AgentDetail) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name ?? '');
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

async function fluxRequests(request: APIRequestContext, label: string): Promise<FluxRequest[]> {
  const response = await request.get(`${FLUX_ORIGIN}/__requests?label=${label}`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { requests: FluxRequest[] }).requests;
}

/** Runs one Flux call through the chat and waits for the generated image to render. */
async function generateImage(page: Page, action: string, mode: string, label: string) {
  const agent = await createAgent(page);
  try {
    await selectAgent(page, agent);
    const response = await sendMessage(page, `E2E_FLUX_IMAGE:${action}:${mode}:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
    const chat = messagesView(page);
    await expect(chat.getByText(`Flux image ready for ${label}.`)).toBeVisible({
      timeout: 30000,
    });
    const image = chat.getByRole('img').filter({ visible: true });
    await expect(image.first()).toBeVisible();
    await expect(chat.getByText(RETRIEVAL_ERROR)).toHaveCount(0);
  } finally {
    await cleanupAgent(page, agent.id);
  }
}

const label = (prefix: string) => `${prefix}${Date.now().toString(36)}`;

test('a Flux image renders when the endpoint routes the task to a cluster polling_url @scenario:flux-image-from-cluster-polling-url', async ({
  page,
  request,
}) => {
  const id = label('poll');
  await generateImage(page, 'generate', 'polling', id);

  const reads = (await fluxRequests(request, id)).filter((entry) => entry.method === 'GET');
  expect(reads.some((entry) => entry.path === '/cluster/v1/get_result' && entry.hasKey)).toBe(true);
  expect(reads.some((entry) => entry.path === '/v1/get_result')).toBe(false);
});

test('a finetuned Flux image renders when the endpoint routes the task to a cluster polling_url @scenario:flux-finetuned-image-from-cluster-polling-url', async ({
  page,
  request,
}) => {
  const id = label('ft');
  await generateImage(page, 'finetuned', 'polling', id);

  const requests = await fluxRequests(request, id);
  expect(
    requests.some((entry) => entry.method === 'POST' && entry.path === '/v1/flux-pro-finetuned'),
  ).toBe(true);
  const reads = requests.filter((entry) => entry.method === 'GET');
  expect(reads.some((entry) => entry.path === '/cluster/v1/get_result' && entry.hasKey)).toBe(true);
  expect(reads.some((entry) => entry.path === '/v1/get_result')).toBe(false);
});

test('a Flux image renders from get_result on the base URL when no polling_url is returned @scenario:flux-image-without-polling-url', async ({
  page,
  request,
}) => {
  const id = label('legacy');
  await generateImage(page, 'generate', 'legacy', id);

  const reads = (await fluxRequests(request, id)).filter((entry) => entry.method === 'GET');
  expect(
    reads.some(
      (entry) =>
        entry.path === '/v1/get_result' && entry.host === `127.0.0.1:${FLUX_PORT}` && entry.hasKey,
    ),
  ).toBe(true);
});

test('the Flux key is never sent to a polling_url on another origin @scenario:flux-key-withheld-from-foreign-polling-url', async ({
  page,
  request,
}) => {
  const id = label('foreign');
  await generateImage(page, 'generate', 'foreign', id);

  const reads = (await fluxRequests(request, id)).filter((entry) => entry.method === 'GET');
  expect(reads.some((entry) => entry.host === `localhost:${FLUX_PORT}`)).toBe(false);
  expect(reads.some((entry) => entry.path === '/cluster/v1/get_result')).toBe(false);
  expect(
    reads.some(
      (entry) =>
        entry.path === '/v1/get_result' && entry.host === `127.0.0.1:${FLUX_PORT}` && entry.hasKey,
    ),
  ).toBe(true);
});
