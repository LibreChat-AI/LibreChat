import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openAgentBuilder } from '../agents.helpers';
import {
  messagesView,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  selectModelSpec,
  sendMessage,
} from '../helpers';

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const slowRun = (label: string) => `E2E_SLOW_REPLY:${label}`;

async function startRun(page: Page, label: string) {
  const response = await sendMessage(page, slowRun(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });
}

async function startRunThroughComposer(page: Page, label: string) {
  await messageInput(page).fill(slowRun(label));
  await messageInput(page).press('Enter');
  await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });
}

async function openComposer(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

test.describe('composer redesign contracts', () => {
  test('Composer hint names the interrupt default @scenario:composer-hint-names-the-interrupt-default', async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem('steerInterruptsByDefault', JSON.stringify(true)),
    );
    await openComposer(page);
    await startRun(page, `interrupt-hint-${Date.now()}`);
    await messageInput(page).fill('interrupt hint');
    await expect(page.getByTestId('composer-hints')).toContainText(/interrupt/i);
  });

  test('Staged reasoning relabels steer as a new turn @scenario:staged-reasoning-relabels-steer-as-a-new-turn', async ({
    page,
  }) => {
    await openComposer(page);
    await startRun(page, `staged-reasoning-${Date.now()}`);
    const thinking = page.getByRole('button', { name: /^Thinking: / });
    await thinking.click();
    await page
      .getByRole('dialog', { name: /^Thinking: / })
      .getByRole('radio', { name: 'Max', exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(thinking).toHaveAccessibleName(/Max/i);
    await messageInput(page).fill('new turn after reasoning');
    await expect(page.getByTestId('during-run-send-button')).toBeVisible();
    await expect(page.getByTestId('during-run-send-button')).toHaveAttribute(
      'data-during-run-action',
      'queue',
    );
    await page.getByTestId('during-run-send-button').click();
    await expect(
      page.getByTestId('queued-message-row').filter({ hasText: 'new turn after reasoning' }),
    ).toBeVisible();
  });

  test('Model-spec locked reasoning control is hidden @scenario:model-spec-locked-reasoning-control-is-hidden', async ({
    page,
  }) => {
    let interceptedConfig:
      | {
          modelSpecs?: {
            enforce?: boolean;
            list?: Array<{ name?: string; preset?: Record<string, unknown> }>;
          };
        }
      | undefined;
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      const list = Array.isArray(config.modelSpecs?.list) ? config.modelSpecs.list : [];
      const lockedList = list.map((spec: Record<string, unknown>) => ({
        ...spec,
        preset: {
          ...((spec.preset as Record<string, unknown>) ?? {}),
          effort: 'max',
          reasoning_effort: 'max',
          thinkingLevel: 'high',
          thinkingBudget: 1024,
        },
      }));
      interceptedConfig = {
        ...config,
        modelSpecs: { ...(config.modelSpecs ?? {}), enforce: true, list: lockedList },
      };
      await route.fulfill({
        response,
        json: interceptedConfig,
      });
    });
    await openComposer(page);
    await selectModelSpec(page, 'E2E Skill Scope');
    await expect(page).toHaveURL(/spec=e2e-skill-scope/);
    expect(interceptedConfig?.modelSpecs?.enforce).toBe(true);
    expect(
      interceptedConfig?.modelSpecs?.list?.find(
        (spec: Record<string, unknown>) => spec.name === 'e2e-skill-scope',
      )?.preset,
    ).toEqual(
      expect.objectContaining({
        effort: 'max',
        reasoning_effort: 'max',
        thinkingLevel: 'high',
        thinkingBudget: 1024,
      }),
    );
    await expect(page.getByTestId('composer-thinking-button')).toHaveCount(0);
  });

  test('Stop shortcut ignores focus in a non-chat form @scenario:stop-shortcut-ignores-focus-in-a-non-chat-form', async ({
    page,
  }) => {
    const narrow = (page.viewportSize()?.width ?? 1280) <= 768;
    let form;
    if (narrow) {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await startRunThroughComposer(page, `shortcut-form-${Date.now()}`);
      form = await openAgentBuilder(page, { navigate: false });
    } else {
      form = await openAgentBuilder(page);
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await startRunThroughComposer(page, `shortcut-form-${Date.now()}`);
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const dialogs = await page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll('[role="dialog"]:not([inert]):not([data-state="closed"])'),
        ).filter((el) => {
          const style = (el as HTMLElement).style;
          const computedStyle = window.getComputedStyle(el);
          return (
            !el.hasAttribute('hidden') &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            computedStyle.display !== 'none' &&
            computedStyle.visibility !== 'hidden'
          );
        }).length,
    );
    expect(dialogs).toBe(0);
    const nameInput = form.getByLabel('Agent name');
    await nameInput.click();
    await expect(nameInput).toBeFocused();
    const abort = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/api/agents/chat/abort'),
    );
    const modifier = await page.evaluate(() =>
      navigator.platform.includes('Mac') ? 'Meta' : 'Control',
    );
    await page.keyboard.press(`${modifier}+Shift+X`);
    const abortResponse = await abort;
    expect(abortResponse.ok()).toBeTruthy();
  });

  test('Canceled pending steer disappears before application @scenario:canceled-pending-steer-disappears-before-application', async ({
    page,
  }) => {
    await openComposer(page);
    await startRun(page, `cancel-steer-${Date.now()}`);
    await messageInput(page).fill('pending steer');
    await page.getByTestId('during-run-send-button').click();
    const bubble = page
      .getByTestId('pending-steers')
      .getByRole('listitem')
      .filter({ hasText: 'pending steer' });
    await expect(bubble).toContainText('Sending');
    await bubble.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(bubble).toHaveCount(0);
    await expect(messagesView(page).getByText('pending steer', { exact: true })).toHaveCount(0);
  });

  test('Canceled steer returns its text to the composer @scenario:canceled-steer-returns-its-text-to-the-composer', async ({
    page,
  }) => {
    await openComposer(page);
    await startRun(page, `reclaim-steer-${Date.now()}`);
    await messageInput(page).fill('pending steer');
    await page.getByTestId('during-run-send-button').click();
    const bubble = page
      .getByTestId('pending-steers')
      .getByRole('listitem')
      .filter({ hasText: 'pending steer' });
    await expect(bubble).toContainText('Sending');
    /** The draft typed while the cancel was in flight must survive the
     *  reclaim: the returned steer joins it instead of replacing it. */
    await messageInput(page).fill('draft remains');
    await bubble.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(bubble).toHaveCount(0);
    await expect(messageInput(page)).toHaveValue('draft remains\npending steer');
  });

  test('Pending steer status does not claim application before delivery @scenario:pending-steer-status-does-not-claim-application-before-delivery', async ({
    page,
  }) => {
    await openComposer(page);
    await startRun(page, `pending-status-${Date.now()}`);
    await messageInput(page).fill('pending status');
    await page.getByTestId('during-run-send-button').click();
    const bubble = page
      .getByTestId('pending-steers')
      .getByRole('listitem')
      .filter({ hasText: 'pending status' });
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('Sending');
  });
});
