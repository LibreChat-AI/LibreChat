import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { messagesView } from '../helpers';

/**
 * Tool activity headers: a generated title is the only disclosure a lone call needs,
 * file cards drop their timers and success summaries, durations and chevrons sit at the
 * row's end, and actions whose row a title replaced move onto the title line.
 * Conversations are routed fixtures, so every run sees the same rows.
 */
test.describe.configure({ timeout: 120_000 });

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const DONE = 'Tool headers fixture done.';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Part = Record<string, unknown>;

const call = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  output: string,
  extra: Record<string, unknown> = {},
): Part => ({
  type: 'tool_call',
  tool_call: {
    id,
    name,
    args: JSON.stringify(args),
    output,
    progress: 1,
    type: 'tool_call',
    runStepStatus: 'completed',
    ...extra,
  },
});

const label = (text: string, ids: string[], status = 'ok'): Part => ({
  type: 'activity_label',
  activity_label: text,
  tool_call_ids: ids,
  status,
  pending: false,
});

async function openConversation(page: Page, content: Part[], attachments?: Part[]) {
  const conversationId = unique('e2e-tool-headers');
  const now = new Date(0).toISOString();
  const messageId = `${conversationId}-msg`;
  const message = {
    messageId,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content: [...content, { type: 'text', text: DONE }],
    ...(attachments ? { attachments: attachments.map((a) => ({ ...a, messageId })) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const conversation = {
    conversationId,
    title: 'Tool headers',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const convoIdRe = escapeRe(conversationId);
  await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([message]),
    }),
  );
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
  await expect(messagesView(page).getByText(DONE)).toBeVisible({ timeout: 20000 });
}

/** A reader opening a published link: the conversation's messages, served under a share id. */
async function openSharedConversation(page: Page, content: Part[]) {
  const shareId = unique('e2e-shared-tool-headers');
  const conversationId = `${shareId}-convo`;
  const now = new Date(0).toISOString();
  const userMessage = {
    messageId: `${shareId}-user`,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: true,
    sender: 'User',
    text: 'Draft the release notes.',
    createdAt: now,
    updatedAt: now,
  };
  const reply = {
    messageId: `${shareId}-msg`,
    conversationId,
    parentMessageId: userMessage.messageId,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content: [...content, { type: 'text', text: DONE }],
    createdAt: now,
    updatedAt: now,
  };
  const shareIdRe = escapeRe(shareId);
  await page.route(new RegExp(`/api/share/${shareIdRe}/config(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ appTitle: 'LibreChat' }),
    }),
  );
  await page.route(new RegExp(`/api/share/${shareIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        shareId,
        conversationId,
        title: 'Shared tool headers',
        createdAt: now,
        updatedAt: now,
        messages: [userMessage, reply],
      }),
    }),
  );
  await page.goto(`/share/${shareId}`, { timeout: 30000 });
  await expect(messagesView(page).getByText(DONE)).toBeVisible({ timeout: 20000 });
}

/** Opens the disclosure named `name` if it is folded, and returns it. */
async function expand(page: Page, name: RegExp) {
  const button = messagesView(page).getByRole('button', { name }).first();
  await expect(button).toBeVisible();
  if ((await button.getAttribute('aria-expanded')) !== 'true') {
    await button.click();
  }
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  return button;
}

