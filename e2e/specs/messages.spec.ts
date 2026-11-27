import { expect, test } from '@playwright/test';
import type { Response, Page, BrowserContext } from '@playwright/test';

const basePath = 'http://localhost:3080/c/';
const initialUrl = `${basePath}new`;
const endpoints = ['google', 'openAI', 'azureOpenAI'];
const endpoint = endpoints[1];

function isUUID(uuid: string) {
  const regex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return regex.test(uuid);
}

const waitForServerStream = async (response: Response) => {
  const endpointCheck = response.url().includes(`/api/agents`);
  return endpointCheck && response.status() === 200;
};

async function clearConvos(page: Page) {
  await page.goto(initialUrl, { timeout: 5000 });
  await page.getByRole('button', { name: 'test' }).click();
  await page.getByText('Settings').click();
  await page.getByTestId('clear-convos-initial').click();
  await page.getByTestId('clear-convos-confirm').click();
  await page.waitForSelector('[data-testid="convo-icon"]', { state: 'detached' });
  await page.getByRole('button', { name: 'Close' }).click();
}

let beforeAfterAllContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  console.log('🤖: clearing conversations before message tests.');
  beforeAfterAllContext = await browser.newContext();
  const page = await beforeAfterAllContext.newPage();
  await clearConvos(page);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await page.goto(initialUrl, { timeout: 5000 });
});

test.afterEach(async ({ page }) => {
  await page.close();
});

test.describe('Messaging suite', () => {
  test('textbox should be focused after generation, test expected navigation, & test editing messages', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const message = 'hi';
    await page.goto(initialUrl, { timeout: 5000 });
    await page.locator('#new-conversation-menu').click();
    await page.locator(`#${endpoint}`).click();
    await page.locator('form').getByRole('textbox').click();
    await page.locator('form').getByRole('textbox').fill(message);

    const responsePromise = [
      page.waitForResponse(waitForServerStream),
      page.locator('form').getByRole('textbox').press('Enter'),
    ];

    const [response] = (await Promise.all(responsePromise)) as [Response];
    const responseBody = await response.body();
    const messageSuccess = responseBody.includes('"final":true');
    expect(messageSuccess).toBe(true);

    // Check if textbox is focused
    await page.waitForTimeout(250);
    const isTextboxFocused = await page.evaluate(() => {
      return document.activeElement === document.querySelector('[data-testid="text-input"]');
    });
    expect(isTextboxFocused).toBeTruthy();
    const currentUrl = page.url();
    expect(currentUrl).toBe(initialUrl);

    //cleanup the conversation
    await page.getByTestId('nav-new-chat-button').click();
    expect(page.url()).toBe(initialUrl);

    // Click on the first conversation
    await page.getByTestId('convo-icon').first().click({ timeout: 5000 });
    const finalUrl = page.url();
    const conversationId = finalUrl.split(basePath).pop() ?? '';
    expect(isUUID(conversationId)).toBeTruthy();

    // Check if editing works
    const editText = 'All work and no play makes Johnny a poor boy';
    await page.getByRole('button', { name: 'edit' }).click();
    const textEditor = page.getByTestId('message-text-editor');
    await textEditor.click();
    await textEditor.fill(editText);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const updatedTextElement = page.getByText(editText);
    expect(updatedTextElement).toBeTruthy();

    // Check edit response. Nothing is typed into the editor, so the submit button reads
    // "Rerun": reissuing an untouched request is a supported action, not a disabled one.
    await page.getByRole('button', { name: 'edit' }).click();
    const editResponsePromise = [
      page.waitForResponse(waitForServerStream),
      await page.getByRole('button', { name: 'Rerun', exact: true }).click(),
    ];

    const [editResponse] = (await Promise.all(editResponsePromise)) as [Response];
    const editResponseBody = await editResponse.body();
    const editSuccess = editResponseBody.includes('"final":true');
    expect(editSuccess).toBe(true);

    // The generated message should include the edited text
    const currentTextContent = await updatedTextElement.innerText();
    expect(currentTextContent.includes(editText)).toBeTruthy();
  });

  test('message should stop and continue', async ({ page }) => {
    const message = 'write me a 10 stanza poem about space';
    await page.goto(initialUrl, { timeout: 5000 });

    await page.locator('#new-conversation-menu').click();
    await page.locator(`#${endpoint}`).click();
    await page.click('button[data-testid="select-dropdown-button"]:has-text("Model:")');
    await page.getByRole('option', { name: 'gpt-3.5-turbo', exact: true }).click();
    await page.locator('form').getByRole('textbox').click();
    await page.locator('form').getByRole('textbox').fill(message);

    let responsePromise = [
      page.waitForResponse(waitForServerStream),
      page.locator('form').getByRole('textbox').press('Enter'),
    ];

    (await Promise.all(responsePromise)) as [Response];

    // Wait for first Partial tick (it takes 500 ms for server to save the current message stream)
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'Stop' }).click();

    responsePromise = [
      page.waitForResponse(waitForServerStream),
      page.getByTestId('continue-generation-button').click(),
    ];

    (await Promise.all(responsePromise)) as [Response];

    const regenerateButton = page.getByRole('button', { name: 'Regenerate' });
    expect(regenerateButton).toBeTruthy();

    // Clear conversation since it seems to persist despite other tests clearing it
    await page.getByTestId('convo-item').getByRole('button').nth(1).click();
  });

  // in this spec as we are testing post-message navigation, we are not testing the message response
  test('Page navigations', async ({ page }) => {
    await page.goto(initialUrl, { timeout: 5000 });
    await page.getByTestId('convo-icon').first().click({ timeout: 5000 });
    const currentUrl = page.url();
    const conversationId = currentUrl.split(basePath).pop() ?? '';
    expect(isUUID(conversationId)).toBeTruthy();
    await page.getByTestId('nav-new-chat-button').click();
    expect(page.url()).toBe(initialUrl);
  });
});
