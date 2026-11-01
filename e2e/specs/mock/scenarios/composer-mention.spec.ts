import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  modelSelectorTrigger,
  selectMockEndpoint,
} from '../helpers';

/**
 * The `@` mention popover, drawn by the chat package's command popover through the app's
 * windowed list: a combobox whose active option the keyboard moves and announces, which drills
 * an endpoint into its models and switches the conversation to the model picked.
 */
test.describe.configure({ timeout: 120_000 });

async function openMention(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const textarea = page.getByRole('textbox', { name: 'Message input' });
  await textarea.click();
  await textarea.press('@');
  const combobox = page.getByRole('combobox', { name: /Mention/ });
  await expect(combobox).toBeFocused();
  return { textarea, combobox };
}

const activeOption = async (page: Page) => {
  const id = await page
    .getByRole('combobox', { name: /Mention/ })
    .getAttribute('aria-activedescendant');
  return page.locator(`[id="${id}"]`);
};

test.describe('mention popover', () => {
  test('keyboard moves and announces the active option @scenario:mention-popover-keyboard-combobox', async ({
    page,
  }) => {
    const { textarea, combobox } = await openMention(page);

    await expect(combobox).toHaveAttribute('aria-expanded', 'true');
    const listbox = page.locator(`[id="${await combobox.getAttribute('aria-controls')}"]`);
    await expect(listbox).toHaveAttribute('role', 'listbox');
    await expect(listbox.getByRole('option').first()).toBeVisible();
    await expect(listbox.locator('[role="grid"], [role="rowgroup"]')).toHaveCount(0);

    await expect(combobox).toHaveAttribute('aria-activedescendant', 'mention-item-0');
    await combobox.press('ArrowDown');
    await expect(combobox).toHaveAttribute('aria-activedescendant', 'mention-item-1');
    const active = await activeOption(page);
    await expect(active).toHaveAttribute('role', 'option');
    await expect(active).toHaveAttribute('aria-selected', 'true');
    await expect(active).toBeInViewport();
    await expect(listbox.locator('[aria-selected="true"]')).toHaveCount(1);

    await combobox.press('ArrowUp');
    await expect(combobox).toHaveAttribute('aria-activedescendant', 'mention-item-0');

    await combobox.press('Escape');
    await expect(page.getByRole('combobox', { name: /Mention/ })).toHaveCount(0);
    await expect(textarea).toBeFocused();
  });

  test('an endpoint drills into its models and the pick switches the model @scenario:mention-popover-switches-model', async ({
    page,
  }) => {
    /* Mock Providers A and B are model specs in the e2e config, so they switch on pick; C is a
       plain custom endpoint the mention list offers as an endpoint row. */
    const target = { label: 'Mock Provider C', model: 'mock-model-c' };
    const { textarea, combobox } = await openMention(page);

    /* The filter also matches the endpoint's own models (their value is the endpoint name), so
       walk to the endpoint row itself rather than assuming it ranks first. */
    await combobox.fill(target.label);
    const endpointRow = page.getByRole('option', { name: target.label, exact: true });
    await expect(endpointRow).toBeVisible();
    const endpointId = await endpointRow.getAttribute('id');
    for (let step = 0; step < 10; step++) {
      if ((await combobox.getAttribute('aria-activedescendant')) === endpointId) {
        break;
      }
      await combobox.press('ArrowDown');
    }
    await expect(combobox).toHaveAttribute('aria-activedescendant', endpointId ?? '');
    await combobox.press('Enter');

    await expect(combobox).toHaveValue('');
    await expect(await activeOption(page)).toContainText(target.model);
    await combobox.press('Enter');

    await expect(page.getByRole('combobox', { name: /Mention/ })).toHaveCount(0);
    await expect(modelSelectorTrigger(page)).toContainText(/Mock Provider C|mock-model-c/);
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('');
  });

  test('no match closes the popover and returns to the draft @scenario:mention-popover-no-match-closes', async ({
    page,
  }) => {
    const { textarea, combobox } = await openMention(page);

    await combobox.fill('zzzz-no-such-entry');
    await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', /.*/);
    await combobox.press('Enter');

    await expect(page.getByRole('combobox', { name: /Mention/ })).toHaveCount(0);
    await expect(textarea).toBeFocused();
  });
});
