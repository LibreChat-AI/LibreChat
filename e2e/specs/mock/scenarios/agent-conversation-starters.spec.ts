import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  cleanupAgent,
  openAgentBuilder,
  selectMockModel,
  uniqueAgentName,
} from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, fetchJson, getAccessToken, requestJson } from '../helpers';

type StarterAgent = AgentDetail & { conversation_starters?: string[] };

const FORM_NAME = 'Agent configuration form';
const DRAFT_PLACEHOLDER = 'Enter a conversation starter';

const builderForm = (page: Page) => page.getByRole('form', { name: FORM_NAME });

const createAgentViaApi = async (page: Page, name: string, starters: string[]) => {
  const token = await getAccessToken(page);
  return requestJson<StarterAgent>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Agent conversation starters acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      conversation_starters: starters,
    },
  });
};

const fetchStarters = async (page: Page, agentId: string) => {
  const token = await getAccessToken(page);
  const agent = await fetchJson<StarterAgent>(
    page,
    `/api/agents/${encodeURIComponent(agentId)}/expanded`,
    token,
  );
  return agent.conversation_starters ?? [];
};

/** Picks another agent in the open builder, without navigating away. */
const switchAgent = async (form: Locator, name: string) => {
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await form.page().getByRole('option', { name, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  return form;
};

const selectAgentInBuilder = async (page: Page, name: string) =>
  switchAgent(await openAgentBuilder(page), name);

const saveAgent = async (form: Locator, agentId: string) => {
  const page = form.page();
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'PATCH' &&
        new URL(candidate.url()).pathname === `/api/agents/${agentId}` &&
        candidate.ok(),
      { timeout: 30000 },
    ),
    form.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  return response;
};

const addStarter = async (form: Locator, text: string) => {
  const draft = form.getByPlaceholder(DRAFT_PLACEHOLDER);
  await draft.fill(text);
  await draft.press('Enter');
  await expect(
    form.getByRole('textbox', { name: /^Conversation Starters \d+$/ }).last(),
  ).toHaveValue(text);
};

test.describe('agent conversation starters', () => {
  test('starters added in the builder appear on the agent chat landing @scenario:builder-starters-appear-on-agent-landing', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Starters Create');
    const starters = ['Plan my week', 'Summarize this article'];
    let agentId: string | undefined;

    try {
      let form = await openAgentBuilder(page);
      const createNew = form.getByRole('button', { name: 'Create New Agent' });
      if (await createNew.isVisible().catch(() => false)) {
        await createNew.click();
      }
      form = builderForm(page);
      await form.getByLabel('Agent name').fill(name);
      await form
        .getByRole('textbox', { name: 'Instructions', exact: true })
        .fill('Answer with the mock model.');
      await selectMockModel(page, true);
      form = builderForm(page);

      for (const starter of starters) {
        await addStarter(form, starter);
      }
      /** Enter adds a starter; it must not submit the agent form on its own. */
      await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeVisible();

      const [response] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === 'POST' &&
            new URL(candidate.url()).pathname === '/api/agents' &&
            candidate.status() === 201,
          { timeout: 30000 },
        ),
        form.getByRole('button', { name: 'Create', exact: true }).click(),
      ]);
      const created = (await response.json()) as StarterAgent;
      agentId = created.id;
      expect(created.conversation_starters).toEqual(starters);

      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      for (const starter of starters) {
        await expect(page.getByRole('button', { name: starter, exact: true })).toBeVisible({
          timeout: 30000,
        });
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('saving an unrelated field keeps stored starters byte for byte @scenario:unrelated-save-preserves-stored-starters', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Starters Preserve');
    /** Legal through the API: more than the builder renders, with padding. */
    const stored = [' Padded starter ', 'Two', 'Three', 'Four', 'Five beyond the cap'];
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgentViaApi(page, name, stored);
      agentId = agent.id;

      const form = await selectAgentInBuilder(page, name);
      await form.getByLabel('Agent description').fill('Only the description changed.');
      const response = await saveAgent(form, agentId);

      expect(response.request().postDataJSON()).not.toHaveProperty('conversation_starters');
      expect(await fetchStarters(page, agentId)).toEqual(stored);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('deleting every starter in the builder clears them @scenario:builder-clears-all-starters', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Starters Clear');
    const stored = ['First starter', 'Second starter'];
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgentViaApi(page, name, stored);
      agentId = agent.id;

      const form = await selectAgentInBuilder(page, name);
      for (const starter of stored) {
        await form.getByRole('button', { name: `Delete: ${starter}`, exact: true }).click();
      }
      await expect(form.getByRole('textbox', { name: /^Conversation Starters \d+$/ })).toHaveCount(
        0,
      );
      await saveAgent(form, agentId);

      expect(await fetchStarters(page, agentId)).toEqual([]);
      await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
        timeout: 10000,
      });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
        timeout: 30000,
      });
      for (const starter of stored) {
        await expect(page.getByRole('button', { name: starter, exact: true })).toBeHidden();
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('an unsent draft does not follow the user to another agent @scenario:starter-draft-stays-with-its-agent', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Starters Draft');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgentViaApi(page, name, ['Existing starter']);
      agentId = agent.id;

      let form = await selectAgentInBuilder(page, name);
      await form.getByPlaceholder(DRAFT_PLACEHOLDER).fill('Half-typed for the first agent');

      await form.getByRole('button', { name: 'Create New Agent' }).click();
      form = builderForm(page);
      await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
      await expect(form.getByPlaceholder(DRAFT_PLACEHOLDER)).toHaveValue('');
      await expect(form.getByRole('textbox', { name: /^Conversation Starters \d+$/ })).toHaveCount(
        0,
      );
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('an unsent draft survives a trip to the model panel @scenario:starter-draft-survives-panel-switch', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Starters Panel');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgentViaApi(page, name, []);
      agentId = agent.id;

      let form = await selectAgentInBuilder(page, name);
      await form.getByPlaceholder(DRAFT_PLACEHOLDER).fill('Typed before opening the model panel');
      await form.getByRole('button', { name: /^Model/ }).click();
      await builderForm(page).getByRole('button', { name: 'Back to builder' }).click();
      form = builderForm(page);

      await expect(form.getByPlaceholder(DRAFT_PLACEHOLDER)).toHaveValue(
        'Typed before opening the model panel',
      );
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('after saving, the builder shows the starters that were stored @scenario:saved-starters-replace-edited-rows', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Starters Sync');
    const stored = ['One', 'Two', 'Three', 'Four'];
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgentViaApi(page, name, stored);
      agentId = agent.id;

      const form = await selectAgentInBuilder(page, name);
      const rows = form.getByRole('textbox', { name: /^Conversation Starters \d+$/ });
      await expect(
        form.getByPlaceholder('Max number of conversation starters reached'),
      ).toBeDisabled();
      await rows.nth(1).fill('   ');
      await rows.nth(2).fill('  Three padded  ');
      await saveAgent(form, agentId);

      expect(await fetchStarters(page, agentId)).toEqual(['One', 'Three padded', 'Four']);
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(1)).toHaveValue('Three padded');
      await expect(form.getByPlaceholder(DRAFT_PLACEHOLDER)).toBeEnabled();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a starter edited while a save is in flight is kept @scenario:starter-edits-during-save-survive', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Starters In Flight');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgentViaApi(page, name, ['One']);
      agentId = agent.id;
      const id = agentId;

      let releaseSave: () => void = () => undefined;
      const saveHeld = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.route(`**/api/agents/${id}`, async (route) => {
        if (route.request().method() !== 'PATCH') {
          return route.fallback();
        }
        await saveHeld;
        return route.fallback();
      });

      const form = await selectAgentInBuilder(page, name);
      const rows = form.getByRole('textbox', { name: /^Conversation Starters \d+$/ });
      await addStarter(form, 'Sent with the save');

      const saved = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'PATCH' &&
          new URL(candidate.url()).pathname === `/api/agents/${id}` &&
          candidate.ok(),
        { timeout: 30000 },
      );
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await addStarter(form, 'Typed during the save');
      releaseSave();
      await saved;

      expect(await fetchStarters(page, id)).toEqual(['One', 'Sent with the save']);
      await expect(page.getByText(`Successfully updated ${name}`).first()).toBeVisible();
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(2)).toHaveValue('Typed during the save');
      await page.unroute(`**/api/agents/${id}`);

      await saveAgent(form, id);
      expect(await fetchStarters(page, id)).toEqual([
        'One',
        'Sent with the save',
        'Typed during the save',
      ]);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('switching agents while a save is in flight keeps the other agent starters @scenario:save-finishing-after-switch-keeps-other-agent-starters', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const firstName = uniqueAgentName('E2E Starters Switch A');
    const secondName = uniqueAgentName('E2E Starters Switch B');
    /** Padded, so a rewrite through the builder would be visible in storage. */
    const secondStored = [' Padded B starter ', 'B two'];
    let firstId: string | undefined;
    let secondId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      firstId = (await createAgentViaApi(page, firstName, ['A starter'])).id;
      secondId = (await createAgentViaApi(page, secondName, secondStored)).id;
      const id = firstId;

      let releaseSave: () => void = () => undefined;
      const saveHeld = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.route(`**/api/agents/${id}`, async (route) => {
        if (route.request().method() !== 'PATCH') {
          return route.fallback();
        }
        await saveHeld;
        return route.fallback();
      });

      const form = await selectAgentInBuilder(page, firstName);
      await form.getByLabel('Agent description').fill('First agent saved slowly.');
      const saved = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'PATCH' &&
          new URL(candidate.url()).pathname === `/api/agents/${id}` &&
          candidate.ok(),
        { timeout: 30000 },
      );
      await form.getByRole('button', { name: 'Save', exact: true }).click();

      /** A navigation would abort the held save, so the switch stays in place. */
      await switchAgent(form, secondName);
      releaseSave();
      await saved;
      await page.unroute(`**/api/agents/${id}`);
      await expect(form.getByLabel('Agent name')).toHaveValue(secondName);

      await form.getByLabel('Agent description').fill('Second agent, unrelated edit.');
      const response = await saveAgent(form, secondId);

      expect(response.request().postDataJSON()).not.toHaveProperty('conversation_starters');
      expect(await fetchStarters(page, secondId)).toEqual(secondStored);
    } finally {
      await cleanupAgent(page, firstId);
      await cleanupAgent(page, secondId);
    }
  });
});
