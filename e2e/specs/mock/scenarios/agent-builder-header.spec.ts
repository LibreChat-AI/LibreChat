import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { installCodeMocks, openCodeChat, singleMachine } from './codeWorkspaceMocks';
import { openAgentBuilder } from '../agents.helpers';
import { probeStyle } from './style.helpers';

const RIGHT_EDGE_TOLERANCE = 6;

async function rightEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return (box?.x ?? 0) + (box?.width ?? 0);
}

/** Open the item dialog (the settings of a native tool) from its card in the tool library. */
async function openOrchestrationItem(page: Page, name: 'Handoffs' | 'Subagents'): Promise<Locator> {
  const form = await openAgentBuilder(page, { navigate: false });
  await form.getByRole('button', { name: 'Add tools' }).click();
  const library = page.getByRole('dialog', { name: 'Tool Library' });
  await expect(library).toBeVisible();
  const card = library
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: new RegExp(`^${name}`) }) });
  await card.hover();
  await card.getByRole('button', { name: /^(Configure|Tool details)$/ }).click();
  const dialog = page.getByRole('dialog').filter({ hasNotText: 'Tool Library' }).last();
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('agent builder header', () => {
  test('instructions source is a segmented radio @scenario:instructions-source-is-segmented-radio', async ({
    page,
  }) => {
    const form = await openAgentBuilder(page);
    const group = form.getByRole('radiogroup', { name: 'Instructions source' });
    await expect(group).toBeVisible();
    const inline = group.getByRole('radio', { name: 'Inline' });
    const prompt = group.getByRole('radio', { name: 'Prompt' });
    await expect(inline).toBeChecked();
    await expect(prompt).not.toBeChecked();

    const editor = form.locator('#instructions');
    await expect(editor).toBeVisible();
    const heading = form.getByTestId('instructions-heading');
    const variables = form.getByRole('button', { name: 'Variables', exact: true });
    const expand = form.getByRole('button', { name: 'Expand editor', exact: true });
    for (const action of [variables, expand]) {
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      const headingBox = await heading.boundingBox();
      expect(box).not.toBeNull();
      expect(headingBox).not.toBeNull();
      expect(
        Math.abs(box!.y + box!.height / 2 - headingBox!.y - headingBox!.height / 2),
      ).toBeLessThanOrEqual(RIGHT_EDGE_TOLERANCE);
    }
    expect(await rightEdge(heading)).toBeLessThanOrEqual((await variables.boundingBox())!.x);
    expect(await rightEdge(variables)).toBeLessThanOrEqual((await expand.boundingBox())!.x);
    expect(await rightEdge(expand)).toBeLessThanOrEqual((await group.boundingBox())!.x);

    await editor.fill('Instructions with Unicode: café');
    await variables.focus();
    await page.keyboard.press('Tab');
    await expect(expand).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Instructions', exact: true });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('textbox', { name: 'Instructions', exact: true })
      .fill('Edited instructions');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(expand).toBeFocused();
    await expect(editor).toHaveValue('Edited instructions');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(expand).toBeFocused();

    await inline.focus();
    await page.keyboard.press('ArrowRight');
    await expect(prompt).toBeChecked();
    await expect(inline).not.toBeChecked();
    await expect(variables).toBeHidden();
    await expect(expand).toBeHidden();
    await page.keyboard.press('ArrowLeft');
    await expect(inline).toBeChecked();
    await prompt.click();
    await expect(prompt).toBeChecked();
    await inline.click();
    await expect(inline).toBeChecked();
    await expect(variables).toBeVisible();
    await expect(expand).toBeVisible();
    await expect(editor).toHaveValue('Edited instructions');
  });

  test('ownership icon follows theme ink @scenario:agent-ownership-icon-theme', async ({
    page,
  }) => {
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    const selector = page.getByRole('dialog', { name: 'Agent', exact: true });
    const toggle = selector.getByRole('button', { name: 'My agents', exact: true });
    await expect(toggle).toBeVisible();
    const secondaryInk = await probeStyle(page, 'text-text-secondary', 'color');
    for (const pressed of ['false', 'true']) {
      await page.mouse.move(0, 0);
      await expect(toggle).toHaveAttribute('aria-pressed', pressed);
      await expect(toggle).toHaveCSS('color', secondaryInk);
      await expect(toggle.locator('svg')).toHaveCSS('color', secondaryInk);
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('orchestration dialogs open without their info card @scenario:agent-item-dialog-opens-without-info-card', async ({
    page,
  }) => {
    await page.goto('/c/new', { timeout: 15000 });
    for (const name of ['Handoffs', 'Subagents'] as const) {
      const dialog = await openOrchestrationItem(page, name);
      await page.waitForTimeout(500);
      await expect(page.getByText(/Configure agents that this agent can transfer/)).toHaveCount(0);
      await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
      await expect(dialog).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  });

  test('an MCP server row carries no tool count @scenario:mcp-tool-row-without-count', async ({
    page,
  }) => {
    await installCodeMocks(page, { environments: [singleMachine()], mcp: true });
    await openCodeChat(page);
    const form = await openAgentBuilder(page, { navigate: false });
    const row = form.getByText('context7', { exact: false }).first();
    await expect(row).toBeVisible();
    const container = form.getByRole('listitem').filter({ hasText: 'context7' }).first();
    await expect(container).toBeVisible();
    await expect(container).not.toContainText('· 2');
    await expect(container).not.toContainText('·');
  });
});
