import { expect, test } from '@playwright/test';
import { ContentTypes, parseNativeMessageReference } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { mediaFixtureURL } from '../../setup/media';
import {
  fetchJson,
  getAccessToken,
  messagesView,
  selectModelSpec,
  sendMessage,
  sendMessageAndWaitForCompletion,
  uniqueName,
} from './helpers';
import { expectAccessible } from './accessibility';

function expectPrivateReplayAbsent(messages: TMessage[], originalBytes: Buffer) {
  const serialized = JSON.stringify(messages);
  for (const privateField of [
    'nativeSignatures',
    'thoughtSignatures',
    'thoughtSignature',
    'thought_signature',
    'e2e-private-',
    'inlineData',
    'data:image/',
    originalBytes.toString('base64'),
  ])
    expect(serialized).not.toContain(privateField);
  for (const message of messages) {
    for (const part of message.content ?? []) {
      const identity = (part as { native_media?: { continuationRef?: string } } | null)
        ?.native_media;
      if (!identity) continue;
      const reference = parseNativeMessageReference(identity.continuationRef ?? '');
      expect(reference?.messageId).toBe(message.messageId);
    }
  }
}

for (const mode of ['complete', 'abort'] as const) {
  test(
    mode === 'complete'
      ? 'a native image streams before completion and retains private continuation across reload'
      : 'a stopped native image remains visible and continues after reload',
    async ({ page }) => {
      test.slow();
      await page.goto('/c/new');
      await selectModelSpec(page, 'E2E Native Gemini');
      const fixtureToken = uniqueName('native-observatory');
      const admission = await sendMessage(page, `E2E_NATIVE_MEDIA:${fixtureToken}`);
      const { conversationId } = (await admission.json()) as { conversationId: string };
      const messages = messagesView(page);
      const image = messages.locator('.message-render img').first();
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(0);
      await expect(
        page.getByRole('button', { name: 'Stop generating', exact: true }),
      ).toBeVisible();
      if (mode === 'complete') {
        const completion = await page.request.post(
          `${mediaFixtureURL}/__fixture/native/${encodeURIComponent(fixtureToken)}/complete`,
        );
        expect(completion.status()).toBe(200);
        await expect(messages.getByText('E2E native image ready', { exact: true })).toBeVisible();
      } else {
        await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
      }
      await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden();
      await expect(page).toHaveURL((url) => url.pathname === `/c/${conversationId}`);
      const token = await getAccessToken(page);
      const messageURL = `/api/messages/${encodeURIComponent(conversationId)}`;
      let saved: TMessage[] = [];
      await expect
        .poll(async () => {
          saved = await fetchJson<TMessage[]>(page, messageURL, token);
          return saved.some((message) =>
            message.content?.some(
              (part) => part?.type === ContentTypes.IMAGE_FILE && !!part.image_file?.file_id,
            ),
          );
        })
        .toBe(true);
      const images = saved
        .flatMap((message) => message.content ?? [])
        .flatMap((part) => (part?.type === ContentTypes.IMAGE_FILE ? [part.image_file] : []));
      expect(images).toHaveLength(1);
      expect(images[0].file_id).toBeTruthy();
      expect(images[0].filepath).toBeTruthy();
      const original = await image.getAttribute('src');
      expect(original).not.toMatch(/^(data:|blob:)/);
      const download = await page.request.get(original!);
      expect(download.ok()).toBe(true);
      expect(download.headers()['content-type']).toContain('image/');
      const originalBytes = await download.body();
      expect(originalBytes.length).toBeGreaterThan(0);
      expectPrivateReplayAbsent(saved, originalBytes);
      await page.reload();
      await expect(image).toHaveAttribute('src', original!);
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(0);
      await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden();
      await sendMessageAndWaitForCompletion(page, `E2E_NATIVE_CONTINUATION:${fixtureToken}`);
      await expect(
        messages.getByText('E2E native continuation ready', { exact: true }),
      ).toBeVisible();
      const continued = await fetchJson<TMessage[]>(page, messageURL, token);
      expectPrivateReplayAbsent(continued, originalBytes);
      await page.reload();
      await expect(
        messages.getByText('E2E native continuation ready', { exact: true }),
      ).toBeVisible();
      await expect(image).toHaveAttribute('src', original!);
      await expectAccessible(page);
    },
  );
}
