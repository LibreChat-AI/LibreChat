import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { IThemeRGB } from '../../../../packages/client/src/theme/types';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  withMongo,
} from '../db';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { defaultTheme } from '../../../../packages/client/src/theme/themes/default';
import { darkTheme } from '../../../../packages/client/src/theme/themes/dark';
import { openAgentBuilder, uniqueAgentName, cleanupAgent } from '../agents.helpers';
import { MOCK_ENDPOINTS, getAccessToken, requestJson } from '../helpers';
import { getE2EUser } from '../../../setup/user';
import { probeStyle } from './style.helpers';

/**
 * The builder, tools, sharing and message surfaces used to paint with palette
 * utilities and `dark:` twins, which no theme reaches. Each scenario hands the
 * app the ClickHouse reference definition and reads what the browser paints,
 * comparing it with the value the definition sets for the role the surface
 * should use, in both modes.
 */

type Mode = 'light' | 'dark';
type Rgb = [number, number, number];

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';
const WCAG_AA_NORMAL = 4.5;
const CODE_INPUT = 'print(21 * 2)';
const CODE_LOGS = 'forty-two-result';

async function installThemeBridge(page: Page) {
  await page.addInitScript((stored) => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    localStorage.setItem('theme-definition', JSON.stringify(stored));
    localStorage.setItem('theme-source', 'definition');
  }, clickHouseTheme);
}

const colorsFor = (mode: Mode): IThemeRGB => clickHouseTheme.modes[mode]?.colors ?? {};

const rgbCss = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

function parseRgb(value: string): Rgb {
  const channels = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return [channels[0], channels[1], channels[2]];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function contrast(a: Rgb, b: Rgb): number {
  const luminance = ([r, g, b]: Rgb) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const painted = (locator: Locator) =>
  locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor };
  });

async function createAgent(page: Page, name: string, tools: string[]): Promise<string> {
  const token = await getAccessToken(page);
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools,
    },
  });
  return agent.id;
}

async function selectAgentInBuilder(page: Page, name: string) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  return form;
}

async function seedCodeAnalysis(title: string, logs?: string): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email });
    const userId = String(user?._id);
    const userMessageId = randomUUID();
    const now = Date.now();
    await db.collection('messages').insertMany([
      {
        messageId: userMessageId,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        conversationId,
        user: userId,
        endpoint: 'agents',
        text: 'Run the numbers',
        isCreatedByUser: true,
        sender: 'User',
        error: false,
        unfinished: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        __v: 0,
      },
      {
        messageId: randomUUID(),
        parentMessageId: userMessageId,
        conversationId,
        user: userId,
        endpoint: 'agents',
        text: '',
        isCreatedByUser: false,
        sender: 'Mock Provider A',
        error: false,
        unfinished: false,
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: `ci-${conversationId}`,
              type: 'code_interpreter',
              progress: 1,
              code_interpreter: {
                input: CODE_INPUT,
                outputs: logs == null ? [] : [{ type: 'logs', logs }],
              },
            },
          },
          { type: 'text', text: 'Done.' },
        ],
        createdAt: new Date(now + 1000),
        updatedAt: new Date(now + 1000),
        __v: 0,
      },
    ]);
  });
  return conversationId;
}

async function seedCodeReply(title: string, runs: string[] = []): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email });
    const userId = String(user?._id);
    const userMessageId = randomUUID();
    const replyId = randomUUID();
    const now = Date.now();
    await db.collection('messages').insertMany([
      {
        messageId: userMessageId,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        conversationId,
        user: userId,
        endpoint: 'agents',
        text: 'Show me the snippet',
        isCreatedByUser: true,
        sender: 'User',
        error: false,
        unfinished: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        __v: 0,
      },
      {
        messageId: replyId,
        parentMessageId: userMessageId,
        conversationId,
        user: userId,
        endpoint: 'agents',
        text: '',
        isCreatedByUser: false,
        sender: 'Mock Provider A',
        error: false,
        unfinished: false,
        content: [{ type: 'text', text: `Here it is:\n\n\`\`\`python\n${CODE_INPUT}\n\`\`\`` }],
        createdAt: new Date(now + 1000),
        updatedAt: new Date(now + 1000),
        __v: 0,
      },
    ]);
    if (runs.length === 0) {
      return;
    }
    await db.collection('toolcalls').insertMany(
      runs.map((result, i) => ({
        conversationId,
        messageId: replyId,
        toolId: 'execute_code',
        user: user?._id,
        result,
        partIndex: 0,
        blockIndex: 0,
        createdAt: new Date(now + 2000 + i),
        updatedAt: new Date(now + 2000 + i),
      })),
    );
  });
  return conversationId;
}

