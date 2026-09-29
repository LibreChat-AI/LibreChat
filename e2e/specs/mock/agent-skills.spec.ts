import { expect, test } from '@playwright/test';
import type { Locator, Page, Request, Response } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import {
  cleanupAgent,
  openAgentBuilder,
  selectMockModel,
  uniqueAgentName,
  waitForPersistedAgent,
} from './agents.helpers';
import { fetchJson, getAccessToken, requestJson, sendMessage } from './helpers';

const DEPLOYMENT_SKILL_NAME = 'e2e-deployment-skill';
const SKILL_ASSERTION_MARKER = 'E2E_ASSERT_SKILLS:';
const SKILL_ASSERTION_FINAL_TEXT = 'E2E skill assertion passed';
const SKILL_ASSERTION_AUTHORING_ONLY_TEXT = `${SKILL_ASSERTION_FINAL_TEXT}: authoring-only`;
const SKILL_ASSERTION_NO_SKILLS_TEXT = `${SKILL_ASSERTION_FINAL_TEXT}: none`;
const MANUAL_SKILL_ASSERTION_MARKER = 'E2E_ASSERT_MANUAL_SKILL:';
const MANUAL_SKILL_ASSERTION_FINAL_TEXT = 'E2E manual skill assertion passed';
const SKILL_TOOL_INVOCATION_MARKER = 'E2E_INVOKE_SKILL:';
const SKILL_TOOL_ASSERTION_FINAL_TEXT = 'E2E skill tool assertion passed';
const SKILL_PICKER_PLACEHOLDER = 'Select a Skill by name';
const NO_SKILLS_FOUND_TEXT = 'No skills found';
const INLINE_SKILL_DESCRIPTION =
  'Use this inline skill to verify Agent Builder skill selection and persistence.';

type SkillSummary = {
  _id: string;
  name: string;
  description: string;
  source?: string;
  sourceMetadata?: {
    deployment?: boolean;
  };
};

type SkillAgentDetail = AgentDetail & {
  skills?: string[];
  skills_enabled?: boolean;
  skills_scope?: string;
};

type AgentSkillPayload = {
  name?: string;
  skills?: string[];
  skills_enabled?: boolean;
  skills_scope?: string;
  manualSkills?: string[];
};

const uniqueSkillName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

async function createInlineSkill(page: Page, token: string, name: string): Promise<SkillSummary> {
  return requestJson<SkillSummary>(page, {
    path: '/api/skills',
    token,
    method: 'POST',
    body: {
      name,
      description: INLINE_SKILL_DESCRIPTION,
      body: `# ${name}\n\nUse this skill in Agent Builder end-to-end tests.`,
    },
  });
}

async function createInlineSkills(
  page: Page,
  token: string,
  names: string[],
  onCreated?: (skill: SkillSummary) => void,
): Promise<SkillSummary[]> {
  const created: SkillSummary[] = [];
  const batchSize = 10;
  for (let index = 0; index < names.length; index += batchSize) {
    const batch = await Promise.allSettled(
      names.slice(index, index + batchSize).map((name) => createInlineSkill(page, token, name)),
    );
    for (const result of batch) {
      if (result.status === 'fulfilled') {
        created.push(result.value);
        onCreated?.(result.value);
      }
    }
    const failed = batch.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }
  }
  return created;
}

async function getDeploymentSkill(page: Page, token: string): Promise<SkillSummary> {
  const result = await fetchJson<{ skills?: SkillSummary[] }>(
    page,
    `/api/skills?search=${encodeURIComponent(DEPLOYMENT_SKILL_NAME)}&limit=10`,
    token,
  );
  const skill = result.skills?.find((item) => item.name === DEPLOYMENT_SKILL_NAME);
  expect(skill, 'Expected the deployment skill fixture to be accessible').toMatchObject({
    name: DEPLOYMENT_SKILL_NAME,
    source: 'deployment',
    sourceMetadata: { deployment: true },
  });
  return skill!;
}

