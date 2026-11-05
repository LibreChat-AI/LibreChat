import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { installCodeMocks, openCodeChat, singleMachine } from './codeWorkspaceMocks';
import { openAgentBuilder } from '../agents.helpers';

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

    /** The editor's actions share its header row with the hidden label and stay on the right. */
    const editor = form.locator('#instructions');
    await expect(editor).toBeVisible();
    const editorRight = await rightEdge(editor);
    const actions = form
      .getByTestId('instructions-inline-panel')
      .getByRole('button')
      .filter({ hasNot: page.locator('textarea') });
    const count = await actions.count();
    expect(count).toBeGreaterThan(0);
    const lastAction = actions.nth(count - 1);
    expect(Math.abs((await rightEdge(lastAction)) - editorRight)).toBeLessThanOrEqual(
      RIGHT_EDGE_TOLERANCE,
    );
    for (let index = 0; index < count; index += 1) {
      const box = await actions.nth(index).boundingBox();
      const editorBox = await editor.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0) / 2).toBeGreaterThan(
        (editorBox?.x ?? 0) + (editorBox?.width ?? 0) / 2,
      );
    }

    await inline.focus();
    await page.keyboard.press('ArrowRight');
    await expect(prompt).toBeChecked();
    await expect(inline).not.toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(inline).toBeChecked();
    await prompt.click();
    await expect(prompt).toBeChecked();
    await inline.click();
    await expect(inline).toBeChecked();
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
