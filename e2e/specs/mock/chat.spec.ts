import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  isAgentsStream,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  mockReply,
  replyText,
  replyPrompt,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

type UploadFixture = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

const pdfFixture: UploadFixture = {
  name: 'provider-context.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from(
    `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 0 >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`,
  ),
};

const textFixture: UploadFixture = {
  name: 'provider-context.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('This text attachment should be available to the mock model.\n'),
};

// Valid 16x16 PNG. The previous 1x1 fixture had a corrupt IDAT CRC that older
// libpng silently accepted but sharp 0.35.3's newer libpng rejects during
// server-side image processing ("vipspng: libpng read error"). Keep this a
// spec-conformant PNG (correct chunk CRCs).
const imageFixture: UploadFixture = {
  name: 'provider-context.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNwaDjwnxLMMGrA/9EwODAaBg3DIgwACY9/HwbtciYAAAAASUVORK5CYII=',
    'base64',
  ),
};

const composer = (page: Page) => page.locator('form');

async function openProviderFileChooser(page: Page) {
  // Uploads live in the composer palette (the old AttachFileMenu is gone).
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const uploadOption = page.getByRole('button', { name: 'Upload to Provider', exact: true });
  await expect(uploadOption).toBeVisible();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await uploadOption.click();
  const fileChooser = await fileChooserPromise;
  expect(await fileChooser.element().getAttribute('type')).toBe('file');
  return fileChooser;
}

async function uploadProviderFile(page: Page, fixture: UploadFixture) {
  const fileChooser = await openProviderFileChooser(page);
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/files') &&
      response.request().method() === 'POST' &&
      response.status() === 200,
    { timeout: 30000 },
  );
  await fileChooser.setFiles(fixture);
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.ok()).toBeTruthy();
  await page.waitForTimeout(350);
  return uploadResponse;
}

