import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import type { SeedMessage } from '../db';
import type { AgentDetail } from '../agents.helpers';
import { uniqueAgentName } from '../agents.helpers';
import { MOCK_ENDPOINTS, fetchJson, getAccessToken, messagesView, requestJson } from '../helpers';

/**
 * Classes Tailwind 3 never generated, adopted now that Tailwind 4 renders them: the continue
 * action's 19px glyph, the artifact panel's open and close timings, and the agent avatar's ring.
 */
const userEmail = getE2EUser().email;
const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const ARTIFACT_TEXT = [
  ':::artifact{identifier="e2e-timing" type="text/html" title="timing.html"}',
  '<main><h1>Timing</h1></main>',
  ':::',
].join('\n');

async function seedThread(title: string, messages: SeedMessage[]) {
  const conversationId = randomUUID();
  await seedConversations(userEmail, [{ conversationId, title, updatedAt: new Date() }]);
  await seedMessages(userEmail, conversationId, messages);
  return conversationId;
}

async function cleanup(conversationId: string) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

async function openArtifact(page: Page, title: string) {
  const conversationId = await seedThread(title, [
    {
      messageId: randomUUID(),
      parentMessageId: ROOT_PARENT,
      text: ARTIFACT_TEXT,
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
    },
  ]);
  await page.goto(`/c/${conversationId}`, { timeout: 15000 });
  const trigger = messagesView(page).locator('[data-artifact-trigger]').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  const panel = page.locator('#artifact-viewer');
  await expect(panel).toBeVisible();
  return { conversationId, panel };
}

test.describe('continue action', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('the continue action draws its glyph at the size of the actions beside it @scenario:continue-icon-matches-hover-row', async ({
    page,
  }) => {
    const userMessageId = randomUUID();
    const answerId = randomUUID();
    const conversationId = await seedThread('Continue icon', [
      {
        messageId: userMessageId,
        parentMessageId: ROOT_PARENT,
        text: 'Write a long answer',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: answerId,
        parentMessageId: userMessageId,
        text: 'A long answer that stopped at the token limit',
        isCreatedByUser: false,
        sender: 'OpenAI',
        finish_reason: 'length',
      },
    ]);
    try {
      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      const row = page.locator(`[id="${answerId}"]`);
      await expect(row).toBeVisible();
      await row.hover();

      const glyph = page.getByTestId('continue-generation-button').locator('svg');
      const copy = row.getByTestId('copy-response-button').locator('svg').first();
      await expect(glyph).toBeVisible();
      await expect(copy).toBeVisible();
      const [glyphBox, copyBox] = await Promise.all([glyph.boundingBox(), copy.boundingBox()]);
      expect(glyphBox?.width).toBeCloseTo(19, 0);
      expect(glyphBox?.height).toBeCloseTo(19, 0);
      expect(glyphBox?.width).toBeCloseTo(copyBox?.width ?? 0, 0);
    } finally {
      await cleanup(conversationId);
    }
  });
});

test.describe('artifact panel on desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('the docked artifact panel slides in over 350ms @scenario:artifact-panel-desktop-open-timing', async ({
    page,
  }) => {
    const { conversationId, panel } = await openArtifact(page, 'Artifact desktop timing');
    try {
      await expect(panel).toHaveAttribute('role', 'region');
      await expect
        .poll(() => panel.evaluate((node) => getComputedStyle(node).transitionDuration))
        .toBe('0.35s');
    } finally {
      await cleanup(conversationId);
    }
  });
});

test.describe('artifact sheet on mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the artifact sheet slides away within the 250ms its close waits for @scenario:artifact-sheet-mobile-close-timing', async ({
    page,
  }) => {
    const { conversationId, panel } = await openArtifact(page, 'Artifact mobile timing');
    try {
      await expect(panel).toHaveAttribute('role', 'dialog');
      await expect
        .poll(() => panel.evaluate((node) => getComputedStyle(node).transitionDuration))
        .toBe('0.3s');

      await panel.evaluate((node) => {
        const record = window as unknown as { closingDuration?: string };
        const observer = new MutationObserver(() => {
          if (node.className.includes('translate-y-full') && record.closingDuration == null) {
            record.closingDuration = getComputedStyle(node).transitionDuration;
            observer.disconnect();
          }
        });
        observer.observe(node, { attributes: true, attributeFilter: ['class'] });
      });
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(panel).toBeHidden();
      expect(
        await page.evaluate(
          () => (window as unknown as { closingDuration?: string }).closingDuration,
        ),
      ).toBe('0.25s');
    } finally {
      await cleanup(conversationId);
    }
  });
});

test.describe('agent avatar', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('a favorite agent with a picture is framed by a 1px medium border @scenario:agent-avatar-border', async ({
    page,
  }) => {
    await page.goto('/c/new', { timeout: 15000 });
    const token = await getAccessToken(page);
    const avatar =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ffffff"/></svg>',
      );
    const agent = await requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('Avatar border'),
        instructions: 'Avatar border scenario.',
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        model_parameters: {},
        avatar: { filepath: avatar, source: 'local' },
      },
    });
    const original = await fetchJson<Array<Record<string, unknown>>>(
      page,
      '/api/user/settings/favorites',
      token,
    );
    try {
      await requestJson(page, {
        path: '/api/user/settings/favorites',
        token,
        method: 'POST',
        body: { favorites: [{ agentId: agent.id }, ...original].slice(0, 50) },
      });
      await page.reload();

      const image = page.getByRole('img', { name: `${agent.name} avatar` }).first();
      await expect(image).toBeVisible({ timeout: 15000 });
      const style = await image.evaluate((node) => {
        const computed = getComputedStyle(node);
        const probe = document.createElement('div');
        probe.className = 'border-border-medium border';
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).borderTopColor;
        probe.remove();
        return { width: computed.borderTopWidth, color: computed.borderTopColor, expected };
      });
      expect(style.width).toBe('1px');
      expect(style.color).toBe(style.expected);
    } finally {
      await requestJson(page, {
        path: '/api/user/settings/favorites',
        token,
        method: 'POST',
        body: { favorites: original },
      });
      await requestJson(page, { path: `/api/agents/${agent.id}`, token, method: 'DELETE' });
    }
  });
});