/** Reads the shared code block's toolbar (`surface-code`) and code pane (`surface-code-body`). */
async function expectCodePanePaint(block: Locator, colors: IThemeRGB) {
  const surface = rgbCss(colors['rgb-surface-code']);
  const body = rgbCss(colors['rgb-surface-code-body']);
  const code = block.locator('code').first();
  await expect(code).toBeVisible();
  const pane = code.locator('xpath=..');
  const toolbar = block.getByText('python', { exact: true }).first().locator('xpath=..');
  expect((await painted(toolbar)).background).toBe(surface);
  const panePaint = await painted(pane);
  expect(panePaint.background).toBe(body);
  const codeColor = (await painted(code)).color;
  expect(contrast(parseRgb(codeColor), parseRgb(panePaint.background))).toBeGreaterThan(
    WCAG_AA_NORMAL,
  );
}

async function openCodeAnalysis(page: Page, conversationId: string, mode: Mode) {
  await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));
  await page.getByRole('button', { name: 'Finished analyzing' }).first().click();
  const block = page.locator('.code-analyze-block').first();
  await expect(block).toBeVisible({ timeout: 20000 });
  return block;
}

test.describe('semantic colour roles on builder, tools and sharing surfaces', () => {
  test('agent tool rows paint their icon chips with the theme series roles @scenario:agent-tool-row-chips-follow-theme-series-roles', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await installThemeBridge(page);
    await page.goto('/c/new');
    const name = uniqueAgentName('Theme Tool Rows');
    const agentId = await createAgent(page, name, ['execute_code', 'file_search']);

    try {
      for (const mode of MODES) {
        await page.goto(`/c/new?${THEME_PARAM}=${mode}`);
        const form = await selectAgentInBuilder(page, name);
        const colors = colorsFor(mode);

        const runCode = form.getByText('Run Code', { exact: true }).first();
        await expect(runCode).toBeVisible();
        const chip = runCode
          .locator('xpath=ancestor::div[contains(@class,"group")][1]')
          .locator('span[aria-hidden="true"]')
          .first();
        const chipPaint = await painted(chip);
        expect(chipPaint.color).toBe(rgbCss(colors['rgb-series-7']));
        expect(chipPaint.background).toBe(
          await probeStyle(page, 'bg-series-7/15', 'background-color'),
        );

        const fileSearch = form.getByText('File Search', { exact: true }).first();
        const fileChip = fileSearch
          .locator('xpath=ancestor::div[contains(@class,"group")][1]')
          .locator('span[aria-hidden="true"]')
          .first();
        expect((await painted(fileChip)).color).toBe(rgbCss(colors['rgb-series-5']));
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('the share dialog paints a user principal with the theme series role @scenario:share-dialog-user-avatar-follows-theme-series-role', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await installThemeBridge(page);
    await page.goto('/c/new');
    const name = uniqueAgentName('Theme Share Avatar');
    const agentId = await createAgent(page, name, []);

    try {
      for (const mode of MODES) {
        await page.goto(`/c/new?${THEME_PARAM}=${mode}`);
        await selectAgentInBuilder(page, name);
        await page.getByRole('button', { name: `Share ${name}` }).click();
        const dialog = page.getByRole('dialog').filter({ hasText: `Share ${name}` });
        await expect(dialog).toBeVisible();

        const icon = dialog.locator('svg.lucide-user').first();
        await expect(icon).toBeVisible();
        const colors = colorsFor(mode);
        expect((await painted(icon)).color).toBe(rgbCss(colors['rgb-series-1']));
        const container = icon.locator('xpath=..');
        expect((await painted(container)).background).toBe(
          await probeStyle(page, 'bg-series-1/15', 'background-color'),
        );
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a code-analysis block paints the theme code surface and keeps its output readable @scenario:code-analysis-block-follows-theme-code-surface', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedCodeAnalysis('Theme code analysis', CODE_LOGS);
    await installThemeBridge(page);

    try {
      for (const mode of MODES) {
        const colors = colorsFor(mode);
        const block = await openCodeAnalysis(page, conversationId, mode);
        expect((await painted(block)).background).toBe(rgbCss(colors['rgb-surface-code']));
        await expectCodePanePaint(block, colors);

        const output = block.getByText(CODE_LOGS, { exact: true });
        await expect(output).toBeVisible();
        const pane = block.getByText('Result', { exact: true }).locator('xpath=..');
        const panePaint = await painted(pane);
        expect(panePaint.background).toBe(rgbCss(colors['rgb-surface-tertiary']));

        const outputColor = (await painted(output)).color;
        expect(outputColor).toBe(rgbCss(colors['rgb-text-primary']));
        expect(contrast(parseRgb(outputColor), parseRgb(panePaint.background))).toBeGreaterThan(
          WCAG_AA_NORMAL,
        );
      }
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a chat code block paints its toolbar and code pane with the theme code surface @scenario:chat-code-block-follows-theme-code-surface', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedCodeReply('Theme chat code block');
    await installThemeBridge(page);

    try {
      for (const mode of MODES) {
        await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));
        const code = page.locator('.message-render code', { hasText: CODE_INPUT }).first();
        await expect(code).toBeVisible({ timeout: 20000 });
        const block = code.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
        await expectCodePanePaint(block, colorsFor(mode));
      }
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the built-in theme keeps the code pane distinct from its toolbar @scenario:chat-code-block-keeps-default-pane', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedCodeReply('Default chat code block');

    try {
      for (const mode of MODES) {
        await page.addInitScript((m) => {
          localStorage.setItem('color-theme', m);
          localStorage.removeItem('theme-definition');
          localStorage.removeItem('theme-source');
          localStorage.removeItem('theme-colors');
          localStorage.removeItem('theme-name');
        }, mode);
        await page.goto(`/c/${conversationId}`);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));
        const code = page.locator('.message-render code', { hasText: CODE_INPUT }).first();
        await expect(code).toBeVisible({ timeout: 20000 });
        const block = code.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
        await expectCodePanePaint(block, mode === 'dark' ? darkTheme : defaultTheme);
        const pane = (await painted(code.locator('xpath=..'))).background;
        const toolbar = (
          await painted(block.getByText('python', { exact: true }).first().locator('xpath=..'))
        ).background;
        expect(pane).not.toBe(toolbar);
      }
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('an executed chat code block paints its output pane and result switcher with the theme code surface @scenario:executed-code-block-output-follows-theme-code-surface', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedCodeReply('Theme executed code block', [
      'first-run-output',
      'second-run-output',
    ]);
    await installThemeBridge(page);

    try {
      for (const mode of MODES) {
        await page.goto(`/c/${conversationId}?${THEME_PARAM}=${mode}`);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));
        const surface = rgbCss(colorsFor(mode)['rgb-surface-code']);
        const switcher = page.getByRole('navigation', { name: 'Navigate results' });
        await expect(switcher).toBeVisible({ timeout: 20000 });
        expect((await painted(switcher)).background).toBe(surface);

        const output = page.getByText(/^(first|second)-run-output$/);
        await expect(output).toBeVisible();
        const pane = page.getByText('Output', { exact: true }).locator('xpath=..');
        const panePaint = await painted(pane);
        expect(panePaint.background).toBe(surface);
        expect(
          contrast(parseRgb((await painted(output)).color), parseRgb(panePaint.background)),
        ).toBeGreaterThan(WCAG_AA_NORMAL);
      }
    } finally {
      await withMongo((db) => db.collection('toolcalls').deleteMany({ conversationId }));
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a code-analysis block without output shows the code alone @scenario:code-analysis-block-without-output-has-no-result-pane', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedCodeAnalysis('Theme code analysis empty');
    await installThemeBridge(page);

    try {
      for (const mode of MODES) {
        const colors = colorsFor(mode);
        const block = await openCodeAnalysis(page, conversationId, mode);
        expect((await painted(block)).background).toBe(rgbCss(colors['rgb-surface-code']));
        await expect(block.getByText('print', { exact: false }).first()).toBeVisible();
        await expect(block.getByText('Result', { exact: true })).toHaveCount(0);
      }
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a prompt variable paints the theme warning roles @scenario:prompt-variable-chip-follows-theme-warning-role', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await installThemeBridge(page);
    const groupIds: string[] = [];

    try {
      for (const mode of MODES) {
        await page.goto(`/c/new?${THEME_PARAM}=${mode}`);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));
        const promptsButton = page.getByRole('button', { name: 'Prompts', exact: true });
        if ((await promptsButton.getAttribute('aria-pressed')) !== 'true') {
          await promptsButton.click();
        }

        /** Prompts open on their own page only from inside the app, and creating
         *  one is the path that lands there. */
        await page.getByRole('button', { name: 'Create Prompt' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog
          .getByRole('textbox', { name: 'Prompt Name' })
          .fill(`Theme variable ${mode} ${randomUUID().slice(0, 8)}`);
        await dialog
          .getByRole('textbox', { name: 'Prompt text input field' })
          .fill('Summarize {{topic}} for the team.');
        const [created] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/api/prompts' &&
              response.ok(),
            { timeout: 30000 },
          ),
          dialog.getByRole('button', { name: 'Create Prompt' }).click(),
        ]);
        const body = (await created.json()) as { group?: { _id: string } };
        const groupId = body.group?._id ?? '';
        expect(groupId).not.toBe('');
        groupIds.push(groupId);
        await expect(page).toHaveURL(new RegExp(`/prompts/${groupId}$`));

        const chip = page.locator('b').filter({ hasText: '{{topic}}' }).first();
        await expect(chip).toBeVisible({ timeout: 20000 });
        const colors = colorsFor(mode);
        const chipPaint = await painted(chip);
        expect(chipPaint.background).toBe(rgbCss(colors['rgb-status-warning-subtle']));
        expect(chipPaint.color).toBe(rgbCss(colors['rgb-text-warning']));
      }
    } finally {
      const token = await getAccessToken(page);
      for (const groupId of groupIds) {
        await requestJson<{ message?: string }>(page, {
          path: `/api/prompts/groups/${encodeURIComponent(groupId)}`,
          token,
          method: 'DELETE',
        });
      }
    }
  });
});
