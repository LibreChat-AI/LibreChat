import { expect, test } from '@playwright/test';
import { withMongo } from './db';
import {
  loginAdmin,
  setRuntimeAssistantProtection,
  restoreRuntimeFilters,
} from './content-filters.helpers';
import {
  messagesView,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from './helpers';

const provider = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;
const endpoint = { label: 'Assistant Output Fixture', model: 'gpt-4o-mini' };
const privateText = 'private phrase example';
const approved = 'This is an approved answer.';

test('assistant output is approved before chat delivery, saved history, and reuse', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const token = await loginAdmin(request);
  try {
    await setRuntimeAssistantProtection(
      request,
      token,
      {
        version: 1,
        assistantText: {
          timeoutMs: 10_000,
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'Private phrase', regex: privateText }],
        },
      },
      endpoint.label,
      `${provider}/v1`,
    );
    await page.goto('/c/new');
    await selectMockEndpoint(page, endpoint);
    const first = await sendMessageAndWaitForCompletion(page, 'E2E_ASSISTANT_OUTPUT: approved');
    const { conversationId } = await first.json();
    await expect(messagesView(page).getByText(approved, { exact: true })).toBeVisible();
    await page.reload();
    await expect(messagesView(page).getByText(approved, { exact: true })).toBeVisible();

    const withheld = await sendMessage(page, 'E2E_ASSISTANT_OUTPUT: withhold');
    expect((await withheld.json()).conversationId).toBe(conversationId);
    await expect(
      messagesView(page).getByText('The reply was withheld', { exact: false }),
    ).toBeVisible();
    await expect(messagesView(page)).not.toContainText('Do not send this private');

    const capture = await request.get(`${provider}/__e2e/requests`);
    const { requests } = (await capture.json()) as {
      requests: { messages: { role: string; content: unknown }[] }[];
    };
    const outbound = requests.findLast(({ messages }) =>
      messages.some(
        ({ role, content }) =>
          role === 'user' && JSON.stringify(content).includes('E2E_ASSISTANT_OUTPUT: withhold'),
      ),
    );
    expect(
      outbound?.messages.some(
        ({ role, content }) => role === 'assistant' && JSON.stringify(content).includes(approved),
      ),
    ).toBe(true);
    const saved = await withMongo(async (db) => {
      let rows = '';
      await expect
        .poll(async () => {
          rows = JSON.stringify(await db.collection('messages').find({ conversationId }).toArray());
          return rows.includes('assistant_output_withheld');
        })
        .toBe(true);
      return rows;
    });
    expect(saved).toContain(approved);
    expect(saved).not.toContain('Do not send this private');
    expect(saved).not.toContain(privateText);

    const [rejected] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.startsWith('/api/agents/chat') &&
          response.request().method() === 'POST' &&
          response.status() === 400,
      ),
      messagesView(page).getByRole('button', { name: 'Regenerate', exact: true }).last().click(),
    ]);
    expect(await rejected.json()).toMatchObject({ code: 'assistant_output_unsupported' });
    await expect(
      messagesView(page).getByText('Assistant reply protection requires a new text-only turn', {
        exact: false,
      }),
    ).toBeVisible();
  } finally {
    await restoreRuntimeFilters(request, token);
  }
});