test.describe('tool activity headers', () => {
  test('a titled lone call shows its result under the title with no second row or rail @scenario:titled-lone-call-shows-result-directly', async ({
    page,
  }) => {
    await openConversation(page, [
      call(
        'r1',
        'read_file_mcp_filesystem',
        { path: 'README.md' },
        'An open-source AI chat platform.',
      ),
      label('Read the project README', ['r1']),
    ]);
    const view = messagesView(page);
    await expand(page, /Read the project README/);
    await expect(view.getByText('An open-source AI chat platform.')).toBeVisible();
    await expect(view.getByRole('button', { name: /^Ran read_file/ })).toHaveCount(0);
    await expect(view.getByTestId('fold-rail')).toHaveCount(0);
  });

  test('a titled group of several calls keeps a row per call and its tree, without repeat counts @scenario:titled-group-keeps-rows-without-multipliers', async ({
    page,
  }) => {
    const ids = ['w1', 'w2', 'w3'];
    await openConversation(page, [
      ...ids.map((id, i) =>
        call(id, 'get_weather_mcp_weather', { city: 'Milan' }, `Milan: ${18 + i}C`),
      ),
      label('Checked the Milan weather', ids),
    ]);
    const view = messagesView(page);
    await expand(page, /Checked the Milan weather/);
    await expect(view.getByRole('button', { name: /^Ran get_weather/ })).toHaveCount(3);
    await expect(view.getByTestId('fold-rail').first()).toBeVisible();
    await expect(view.getByText(/×\s*3|x3\b/)).toHaveCount(0);
  });

  test('a tool row shows its duration and an always-visible chevron at the row end @scenario:tool-row-duration-and-chevron-at-end', async ({
    page,
  }) => {
    await openConversation(page, [
      call('q1', 'run_query_mcp_mongo', { collection: 'messages' }, 'COLLSCAN', {
        runStepDurationMs: 2400,
      }),
      call('q2', 'list_indexes_mcp_mongo', { collection: 'messages' }, '_id_', {
        runStepDurationMs: 3100,
      }),
    ]);
    await expand(page, /^Ran 2 actions|^Ran run_query/);
    const row = messagesView(page)
      .getByRole('button', { name: /Ran run_query/ })
      .first();
    await expect(row).toBeVisible();
    const duration = row.getByText('2.4s', { exact: true });
    await expect(duration).toBeVisible();
    await expect(row).not.toContainText('in 2.4s');
    const [rowBox, durationBox] = await Promise.all([row.boundingBox(), duration.boundingBox()]);
    expect(rowBox && durationBox).toBeTruthy();
    /** Pinned to the end: the time's right edge sits within the last 48px of the row. */
    expect(rowBox!.x + rowBox!.width - (durationBox!.x + durationBox!.width)).toBeLessThan(48);
    await page.mouse.move(0, 0);
    const chevronOpacity = await row
      .locator('svg')
      .last()
      .evaluate((el) => getComputedStyle(el).opacity);
    expect(chevronOpacity).toBe('1');
  });

  test('file read and edit cards show the full path with no timer or success summary @scenario:file-cards-show-full-path-without-timer-or-summary', async ({
    page,
  }) => {
    await openConversation(page, [
      call('f1', 'read_file', { file_path: 'src/index.ts' }, 'export {};\n', {
        runStepDurationMs: 2100,
      }),
      call(
        'f2',
        'edit_file',
        {
          path: 'src/index.ts',
          old_text: 'export {};',
          new_text: "export { greet } from './greet';",
        },
        'Edited',
        { runStepDurationMs: 3100 },
      ),
      label('Updated the index module', ['f1', 'f2']),
    ]);
    const view = messagesView(page);
    await expand(page, /Updated the index module/);
    const read = await expand(page, /^Read index\.ts/);
    const edit = await expand(page, /^Edited index\.ts/);
    await expect(read).not.toContainText(/\d\.\ds/);
    await expect(edit).not.toContainText(/\d\.\ds/);
    await expect(view.getByText('src/index.ts', { exact: true })).toHaveCount(2);
    await expect(view.getByText('Edited', { exact: true })).toHaveCount(0);
  });

  test('a failed edit keeps its error output visible @scenario:failed-edit-keeps-error-output', async ({
    page,
  }) => {
    await openConversation(page, [
      call(
        'e1',
        'edit_file',
        { path: 'src/a.ts', old_text: 'missing', new_text: 'replacement' },
        'Error: old_text matched 0 locations in src/a.ts.',
        { runStepStatus: 'failed' },
      ),
    ]);
    await expand(page, /a\.ts/);
    await expect(messagesView(page).getByText(/matched 0 locations/)).toBeVisible();
  });

  test('a file card keeps a warning that follows its success summary @scenario:file-card-keeps-warning-after-summary', async ({
    page,
  }) => {
    await openConversation(page, [
      call(
        'w1',
        'create_file',
        { file_path: 'skills/demo/SKILL.md', content: '# Demo\n\nUse this skill for testing.' },
        [
          'Created skills/demo/SKILL.md (35 chars).',
          '',
          'Warnings:',
          '- frontmatter.owner [UNKNOWN_KEY]: "owner" is not a recognized frontmatter key and is stored as-is',
        ].join('\n'),
      ),
    ]);
    await expand(page, /SKILL\.md/);
    await expect(messagesView(page).getByText(/not a recognized frontmatter key/)).toBeVisible();
  });

  test('a titled failed command opens on its error with the time on the command line @scenario:titled-failed-command-shows-error-and-time', async ({
    page,
  }) => {
    await openConversation(page, [
      call('b1', 'bash_tool', { command: 'false' }, 'Error: tool call failed: exit code 2', {
        runStepStatus: 'failed',
        runStepDurationMs: 10200,
      }),
      label('Checked the failing command', ['b1'], 'failed'),
    ]);
    const view = messagesView(page);
    await expand(page, /Checked the failing command/);
    await expect(
      view.getByText('Error: tool call failed: exit code 2', { exact: true }),
    ).toBeVisible();
    const time = view.getByTestId('command-time').first();
    await expect(time).toContainText('10.2s');
    const command = view.getByText('false', { exact: true }).first();
    const [timeBox, commandBox] = await Promise.all([time.boundingBox(), command.boundingBox()]);
    /** Same line: the time no longer gets a strip of its own above the command. */
    expect(
      Math.abs(timeBox!.y + timeBox!.height / 2 - (commandBox!.y + commandBox!.height / 2)),
    ).toBeLessThan(8);
    await expect(view.getByTestId('fold-rail')).toHaveCount(0);
  });

  test('a titled web search keeps its details on the title line @scenario:titled-web-search-details-on-title-line', async ({
    page,
  }) => {
    const ws = call('s1', 'web_search', { query: 'css view transitions support' }, 'results');
    await openConversation(
      page,
      [ws, label('Searched for View Transitions support', ['s1'])],
      [
        {
          type: 'web_search',
          toolCallId: 's1',
          web_search: {
            turn: 0,
            organic: [{ link: 'https://developer.mozilla.org/', title: 'MDN on view transitions' }],
            topStories: [],
          },
        },
      ],
    );
    const view = messagesView(page);
    const header = await expand(page, /Searched for View Transitions support/);
    await expect(view.getByRole('link', { name: /MDN on view transitions/ })).toBeVisible();
    const details = view.getByRole('button', { name: 'Search details' });
    await expect(details).toBeVisible();
    const [headerBox, detailsBox] = await Promise.all([
      header.boundingBox(),
      details.boundingBox(),
    ]);
    expect(
      Math.abs(headerBox!.y + headerBox!.height / 2 - (detailsBox!.y + detailsBox!.height / 2)),
    ).toBeLessThan(8);
    await details.focus();
    await expect(page.getByText('css view transitions support')).toBeVisible();
  });

  test('a loaded skill shows its instructions and opens the skill @scenario:loaded-skill-shows-instructions-and-opens-skill', async ({
    page,
  }) => {
    const skill = {
      _id: 'e2e-skill-release-notes',
      name: 'release-notes',
      description: 'Drafts release notes.',
      body: 'Group merged PRs by type.',
    };
    await page.route(/\/api\/skills(?:\?.*)?$/, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills: [skill], has_more: false, after: null }),
      }),
    );
    await page.route(new RegExp(`/api/skills/${skill._id}$`), (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(skill) }),
    );
    await openConversation(page, [
      call(
        'k1',
        'skill',
        { skillName: 'release-notes' },
        'Skill "release-notes" loaded. Follow the instructions below.',
      ),
    ]);
    const view = messagesView(page);
    await expand(page, /release-notes/);
    await expect(view.getByText('Group merged PRs by type.')).toBeVisible();
    await expect(
      view.getByText('Skill "release-notes" loaded. Follow the instructions below.'),
    ).toHaveCount(0);
    await view.getByRole('button', { name: 'Open skill' }).click();
    await expect(page).toHaveURL(new RegExp(`/skills/${skill._id}`));
  });

  test('a skill outside the library falls back to the tool output with no link @scenario:unknown-skill-falls-back-to-output', async ({
    page,
  }) => {
    await page.route(/\/api\/skills(?:\?.*)?$/, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills: [], has_more: false, after: null }),
      }),
    );
    await openConversation(page, [
      call('k2', 'skill', { skillName: 'deployment-only' }, 'Skill "deployment-only" loaded.'),
    ]);
    const view = messagesView(page);
    await expand(page, /deployment-only/);
    await expect(view.getByText('Skill "deployment-only" loaded.')).toBeVisible();
    await expect(view.getByRole('button', { name: 'Open skill' })).toHaveCount(0);
  });

  test("a shared skill call keeps its output instead of the viewer's same-named skill @scenario:shared-skill-call-keeps-output", async ({
    page,
  }) => {
    const viewerSkill = {
      _id: 'e2e-skill-viewer-release-notes',
      name: 'release-notes',
      description: "The viewer's own release notes skill.",
      body: 'The viewer wrote these instructions.',
    };
    await page.route(/\/api\/skills(?:\?.*)?$/, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills: [viewerSkill], has_more: false, after: null }),
      }),
    );
    await page.route(new RegExp(`/api/skills/${viewerSkill._id}$`), (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(viewerSkill),
      }),
    );
    await openSharedConversation(page, [
      call(
        'k3',
        'skill',
        { skillName: 'release-notes' },
        'Skill "release-notes" loaded. Follow the instructions below.',
      ),
    ]);
    const view = messagesView(page);
    /** A lookup would start as the row opens, and the viewer's library answers at once, so
     *  waiting out a short window for the request is what lets the absence checks below fail
     *  against the old behavior instead of passing before its fetch lands. */
    const lookup = page
      .waitForRequest((request) => new URL(request.url()).pathname.startsWith('/api/skills'), {
        timeout: 2000,
      })
      .then(
        () => true,
        () => false,
      );
    await expand(page, /release-notes/);
    await expect(
      view.getByText('Skill "release-notes" loaded. Follow the instructions below.'),
    ).toBeVisible();
    expect(await lookup).toBe(false);
    await expect(view.getByText('The viewer wrote these instructions.')).toHaveCount(0);
    await expect(view.getByRole('button', { name: 'Open skill' })).toHaveCount(0);
  });

  test('an agent handoff opens like a tool disclosure and copies its instructions @scenario:handoff-reveals-instructions-with-copy', async ({
    page,
  }) => {
    await openConversation(page, [
      call('h1', 'lc_transfer_to_billing_agent', { instructions: 'User needs billing help' }, 'ok'),
    ]);
    const view = messagesView(page);
    await expand(page, /^Transferred to/);
    await expect(view.getByText('User needs billing help')).toBeVisible();
    await expect(view.getByRole('button', { name: /copy/i }).first()).toBeAttached();
  });
});
