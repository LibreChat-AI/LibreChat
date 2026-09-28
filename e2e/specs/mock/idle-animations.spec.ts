import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  seedConversations,
  seedMessages,
  deleteConversations,
  deleteMessagesByConversation,
} from './db';
import { getE2EUser } from '../../setup/user';

/** Exercise real animation CSS even on hosts whose OS prefers reduced motion. */
test.use({ reducedMotion: 'no-preference' });

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 664 },
]) {
  test(`settled code messages have no continuously running animations (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const conversationId = randomUUID();
    const userEmail = getE2EUser().email;
    const messages = [];
    let parentMessageId = '00000000-0000-0000-0000-000000000000';
    for (let index = 0; index < 6; index++) {
      const messageId = `${conversationId}-${index}`;
      const isCreatedByUser = index % 2 === 0;
      messages.push({
        messageId,
        parentMessageId,
        isCreatedByUser,
        sender: isCreatedByUser ? 'User' : 'Assistant',
        text: isCreatedByUser
          ? `Show example ${index}`
          : `Settled example ${index}\n\n\`\`\`python\nprint(${index})\n\`\`\``,
      });
      parentMessageId = messageId;
    }

    try {
      await seedConversations(userEmail, [
        { conversationId, title: 'Idle animations', updatedAt: new Date() },
      ]);
      await seedMessages(userEmail, conversationId, messages);
      await page.goto(`/c/${conversationId}`);
      const rows = page.locator('.message-render');
      await expect(rows).toHaveCount(messages.length);
      for (let index = 1; index < messages.length; index += 2) {
        await expect(
          rows.nth(index).getByRole('button', { name: 'Run Code', exact: true }).first(),
        ).toBeAttached();
      }

      /** Finite entrance transitions are allowed; opacity-hidden infinite loops are not. */
      await expect
        .poll(
          () =>
            rows.evaluateAll((elements) =>
              elements.flatMap((element) =>
                element
                  .getAnimations({ subtree: true })
                  .filter(
                    (animation) =>
                      animation.playState === 'running' &&
                      animation.effect?.getTiming().iterations === Infinity,
                  )
                  .map((animation) => ({
                    animation:
                      animation instanceof CSSAnimation ? animation.animationName : animation.id,
                    target: (animation.effect as KeyframeEffect | null)?.target?.outerHTML.slice(
                      0,
                      250,
                    ),
                  })),
              ),
            ),
          {
            message:
              'Idle transcript must not continuously animate, including invisible descendants',
          },
        )
        .toEqual([]);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
}
