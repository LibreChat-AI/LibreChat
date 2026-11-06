import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { NEW_CHAT_PATH, MOCK_ENDPOINTS, selectMockEndpoint, sendMessage } from '../helpers';
import { computedStyles, normalizeColor, probeStyle, themeValue } from './style.helpers';
import { getE2EUser } from '../../../setup/user';

const PHASE = 'Checked the message theme';
const MARKDOWN = [
  'The message surfaces follow the active theme.',
  '',
  '> A quoted result.',
  '',
  '| Surface | Status |',
  '| --- | --- |',
  '| Stop control | Visible |',
  '| Activity header | Blends into the message canvas |',
].join('\n');

async function seedChat(): Promise<string> {
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Message theme checks', updatedAt: new Date() },
  ]);
  await seedMessages(email, conversationId, [
    {
      messageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Check the controls and message surfaces.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: messageId,
      text: MARKDOWN,
      isCreatedByUser: false,
      sender: 'Mock Provider A',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: 'theme-read',
            name: 'read_file',
            args: '{"path":"theme.ts"}',
            output: 'Theme roles checked.',
            type: 'tool_call',
            progress: 1,
          },
        },
        {
          type: 'tool_call',
          tool_call: {
            id: 'theme-query',
            name: 'run_select_query',
            args: '{}',
            output: 'Message colors checked.',
            type: 'tool_call',
            progress: 1,
          },
        },
        {
          type: 'activity_label',
          activity_label: PHASE,
          activity_label_type: 'phase',
          activity_start_index: 0,
          activity_end_index: 2,
          activity_count: 2,
          pending: false,
        },
        { type: 'text', text: MARKDOWN },
      ],
    },
  ]);
  return conversationId;
}

test.use({ viewport: { width: 1280, height: 800 } });

for (const definition of ['stock', 'clickhouse'] as const) {
  for (const mode of ['light', 'dark'] as const) {
    test(`message surfaces and stop contrast in ${definition} ${mode} @scenario:message-theme-${definition}-${mode}`, async ({
      page,
    }) => {
      await page.addInitScript(
        ({ selectedMode, theme }) => {
          localStorage.setItem('color-theme', selectedMode);
          localStorage.setItem('navVisible', 'true');
          localStorage.removeItem('theme-colors');
          localStorage.removeItem('theme-name');
          if (theme) {
            localStorage.setItem('theme-definition', JSON.stringify(theme));
            localStorage.setItem('theme-source', 'definition');
          } else {
            localStorage.removeItem('theme-definition');
            localStorage.removeItem('theme-source');
          }
        },
        { selectedMode: mode, theme: definition === 'clickhouse' ? clickHouseTheme : null },
      );
      const conversationId = await seedChat();
      try {
        await page.goto(`/c/${conversationId}`);
        const phase = page.getByTestId('activity-phase-card');
        const toggle = phase.getByRole('button', { name: PHASE });
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const header = toggle.locator('..').locator('..');
        const table = page.locator('.markdown table');
        await expect(table).toBeVisible();
        const screenshot = test.info().outputPath(`messages-${definition}-${mode}.png`);
        await page.screenshot({ path: screenshot, animations: 'disabled' });
        await test.info().attach(`messages-${definition}-${mode}`, {
          path: screenshot,
          contentType: 'image/png',
        });

        expect((await computedStyles(header, ['backgroundColor'])).backgroundColor).toBe(
          await probeStyle(page, 'bg-surface-canvas', 'background-color'),
        );
        const heading = table.locator('th').first();
        const headingStyles = await computedStyles(heading, [
          'backgroundColor',
          'color',
          'borderTopColor',
          'borderTopLeftRadius',
        ]);
        expect(headingStyles.backgroundColor).toBe(
          await probeStyle(page, 'bg-table-header-fill', 'background-color'),
        );
        expect(headingStyles.color).toBe(await probeStyle(page, 'text-table-header-text', 'color'));
        expect(headingStyles.borderTopColor).toBe(
          await probeStyle(page, 'border border-border-medium', 'border-top-color'),
        );
        expect(headingStyles.borderTopLeftRadius).toBe(
          await probeStyle(page, 'rounded-theme-control', 'border-top-left-radius'),
        );
        expect(
          (await computedStyles(table.locator('td').first(), ['borderLeftColor'])).borderLeftColor,
        ).toBe(await probeStyle(page, 'border border-border-medium', 'border-left-color'));
        expect(
          (await computedStyles(page.locator('.markdown blockquote'), ['borderLeftColor']))
            .borderLeftColor,
        ).toBe(await normalizeColor(page, `rgb(${await themeValue(page, '--prose-quote-bar')})`));

        await page.goto(NEW_CHAT_PATH);
        await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
        await sendMessage(page, `E2E_SLOW_REPLY:theme-${definition}-${mode}`);
        const stop = page.getByTestId('stop-generation-button');
        await expect(stop).toBeVisible();
        await expect(stop).toBeEnabled();
        await page.mouse.move(0, 0);
        const stopScreenshot = test.info().outputPath(`stop-${definition}-${mode}.png`);
        await page.screenshot({ path: stopScreenshot, animations: 'disabled' });
        await test.info().attach(`stop-${definition}-${mode}`, {
          path: stopScreenshot,
          contentType: 'image/png',
        });
        const colors = await computedStyles(stop, ['color', 'backgroundColor']);
        expect(colors.backgroundColor).toBe(
          await probeStyle(page, 'bg-surface-inverted', 'background-color'),
        );
        expect(colors.color).toBe(await probeStyle(page, 'text-text-inverted', 'color'));
        expect((await computedStyles(stop.locator('rect'), ['fill'])).fill).toBe(colors.color);
        expect(colors.color).not.toBe(colors.backgroundColor);
        await stop.click();
        await expect(stop).toBeHidden();
      } finally {
        await Promise.all([
          deleteMessagesByConversation([conversationId]),
          deleteConversations([conversationId]),
        ]);
      }
    });
  }
}
