import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import type { UploadedFile } from '../helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessageAndWaitForCompletion,
  uniqueName,
  uploadViaUnifiedButton,
} from '../helpers';

const REPORT_MARKER = 'E2E_REPORT_CONTEXT_TOKENS';
/** About 300k base64 characters once encoded, which the counter estimates as four pages. */
const PDF_BODY_BYTES = 225_000;
/** One estimated PDF page; a text-only probe message counts a few dozen tokens at most. */
const ONE_PAGE_TOKENS = 1500;

type ContextTokensReport = { provider: string | null; latest: number | null; total: number };

function syntheticPdf(): string {
  return `%PDF-1.4\n%${'A'.repeat(PDF_BODY_BYTES)}\n%%EOF\n`;
}

async function createAndSelectGeminiAgent(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  const agentName = uniqueAgentName('E2E Gemini Media Agent');
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: agentName,
      description: 'Counts native Google attachments toward the context budget.',
      instructions: 'Read the attachment.',
      provider: 'google',
      model: 'gemini-2.5-flash',
      model_parameters: { resendFiles: true },
    },
  });

  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agentName);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  return agent.id;
}

async function reportContextTokens(page: Page): Promise<ContextTokensReport> {
  const before = await messagesView(page)
    .getByText(/E2E context tokens: /)
    .count();
  await sendMessageAndWaitForCompletion(page, `${REPORT_MARKER} ${Date.now()}`);
  const reply = messagesView(page).getByText(/E2E context tokens: /);
  await expect(reply).toHaveCount(before + 1, { timeout: 15000 });
  const text = (await reply.last().textContent()) ?? '';
  return JSON.parse(text.slice(text.indexOf('{'))) as ContextTokensReport;
}

/** Set up through the agent builder, which the mobile layout keeps in its drawer. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

test.describe('Google native media in the context budget', () => {
  let agentId: string | undefined;

  test.afterEach(async ({ page }) => {
    await cleanupAgent(page, agentId);
    agentId = undefined;
  });

  test('a PDF sent to a Gemini agent counts toward the context budget @scenario:gemini-pdf-counts-toward-context-budget', async ({
    page,
  }) => {
    test.setTimeout(120000);
    agentId = await createAndSelectGeminiAgent(page);

    const fileName = `${uniqueName('report')}.pdf`;
    const upload = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'application/pdf',
      content: syntheticPdf(),
    });
    expect(upload.ok()).toBeTruthy();
    expect(((await upload.json()) as UploadedFile).llmDeliveryPath).toBe('provider');
    await expect(page.getByRole('button', { name: fileName })).toBeVisible({ timeout: 15000 });

    const report = await reportContextTokens(page);
    expect(report.provider).toBe('google');
    expect(report.latest).toBeGreaterThan(ONE_PAGE_TOKENS);
  });

  test('a PDF resent from an earlier Gemini turn still counts on the next turn @scenario:gemini-resent-pdf-counts-on-later-turns', async ({
    page,
  }) => {
    test.setTimeout(120000);
    agentId = await createAndSelectGeminiAgent(page);

    const fileName = `${uniqueName('history')}.pdf`;
    const upload = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'application/pdf',
      content: syntheticPdf(),
    });
    expect(upload.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: fileName })).toBeVisible({ timeout: 15000 });

    const first = await reportContextTokens(page);
    expect(first.latest).toBeGreaterThan(ONE_PAGE_TOKENS);

    const second = await reportContextTokens(page);
    expect(second.provider).toBe('google');
    expect(second.latest).toBeLessThan(ONE_PAGE_TOKENS);
    expect(second.total).toBeGreaterThan(ONE_PAGE_TOKENS);
  });
});