async function deleteSkill(page: Page, token: string, skillId: string): Promise<void> {
  await requestJson(page, {
    path: `/api/skills/${encodeURIComponent(skillId)}`,
    token,
    method: 'DELETE',
  });
}

async function deleteSkills(page: Page, token: string, skillIds: string[]): Promise<void> {
  const batchSize = 10;
  const failures: unknown[] = [];
  for (let index = 0; index < skillIds.length; index += batchSize) {
    const results = await Promise.allSettled(
      skillIds.slice(index, index + batchSize).map((skillId) => deleteSkill(page, token, skillId)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(result.reason);
      }
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
}

async function settleCleanup(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length > 0) {
    throw failures[0].reason;
  }
}

async function openSkillsDialog(page: Page, form: Locator): Promise<Locator> {
  const selectedSkillsRadio = form.getByRole('radio', { name: 'Selected', exact: true });
  if ((await selectedSkillsRadio.getAttribute('aria-checked')) !== 'true') {
    await selectedSkillsRadio.click();
    await expect(selectedSkillsRadio).toHaveAttribute('aria-checked', 'true');
  }
  await form.getByRole('button', { name: /Add skill/ }).click();
  const dialog = page
    .getByRole('dialog')
    .filter({ hasText: 'Browse and add skills to your agent.' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function skillCard(dialog: Locator, name: string): Promise<Locator> {
  const item = dialog
    .getByRole('list', { name: 'Skills' })
    .getByRole('listitem')
    .filter({ hasText: name });
  await expect(item).toHaveCount(1);
  const card = item.getByRole('button').filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  return card;
}

async function selectSkill(dialog: Locator, name: string): Promise<void> {
  const card = await skillCard(dialog, name);
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
}

async function waitForAgentMutation(
  page: Page,
  method: 'POST' | 'PATCH',
  agentId?: string,
): Promise<Response> {
  return page.waitForResponse(
    (response) => {
      const { pathname } = new URL(response.url());
      const expectedPath = agentId ? `/api/agents/${agentId}` : '/api/agents';
      return response.request().method() === method && pathname === expectedPath;
    },
    { timeout: 30000 },
  );
}

async function selectAgent(page: Page, form: Locator, agentName: string): Promise<void> {
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
}

async function openSkillPicker(page: Page): Promise<Locator> {
  const messageInput = page.getByRole('textbox', { name: 'Message input' });
  await messageInput.click();
  await messageInput.fill('');
  await messageInput.pressSequentially('$');
  const searchInput = page.getByPlaceholder(SKILL_PICKER_PLACEHOLDER);
  await expect(searchInput).toBeVisible();
  return searchInput;
}

function skillPickerOption(page: Page, name: string): Locator {
  return page.locator('button[id^="skill-item-"]').filter({ hasText: name });
}

async function expectSkillInPicker(page: Page, searchInput: Locator, name: string): Promise<void> {
  await searchInput.fill(name);
  await expect(skillPickerOption(page, name)).toHaveCount(1);
  await expect(skillPickerOption(page, name)).toBeVisible();
}

async function expectSkillAbsentFromPicker(
  page: Page,
  searchInput: Locator,
  name: string,
): Promise<void> {
  await searchInput.fill(name);
  await expect(
    searchInput.locator('..').getByText(NO_SKILLS_FOUND_TEXT, { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(skillPickerOption(page, name)).toHaveCount(0);
}

async function closeSkillPicker(page: Page, searchInput: Locator): Promise<void> {
  await searchInput.press('Escape');
  await expect(searchInput).toBeHidden();
  await page.getByRole('textbox', { name: 'Message input' }).fill('');
}

test.describe('Agent Builder skills', () => {
  test('creates an agent with deployment and inline skills, then removes and persists one', async ({
    page,
  }) => {
    test.setTimeout(180000);

    const agentName = uniqueAgentName('E2E Agent Skills');
    const agentDescription = 'Agent Builder skill selection end-to-end coverage.';
    const inlineSkillName = uniqueSkillName('e2e-agent-inline');
    const unselectedSkillName = uniqueSkillName('e2e-agent-unselected');
    let createdAgentId: string | undefined;
    const createdSkillIds: string[] = [];

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);

    try {
      const deploymentSkill = await getDeploymentSkill(page, token);
      const [inlineSkill] = await createInlineSkills(
        page,
        token,
        [inlineSkillName, unselectedSkillName],
        (skill) => createdSkillIds.push(skill._id),
      );

      let form = await openAgentBuilder(page);
      await form.getByLabel('Agent name').fill(agentName);
      await form.getByLabel('Agent description').fill(agentDescription);
      await selectMockModel(page, true);
      form = page.getByRole('form', { name: 'Agent configuration form' });

      const dialog = await openSkillsDialog(page, form);
      await selectSkill(dialog, DEPLOYMENT_SKILL_NAME);
      await selectSkill(dialog, inlineSkillName);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      const createResponsePromise = waitForAgentMutation(page, 'POST');
      await form.getByRole('button', { name: 'Create', exact: true }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status(), await createResponse.text()).toBe(201);

      const createdAgent = (await createResponse.json()) as SkillAgentDetail;
      createdAgentId = createdAgent.id;
      const createPayload = createResponse.request().postDataJSON() as AgentSkillPayload;
      expect(createPayload.skills_enabled).toBe(true);
      expect(createPayload.skills).toHaveLength(2);
      expect(createPayload.skills).toEqual(
        expect.arrayContaining([deploymentSkill._id, inlineSkill._id]),
      );

      expect(createdAgent).toMatchObject({
        id: createdAgentId,
        name: agentName,
        skills_enabled: true,
      });
      expect(createdAgent.skills).toEqual(
        expect.arrayContaining([deploymentSkill._id, inlineSkill._id]),
      );

      const persistedAgent = (await waitForPersistedAgent(
        page,
        agentName,
        agentDescription,
      )) as SkillAgentDetail;
      expect(persistedAgent.skills_enabled).toBe(true);
      expect(persistedAgent.skills).toEqual(
        expect.arrayContaining([deploymentSkill._id, inlineSkill._id]),
      );

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByText(DEPLOYMENT_SKILL_NAME, { exact: true })).toBeVisible();
      await expect(form.getByText(inlineSkillName, { exact: true })).toBeVisible();

      const retainedDescription = `${agentDescription} Saved with both skills still selected.`;
      await form.getByLabel('Agent description').fill(retainedDescription);
      const retentionResponsePromise = waitForAgentMutation(page, 'PATCH', createdAgentId);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      const retentionResponse = await retentionResponsePromise;
      expect(retentionResponse.status(), await retentionResponse.text()).toBe(200);

      const retainedAgent = (await retentionResponse.json()) as SkillAgentDetail;
      const retentionPayload = retentionResponse.request().postDataJSON() as AgentSkillPayload;
      expect(retentionPayload.skills_enabled).toBe(true);
      expect(retentionPayload.skills).toHaveLength(2);
      expect(retentionPayload.skills).toEqual(
        expect.arrayContaining([deploymentSkill._id, inlineSkill._id]),
      );
      expect(retainedAgent.skills_enabled).toBe(true);
      expect(retainedAgent.skills).toHaveLength(2);
      expect(retainedAgent.skills).toEqual(
        expect.arrayContaining([deploymentSkill._id, inlineSkill._id]),
      );

      const expandedRetainedAgent = await fetchJson<SkillAgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(createdAgentId)}/expanded`,
        token,
      );
      expect(expandedRetainedAgent.skills_enabled).toBe(true);
      expect(expandedRetainedAgent.skills).toHaveLength(2);
      expect(expandedRetainedAgent.skills).toEqual(
        expect.arrayContaining([deploymentSkill._id, inlineSkill._id]),
      );

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByText(DEPLOYMENT_SKILL_NAME, { exact: true })).toBeVisible();
      await expect(form.getByText(inlineSkillName, { exact: true })).toBeVisible();

      await form.getByRole('button', { name: 'Select Agent' }).click();
      const pickerSearch = await openSkillPicker(page);
      await expectSkillInPicker(page, pickerSearch, DEPLOYMENT_SKILL_NAME);
      await expectSkillInPicker(page, pickerSearch, inlineSkillName);
      await expectSkillAbsentFromPicker(page, pickerSearch, unselectedSkillName);
      await closeSkillPicker(page, pickerSearch);

      const runtimeResponse = await sendMessage(
        page,
        [
          `${SKILL_ASSERTION_MARKER}*${DEPLOYMENT_SKILL_NAME},${inlineSkillName},!${unselectedSkillName}`,
          'Verify the persisted Agent Builder skill allowlist at runtime.',
        ].join('\n'),
      );
      expect(runtimeResponse.ok()).toBeTruthy();
      await expect(
        page
          .getByTestId('messages-view')
          .getByText(`${SKILL_ASSERTION_FINAL_TEXT}: ${DEPLOYMENT_SKILL_NAME}, ${inlineSkillName}`),
      ).toBeVisible({ timeout: 30000 });

      const inlineToolResponse = await sendMessage(
        page,
        `${SKILL_TOOL_INVOCATION_MARKER}${inlineSkillName}`,
      );
      expect(inlineToolResponse.ok()).toBeTruthy();
      await expect(
        page
          .getByTestId('messages-view')
          .getByText(`${SKILL_TOOL_ASSERTION_FINAL_TEXT}: ${inlineSkillName}`),
      ).toBeVisible({ timeout: 30000 });

      const deploymentToolResponse = await sendMessage(
        page,
        `${SKILL_TOOL_INVOCATION_MARKER}${DEPLOYMENT_SKILL_NAME}`,
      );
      expect(deploymentToolResponse.ok()).toBeTruthy();
      await expect(
        page
          .getByTestId('messages-view')
          .getByText(`${SKILL_TOOL_ASSERTION_FINAL_TEXT}: ${DEPLOYMENT_SKILL_NAME}`),
      ).toBeVisible({ timeout: 30000 });

      const manualPickerSearch = await openSkillPicker(page);
      await expectSkillInPicker(page, manualPickerSearch, inlineSkillName);
      await skillPickerOption(page, inlineSkillName).click();
      await expect(manualPickerSearch).toBeHidden();
      await expect(
        page
          .getByRole('list', { name: 'Skills queued for next submission' })
          .getByText(inlineSkillName, { exact: true }),
      ).toBeVisible();

      const manualResponse = await sendMessage(
        page,
        `${MANUAL_SKILL_ASSERTION_MARKER}${inlineSkillName}`,
      );
      expect(manualResponse.ok()).toBeTruthy();
      expect((manualResponse.request().postDataJSON() as AgentSkillPayload).manualSkills).toEqual([
        inlineSkillName,
      ]);
      await expect(
        page
          .getByTestId('messages-view')
          .getByText(`${MANUAL_SKILL_ASSERTION_FINAL_TEXT}: ${inlineSkillName}`),
      ).toBeVisible({ timeout: 30000 });

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      const deploymentRow = form.locator('li').filter({ hasText: DEPLOYMENT_SKILL_NAME });
      await expect(deploymentRow).toHaveCount(1);
      await deploymentRow.hover();
      await deploymentRow.getByRole('button', { name: /^Remove / }).click();
      await expect(form.getByText(DEPLOYMENT_SKILL_NAME, { exact: true })).toBeHidden();

      const updateResponsePromise = waitForAgentMutation(page, 'PATCH', createdAgentId);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      const updateResponse = await updateResponsePromise;
      expect(updateResponse.status(), await updateResponse.text()).toBe(200);

      const updatePayload = updateResponse.request().postDataJSON() as AgentSkillPayload;
      expect(updatePayload).toMatchObject({
        skills: [inlineSkill._id],
        skills_enabled: true,
      });

      const updatedAgent = await fetchJson<SkillAgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(createdAgentId)}/expanded`,
        token,
      );
      expect(updatedAgent.skills).toEqual([inlineSkill._id]);
      expect(updatedAgent.skills_enabled).toBe(true);

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByText(inlineSkillName, { exact: true })).toBeVisible();
      await expect(form.getByText(DEPLOYMENT_SKILL_NAME, { exact: true })).toBeHidden();

      const finalSkillRow = form.locator('li').filter({ hasText: inlineSkillName });
      await expect(finalSkillRow).toHaveCount(1);
      await finalSkillRow.hover();
      await finalSkillRow.getByRole('button', { name: /^Remove / }).click();
      await expect(form.getByText(inlineSkillName, { exact: true })).toBeHidden();

      /** Emptying the allowlist stays in Selected: the mode is explicit now, so
       *  removing the last skill no longer infers Off. Only `skills` is written,
       *  and an explicit Selected with nothing selected resolves to no skills at
       *  runtime, which the picker and the run below both confirm. Skills stay
       *  enabled, so that run can still author one: it keeps the `skill` tool in
       *  its authoring variant with nothing in the catalog, which is what
       *  separates this from the Off agent below. */
      const emptiedResponsePromise = waitForAgentMutation(page, 'PATCH', createdAgentId);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      const emptiedResponse = await emptiedResponsePromise;
      expect(emptiedResponse.status(), await emptiedResponse.text()).toBe(200);
      expect(emptiedResponse.request().postDataJSON()).toMatchObject({
        skills: [],
      });

      const emptiedAgent = await fetchJson<SkillAgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(createdAgentId)}/expanded`,
        token,
      );
      expect(emptiedAgent.skills).toEqual([]);
      expect(emptiedAgent.skills_enabled).toBe(true);
      expect(emptiedAgent.skills_scope).toBe('selected');

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByText(DEPLOYMENT_SKILL_NAME, { exact: true })).toBeHidden();
      await expect(form.getByText(inlineSkillName, { exact: true })).toBeHidden();
      await form.getByRole('button', { name: 'Select Agent' }).click();

      const disabledPickerSearch = await openSkillPicker(page);
      await expectSkillAbsentFromPicker(page, disabledPickerSearch, DEPLOYMENT_SKILL_NAME);
      await expectSkillAbsentFromPicker(page, disabledPickerSearch, inlineSkillName);
      await closeSkillPicker(page, disabledPickerSearch);

      const emptiedRuntimeResponse = await sendMessage(
        page,
        `${SKILL_ASSERTION_MARKER}!${DEPLOYMENT_SKILL_NAME},!${inlineSkillName}`,
      );
      expect(emptiedRuntimeResponse.ok()).toBeTruthy();
      await expect(
        page.getByTestId('messages-view').getByText(SKILL_ASSERTION_AUTHORING_ONLY_TEXT),
      ).toBeVisible({ timeout: 30000 });
    } finally {
      await settleCleanup([
        cleanupAgent(page, createdAgentId),
        deleteSkills(page, token, createdSkillIds),
      ]);
    }
  });

  test('persists explicit use-all semantics and includes skills created later', async ({
    page,
  }) => {
    test.setTimeout(180000);

    const agentName = uniqueAgentName('E2E Agent All Skills');
    const agentDescription = 'Agent Builder explicit use-all-skills end-to-end coverage.';
    const futureSkillName = uniqueSkillName('e2e-agent-future');
    let createdAgentId: string | undefined;
    let futureSkill: SkillSummary | undefined;

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);

    try {
      let form = await openAgentBuilder(page);
      await form.getByLabel('Agent name').fill(agentName);
      await form.getByLabel('Agent description').fill(agentDescription);
      await selectMockModel(page, true);
      form = page.getByRole('form', { name: 'Agent configuration form' });

      const offSkillsRadio = form.getByRole('radio', { name: 'Off', exact: true });
      const allSkillsRadio = form.getByRole('radio', { name: 'All', exact: true });
      await expect(offSkillsRadio).toHaveAttribute('aria-checked', 'true');
      await expect(allSkillsRadio).toHaveAttribute('aria-checked', 'false');
      await allSkillsRadio.click();
      await expect(allSkillsRadio).toHaveAttribute('aria-checked', 'true');
      await expect(offSkillsRadio).toHaveAttribute('aria-checked', 'false');
      const allSkillsSummary = form.getByRole('button', { name: /\d+ skills? available/ });
      await expect(allSkillsSummary).toBeVisible();
      await expect(allSkillsSummary).toHaveAttribute('aria-expanded', 'false');
      // The Selected body stays mounted so mode switches tween; it is inert and
      // aria-hidden while All is active, so its Add row must not be reachable.
      await expect(form.getByRole('button', { name: /Add skill/ })).toBeHidden();

      const createResponsePromise = waitForAgentMutation(page, 'POST');
      await form.getByRole('button', { name: 'Create', exact: true }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status(), await createResponse.text()).toBe(201);

      const createdAgent = (await createResponse.json()) as SkillAgentDetail;
      createdAgentId = createdAgent.id;
      const createPayload = createResponse.request().postDataJSON() as AgentSkillPayload;
      /** All writes the mode outright and deliberately leaves `skills` alone, so
       *  a fresh agent sends no allowlist at all rather than an empty one. That
       *  is what lets a later return to Selected restore previous picks. */
      expect(createPayload).toMatchObject({
        skills_enabled: true,
        skills_scope: 'all',
      });

      expect(createdAgent).toMatchObject({
        id: createdAgentId,
        skills_enabled: true,
        skills_scope: 'all',
      });

      const persistedAgent = (await waitForPersistedAgent(
        page,
        agentName,
        agentDescription,
      )) as SkillAgentDetail;
      expect(persistedAgent.skills_enabled).toBe(true);
      expect(persistedAgent.skills_scope).toBe('all');

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByRole('radio', { name: 'All', exact: true })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(form.getByRole('button', { name: /\d+ skills? available/ })).toBeVisible();
      await expect(form.getByRole('button', { name: /Add skill/ })).toBeHidden();

      futureSkill = await createInlineSkill(page, token, futureSkillName);
      await form.getByRole('button', { name: 'Select Agent' }).click();
      const useAllPickerSearch = await openSkillPicker(page);
      await expectSkillInPicker(page, useAllPickerSearch, futureSkillName);
      await closeSkillPicker(page, useAllPickerSearch);

      const runtimeResponse = await sendMessage(
        page,
        [
          `${SKILL_ASSERTION_MARKER}${DEPLOYMENT_SKILL_NAME},${futureSkillName}`,
          'Verify use-all includes a skill created after the agent was saved.',
        ].join('\n'),
      );
      expect(runtimeResponse.ok()).toBeTruthy();
      await expect(
        page
          .getByTestId('messages-view')
          .getByText(`${SKILL_ASSERTION_FINAL_TEXT}: ${DEPLOYMENT_SKILL_NAME}, ${futureSkillName}`),
      ).toBeVisible({ timeout: 30000 });

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      const persistedOffSkillsRadio = form.getByRole('radio', { name: 'Off', exact: true });
      await persistedOffSkillsRadio.click();
      await expect(persistedOffSkillsRadio).toHaveAttribute('aria-checked', 'true');
      await expect(form.getByRole('button', { name: /Add skill/ })).toBeHidden();

      const updateResponsePromise = waitForAgentMutation(page, 'PATCH', createdAgentId);
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      const updateResponse = await updateResponsePromise;
      expect(updateResponse.status(), await updateResponse.text()).toBe(200);
      /** Off writes the mode and both capability flags, and still leaves the
       *  allowlist untouched. */
      expect(updateResponse.request().postDataJSON()).toMatchObject({
        skills_enabled: false,
        skills_scope: 'none',
      });

      const disabledAgent = await fetchJson<SkillAgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(createdAgentId)}/expanded`,
        token,
      );
      expect(disabledAgent.skills_enabled).toBe(false);
      expect(disabledAgent.skills_scope).toBe('none');

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByRole('radio', { name: 'Off', exact: true })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(form.getByRole('button', { name: /Add skill/ })).toBeHidden();

      await form.getByRole('button', { name: 'Select Agent' }).click();
      const disabledPickerSearch = await openSkillPicker(page);
      await expectSkillAbsentFromPicker(page, disabledPickerSearch, futureSkillName);
      await closeSkillPicker(page, disabledPickerSearch);

      const disabledRuntimeResponse = await sendMessage(
        page,
        [
          `${SKILL_ASSERTION_MARKER}!${DEPLOYMENT_SKILL_NAME},!${futureSkillName}`,
          'Verify the master skill toggle hides every skill at runtime.',
        ].join('\n'),
      );
      expect(disabledRuntimeResponse.ok()).toBeTruthy();
      /** Off turns authoring off with invocation, so this run gets no `skill`
       *  tool at all — unlike the emptied-allowlist run above. */
      await expect(
        page.getByTestId('messages-view').getByText(SKILL_ASSERTION_NO_SKILLS_TEXT),
      ).toBeVisible({ timeout: 30000 });
    } finally {
      await settleCleanup([
        cleanupAgent(page, createdAgentId),
        ...(futureSkill ? [deleteSkill(page, token, futureSkill._id)] : []),
      ]);
    }
  });

  test('creates a skill inside the builder and auto-selects it for the new agent', async ({
    page,
  }) => {
    test.setTimeout(180000);

    const agentName = uniqueAgentName('E2E Agent Created Skill');
    const agentDescription = 'Agent Builder inline skill creation end-to-end coverage.';
    const skillName = uniqueSkillName('e2e-builder-created');
    let createdAgentId: string | undefined;
    let createdSkill: SkillSummary | undefined;
    let agentPostCount = 0;
    const countAgentPosts = (request: Request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents') {
        agentPostCount += 1;
      }
    };
    page.on('request', countAgentPosts);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);

    try {
      let form = await openAgentBuilder(page);
      await form.getByLabel('Agent name').fill(agentName);
      await form.getByLabel('Agent description').fill(agentDescription);
      await selectMockModel(page, true);
      form = page.getByRole('form', { name: 'Agent configuration form' });

      const skillsDialog = await openSkillsDialog(page, form);
      await skillsDialog.getByRole('button', { name: 'Create Skill', exact: true }).click();

      const createSkillDialog = page
        .getByRole('dialog')
        .filter({ hasText: 'Write skill instructions' });
      await expect(createSkillDialog).toBeVisible();
      await createSkillDialog.getByLabel('Name').fill(skillName);
      await createSkillDialog.getByLabel('Description').fill(INLINE_SKILL_DESCRIPTION);
      await createSkillDialog
        .getByLabel('Instructions')
        .fill(`# ${skillName}\n\nCreated inline from Agent Builder.`);

      const skillResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/skills',
        { timeout: 30000 },
      );
      await createSkillDialog.getByRole('button', { name: 'Create', exact: true }).click();
      const skillResponse = await skillResponsePromise;
      expect(skillResponse.status(), await skillResponse.text()).toBe(201);
      createdSkill = (await skillResponse.json()) as SkillSummary;
      expect(skillResponse.request().postDataJSON()).toMatchObject({
        name: skillName,
        description: INLINE_SKILL_DESCRIPTION,
      });
      expect(agentPostCount).toBe(0);

      await expect(createSkillDialog).toBeHidden();
      const createdCard = await skillCard(skillsDialog, skillName);
      await expect(createdCard).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      await expect(skillsDialog).toBeHidden();
      await expect(form.getByText(skillName, { exact: true })).toBeVisible();

      const createAgentResponsePromise = waitForAgentMutation(page, 'POST');
      await form.getByRole('button', { name: 'Create', exact: true }).click();
      const createAgentResponse = await createAgentResponsePromise;
      expect(createAgentResponse.status(), await createAgentResponse.text()).toBe(201);
      expect(agentPostCount).toBe(1);
      const createdAgent = (await createAgentResponse.json()) as SkillAgentDetail;
      createdAgentId = createdAgent.id;
      expect(createAgentResponse.request().postDataJSON()).toMatchObject({
        skills: [createdSkill._id],
        skills_enabled: true,
      });

      expect(createdAgent).toMatchObject({
        id: createdAgentId,
        skills: [createdSkill._id],
        skills_enabled: true,
      });

      const persistedAgent = (await waitForPersistedAgent(
        page,
        agentName,
        agentDescription,
      )) as SkillAgentDetail;
      expect(persistedAgent.skills).toEqual([createdSkill._id]);
      expect(persistedAgent.skills_enabled).toBe(true);

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByText(skillName, { exact: true })).toBeVisible();
    } finally {
      page.off('request', countAgentPosts);
      await settleCleanup([
        cleanupAgent(page, createdAgentId),
        ...(createdSkill ? [deleteSkill(page, token, createdSkill._id)] : []),
      ]);
    }
  });

  test('discovers and selects a skill beyond the first 100 accessible skills', async ({ page }) => {
    test.setTimeout(240000);

    const agentName = uniqueAgentName('E2E Agent Paginated Skill');
    const agentDescription = 'Agent Builder paginated skill discovery end-to-end coverage.';
    const targetSkillName = uniqueSkillName('e2e-agent-off-page');
    const fillerPrefix = uniqueSkillName('e2e-agent-page');
    let createdAgentId: string | undefined;
    const createdSkillIds: string[] = [];

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);

    try {
      const targetSkill = await createInlineSkill(page, token, targetSkillName);
      createdSkillIds.push(targetSkill._id);
      const fillerNames = Array.from(
        { length: 100 },
        (_, index) => `${fillerPrefix}-${String(index).padStart(3, '0')}`,
      );
      await createInlineSkills(page, token, fillerNames, (skill) =>
        createdSkillIds.push(skill._id),
      );

      const firstPage = await fetchJson<{
        skills: SkillSummary[];
        has_more: boolean;
        after: string | null;
      }>(page, '/api/skills?limit=100', token);
      expect(firstPage.has_more).toBe(true);
      expect(firstPage.after).toBeTruthy();
      expect(firstPage.skills.some((skill) => skill._id === targetSkill._id)).toBe(false);

      let form = await openAgentBuilder(page);
      await form.getByLabel('Agent name').fill(agentName);
      await form.getByLabel('Agent description').fill(agentDescription);
      await selectMockModel(page, true);
      form = page.getByRole('form', { name: 'Agent configuration form' });

      const nextPageResponsePromise = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return url.pathname === '/api/skills' && url.searchParams.has('cursor');
        },
        { timeout: 30000 },
      );
      const dialog = await openSkillsDialog(page, form);
      const nextPageResponse = await nextPageResponsePromise;
      expect(nextPageResponse.ok(), await nextPageResponse.text()).toBe(true);

      await dialog.getByRole('textbox', { name: 'Search skills...' }).fill(targetSkillName);
      await selectSkill(dialog, targetSkillName);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(form.getByText(targetSkillName, { exact: true })).toBeVisible();

      const createResponsePromise = waitForAgentMutation(page, 'POST');
      await form.getByRole('button', { name: 'Create', exact: true }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status(), await createResponse.text()).toBe(201);
      const createdAgent = (await createResponse.json()) as SkillAgentDetail;
      createdAgentId = createdAgent.id;
      expect(createResponse.request().postDataJSON()).toMatchObject({
        skills: [targetSkill._id],
        skills_enabled: true,
      });

      const persistedAgent = (await waitForPersistedAgent(
        page,
        agentName,
        agentDescription,
      )) as SkillAgentDetail;
      expect(persistedAgent.skills).toEqual([targetSkill._id]);
      expect(persistedAgent.skills_enabled).toBe(true);

      form = await openAgentBuilder(page);
      await selectAgent(page, form, agentName);
      await expect(form.getByText(targetSkillName, { exact: true })).toBeVisible();
    } finally {
      await settleCleanup([
        cleanupAgent(page, createdAgentId),
        deleteSkills(page, token, createdSkillIds),
      ]);
    }
  });
});
