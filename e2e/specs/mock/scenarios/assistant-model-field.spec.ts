import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken, requestJson } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * The Assistant Builder's model field is a field `Dropdown` named by its visible "Model" label,
 * whose trigger also reads out the chosen model. It opens from the keyboard, marks the current
 * model as selected, and a keyboard pick moves the field to the next model in the list.
 */

type CreatedAssistant = { id: string };

const ASSISTANT_NAME = 'E2E model field assistant';
const SECOND_MODEL = 'e2e-assistants-second-model';

/** The mock lists one assistants model; a second one gives the keyboard somewhere to move. */
async function offerSecondModel(page: Page) {
  await page.route('**/api/models', async (route) => {
    const response = await route.fetch();
    const models = (await response.json()) as Record<string, string[]>;
    models.assistants = [...new Set([...(models.assistants ?? []), SECOND_MODEL])];
    await route.fulfill({ response, json: models });
  });
}

async function createAssistant(page: Page): Promise<CreatedAssistant> {
  await page.goto('/c/new', { timeout: 10000 });
  const token = await getAccessToken(page);
  return requestJson<CreatedAssistant>(page, {
    path: '/api/assistants/v2',
    token,
    method: 'POST',
    body: { endpoint: 'assistants', model: 'gpt-4o-mini', name: ASSISTANT_NAME },
  });
}

async function deleteAssistant(page: Page, assistantId: string) {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/assistants/v2/${encodeURIComponent(assistantId)}?endpoint=assistants&model=gpt-4o-mini`,
    token,
    method: 'DELETE',
    body: { endpoint: 'assistants' },
  });
}

test('the model field opens and takes a pick from the keyboard @scenario:assistant-model-field-keyboard', async ({
  page,
}) => {
  test.setTimeout(60000);
  const assistant = await createAssistant(page);
  await offerSecondModel(page);

  try {
    await page.goto('/c/new?endpoint=assistants&model=gpt-4o-mini', { timeout: 10000 });
    await openSidebar(page);
    /** The mobile drawer opens on chat history; its panels are items of the Control Panel menu. */
    const controlPanel = page.getByRole('button', { name: 'Control Panel' });
    if (await controlPanel.isVisible()) {
      await controlPanel.click();
      await page.getByRole('menuitemcheckbox', { name: 'Assistant Builder' }).click();
    } else {
      await page.getByRole('button', { name: 'Assistant Builder' }).first().click();
    }

    /** The name is the label followed by the chosen model, so it changes with each pick. */
    const field = page.getByRole('combobox', { name: /^Model / });
    await expect(field).toHaveAccessibleName('Model gpt-4o-mini');

    await field.focus();
    await page.keyboard.press('Enter');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option', { name: 'gpt-4o-mini', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const options = (await listbox.getByRole('option').allInnerTexts()).map((label) =>
      label.trim(),
    );
    const next = options[options.indexOf('gpt-4o-mini') + 1] ?? options[0];
    expect(options).toContain(SECOND_MODEL);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(listbox).toBeHidden();
    await expect(field).toHaveAccessibleName(`Model ${next}`);
    await expect(field).toBeFocused();
  } finally {
    await deleteAssistant(page, assistant.id);
  }
});
