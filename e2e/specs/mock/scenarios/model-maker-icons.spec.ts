import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  escapeRegExp,
  messagesView,
  modelSelectorTrigger,
  NEW_CHAT_PATH,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/** The shared helper treats the model submenu as optional; here the model decides the icon. */
async function selectModel(page: Page, endpoint: string, model: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await modelSelectorTrigger(page).click();
  await page.getByRole('option', { name: endpoint }).click();
  /** On mobile the option's accessible name also carries its pin button. */
  const option = page.getByRole('option', { name: new RegExp(`^${escapeRegExp(model)}( Pin)?$`) });
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
}

const triggerArt = (page: Page, label: string) =>
  modelSelectorTrigger(page).getByRole('img', { name: label });

test('A Gemini model on a gateway endpoint shows the Gemini mark @scenario:a-hosted-gemini-model-shows-the-gemini-mark', async ({
  page,
}) => {
  /** `Mock Gemini` names no provider, so before the maker lookup it rendered the generic art. */
  await selectModel(page, 'Mock Gemini', 'gemini-2.5-pro');
  await expect(triggerArt(page, 'Gemini')).toBeVisible();

  await sendMessageAndWaitForCompletion(page, `Maker icon ${Date.now()}`);
  await expect(messagesView(page).getByRole('img', { name: 'Gemini' }).first()).toBeVisible();

  await page.reload();
  await expect(messagesView(page).getByRole('img', { name: 'Gemini' }).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(triggerArt(page, 'Gemini')).toBeVisible();
});

test('A model with no known maker keeps the endpoint icon @scenario:a-model-with-no-known-maker-keeps-the-host-icon', async ({
  page,
}) => {
  await selectModel(page, 'Mock Provider C', 'mock-model-c');
  await expect(triggerArt(page, 'Custom')).toBeVisible();

  await sendMessageAndWaitForCompletion(page, `Host icon ${Date.now()}`);
  await expect(messagesView(page).getByRole('img', { name: 'Custom' }).first()).toBeVisible();
});

/** Opens an endpoint's model list without choosing a model. */
async function openModelList(page: Page, endpoint: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await modelSelectorTrigger(page).click();
  await page.getByRole('option', { name: endpoint }).click();
}

test('Each row of a gateway model list shows its own maker @scenario:model-list-rows-show-each-model-maker', async ({
  page,
}) => {
  await openModelList(page, 'Mock Gemini');
  /** The mark is decorative, so the row keeps the model id as its whole name. */
  const row = page.getByRole('option', { name: /^gemini-2\.5-pro( Pin)?$/ });
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.getByRole('img', { name: 'Gemini', includeHidden: true })).toBeVisible();

  await openModelList(page, 'Mock Provider C');
  const hostRow = page.getByRole('option', { name: /^mock-model-c( Pin)?$/ });
  await expect(hostRow).toBeVisible({ timeout: 10000 });
  await expect(hostRow.getByRole('img', { name: 'Custom', includeHidden: true })).toBeVisible();
});
