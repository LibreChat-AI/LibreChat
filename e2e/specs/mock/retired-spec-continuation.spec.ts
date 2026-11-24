import { expect, test } from '@playwright/test';
import type { TMessage, TStartupConfig } from 'librechat-data-provider';
import { deleteConversations, withMongo } from './db';
import {
  fetchJson,
  getAccessToken,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

test('continues a saved chat whose hidden spec moved off a retired endpoint', async ({ page }) => {
  const provider = MOCK_ENDPOINTS[0];
  const spec = 'e2e-handoff-specialist';
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, provider);
  const first = await sendMessageAndWaitForCompletion(page, 'Original turn before retirement');
  const { conversationId } = await first.json();
  try {
    const token = await getAccessToken(page);
    const messages = `/api/messages/${conversationId}`;
    const original = await fetchJson<TMessage[]>(page, messages, token);
    const parent = original.find((message) => !message.isCreatedByUser);
    expect(parent).toBeDefined();
    await withMongo(async (db) => {
      const result = await db
        .collection('conversations')
        .updateOne(
          { conversationId },
          { $set: { endpoint: 'Retired Provider', model: 'retired-model', spec } },
        );
      expect(result.matchedCount).toBe(1);
    });

    await page.goto(`/c/${conversationId}`);
    await expect(page.getByText('Original turn before retirement')).toBeVisible();
    const config = await fetchJson<TStartupConfig>(page, '/api/config', token);
    expect(config.modelSpecs?.list?.some((entry) => entry.name === spec)).toBe(false);

    const followUp = await sendMessageAndWaitForCompletion(page, 'Continue the original chat');
    expect(followUp.request().postDataJSON()).toMatchObject({
      conversationId,
      parentMessageId: parent?.messageId,
      endpoint: provider.label,
      model: provider.model,
      spec,
    });
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`));
    const continued = await fetchJson<TMessage[]>(page, messages, token);
    expect(continued).toHaveLength(original.length + 2);
    expect(continued.map((message) => message.messageId)).toEqual(
      expect.arrayContaining(original.map((message) => message.messageId)),
    );
  } finally {
    await deleteConversations([conversationId]);
  }
});
