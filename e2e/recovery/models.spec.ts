import { expect, test } from '@playwright/test';

const providerURL = `http://127.0.0.1:${process.env.E2E_RECOVERY_PROVIDER_PORT ?? 4018}`;

test('an imported chat keeps its history while model access recovers', async ({
  page,
  request,
}, testInfo) => {
  await request.post(`${providerURL}/availability?available=false`);
  await page.goto('/c/new');
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  const imported = {
    conversationId: '78f5a289-5ebd-4314-898c-e06135f76b6a',
    title: 'Model recovery history',
    endpoint: 'Recovery',
    messages: [
      {
        messageId: '11111111-1111-4111-8111-111111111111',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Keep this original question.',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: '22222222-2222-4222-8222-222222222222',
        parentMessageId: '11111111-1111-4111-8111-111111111111',
        text: 'Keep this original answer.',
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    ],
  };
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: /Settings/ });
  await settings.getByRole('tab', { name: 'Data & Privacy' }).click();
  const fileChooser = page.waitForEvent('filechooser');
  await settings.getByRole('button', { name: 'Import conversations from a JSON file' }).click();
  await (
    await fileChooser
  ).setFiles({
    name: 'recovery.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(
    page.getByText('Conversations imported successfully', { exact: true }),
  ).toBeVisible();
  await settings.getByRole('button', { name: 'Close Settings' }).click();
  await page.reload();
  await page.getByText(imported.title, { exact: true }).first().click();
  const originalQuestion = page
    .locator('.message-render')
    .filter({ hasText: 'Keep this original question.' });
  const originalAnswer = page
    .locator('.message-render')
    .filter({ hasText: 'Keep this original answer.' });
  await expect(originalQuestion).toBeVisible();
  await expect(originalAnswer).toBeVisible();
  await expect(page.getByText('Select a model to continue.', { exact: false })).toBeVisible();
  await expect(
    page.getByText(
      'No models are available. Wait for access to return or contact an administrator.',
      { exact: false },
    ),
  ).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill('Continue this history.');
  await expect(page.getByTestId('send-button')).toBeDisabled();
  await input.press('Enter');
  await expect(input).toHaveValue('Continue this history.');
  await page.screenshot({ path: testInfo.outputPath('unavailable.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(originalAnswer).toBeVisible();
  await input.fill('Continue this history.');
  await expect(page.getByTestId('send-button')).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('unavailable-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await request.post(`${providerURL}/availability?available=true`);
  await page.reload();
  await expect(originalAnswer).toBeVisible();
  // Existing chat-opening defaults choose the restored provider's available model.
  await expect(page.getByTestId('model-selector-button').first()).toContainText('recovery-model');
  await input.fill('Continue this history.');
  await expect(page.getByTestId('send-button')).toBeEnabled();
  await page.getByTestId('send-button').click();
  await expect(
    page.locator('.message-render').filter({ hasText: 'E2E mock reply: pong' }),
  ).toBeVisible();
  await expect(originalQuestion).toBeVisible();
  await expect(originalAnswer).toBeVisible();
  await page.reload();
  await expect(originalQuestion).toBeVisible();
  await expect(originalAnswer).toBeVisible();
  await expect(
    page.locator('.message-render').filter({ hasText: 'E2E mock reply: pong' }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('recovered.png') });
  console.log(
    'Recovery verified: import with empty catalog; history visible; send blocked; restore catalog; existing chat-opening fallback selects model; send reply; original history preserved.',
  );
});
