import { expect, test } from '@playwright/test';
import type { TStartupConfig } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import { cleanupAgent } from './agents.helpers';
import {
  NEW_CHAT_PATH,
  getAccessToken,
  mockReply,
  requestJson,
  selectModelSpec,
  sendMessage,
} from './helpers';

/** Label of the `softDefault: true` spec in e2e/config/librechat.e2e.yaml. */
const SOFT_DEFAULT_LABEL = 'E2E Soft Default';

/** Name (URL identity) of the `softDefault: true` spec in e2e/config/librechat.e2e.yaml. */
const SOFT_DEFAULT_NAME = 'e2e-soft-default';

/** Ephemeral endpoint from e2e/config/librechat.e2e.yaml with no mirroring spec. */
const EPHEMERAL_ENDPOINT = { label: 'Mock Provider C', model: 'mock-model-c' };

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const modelTrigger = (page: Page) => page.getByRole('button', { name: 'Select a model' }).first();

/** Reset selection state so the test starts as a fresh instance (auth stays in cookies). */
async function startFresh(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await page.evaluate(() => localStorage.clear());
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
}

type AgentResponse = {
  id: string;
  name?: string | null;
};

async function createAgent(page: Page, name: string, description?: string): Promise<AgentResponse> {
  const token = await getAccessToken(page);
  return requestJson<AgentResponse>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      ...(description ? { description } : {}),
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
    },
  });
}

