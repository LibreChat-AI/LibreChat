import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { GraphEdge } from 'librechat-data-provider';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, selectMockModel, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessageAndWaitForCompletion,
} from './helpers';

const DESCRIPTION = 'Created by the mock end-to-end suite to verify agent handoffs.';
const INSTRUCTIONS = 'Follow the deterministic handoff instructions from the mock model.';
const HANDOFF_DESCRIPTION = 'Delegate requests that require specialist handling.';
const HANDOFF_PROMPT = 'Pass the specialist the exact request and relevant constraints.';
const HANDOFF_PROMPT_KEY = 'context';
const MCP_SERVER_TOOL_ID = 'sys__server__sys_mcp_e2e-memory';
const MCP_TOOL_ID = 'remember_fact_mcp_e2e-memory';
const MISSING_MCP_TOOL_ID = 'retired_fact_mcp_e2e-memory';
const MCP_SERVER_NAME = 'e2e-memory';

type HandoffRoute = {
  from: string;
  to: string;
  description?: string;
  prompt?: string;
  promptKey?: string;
  args?: Record<string, unknown>;
  receipt?: string;
  targetInstructions?: string;
  targetTools?: string[];
  targetToolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    outputIncludes: string;
  };
};

type MCPToolsResponse = {
  servers?: Record<string, { tools?: Array<{ pluginKey: string }> }>;
};

const handoffMarker = (label: string, routes: HandoffRoute[]) =>
  `E2E_HANDOFF:${Buffer.from(JSON.stringify({ label, routes })).toString('base64url')}`;

async function waitForMCPTool(page: Page, token: string): Promise<void> {
  let latestTools: MCPToolsResponse | null = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    latestTools = await fetchJson<MCPToolsResponse>(page, '/api/mcp/tools', token);
    const tools = latestTools.servers?.[MCP_SERVER_NAME]?.tools ?? [];
    if (tools.some((tool) => tool.pluginKey === MCP_TOOL_ID)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  expect(
    latestTools?.servers?.[MCP_SERVER_NAME]?.tools,
    `Expected ${MCP_SERVER_NAME} to expose ${MCP_TOOL_ID}`,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ pluginKey: MCP_TOOL_ID })]));
}

async function startNewAgent(page: Page): Promise<Locator> {
  let form = await openAgentBuilder(page);
  const createNewButton = form.getByRole('button', { name: 'Create New Agent' });
  if (await createNewButton.isVisible().catch(() => false)) {
    await createNewButton.click();
    form = page.getByRole('form', { name: 'Agent configuration form' });
  }

  await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
  return form;
}

async function configureNewAgent(page: Page, name: string): Promise<Locator> {
  let form = await startNewAgent(page);
  await form.getByLabel('Agent name').fill(name);
  await form.getByLabel('Agent description').fill(DESCRIPTION);
  await form.getByLabel('Instructions').fill(INSTRUCTIONS);
  await selectMockModel(page, true);
  form = page.getByRole('form', { name: 'Agent configuration form' });
  return form;
}

async function createConfiguredAgent(form: Locator): Promise<AgentDetail> {
  const page = form.page();
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
  return (await response.json()) as AgentDetail;
}

async function createAgentViaApi(
  page: Page,
  token: string,
  name: string,
  edges?: GraphEdge[],
  overrides: { instructions?: string; tools?: string[] } = {},
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: DESCRIPTION,
      instructions: INSTRUCTIONS,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      edges,
      ...overrides,
    },
  });
}