test.describe('core chat loop', () => {
  test('streams a response, saves the conversation, and persists across reload', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const userMessage = 'ping from e2e';

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessageAndWaitForCompletion(page, userMessage);
    expect(response.ok()).toBeTruthy();

    await expect(page.getByText(userMessage)).toBeVisible();
    const userMessageTurn = messagesView(page)
      .locator('.message-render')
      .filter({ hasText: userMessage });
    await expect(userMessageTurn.locator('.user-turn')).toBeVisible();
    await expect(userMessageTurn.locator('.agent-turn')).toHaveCount(0);
    await expect(mockReply(page)).toBeVisible();

    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/);
    const conversationUrl = page.url();

    await expect(page.getByTestId('convo-item').first()).toBeVisible();

    await page.reload({ timeout: 10000 });
    await expect(page).toHaveURL(conversationUrl);
    await expect(page.getByText(userMessage)).toBeVisible();
    await expect(mockReply(page)).toBeVisible();
    await expect(page.getByTestId('convo-item').first()).toBeVisible();
  });

  test('keeps send disabled until the composer has message text', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const input = page.getByRole('textbox', { name: 'Message input' });
    const sendButton = page.getByTestId('send-button');

    await expect(sendButton).toBeDisabled();
    await input.fill('ready to send');
    await expect(sendButton).toBeEnabled();
    await input.fill('   ');
    await expect(sendButton).toBeDisabled();
  });

  test('renders assistant markdown and syntax-highlighted code blocks', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessageAndWaitForCompletion(page, 'E2E_MARKDOWN_REPLY');
    expect(response.ok()).toBeTruthy();

    const assistantMessage = messagesView(page)
      .locator('.message-render')
      .filter({ hasText: 'E2E markdown heading' })
      .last();
    await expect(assistantMessage.locator('.agent-turn')).toBeVisible();
    await expect(
      assistantMessage.getByRole('heading', { name: 'E2E markdown heading' }),
    ).toBeVisible();
    await expect(
      assistantMessage.locator('strong').filter({ hasText: 'E2E bold text' }),
    ).toBeVisible();
    await expect(
      assistantMessage.getByRole('listitem').filter({ hasText: 'E2E list item' }),
    ).toBeVisible();

    const codeBlock = assistantMessage.locator('code').filter({ hasText: 'e2eSyntaxHighlight' });
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).toHaveClass(/hljs/);
    await expect(codeBlock).toHaveClass(/language-javascript/);
  });

  test('can switch back to the previous branch after regenerating an earlier response', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const firstMessage = 'branch root from e2e';
    const followUpMessage = 'follow-up on original branch from e2e';

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    let response = await sendMessageAndWaitForCompletion(page, firstMessage);
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible();

    response = await sendMessageAndWaitForCompletion(page, followUpMessage);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText(followUpMessage)).toBeVisible();

    const firstAssistantMessage = messagesView(page).locator('.message-render').nth(1);
    await firstAssistantMessage.hover();
    const regenerateButton = firstAssistantMessage
      .getByRole('button', { name: 'Regenerate', exact: true })
      .last();
    await expect(regenerateButton).toBeVisible();

    const [regenerateResponse] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenerateButton.click(),
    ]);
    expect(regenerateResponse.ok()).toBeTruthy();

    await expect(page.getByText('2 / 2')).toBeVisible();
    await page.getByRole('button', { name: 'Previous sibling message' }).click();
    await expect(page.getByText('1 / 2')).toBeVisible();
    await expect(page.getByText(followUpMessage)).toBeVisible();
  });

  test('keeps the viewed branch when regenerating its latest response with an earlier branch present', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const firstMessage = 'first turn from e2e';
    const secondMessage = 'second turn from e2e';

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    let response = await sendMessageAndWaitForCompletion(page, firstMessage);
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page).first()).toBeVisible();
    response = await sendMessageAndWaitForCompletion(page, secondMessage);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText(secondMessage)).toBeVisible();

    // Regenerate the INITIAL response → a second root-level branch the second
    // turn does not belong to.
    const firstAssistant = messagesView(page).locator('.message-render').nth(1);
    await firstAssistant.hover();
    const regenInitial = firstAssistant
      .getByRole('button', { name: 'Regenerate', exact: true })
      .last();
    await expect(regenInitial).toBeVisible();
    [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenInitial.click(),
    ]);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText('2 / 2')).toBeVisible();
    await expect(page.getByText(secondMessage)).toHaveCount(0);

    // Back to the ORIGINAL branch (both turns present).
    await page.getByRole('button', { name: 'Previous sibling message' }).click();
    await expect(page.getByText('1 / 2')).toBeVisible();
    await expect(page.getByText(secondMessage)).toBeVisible();

    // Regenerate the LATEST response on the original branch. The bug snapped the
    // root fork back to the newest (regenerated-initial) branch, dropping the
    // original thread; the view must stay put.
    const latestAssistant = messagesView(page).locator('.message-render').last();
    await latestAssistant.hover();
    const regenLatest = latestAssistant
      .getByRole('button', { name: 'Regenerate', exact: true })
      .last();
    await expect(regenLatest).toBeVisible();
    [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenLatest.click(),
    ]);
    expect(response.ok()).toBeTruthy();

    // Still on the original branch: the second turn survives and the root fork
    // still reads 1 / 2 (rather than snapping to the regenerated-initial branch).
    await expect(page.getByText(secondMessage)).toBeVisible();
    await expect(page.getByText('1 / 2')).toBeVisible();
  });

  test('preserves a long original branch when regenerating early then later on it', async ({
    page,
  }) => {
    test.setTimeout(150000);
    // Labeled prompts give each turn a unique reply, so we can both settle on
    // it (turn complete) and assert which branch is visible.
    const turns = [
      { prompt: replyPrompt('lb-one'), reply: replyText('lb-one') },
      { prompt: replyPrompt('lb-two'), reply: replyText('lb-two') },
      { prompt: replyPrompt('lb-three'), reply: replyText('lb-three') },
    ];

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    // Build a three-turn thread (the "long running thread"), waiting for each
    // turn's unique reply to render before sending the next.
    for (const turn of turns) {
      const response = await sendMessageAndWaitForCompletion(page, turn.prompt);
      expect(response.ok()).toBeTruthy();
      await expect(messagesView(page).getByText(turn.reply)).toBeVisible({ timeout: 30000 });
    }

    // Regenerate from an EARLIER part of the branch (the first response). This
    // forks a fresh root branch that does not contain the later turns.
    const earlyAssistant = messagesView(page).locator('.message-render').nth(1);
    await earlyAssistant.hover();
    const regenEarly = earlyAssistant
      .getByRole('button', { name: 'Regenerate', exact: true })
      .last();
    await expect(regenEarly).toBeVisible();
    let [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenEarly.click(),
    ]);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText('2 / 2')).toBeVisible();
    // The fresh branch does not contain the later turns' replies.
    await expect(messagesView(page).getByText(turns[1].reply)).toHaveCount(0);
    await expect(messagesView(page).getByText(turns[2].reply)).toHaveCount(0);

    // Go back to the ORIGINAL branch — all three turns are present again.
    await page.getByRole('button', { name: 'Previous sibling message' }).click();
    await expect(page.getByText('1 / 2')).toBeVisible();
    await expect(messagesView(page).getByText(turns[1].reply)).toBeVisible();
    await expect(messagesView(page).getByText(turns[2].reply)).toBeVisible();

    // Regenerate from LATER in the original branch (its latest response). The
    // bug snapped the early fork back to the regenerated branch, collapsing the
    // long original thread; it must stay intact.
    const lateAssistant = messagesView(page).locator('.message-render').last();
    await lateAssistant.hover();
    const regenLate = lateAssistant.getByRole('button', { name: 'Regenerate', exact: true }).last();
    await expect(regenLate).toBeVisible();
    [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenLate.click(),
    ]);
    expect(response.ok()).toBeTruthy();

    // The whole original branch survives and its first fork still reads 1 / 2.
    await expect(messagesView(page).getByText(turns[1].reply)).toBeVisible();
    await expect(page.getByText('1 / 2')).toBeVisible();
  });

  test('keeps upload-to-provider CSV attached to the sent message and model input', async ({
    page,
  }) => {
    test.setTimeout(90000);

    const csvFixture: UploadFixture = {
      name: 'provider-upload.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,value\nalpha,1\n'),
    };
    const filename = csvFixture.name;
    const assertionText = `E2E_ASSERT_PROVIDER_FILE:${filename}`;
    const fileChip = messagesView(page).getByRole('button', { name: filename });

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await uploadProviderFile(page, csvFixture);

    await expect(page.getByRole('button', { name: filename })).toBeVisible();

    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.fill(assertionText);
    await expect(page.getByTestId('send-button')).toBeEnabled();

    const [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      page.getByTestId('send-button').click(),
    ]);
    expect(response.ok()).toBeTruthy();

    await expect(
      messagesView(page).getByText(`E2E provider file assertion passed: ${filename}`),
    ).toBeVisible();
    await expect(fileChip).toBeVisible();

    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/);
    const conversationUrl = page.url();
    await page.reload({ timeout: 10000 });
    await expect(page).toHaveURL(conversationUrl);
    await expect(fileChip).toBeVisible();
  });

  test('supports attaching, removing, and sending provider files from the composer', async ({
    page,
  }) => {
    test.setTimeout(90000);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await uploadProviderFile(page, pdfFixture);
    const pdfChip = composer(page).getByRole('button', { name: pdfFixture.name });
    await expect(pdfChip).toBeVisible();

    await composer(page).getByRole('button', { name: 'Remove file' }).click();
    await expect(pdfChip).toHaveCount(0);

    await uploadProviderFile(page, imageFixture);
    await expect(
      composer(page).getByRole('button', { name: 'View Preview image in full size' }),
    ).toBeVisible();

    await uploadProviderFile(page, textFixture);
    const textChip = composer(page).getByRole('button', { name: textFixture.name });
    await expect(textChip).toBeVisible();

    const assertionText = `E2E_ASSERT_PROVIDER_FILE:${textFixture.name}`;
    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.fill(assertionText);
    await expect(page.getByTestId('send-button')).toBeEnabled();

    const [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      page.getByTestId('send-button').click(),
    ]);
    expect(response.ok()).toBeTruthy();

    await expect(
      messagesView(page).getByText(`E2E provider file assertion passed: ${textFixture.name}`),
    ).toBeVisible();
    await expect(messagesView(page).getByRole('button', { name: textFixture.name })).toBeVisible();
  });
});