async function selectAgent(page: Page, agentName: string) {
  await modelTrigger(page).click();
  await page.getByRole('option', { name: 'My Agents' }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(modelTrigger(page)).toContainText(agentName);
}

async function selectEphemeralModel(page: Page) {
  await modelTrigger(page).click();
  await page.getByRole('option', { name: EPHEMERAL_ENDPOINT.label }).click();
  await page.getByRole('option', { name: EPHEMERAL_ENDPOINT.model, exact: true }).click();
  await expect(modelTrigger(page)).toContainText(EPHEMERAL_ENDPOINT.model);
}

async function sendAndAwaitReply(page: Page, text: string) {
  const response = await sendMessage(page, text);
  expect(response.ok()).toBeTruthy();
  await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
}

async function newChat(page: Page) {
  await page.getByTestId('new-chat-button').click();
  await expect(page).toHaveURL(/\/c\/new/, { timeout: 15000 });
}

test.describe('soft default model spec', () => {
  test('applies the soft default on a fresh instance and stays applied across reloads', async ({
    page,
  }) => {
    await startFresh(page);

    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    // Its own auto-application must not convert it into a sticky "last" selection
    // that would behave differently on the next load.
    await page.reload({ timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });
  });

  test('a previously selected agent outranks the soft default', async ({ page }) => {
    test.setTimeout(120000);
    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    const agentName = uniqueName('E2E Soft Agent');
    await createAgent(page, agentName);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await selectAgent(page, agentName);

    await page.reload({ timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(agentName, { timeout: 15000 });

    await page.getByTestId('new-chat-button').click();
    await expect(page).toHaveURL(/\/c\/new/, { timeout: 15000 });
    await expect(modelTrigger(page)).toContainText(agentName, { timeout: 15000 });
  });

  test('a previous ephemeral endpoint and model selection outranks the soft default', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    await selectEphemeralModel(page);

    await page.reload({ timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(EPHEMERAL_ENDPOINT.model, { timeout: 15000 });
    await expect(modelTrigger(page)).not.toContainText(SOFT_DEFAULT_LABEL);

    await page.getByTestId('new-chat-button').click();
    await expect(page).toHaveURL(/\/c\/new/, { timeout: 15000 });
    await expect(modelTrigger(page)).toContainText(EPHEMERAL_ENDPOINT.model, { timeout: 15000 });
  });

  test('stays soft on New Chat after the first conversation is sent', async ({ page }) => {
    test.setTimeout(120000);
    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    await sendAndAwaitReply(page, 'first soft conversation');

    await newChat(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });
  });

  test('viewing the soft conversation re-arms it on the next New Chat', async ({ page }) => {
    test.setTimeout(120000);
    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    await sendAndAwaitReply(page, 'soft history conversation');
    const softConvoUrl = page.url();

    await newChat(page);
    await selectEphemeralModel(page);

    await page.goto(softConvoUrl, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    // Fresh load (not the in-memory SPA transition, which masks the regression): the
    // cold ChatRoute path resolves the New Chat purely from getDefaultModelSpec.
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });
    await expect(modelTrigger(page)).not.toHaveText('Select a model');
  });

  // Regression: agents-only deployment (`addedEndpoints: [agents]`) — the selector
  // offers specs and agent picks only, so `hasEphemeralModelOptions` is false and the
  // soft default used to re-arm on every New Chat, discarding the user's agent. A
  // concrete agent pick is the one real selection such deployments provide and must
  // survive New Chat and a cold load; the soft default must still land fresh
  // instances. The allow-list is narrowed via `/api/config` interception because the
  // gate resolves entirely client-side from the startup config.
  test('a selected agent survives New Chat in an agents-only allow-list', async ({ page }) => {
    test.setTimeout(120000);
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = (await response.json()) as TStartupConfig;
      if (config.modelSpecs) {
        config.modelSpecs = { ...config.modelSpecs, addedEndpoints: ['agents'] };
      }
      await route.fulfill({ response, json: config });
    });

    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    const agentName = uniqueName('E2E Agents Only');
    await createAgent(page, agentName);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await selectAgent(page, agentName);
    await sendAndAwaitReply(page, 'agents-only agent conversation');

    await newChat(page);
    await expect(modelTrigger(page)).toContainText(agentName, { timeout: 15000 });

    // Cold load (not the SPA transition): ChatRoute resolves purely from getDefaultModelSpec.
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(agentName, { timeout: 15000 });

    // The soft default still owns the fresh-instance landing under this allow-list.
    await page.evaluate(() => localStorage.clear());
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });
  });

  // Regression: softDefault spec on an endpoint kept out of `addedEndpoints` (e.g. a
  // bedrock spec with `addedEndpoints: [agents, <custom>]`). Using the custom endpoint
  // leaves a model in history under a key the spec preset never matches, which used to
  // suppress the soft default and strand a freshly loaded New Chat on the unselectable
  // endpoint ("Select a model"). The spec must re-arm when it was the conversation used
  // last. A cold load is used because the SPA New Chat transition resolves non-
  // deterministically and can mask the dropped spec.
  test('re-arms on a fresh New Chat when the spec endpoint is outside the allow-list', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    await selectEphemeralModel(page);
    await sendAndAwaitReply(page, 'history on a different endpoint');

    await newChat(page);
    await selectModelSpec(page, SOFT_DEFAULT_LABEL);
    await sendAndAwaitReply(page, 'soft spec used last');
    const specConvoUrl = page.url();

    await page.goto(specConvoUrl, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });
    await expect(modelTrigger(page)).not.toHaveText('Select a model');
  });

  // Regression: two tabs share localStorage — one on the soft default spec, one on a
  // configured agent. Refreshing the agent tab stamps the agent as the last setup; a
  // cold load of `/c/new?spec=<name>` then carried only the spec NAME while the
  // endpoint and agent_id resurfaced from storage, rendering a chimera (spec chip over
  // an agent landing/composer). A spec named in the URL must resolve to its full preset.
  test('a spec named in the URL wins over a previously selected agent on a cold load', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    const agentName = uniqueName('E2E URL Spec Agent');
    const agentDescription = 'Powered by E2E Mock';
    await createAgent(page, agentName, agentDescription);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectAgent(page, agentName);

    // Mirrors refreshing the agent tab: the restored selection is re-stamped as the
    // last conversation setup.
    await page.reload({ timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(agentName, { timeout: 15000 });

    await page.goto(`${NEW_CHAT_PATH}?spec=${SOFT_DEFAULT_NAME}`, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    const main = page.getByRole('main');
    const composer = page.getByRole('textbox', { name: 'Message input' });
    const user = getPrimaryE2EUser();
    // The placeholder mirrors the sender chain, so a spec-launched chat shows the
    // spec label (matching the model selector), not the endpoint's display label.
    await expect(composer).toHaveAttribute('placeholder', new RegExp(SOFT_DEFAULT_LABEL), {
      timeout: 15000,
    });
    await expect(main).toContainText(user.name, { timeout: 15000 });
    await expect(main).not.toContainText(agentName);
    await expect(main).not.toContainText(agentDescription);

    // The mixed state used to be written back to localStorage; a follow-up cold load
    // of a plain New Chat must stay on the spec, not resurrect the agent.
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });
    await expect(main).not.toContainText(agentName);
  });

  // Regression: a stored agent selection can outlive the agent itself (deletion here;
  // switching orgs that share browser storage behaves the same, since the other org's
  // agent id never resolves). The dead pick used to keep suppressing the soft default
  // and strand a cold New Chat on the agents endpoint with nothing selected. Once the
  // agent list loads without the stored id, the pick is residue and the soft default
  // must re-arm.
  test('a stored agent that no longer exists yields to the soft default on a cold load', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await startFresh(page);
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });

    const agentName = uniqueName('E2E Stale Agent');
    const agent = await createAgent(page, agentName);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectAgent(page, agentName);

    await page.reload({ timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(agentName, { timeout: 15000 });

    await cleanupAgent(page, agent.id);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(SOFT_DEFAULT_LABEL, { timeout: 15000 });
    await expect(modelTrigger(page)).not.toHaveText('Select a model');

    // A live selection must still outrank the soft default after the fix: recreate,
    // select, and confirm the carry-forward behavior is intact on a cold load.
    const survivorName = uniqueName('E2E Live Agent');
    await createAgent(page, survivorName);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectAgent(page, survivorName);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(modelTrigger(page)).toContainText(survivorName, { timeout: 15000 });
  });
});