async function selectAgentForChat(page: Page, agentName: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

async function cleanupAgents(
  page: Page,
  token: string,
  agentIds: Array<string | undefined>,
): Promise<void> {
  for (const agentId of agentIds.reverse()) {
    if (!agentId) {
      continue;
    }
    await requestJson(page, {
      path: `/api/agents/${encodeURIComponent(agentId)}`,
      token,
      method: 'DELETE',
    }).catch(() => undefined);
  }
}

test.describe('agent handoffs', () => {
  test.describe.configure({ timeout: 60_000 });

  test('creates and runs a router with handoffs selected before the router exists', async ({
    page,
  }) => {
    test.setTimeout(180000);

    const specialistName = uniqueAgentName('E2E Handoff Specialist');
    const bareSpecialistName = uniqueAgentName('E2E Bare Handoff Specialist');
    const routerName = uniqueAgentName('E2E Handoff Router');
    let specialistId: string | undefined;
    let bareSpecialistId: string | undefined;
    let routerId: string | undefined;

    try {
      const specialistForm = await configureNewAgent(page, specialistName);
      const specialist = await createConfiguredAgent(specialistForm);
      specialistId = specialist.id;

      const bareSpecialistForm = await configureNewAgent(page, bareSpecialistName);
      const bareSpecialist = await createConfiguredAgent(bareSpecialistForm);
      bareSpecialistId = bareSpecialist.id;

      const routerForm = await configureNewAgent(page, routerName);
      await routerForm.getByRole('button', { name: 'Advanced' }).click();
      const handoffs = routerForm.getByRole('region', { name: 'Handoffs' });
      await expect(handoffs).toBeVisible();

      await handoffs.getByRole('combobox', { name: 'Add agent' }).click();
      await page.getByRole('option', { name: specialistName }).click();
      await expect(handoffs.getByText('1 / 10', { exact: true })).toBeVisible();
      await handoffs.getByRole('button', { name: 'Expand' }).click();
      await handoffs.getByLabel('Handoff description').fill(HANDOFF_DESCRIPTION);
      await handoffs.getByLabel('Passthrough content').fill(HANDOFF_PROMPT);
      await handoffs
        .getByLabel("Content parameter name (default: 'instructions')")
        .fill(HANDOFF_PROMPT_KEY);
      await handoffs.getByRole('combobox', { name: 'Add agent' }).click();
      await page.getByRole('option', { name: bareSpecialistName }).click();
      await expect(handoffs.getByText('2 / 10', { exact: true })).toBeVisible();

      const router = await createConfiguredAgent(routerForm);
      routerId = router.id;

      const token = await getAccessToken(page);
      const persisted = await fetchJson<AgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(router.id)}/expanded`,
        token,
      );

      expect(persisted.edges).toEqual([
        {
          from: router.id,
          to: specialist.id,
          edgeType: 'handoff',
          description: HANDOFF_DESCRIPTION,
          prompt: HANDOFF_PROMPT,
          promptKey: HANDOFF_PROMPT_KEY,
        },
        {
          from: router.id,
          to: bareSpecialist.id,
          edgeType: 'handoff',
        },
      ]);

      const reopenedForm = await openAgentBuilder(page);
      await reopenedForm.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: routerName }).click();
      await reopenedForm.getByRole('button', { name: 'Advanced' }).click();
      const reopenedHandoffs = reopenedForm.getByRole('region', { name: 'Handoffs' });
      await expect(reopenedHandoffs.getByText('2 / 10', { exact: true })).toBeVisible();
      const reopenedDestinations = reopenedHandoffs.getByRole('combobox', {
        name: 'Select agent',
      });
      await expect(reopenedDestinations).toHaveCount(2);
      await expect(reopenedDestinations.first()).toContainText(specialistName);
      await expect(reopenedDestinations.last()).toContainText(bareSpecialistName);
      await reopenedHandoffs.getByRole('button', { name: 'Expand' }).first().click();
      await expect(reopenedHandoffs.getByLabel('Handoff description')).toHaveValue(
        HANDOFF_DESCRIPTION,
      );
      await expect(reopenedHandoffs.getByLabel('Passthrough content')).toHaveValue(HANDOFF_PROMPT);
      await expect(
        reopenedHandoffs.getByLabel("Content parameter name (default: 'instructions')"),
      ).toHaveValue(HANDOFF_PROMPT_KEY);

      await reopenedForm.getByRole('button', { name: 'Select Agent' }).click();
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();

      const label = `scratch-bare-${Date.now()}`;
      const response = await sendMessageAndWaitForCompletion(
        page,
        handoffMarker(label, [
          {
            from: router.id,
            to: bareSpecialist.id,
            args: {},
          },
        ]),
      );
      expect(response.ok()).toBeTruthy();
      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${label}: agent=${bareSpecialist.id}; received=(no injected handoff content)`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByRole('button', {
          name: `Transferred to ${bareSpecialistName}`,
        }),
      ).toBeDisabled();
    } finally {
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, bareSpecialistId);
      await cleanupAgent(page, specialistId);
    }
  });

  test('moves copied handoffs from the original router to its duplicate', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const targetName = uniqueAgentName('E2E Handoff Clone Target');
    const routerName = uniqueAgentName('E2E Handoff Clone Router');
    let targetId: string | undefined;
    let routerId: string | undefined;
    let cloneId: string | undefined;

    try {
      const target = await createAgentViaApi(page, token, targetName);
      targetId = target.id;
      const router = await createAgentViaApi(page, token, routerName, [
        {
          from: '',
          to: target.id,
          edgeType: 'handoff',
          description: 'Delegate clone work',
          prompt: 'Preserve this payload',
          promptKey: 'instructions',
        },
      ]);
      routerId = router.id;

      const duplicate = await requestJson<{ agent: AgentDetail }>(page, {
        path: `/api/agents/${encodeURIComponent(router.id)}/duplicate`,
        token,
        method: 'POST',
      });
      cloneId = duplicate.agent.id;

      expect(duplicate.agent.edges).toEqual([
        {
          from: duplicate.agent.id,
          to: target.id,
          edgeType: 'handoff',
          description: 'Delegate clone work',
          prompt: 'Preserve this payload',
          promptKey: 'instructions',
        },
      ]);
    } finally {
      await cleanupAgent(page, cloneId);
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, targetId);
    }
  });

  test('edits, saves, reopens, and restores handoff versions without duplicate destinations', async ({
    page,
  }) => {
    test.setTimeout(240000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const firstName = uniqueAgentName('E2E Editable Handoff First');
    const secondName = uniqueAgentName('E2E Editable Handoff Second');
    const thirdName = uniqueAgentName('E2E Editable Handoff Third');
    const routerName = uniqueAgentName('E2E Editable Handoff Router');
    const createdIds: string[] = [];
    let routerId: string | undefined;

    try {
      const first = await createAgentViaApi(page, token, firstName);
      const second = await createAgentViaApi(page, token, secondName);
      const third = await createAgentViaApi(page, token, thirdName);
      createdIds.push(first.id, second.id, third.id);

      const routerForm = await configureNewAgent(page, routerName);
      await routerForm.getByRole('button', { name: 'Advanced' }).click();
      const handoffs = routerForm.getByRole('region', { name: 'Handoffs' });
      const addAgent = handoffs.getByRole('combobox', { name: 'Add agent' });

      await addAgent.click();
      await page.getByRole('option', { name: firstName }).click();
      await addAgent.click();
      await expect(page.getByRole('option', { name: firstName })).toHaveCount(0);
      await page.getByRole('option', { name: secondName }).click();
      await expect(handoffs.getByText('2 / 10', { exact: true })).toBeVisible();

      const expandButtons = handoffs.getByRole('button', { name: 'Expand' });
      await expandButtons.first().click();
      await expandButtons.first().click();
      await handoffs
        .getByLabel('Handoff description')
        .nth(1)
        .fill('The surviving expanded handoff');

      await handoffs.getByRole('button', { name: `Remove handoff to ${firstName}` }).click();
      await expect(handoffs.getByText('1 / 10', { exact: true })).toBeVisible();
      await expect(handoffs.getByText(secondName, { exact: true })).toBeVisible();
      await expect(handoffs.getByLabel('Handoff description')).toHaveValue(
        'The surviving expanded handoff',
      );

      const destination = handoffs.getByRole('combobox', { name: 'Select agent' });
      await destination.click();
      const destinationDialog = page.getByRole('dialog', { name: 'Select agent' }).last();
      await expect(destinationDialog.getByRole('option', { name: firstName })).toBeVisible();
      await expect(destinationDialog.getByRole('option', { name: thirdName })).toBeVisible();
      await destinationDialog.getByRole('option', { name: firstName }).click();

      await addAgent.click();
      const addDialog = page.getByRole('dialog', { name: 'Add agent' });
      await expect(addDialog.getByRole('option', { name: firstName })).toHaveCount(0);
      await expect(addDialog.getByRole('option', { name: secondName })).toBeVisible();
      await addDialog.getByRole('option', { name: thirdName }).click();

      const router = await createConfiguredAgent(routerForm);
      routerId = router.id;
      const persisted = await fetchJson<AgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(router.id)}/expanded`,
        token,
      );
      expect(persisted.edges).toEqual([
        {
          from: router.id,
          to: first.id,
          edgeType: 'handoff',
          description: 'The surviving expanded handoff',
        },
        {
          from: router.id,
          to: third.id,
          edgeType: 'handoff',
        },
      ]);

      let editForm = await openAgentBuilder(page);
      await editForm.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: routerName }).click();
      await expect(editForm.getByLabel('Agent name')).toHaveValue(routerName);
      await editForm.getByRole('button', { name: 'Advanced' }).click();

      let editableHandoffs = editForm.getByRole('region', { name: 'Handoffs' });
      await expect(editableHandoffs.getByText('2 / 10', { exact: true })).toBeVisible();
      await editableHandoffs.getByRole('button', { name: 'Expand' }).first().click();
      await editableHandoffs
        .getByLabel('Handoff description')
        .fill('The updated persisted handoff');
      const secondDestination = editableHandoffs
        .getByRole('combobox', { name: 'Select agent' })
        .nth(1);
      await secondDestination.click();
      await page
        .getByRole('dialog', { name: 'Select agent' })
        .last()
        .getByRole('option', { name: secondName })
        .click();

      await editForm.getByRole('button', { name: 'Back to builder' }).click();
      const [updateResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'PATCH' &&
            new URL(response.url()).pathname === `/api/agents/${router.id}` &&
            response.ok(),
          { timeout: 30000 },
        ),
        editForm.getByRole('button', { name: 'Save', exact: true }).click(),
      ]);
      expect(updateResponse.ok()).toBeTruthy();

      const updated = await fetchJson<AgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(router.id)}/expanded`,
        token,
      );
      expect(updated.edges).toEqual([
        {
          from: router.id,
          to: first.id,
          edgeType: 'handoff',
          description: 'The updated persisted handoff',
        },
        {
          from: router.id,
          to: second.id,
          edgeType: 'handoff',
        },
      ]);

      editForm = await openAgentBuilder(page);
      await editForm.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: routerName }).click();
      await editForm.getByRole('button', { name: 'Advanced' }).click();
      editableHandoffs = editForm.getByRole('region', { name: 'Handoffs' });
      await expect(editableHandoffs.getByText('2 / 10', { exact: true })).toBeVisible();
      await expect(
        editableHandoffs.getByRole('combobox', { name: 'Select agent' }).first(),
      ).toContainText(firstName);
      await expect(
        editableHandoffs.getByRole('combobox', { name: 'Select agent' }).nth(1),
      ).toContainText(secondName);
      await editableHandoffs.getByRole('button', { name: 'Expand' }).first().click();
      await expect(editableHandoffs.getByLabel('Handoff description')).toHaveValue(
        'The updated persisted handoff',
      );

      await editForm.getByRole('button', { name: 'Back to builder' }).click();
      await editForm.getByRole('button', { name: 'Version', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Version History' })).toBeVisible();
      const history = page.getByRole('list', { name: 'Version History' });
      const versionItems = history.getByRole('listitem');
      await expect(versionItems).toHaveCount(2);
      await expect(versionItems.first()).toHaveAttribute('aria-current', 'true');
      await expect(versionItems.last()).not.toHaveAttribute('aria-current');

      await versionItems.last().getByRole('button', { name: 'Restore' }).click();
      const restoreDialog = page.getByRole('dialog', {
        name: 'Are you sure you want to restore this version?',
      });
      const [restoreResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `/api/agents/${router.id}/revert` &&
            response.ok(),
          { timeout: 30000 },
        ),
        restoreDialog.getByRole('button', { name: 'Restore', exact: true }).click(),
      ]);
      expect(restoreResponse.ok()).toBeTruthy();
      await expect(page.getByText('Version restored successfully', { exact: true })).toBeVisible();
      await expect(versionItems.last()).toHaveAttribute('aria-current', 'true');

      await page.getByRole('button', { name: 'Back to builder' }).click();
      editForm = page.getByRole('form', { name: 'Agent configuration form' });
      await editForm.getByRole('button', { name: 'Advanced' }).click();
      editableHandoffs = editForm.getByRole('region', { name: 'Handoffs' });
      await expect(
        editableHandoffs.getByRole('combobox', { name: 'Select agent' }).first(),
      ).toContainText(firstName);
      await expect(
        editableHandoffs.getByRole('combobox', { name: 'Select agent' }).nth(1),
      ).toContainText(thirdName);

      const restored = await fetchJson<AgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(router.id)}/expanded`,
        token,
      );
      expect(restored.edges).toEqual(persisted.edges);
    } finally {
      await cleanupAgents(page, token, [routerId, ...createdIds]);
    }
  });

  test('enforces the ten-destination handoff limit in the builder', async ({ page }) => {
    test.setTimeout(240000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const targetNames = Array.from({ length: 10 }, (_, index) =>
      uniqueAgentName(`E2E Handoff Limit ${index + 1}`),
    );
    const targetIds: string[] = [];

    try {
      for (const targetName of targetNames) {
        const target = await createAgentViaApi(page, token, targetName);
        targetIds.push(target.id);
      }

      const routerForm = await configureNewAgent(page, uniqueAgentName('E2E Handoff Limit Router'));
      await routerForm.getByRole('button', { name: 'Advanced' }).click();
      const handoffs = routerForm.getByRole('region', { name: 'Handoffs' });

      for (const targetName of targetNames) {
        await handoffs.getByRole('combobox', { name: 'Add agent' }).click();
        await page.getByRole('option', { name: targetName }).click();
      }

      await expect(handoffs.getByText('10 / 10', { exact: true })).toBeVisible();
      await expect(
        handoffs.getByText('Maximum 10 handoff agents reached.', { exact: true }),
      ).toBeVisible();
      await expect(handoffs.getByRole('combobox', { name: 'Add agent' })).toHaveCount(0);
      await expect(handoffs.getByRole('combobox', { name: 'Select agent' })).toHaveCount(10);
    } finally {
      await cleanupAgents(page, token, targetIds);
    }
  });

  test('refreshes a cached router after its handoff target is deleted', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const targetName = uniqueAgentName('E2E Deleted Handoff Target');
    const routerName = uniqueAgentName('E2E Cached Handoff Router');
    let routerId: string | undefined;

    try {
      const target = await createAgentViaApi(page, token, targetName);
      const router = await createAgentViaApi(page, token, routerName, [
        {
          from: '',
          to: target.id,
          edgeType: 'handoff',
          description: 'This edge should disappear with its target.',
        },
      ]);
      routerId = router.id;

      let form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: routerName }).click();
      await form.getByRole('button', { name: 'Advanced' }).click();
      await expect(
        form.getByRole('region', { name: 'Handoffs' }).getByText('1 / 10', { exact: true }),
      ).toBeVisible();

      await form.getByRole('button', { name: 'Back to builder' }).click();
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: targetName }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(targetName);
      await form.getByRole('button', { name: 'Delete Agent' }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete Agent' });
      await expect(dialog).toBeVisible();
      const [deleteResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'DELETE' &&
            new URL(response.url()).pathname === `/api/agents/${target.id}` &&
            response.ok(),
          { timeout: 30000 },
        ),
        dialog.getByRole('button', { name: 'Delete', exact: true }).click(),
      ]);
      expect(deleteResponse.ok()).toBeTruthy();

      form = page.getByRole('form', { name: 'Agent configuration form' });
      await expect(form.getByLabel('Agent name')).toHaveValue(routerName, { timeout: 30000 });
      await form.getByRole('button', { name: 'Advanced' }).click();
      const handoffs = form.getByRole('region', { name: 'Handoffs' });
      await expect(handoffs.getByText('0 / 10', { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(handoffs.getByText(targetName, { exact: true })).toHaveCount(0);

      const persisted = await fetchJson<AgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(router.id)}/expanded`,
        token,
      );
      expect(persisted.edges ?? []).toEqual([]);
    } finally {
      await cleanupAgents(page, token, [routerId]);
    }
  });

  test('rejects a stale handoff when its target no longer exists', async ({ page }) => {
    test.setTimeout(120000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const target = await createAgentViaApi(
      page,
      token,
      uniqueAgentName('E2E Missing Handoff Target'),
    );
    const router = await createAgentViaApi(
      page,
      token,
      uniqueAgentName('E2E Missing Handoff Router'),
      [{ from: '', to: target.id, edgeType: 'handoff' }],
    );

    try {
      await requestJson(page, {
        path: `/api/agents/${encodeURIComponent(target.id)}`,
        token,
        method: 'DELETE',
      });

      const staleSave = await page.request.patch(`/api/agents/${encodeURIComponent(router.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          edges: [{ from: router.id, to: target.id, edgeType: 'handoff' }],
        },
      });
      expect(staleSave.status()).toBe(400);
      await expect(staleSave.json()).resolves.toMatchObject({
        error: 'One or more agents referenced in edges do not exist',
        agent_ids: [target.id],
      });
    } finally {
      await cleanupAgents(page, token, [router.id]);
    }
  });

  test('routes to the chosen agent, renders passthrough details, and survives reloads', async ({
    page,
  }) => {
    test.setTimeout(180000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const chosenName = uniqueAgentName('E2E Chosen Handoff');
    const unusedName = uniqueAgentName('E2E Unused Handoff');
    const routerName = uniqueAgentName('E2E Choice Router');
    const label = `choice-${Date.now()}`;
    const payload = `receipt-${Date.now()}`;
    const chosenInstructions = `Only the chosen specialist has this instruction marker: ${label}.`;
    let chosenId: string | undefined;
    let unusedId: string | undefined;
    let routerId: string | undefined;

    try {
      await waitForMCPTool(page, token);
      const chosen = await createAgentViaApi(page, token, chosenName, undefined, {
        instructions: chosenInstructions,
        tools: [MCP_SERVER_TOOL_ID, MCP_TOOL_ID],
      });
      chosenId = chosen.id;
      const unused = await createAgentViaApi(page, token, unusedName);
      unusedId = unused.id;
      const router = await createAgentViaApi(page, token, routerName, [
        {
          from: '',
          to: chosen.id,
          edgeType: 'handoff',
          description: 'Use the chosen specialist for this request.',
          prompt: 'Pass precise instructions to the chosen specialist.',
          promptKey: 'brief',
        },
        {
          from: '',
          to: unused.id,
          edgeType: 'handoff',
          description: 'A valid alternative that should not be selected.',
        },
      ]);
      routerId = router.id;

      await selectAgentForChat(page, routerName);
      const noTransferLabel = `no-transfer-${Date.now()}`;
      const noTransferResponse = await sendMessageAndWaitForCompletion(
        page,
        `E2E_REPLY:${noTransferLabel}`,
      );
      expect(noTransferResponse.ok()).toBeTruthy();
      await expect(
        messagesView(page).getByText(`E2E reply ${noTransferLabel}`, { exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByRole('button', { name: /^Transferred to / }),
      ).toHaveCount(0);

      const response = await sendMessageAndWaitForCompletion(
        page,
        handoffMarker(label, [
          {
            from: router.id,
            to: chosen.id,
            description: 'Use the chosen specialist for this request.',
            prompt: 'Pass precise instructions to the chosen specialist.',
            promptKey: 'brief',
            args: { brief: payload },
            receipt: payload,
            targetInstructions: chosenInstructions,
            targetTools: [MCP_TOOL_ID],
          },
        ]),
      );
      expect(response.ok()).toBeTruthy();

      const finalText = `E2E handoff complete ${label}: agent=${chosen.id}; received=${payload}`;
      await expect(messagesView(page).getByText(finalText, { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${unusedName}` }),
      ).toHaveCount(0);

      let transferCard = messagesView(page).getByRole('button', {
        name: `Transferred to ${chosenName}`,
      });
      await expect(transferCard).toBeEnabled();
      await transferCard.click();
      const handoffDetails = messagesView(page).getByRole('region', {
        name: 'Handoff instructions',
      });
      await expect(handoffDetails).toBeVisible();
      await expect(handoffDetails.getByText(payload, { exact: true })).toBeVisible();

      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
      const conversationUrl = page.url();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(conversationUrl);
      await expect(messagesView(page).getByText(finalText, { exact: true })).toBeVisible({
        timeout: 30000,
      });
      transferCard = messagesView(page).getByRole('button', {
        name: `Transferred to ${chosenName}`,
      });
      await expect(transferCard).toBeVisible();

      const emptyLabel = `${label}-empty`;
      const emptyResponse = await sendMessageAndWaitForCompletion(
        page,
        handoffMarker(emptyLabel, [
          {
            from: router.id,
            to: chosen.id,
            description: 'Use the chosen specialist for this request.',
            prompt: 'Pass precise instructions to the chosen specialist.',
            promptKey: 'brief',
            args: {},
          },
        ]),
      );
      expect(emptyResponse.ok()).toBeTruthy();
      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${emptyLabel}: agent=${chosen.id}; received=(no injected handoff content)`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page)
          .getByRole('button', { name: `Transferred to ${chosenName}` })
          .last(),
      ).toBeDisabled();
    } finally {
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, unusedId);
      await cleanupAgent(page, chosenId);
    }
  });

  test('invokes the target-scoped MCP tool after transfer and persists its output', async ({
    page,
  }) => {
    test.setTimeout(180000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const targetName = uniqueAgentName('E2E Tool Handoff Target');
    const routerName = uniqueAgentName('E2E Tool Handoff Router');
    const label = `target-tool-${Date.now()}`;
    const fact = `delegated fact ${label}`;
    const toolCallId = `call_e2e_handoff_target_tool_${label}`;
    const toolOutput = `E2E MCP memory noted: ${fact}`;
    let targetId: string | undefined;
    let routerId: string | undefined;

    try {
      await waitForMCPTool(page, token);
      const target = await createAgentViaApi(page, token, targetName, undefined, {
        tools: [MCP_SERVER_TOOL_ID, MCP_TOOL_ID],
      });
      targetId = target.id;
      const router = await createAgentViaApi(page, token, routerName, [
        {
          from: '',
          to: target.id,
          edgeType: 'handoff',
          description: 'Delegate requests that require the target memory tool.',
        },
      ]);
      routerId = router.id;

      await selectAgentForChat(page, routerName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        handoffMarker(label, [
          {
            from: router.id,
            to: target.id,
            description: 'Delegate requests that require the target memory tool.',
            args: {},
            targetTools: [MCP_TOOL_ID],
            targetToolCall: {
              id: toolCallId,
              name: MCP_TOOL_ID,
              args: { fact },
              outputIncludes: toolOutput,
            },
          },
        ]),
      );
      expect(response.ok()).toBeTruthy();

      const view = messagesView(page);
      await expect(view.getByRole('button', { name: `Transferred to ${targetName}` })).toBeVisible({
        timeout: 30000,
      });
      const toolCall = view.locator(`[data-testid="tool-call"][data-tool-call-id="${toolCallId}"]`);
      await expect(toolCall).toBeVisible({ timeout: 30000 });
      const toolToggle = toolCall.getByRole('button', { name: /remember_fact/ });
      if ((await toolToggle.getAttribute('aria-expanded')) !== 'true') {
        await toolToggle.click();
      }
      await expect(
        view.locator(`[data-tool-call-output-id="${toolCallId}"]`).getByText(toolOutput, {
          exact: true,
        }),
      ).toBeVisible({ timeout: 30000 });
      const finalText = `E2E handoff tool complete ${label}: agent=${target.id}`;
      await expect(view.getByText(finalText, { exact: true })).toBeVisible({ timeout: 30000 });

      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        messagesView(page).locator(`[data-testid="tool-call"][data-tool-call-id="${toolCallId}"]`),
      ).toBeVisible({ timeout: 30000 });
      await expect(messagesView(page).getByText(finalText, { exact: true })).toBeVisible({
        timeout: 30000,
      });
    } finally {
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, targetId);
    }
  });

  test('publishes a terminal error before model execution when the handoff target expects an unavailable MCP tool', async ({
    page,
  }) => {
    test.setTimeout(180000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const targetName = uniqueAgentName('E2E Unavailable Tool Target');
    const routerName = uniqueAgentName('E2E Unavailable Tool Router');
    const label = `unavailable-target-tool-${Date.now()}`;
    let targetId: string | undefined;
    let routerId: string | undefined;

    try {
      await waitForMCPTool(page, token);
      const target = await createAgentViaApi(page, token, targetName, undefined, {
        tools: [MISSING_MCP_TOOL_ID],
      });
      targetId = target.id;
      const router = await createAgentViaApi(page, token, routerName, [
        {
          from: '',
          to: target.id,
          edgeType: 'handoff',
          description: 'Delegate requests that require the unavailable target tool.',
        },
      ]);
      routerId = router.id;

      await selectAgentForChat(page, routerName);
      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill(
        handoffMarker(label, [
          {
            from: router.id,
            to: target.id,
            description: 'Delegate requests that require the unavailable target tool.',
            args: {},
          },
        ]),
      );
      const [response] = await Promise.all([
        page.waitForResponse((candidate) => {
          const { pathname } = new URL(candidate.url());
          return (
            candidate.request().method() === 'POST' &&
            (pathname === '/api/agents/chat' || pathname.startsWith('/api/agents/chat/')) &&
            !pathname.endsWith('/abort')
          );
        }),
        input.press('Enter'),
      ]);

      expect(response.status()).toBe(200);
      await expect(
        messagesView(page).getByText(
          /is configured to use MCP tools, but none are available\. Verify that the MCP server is connected and this agent can access its selected tools, then try again\./,
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByText(new RegExp(`E2E handoff (continuing|complete) ${label}`)),
      ).toHaveCount(0);
    } finally {
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, targetId);
    }
  });

  test('executes a transitive router-to-specialist-to-reviewer handoff', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const reviewerName = uniqueAgentName('E2E Handoff Reviewer');
    const specialistName = uniqueAgentName('E2E Handoff Middle');
    const routerName = uniqueAgentName('E2E Handoff Chain Router');
    const label = `chain-${Date.now()}`;
    const specialistReceipt = `specialist-context-${Date.now()}`;
    const reviewerReceipt = `reviewer-context-${Date.now()}`;
    let reviewerId: string | undefined;
    let specialistId: string | undefined;
    let routerId: string | undefined;

    try {
      const reviewer = await createAgentViaApi(page, token, reviewerName);
      reviewerId = reviewer.id;
      const specialist = await createAgentViaApi(page, token, specialistName, [
        {
          from: '',
          to: reviewer.id,
          edgeType: 'handoff',
          description: 'Send completed specialist work to review.',
          prompt: 'Pass review context.',
          promptKey: 'context',
        },
      ]);
      specialistId = specialist.id;
      const router = await createAgentViaApi(page, token, routerName, [
        {
          from: '',
          to: specialist.id,
          edgeType: 'handoff',
          description: 'Start with the specialist.',
          prompt: 'Pass specialist instructions.',
        },
      ]);
      routerId = router.id;

      await selectAgentForChat(page, routerName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        handoffMarker(label, [
          {
            from: router.id,
            to: specialist.id,
            description: 'Start with the specialist.',
            prompt: 'Pass specialist instructions.',
            args: { instructions: specialistReceipt },
          },
          {
            from: specialist.id,
            to: reviewer.id,
            description: 'Send completed specialist work to review.',
            prompt: 'Pass review context.',
            promptKey: 'context',
            args: { context: reviewerReceipt },
          },
        ]),
      );
      expect(response.ok()).toBeTruthy();

      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${label}: agent=${reviewer.id}; received=${reviewerReceipt}`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${specialistName}` }),
      ).toBeVisible();
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${reviewerName}` }),
      ).toBeVisible();
    } finally {
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, specialistId);
      await cleanupAgent(page, reviewerId);
    }
  });

  test('executes simultaneous handoffs and renders both transfer branches', async ({ page }) => {
    test.setTimeout(180000);

    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const leftName = uniqueAgentName('E2E Parallel Left');
    const rightName = uniqueAgentName('E2E Parallel Right');
    const routerName = uniqueAgentName('E2E Parallel Router');
    const label = `parallel-${Date.now()}`;
    const leftReceipt = `left-context-${Date.now()}`;
    const rightReceipt = `right-context-${Date.now()}`;
    let leftId: string | undefined;
    let rightId: string | undefined;
    let routerId: string | undefined;

    try {
      const left = await createAgentViaApi(page, token, leftName);
      leftId = left.id;
      const right = await createAgentViaApi(page, token, rightName);
      rightId = right.id;
      const router = await createAgentViaApi(page, token, routerName, [
        {
          from: '',
          to: left.id,
          edgeType: 'handoff',
          description: 'Run the left branch.',
          prompt: 'Pass left-branch instructions.',
        },
        {
          from: '',
          to: right.id,
          edgeType: 'handoff',
          description: 'Run the right branch.',
          prompt: 'Pass right-branch context.',
          promptKey: 'context',
        },
      ]);
      routerId = router.id;

      await selectAgentForChat(page, routerName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        handoffMarker(label, [
          {
            from: router.id,
            to: left.id,
            description: 'Run the left branch.',
            prompt: 'Pass left-branch instructions.',
            args: { instructions: leftReceipt },
          },
          {
            from: router.id,
            to: right.id,
            description: 'Run the right branch.',
            prompt: 'Pass right-branch context.',
            promptKey: 'context',
            args: { context: rightReceipt },
          },
        ]),
      );
      expect(response.ok()).toBeTruthy();

      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${label}: agent=${left.id}; received=${leftReceipt}`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${label}: agent=${right.id}; received=${rightReceipt}`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${leftName}` }),
      ).toBeVisible();
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${rightName}` }),
      ).toBeVisible();

      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
      const conversationUrl = page.url();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(conversationUrl);
      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${label}: agent=${left.id}; received=${leftReceipt}`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByText(
          `E2E handoff complete ${label}: agent=${right.id}; received=${rightReceipt}`,
          { exact: true },
        ),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${leftName}` }),
      ).toBeVisible();
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${rightName}` }),
      ).toBeVisible();
    } finally {
      await cleanupAgent(page, routerId);
      await cleanupAgent(page, rightId);
      await cleanupAgent(page, leftId);
    }
  });
});
