import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  isAgentsStream,
  getAccessToken,
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

    await expect(
      page.getByTestId('composer-tray').getByRole('button', { name: filename, exact: true }),
    ).toBeVisible();

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

  test('stops sending a file the conversation leaves out, and sends it again once taken back @scenario:conversation-leaves-file-out', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const csvFixture: UploadFixture = {
      name: 'left-out-upload.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,value\nalpha,1\n'),
    };
    const filename = csvFixture.name;
    const fileChip = messagesView(page).getByRole('button', { name: filename });
    const listed = (label: string, names: string) =>
      messagesView(page).getByText(`E2E provider files (${label}): ${names}`);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const upload = await uploadProviderFile(page, csvFixture);
    const { file_id: fileId } = (await upload.json()) as { file_id: string };
    expect(fileId).toBeTruthy();

    let response = await sendMessageAndWaitForCompletion(
      page,
      `E2E_ASSERT_PROVIDER_FILE:${filename}`,
    );
    expect(response.ok()).toBeTruthy();
    await expect(
      messagesView(page).getByText(`E2E provider file assertion passed: ${filename}`),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/);
    const conversationId = page.url().split('/c/')[1];

    /** A later turn sends the earlier message's file again: that is the cost being controlled. */
    response = await sendMessageAndWaitForCompletion(page, 'E2E_LIST_PROVIDER_FILES:before');
    expect(response.ok()).toBeTruthy();
    await expect(listed('before', filename)).toBeVisible();

    const token = await getAccessToken(page);
    const setExcluded = (excluded: boolean) =>
      page.request.post(`/api/convos/${conversationId}/files/exclusion`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { fileIds: [fileId], excluded },
      });

    const left = await setExcluded(true);
    expect(left.ok()).toBeTruthy();
    expect(await left.json()).toEqual({ excludedFiles: [fileId] });

    response = await sendMessageAndWaitForCompletion(page, 'E2E_LIST_PROVIDER_FILES:left-out');
    expect(response.ok()).toBeTruthy();
    await expect(listed('left-out', 'none')).toBeVisible();
    /** Left out of what the model is sent, not out of the conversation: the message keeps it. */
    await expect(fileChip).toBeVisible();

    const back = await setExcluded(false);
    expect(back.ok()).toBeTruthy();
    expect(await back.json()).toEqual({ excludedFiles: [] });

    response = await sendMessageAndWaitForCompletion(page, 'E2E_LIST_PROVIDER_FILES:taken-back');
    expect(response.ok()).toBeTruthy();
    await expect(listed('taken-back', filename)).toBeVisible();
  });

  test('lists a chat’s files in the session rail and stops sending one switched off there @scenario:session-rail-files', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);

    const csvFixture: UploadFixture = {
      name: 'rail-upload.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,value\nalpha,1\n'),
    };
    const filename = csvFixture.name;
    const listed = (label: string, names: string) =>
      messagesView(page).getByText(`E2E provider files (${label}): ${names}`);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await uploadProviderFile(page, csvFixture);
    let response = await sendMessageAndWaitForCompletion(
      page,
      `E2E_ASSERT_PROVIDER_FILE:${filename}`,
    );
    expect(response.ok()).toBeTruthy();
    await expect(
      messagesView(page).getByText(`E2E provider file assertion passed: ${filename}`),
    ).toBeVisible();

    await page.getByTestId('header-background-tasks-button').click();
    const rail = page.getByRole('complementary', { name: 'Session' });
    const row = rail.getByTestId('session-file').filter({ hasText: filename });
    await expect(row).toContainText('Sent to the model');
    const include = row.getByRole('switch', { name: `Use ${filename} in new messages` });
    await expect(include).toBeChecked();
    await testInfo.attach('session-rail-files', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await include.click();
    await expect(include).not.toBeChecked();
    await expect(row).toContainText('Left out');
    await expect(rail).toContainText('1 left out');

    response = await sendMessageAndWaitForCompletion(page, 'E2E_LIST_PROVIDER_FILES:switched-off');
    expect(response.ok()).toBeTruthy();
    await expect(listed('switched-off', 'none')).toBeVisible();
    await testInfo.attach('session-rail-files-left-out', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    /** The choice belongs to the conversation, not to this page. */
    await page.reload({ timeout: 10000 });
    await expect(rail).toBeVisible();
    await expect(include).not.toBeChecked();

    await include.click();
    await expect(include).toBeChecked();
    response = await sendMessageAndWaitForCompletion(page, 'E2E_LIST_PROVIDER_FILES:switched-on');
    expect(response.ok()).toBeTruthy();
    await expect(listed('switched-on', filename)).toBeVisible();
    await rail.getByRole('button', { name: 'Close session' }).click();
  });

  test('resizes the session rail from its handle and keeps the width @scenario:session-rail-resize', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessageAndWaitForCompletion(page, 'ping for the rail');
    expect(response.ok()).toBeTruthy();

    await page.getByTestId('header-background-tasks-button').click();
    const rail = page.getByRole('complementary', { name: 'Session' });
    await expect(rail).toBeVisible();
    const handle = page.getByRole('separator', { name: 'Resize the session panel' });
    const thread = messagesView(page);
    const widthOf = async (target: typeof rail) => (await target.boundingBox())?.width ?? 0;
    const viewport = page.viewportSize()?.width ?? 0;

    /** It opens at its default width, against the window's edge. */
    expect(await widthOf(rail)).toBeCloseTo(320, -1);
    const railBox = await rail.boundingBox();
    expect((railBox?.x ?? 0) + (railBox?.width ?? 0)).toBeCloseTo(viewport, 0);
    const threadBefore = await widthOf(thread);

    /** Dragging the handle toward the conversation widens the rail and narrows the thread. */
    const grip = await handle.boundingBox();
    const startX = (grip?.x ?? 0) + (grip?.width ?? 0) / 2;
    const y = (grip?.y ?? 0) + (grip?.height ?? 0) / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - 120, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => widthOf(rail)).toBeGreaterThan(420);
    const dragged = await widthOf(rail);
    expect(await widthOf(thread)).toBeLessThan(threadBefore - 100);

    /** The handle takes the keyboard too. */
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => widthOf(rail)).toBeLessThan(dragged);
    const keyed = await widthOf(rail);

    /** The width is the reader's, so it is there after a reload and in a narrower window. */
    await page.reload({ timeout: 10000 });
    await expect(rail).toBeVisible();
    await expect.poll(() => widthOf(rail)).toBeCloseTo(keyed, -1);
    /** A much narrower window squeezes it to its share of the room, and it does not shrink in
     *  step with the window before that; given the room back, it returns to the reader's width. */
    const height = page.viewportSize()?.height ?? 720;
    await page.setViewportSize({ width: viewport - 300, height });
    await expect.poll(() => widthOf(rail)).toBeLessThan(keyed - 40);
    const squeezed = await widthOf(rail);
    const column = await page
      .locator('#chat-column')
      .evaluate((element) => element.parentElement?.getBoundingClientRect().width ?? 0);
    expect(squeezed).toBeCloseTo(column / 2, -1);
    await page.setViewportSize({ width: viewport, height });
    await expect.poll(() => widthOf(rail)).toBeCloseTo(keyed, -1);

    /** A press on the handle that changes nothing is not a choice of width: after a key that
     *  does not resize, and after a click that does not drag, a squeeze is still not kept. */
    const squeezeAndRestore = async (chosen: number) => {
      await page.setViewportSize({ width: viewport - 300, height });
      await expect.poll(() => widthOf(rail)).toBeLessThan(chosen - 40);
      await page.setViewportSize({ width: viewport, height });
      await expect.poll(() => widthOf(rail)).toBeCloseTo(chosen, -1);
    };
    await handle.focus();
    await page.keyboard.press('Tab');
    await squeezeAndRestore(keyed);
    const idle = await handle.boundingBox();
    await page.mouse.click((idle?.x ?? 0) + (idle?.width ?? 0) / 2, y);
    await squeezeAndRestore(keyed);
    /** Nor is a resizing key with nowhere to go: Home takes the rail to its widest, and a
     *  second Home changes nothing. */
    await handle.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => widthOf(rail)).toBeGreaterThan(keyed + 40);
    const widest = await widthOf(rail);
    await page.keyboard.press('Home');
    await squeezeAndRestore(widest);

    /** Closed, the column and its handle are gone and the thread has the room back. */
    await rail.getByRole('button', { name: 'Close session' }).click();
    await expect(rail).toHaveCount(0);
    await expect(handle).toHaveCount(0);
    await expect.poll(() => widthOf(thread)).toBeGreaterThan(threadBefore);
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
