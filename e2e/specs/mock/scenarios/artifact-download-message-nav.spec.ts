import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const RAIL = 'nav[aria-keyshortcuts="Shift+Alt+M"]';

test.use({ viewport: { width: 1280, height: 800 } });

type Part = Record<string, unknown>;

const lines = (count: number, word = 'Analysis') =>
  Array.from({ length: count }, (_, i) => `${word} line ${i + 1}.`).join('\n\n');

const text = (value: string): Part => ({ type: 'text', text: value });

const call = (id: string, name: string, args: Part, output: string, extra: Part = {}): Part => ({
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

type Thread = {
  /** The last reply's parts; by default one code-execution call and a long answer. */
  content?: Part[];
  /** Files on the last reply, tied to its code-execution call. */
  attachments?: object[];
  /** Fields over the first turns, to give a row above the last reply its own content. */
  firstPrompt?: Part;
  firstReply?: Part;
  secondPrompt?: Part;
};

/**
 * Opens a mocked four-message thread, enough for the rail to render. Rows that
 * a test aims at need room above and below them to scroll level with the rail.
 */
async function openThread(page: Page, conversationId: string, thread: Thread) {
  const toolCallId = `${conversationId}-tool`;
  const replyId = `${conversationId}-assistant-2`;
  const now = new Date(0).toISOString();
  const base = { conversationId, createdAt: now, updatedAt: now };
  const assistant = {
    ...base,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
  };
  const messages = [
    {
      ...base,
      messageId: `${conversationId}-user-1`,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Create a workbook.',
      ...thread.firstPrompt,
    },
    {
      ...assistant,
      messageId: `${conversationId}-assistant-1`,
      parentMessageId: `${conversationId}-user-1`,
      text: 'I will prepare it.',
      ...thread.firstReply,
    },
    {
      ...base,
      messageId: `${conversationId}-user-2`,
      parentMessageId: `${conversationId}-assistant-1`,
      isCreatedByUser: true,
      sender: 'User',
      text: 'Finish the spreadsheet.',
      ...thread.secondPrompt,
    },
    {
      ...assistant,
      messageId: replyId,
      parentMessageId: `${conversationId}-user-2`,
      text: '',
      content: thread.content ?? [
        {
          type: 'tool_call',
          tool_call: {
            id: toolCallId,
            name: 'execute_code',
            args: '{}',
            output: 'done',
            progress: 1,
          },
        },
        text(lines(80)),
      ],
      attachments: (thread.attachments ?? []).map((attachment) => ({
        ...attachment,
        messageId: replyId,
        conversationId,
        toolCallId,
      })),
    },
  ];
  const conversation = {
    ...base,
    title: 'Artifact navigation overlap',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
  };
  await page.route(`**/api/convos/${conversationId}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(`**/api/messages/${conversationId}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(messages),
    }),
  );
  await page.goto(`/c/${conversationId}`);
}

/** Scrolls the message list so the element's center sits level with the middle of the rail. */
function levelWithRail(el: Element, selector: string) {
  const rail = document.querySelector(selector);
  if (!rail) {
    throw new Error('Message navigation rail is missing');
  }
  const railBox = rail.getBoundingClientRect();
  const targetY = railBox.top + railBox.height / 2;
  let scroller = el.parentElement;
  while (
    scroller &&
    !(
      scroller.scrollHeight > scroller.clientHeight + 10 &&
      /auto|scroll/.test(getComputedStyle(scroller).overflowY)
    )
  ) {
    scroller = scroller.parentElement;
  }
  if (!scroller) {
    throw new Error('Message scroller is missing');
  }
  const box = el.getBoundingClientRect();
  scroller.scrollTop += box.top + box.height / 2 - targetY;
}

/**
 * Scrolls `control` level with the middle of the rail, checks that it ends clear
 * of the rail, then clicks its center with the pointer, as a reader would.
 */
async function clickBeneathRail(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const nav = page.locator(RAIL);
  await expect(nav).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  await control.evaluate(levelWithRail, RAIL);

  const box = await control.boundingBox();
  const railBox = await nav.boundingBox();
  expect(box).not.toBeNull();
  expect(railBox).not.toBeNull();
  const center = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  expect(center.y).toBeGreaterThan(railBox!.y);
  expect(center.y).toBeLessThan(railBox!.y + railBox!.height);
  expect(box!.x + box!.width).toBeLessThanOrEqual(railBox!.x - 7);
  await page.mouse.click(center.x, center.y);
}

/**
 * Scrolls `control` level with the middle of the rail and checks, softly so one
 * run names every control that fails, that it ends at least 7px before the rail
 * and that the element under its center is the control, not the rail. `hover`
 * is a box to hold the pointer over first, away from the rail, for a control
 * that takes the pointer only while its block is hovered, or tapped on a touch
 * screen.
 */
async function expectClearOfRail(page: Page, name: string, control: Locator, hover?: Locator) {
  await expect(page.locator(RAIL)).toBeVisible();
  await expect(control, name).toBeAttached();
  await control.scrollIntoViewIfNeeded();
  await control.evaluate(levelWithRail, RAIL);
  if (hover) {
    const box = await hover.boundingBox();
    const target = await control.boundingBox();
    expect(box, `${name}: hover target`).not.toBeNull();
    expect(target, name).not.toBeNull();
    const level = target!.y + target!.height / 2;
    const x = box!.x + 8;
    const y = Math.min(Math.max(level, box!.y + 4), box!.y + box!.height - 4);
    const takesPointer = () =>
      control.evaluate((el) => getComputedStyle(el).pointerEvents !== 'none');
    await page.mouse.move(x, y);
    try {
      await expect.poll(takesPointer, { timeout: 2_000 }).toBe(true);
    } catch {
      await page.mouse.click(x, y);
      await expect
        .poll(takesPointer, { message: `${name} takes the pointer once its block is tapped` })
        .toBe(true);
    }
  }
  const at = await control.evaluate((el, selector) => {
    const rail = document.querySelector(selector)!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      y,
      end: box.right,
      railTop: rail.top,
      railBottom: rail.bottom,
      railStart: rail.left,
      hit: hit != null && (hit === el || el.contains(hit)),
    };
  }, RAIL);
  expect.soft(at.y, `${name} is level with the rail`).toBeGreaterThan(at.railTop);
  expect.soft(at.y, `${name} is level with the rail`).toBeLessThan(at.railBottom);
  expect.soft(at.end, `${name} ends clear of the rail`).toBeLessThanOrEqual(at.railStart - 7);
  expect.soft(at.hit, `${name} takes a pointer at its center`).toBe(true);
}

/** The message row holding `text`. */
const row = (page: Page, value: string) =>
  page.locator('.message-render').filter({ hasText: value }).first();

/** Enters edit mode from the keyboard, which the rail cannot intercept. */
async function editTurn(page: Page, turn: Locator) {
  await turn.hover();
  const edit = turn.getByRole('button', { name: 'Edit', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');
  return page.getByRole('region', { name: 'Edit message' });
}

async function setWidth(page: Page, fullWidth: boolean) {
  await page.evaluate((value) => {
    localStorage.setItem('maximizeChatSpace', JSON.stringify(value));
  }, fullWidth);
}

test('artifact downloads stay clickable beneath the message navigation rail across preview states and chat widths @scenario:artifact-download-clears-message-nav', async ({
  page,
}) => {
  await page.goto('/');
  for (const status of ['ready', 'pending', 'failed'] as const) {
    for (const fullWidth of [false, true]) {
      await setWidth(page, fullWidth);
      const conversationId = `artifact-nav-${Date.now()}-${status}-${fullWidth}`;
      const filename = `workbook-${'x'.repeat(100)}.xlsx`;
      const fileId = `${conversationId}-file`;
      let downloadRequests = 0;
      await page.route('**/api/files/code/download/test-session/**', (route) => {
        downloadRequests += 1;
        return route.fulfill({ status: 200, body: 'workbook bytes' });
      });
      await openThread(page, conversationId, {
        attachments: [
          {
            file_id: fileId,
            filename,
            filepath: `/api/files/code/download/test-session/${fileId}`,
            type: 'execute_code',
            source: 'local',
            bytes: 2048,
            status,
            text: status === 'ready' ? '<table><tr><td>ready</td></tr></table>' : undefined,
            textFormat: status === 'ready' ? 'html' : undefined,
          },
        ],
      });

      const download = page.getByRole('button', { name: `Download ${filename}` });
      await expect(download).toBeVisible();
      if (fullWidth) {
        await expect(page.locator('.message-render').filter({ has: download })).toHaveClass(
          /max-w-full/,
        );
      }
      await clickBeneathRail(page, download);
      await expect.poll(() => downloadRequests).toBe(1);
    }
  }
});

test('text attachment and diagram downloads stay clickable beneath the message navigation rail across chat widths @scenario:attachment-download-clears-message-nav', async ({
  page,
}) => {
  await page.goto('/');
  for (const fullWidth of [false, true]) {
    await setWidth(page, fullWidth);
    const conversationId = `attachment-nav-${Date.now()}-${fullWidth}`;
    const downloads: string[] = [];
    await page.route('**/api/files/code/download/test-session/**', (route) => {
      downloads.push(new URL(route.request().url()).pathname.split('/').pop()!);
      return route.fulfill({ status: 200, body: 'file bytes' });
    });
    const file = (id: string, filename: string, body: string) => ({
      file_id: `${conversationId}-${id}`,
      filename,
      filepath: `/api/files/code/download/test-session/${conversationId}-${id}`,
      type: 'text/plain',
      source: 'local',
      bytes: body.length,
      text: body,
    });
    await openThread(page, conversationId, {
      attachments: [
        file('run-a', 'run-a.log', 'first run\n'.repeat(4)),
        file('run-b', 'run-b.log', 'second run\n'.repeat(4)),
        file('diagram', 'diagram.mmd', 'graph LR; Start-->End;'),
      ],
    });

    const toggle = page.getByRole('button', { name: 'Show 2 files' });
    await clickBeneathRail(page, toggle.locator('svg').last());
    await expect(page.getByRole('button', { name: 'Hide 2 files' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await clickBeneathRail(page, page.getByRole('button', { name: 'Download run-a.log' }));
    await expect.poll(() => downloads).toEqual([`${conversationId}-run-a`]);
    await clickBeneathRail(page, page.getByRole('button', { name: 'Download diagram.mmd' }));
    await expect
      .poll(() => downloads)
      .toEqual([`${conversationId}-run-a`, `${conversationId}-diagram`]);
  }
});

test('code block and diagram controls stay clickable beneath the message navigation rail across chat widths @scenario:code-controls-clear-message-nav', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  for (const fullWidth of [false, true]) {
    await setWidth(page, fullWidth);
    await openThread(page, `code-nav-${Date.now()}-${fullWidth}`, {
      firstReply: { text: lines(14) },
      content: [
        text(['```js', ...Array.from({ length: 60 }, (_, i) => `step(${i});`), '```'].join('\n')),
        text(lines(3, 'Between')),
        text('```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```'),
        text(lines(3, 'Between')),
        text('```mermaid\nnotADiagram\n  A --> B\n```'),
        text(lines(40)),
      ],
    });

    const downloadCode = page.getByRole('button', { name: 'Download code' });
    const codeBar = downloadCode.locator('xpath=..');
    await expectClearOfRail(page, 'Download code', downloadCode);
    await expectClearOfRail(page, 'Copy code', codeBar.getByRole('button', { name: 'Copy code' }));

    /* The floating bar stands in for the header once the header leaves the view. */
    const codeBlock = downloadCode.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
    const floatingCopy = codeBlock.getByRole('button', { name: 'Copy', exact: true });
    await expectClearOfRail(page, 'floating Copy', floatingCopy, codeBlock);
    await expectClearOfRail(
      page,
      'floating Download',
      codeBlock.getByRole('button', { name: 'Download', exact: true }),
      codeBlock,
    );

    const zoomIn = page.getByRole('button', { name: 'Zoom in' }).first();
    await expect(zoomIn).toBeAttached({ timeout: 20_000 });
    const diagram = page.getByRole('button', { name: 'Show Code' }).first();
    const diagramBox = diagram.locator(
      'xpath=ancestor::div[contains(@class,"rounded-lg") and contains(@class,"border")][1]',
    );
    await expectClearOfRail(page, 'Show Code', diagram, diagramBox);
    await expectClearOfRail(
      page,
      'diagram Copy',
      diagram.locator('xpath=..').getByRole('button', { name: 'Copy', exact: true }),
      diagramBox,
    );
    await expectClearOfRail(
      page,
      'zoom bar Copy code',
      zoomIn.locator('xpath=..').getByRole('button', { name: 'Copy code' }),
      diagramBox,
    );

    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await expectClearOfRail(page, 'diagram Retry', retry);
  }
});

test('message actions and editor buttons stay clickable beneath the message navigation rail across chat widths @scenario:turn-controls-clear-message-nav', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  /** Opens the turn's editor, changes its text so every action can be pressed, and checks the
   *  action at the end of its footer. */
  const checkEditor = async (label: string, turn: Locator) => {
    const editor = await editTurn(page, turn);
    await expect(editor).toBeVisible();
    await editor.getByRole('textbox').first().press('End');
    await page.keyboard.type(' edited');
    await expectClearOfRail(page, label, editor.locator('footer').getByRole('button').last());
    await editor.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(editor).toHaveCount(0);
  };

  await page.goto('/');
  for (const fullWidth of [false, true]) {
    await setWidth(page, fullWidth);
    /* An editor's buttons end its turn, so a turn with a row below it can reach the rail. */
    await openThread(page, `turn-nav-${Date.now()}-${fullWidth}`, {
      firstReply: { text: lines(14, 'Plain') },
      content: [text(lines(30))],
    });
    const prompt = row(page, 'Finish the spreadsheet.');
    for (const name of ['Copy to clipboard', 'Edit', 'Open Fork Menu']) {
      await expectClearOfRail(
        page,
        `user turn ${name}`,
        prompt.getByRole('button', { name, exact: true }),
        prompt,
      );
    }
    await checkEditor('user turn editor', prompt);
    await checkEditor('plain reply editor', row(page, 'Plain line 1.'));

    await openThread(page, `turn-parts-nav-${Date.now()}-${fullWidth}`, {
      firstReply: { text: '', content: [text(lines(14, 'Parted'))] },
      content: [text(lines(30))],
    });
    await checkEditor('parted reply editor', row(page, 'Parted line 1.'));
  }
});

test('tool call controls stay clickable beneath the message navigation rail across chat widths @scenario:tool-controls-clear-message-nav', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const skill = {
    _id: 'e2e-skill-release-notes',
    name: 'release-notes',
    description: 'Drafts release notes.',
    body: 'Group merged PRs by type.',
  };
  await page.route(`**/api/skills/${skill._id}`, (route) => route.fulfill({ json: skill }));
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('autoExpandTools', 'true'));
  for (const fullWidth of [false, true]) {
    await setWidth(page, fullWidth);
    const content: Part[] = [
      call('b1', 'bash_tool', { command: 'echo hi' }, 'hi'),
      text('After the command.'),
      call('x1', 'execute_code', { lang: 'py', code: "print('hi')" }, 'hi\n'),
      text('After the script.'),
      call('q1', 'run_query_mcp_mongo', { collection: 'messages' }, 'COLLSCAN'),
      text('After the query.'),
      call('h1', 'lc_transfer_to_billing_agent', { instructions: 'User needs billing help' }, 'ok'),
      text('After the handoff.'),
      call(
        'k1',
        'skill',
        { skillName: 'release-notes' },
        'Skill "release-notes" loaded. Follow the instructions below.',
        { skillId: skill._id },
      ),
      text('After the skill.'),
      call(
        't1',
        'check_background_task',
        { background_task_id: 'task-reviewer' },
        JSON.stringify({
          background_task_id: 'task-reviewer',
          subagent_thread_id: 'thread-reviewer',
          tool: 'subagent',
          subagent_type: 'pr-reviewer',
          status: 'running',
        }),
      ),
      text('After the check.'),
      call('g1', 'bash_tool', { command: 'ls' }, 'a.txt'),
      call('g2', 'bash_tool', { command: 'pwd' }, '/work'),
      text('After the group.'),
    ];
    /* A failed call under a phase label, whose indexes name the parts it covers. */
    const phase = content.length;
    content.push(
      {
        type: 'tool_call',
        tool_call: {
          id: 'failed',
          name: 'bash_tool',
          args: '{"command":"false"}',
          output: 'Error: tool call failed: exit code 2',
          progress: 1,
          type: 'tool_call',
          runStepStatus: 'failed',
        },
      },
      {
        type: 'activity_label',
        activity_label: 'Checked the failing command',
        pending: false,
        status: 'failed',
      },
      {
        type: 'activity_label',
        activity_label: 'Checked the failing command',
        activity_label_type: 'phase',
        activity_start_index: phase,
        activity_end_index: phase + 2,
        activity_count: 1,
        pending: false,
        status: 'failed',
      },
      text(lines(40)),
    );
    await openThread(page, `tool-nav-${Date.now()}-${fullWidth}`, {
      firstReply: {
        text: lines(14),
        unfinished: true,
        finish_reason: 'tool_call_limit',
      },
      content,
    });

    const command = page.getByRole('button', { name: /^Ran command/ }).first();
    await expectClearOfRail(page, 'tool row chevron', command.locator('svg').last());
    const commandPanel = page
      .locator('div.rounded-lg.border')
      .filter({ has: page.getByText('echo hi') })
      .first();
    await expectClearOfRail(
      page,
      'command Copy code',
      commandPanel.getByRole('button', { name: 'Copy code' }),
      commandPanel,
    );
    await expectClearOfRail(
      page,
      'command output Copy',
      commandPanel.getByRole('button', { name: 'Copy', exact: true }),
      commandPanel,
    );

    const script = page
      .locator('div.rounded-lg.border')
      .filter({ has: page.getByText("print('hi')") })
      .first();
    await expectClearOfRail(
      page,
      'script Copy code',
      script.getByRole('button', { name: 'Copy code' }),
    );

    const query = page
      .locator('div.rounded-lg.border')
      .filter({ has: page.getByText('COLLSCAN') })
      .first();
    await expectClearOfRail(
      page,
      'tool output Copy',
      query.getByRole('button', { name: 'Copy', exact: true }).last(),
      query,
    );

    await page
      .getByRole('button', { name: /^Transferred to/ })
      .first()
      .click();
    const handoff = page.getByRole('region', { name: 'Handoff instructions' });
    await expectClearOfRail(
      page,
      'handoff Copy',
      handoff.getByRole('button', { name: 'Copy to clipboard' }),
      handoff,
    );
    await expectClearOfRail(page, 'Open skill', page.getByRole('button', { name: 'Open skill' }));
    await expectClearOfRail(
      page,
      'View activity',
      page.getByRole('button', { name: 'View activity' }),
    );
    await expectClearOfRail(
      page,
      'tool group chevron',
      page.locator('[data-fold-toggle]').first().locator('svg').last(),
    );
    await expectClearOfRail(
      page,
      'failed calls pill',
      page.getByTestId('failed-reveal-pill').first(),
    );
    await expectClearOfRail(
      page,
      'limit notice Dismiss',
      page.getByRole('button', { name: 'Dismiss this notice' }),
    );
  }
});

test('reasoning, search, question and card controls stay clickable beneath the message navigation rail across chat widths @scenario:content-controls-clear-message-nav', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const cards = Array.from({ length: 8 }, (_, i) => `card${i + 1}`);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('showThinking', 'true'));
  for (const fullWidth of [false, true]) {
    await setWidth(page, fullWidth);
    const conversationId = `content-nav-${Date.now()}-${fullWidth}`;
    await openThread(page, conversationId, {
      firstPrompt: { text: lines(10, 'Prompt') },
      firstReply: {
        text: '',
        content: [
          { type: 'text', text: 'Lane one answered.', groupId: 1, agentId: 'agent_lane_one' },
          { type: 'text', text: 'Lane two answered.', groupId: 1, agentId: 'agent_lane_two' },
        ],
      },
      secondPrompt: {
        text: [
          'A background tool task has finished. Continue using its durable result below.',
          JSON.stringify([
            {
              background_task_id: 'task-1',
              tool_call_id: 'call-1',
              tool: 'execute_code',
              status: 'completed',
              result: 'build finished',
            },
          ]),
        ].join('\n'),
      },
      content: [
        { type: 'think', think: lines(30, 'Thought') },
        text('After the thought.'),
        { type: 'summary', content: [{ type: 'text', text: lines(20, 'Summary') }], tokenCount: 6 },
        text('After the summary.'),
        call('s1', 'web_search', { query: 'css view transitions support' }, 'results'),
        text('After the search.'),
        call('c1', 'bash_tool', { command: 'echo hi' }, 'hi'),
        { type: 'activity_label', activity_label: 'Checked the command', pending: false },
        { type: 'think', think: 'Checking whether the output matches' },
        text('After the check.'),
        {
          type: 'ask_user_question',
          ask_user_question: {
            actionId: `${conversationId}-ask`,
            question: { question: 'Which environment?' },
          },
        },
        text(`Here are the cards.\n\n\\ui{${cards.join(',')}}`),
        text(lines(40)),
      ],
      attachments: [
        {
          type: 'web_search',
          toolCallId: 's1',
          web_search: {
            turn: 0,
            organic: [{ link: 'https://developer.mozilla.org/', title: 'MDN on view transitions' }],
            topStories: [],
          },
        },
        {
          type: 'ui_resources',
          ui_resources: cards.map((id, i) => ({
            resourceId: id,
            uri: `ui://${id}`,
            mimeType: 'text/html',
            text: `<p>${i + 1}</p>`,
          })),
        },
      ],
    });

    const branch = page.getByRole('button', { name: 'Create branch from this response' }).last();
    await expectClearOfRail(page, 'lane Branch', branch);

    const wakeup = page.getByRole('button', { name: /Background task finished/ }).first();
    await expectClearOfRail(page, 'wake-up chevron', wakeup.locator('svg').last());

    const thoughts = page.getByRole('button', { name: 'Copy thoughts to clipboard' });
    const thought = page
      .getByText('Thought line 1.')
      .locator('xpath=ancestor::div[contains(@class,"group/thinking-container")][1]');
    await expectClearOfRail(page, 'thoughts Copy', thoughts.first(), thought);
    const thoughtBody = page.getByText('Thought line 29.');
    await expectClearOfRail(page, 'thoughts floating Copy', thoughts.nth(1), thoughtBody);

    await page.getByRole('button', { name: 'Conversation summarized' }).click();
    const summaryCopy = page.getByRole('button', { name: 'Copy summary to clipboard' });
    const summary = page.getByText('Summary line 1.');
    await expectClearOfRail(page, 'summary Copy', summaryCopy.first(), summary);
    await expectClearOfRail(
      page,
      'summary floating Copy',
      summaryCopy.last(),
      page.getByText('Summary line 19.'),
    );

    const searchRow = page.getByRole('button', { name: /^Searched the web/ }).first();
    await expectClearOfRail(
      page,
      'Search details',
      page.getByRole('button', { name: 'Search details' }).first(),
      searchRow,
    );

    const checked = page.getByRole('button', { name: /^Checked the command/ }).first();
    if ((await checked.getAttribute('aria-expanded')) !== 'true') {
      await checked.click();
    }
    const compact = page.locator('[class~="group/reasoning-compact"]').first();
    const compactToggle = compact.getByRole('button', { expanded: false });
    if ((await compactToggle.count()) > 0) {
      await compactToggle.first().click();
    }
    await expectClearOfRail(
      page,
      'compact thoughts Copy',
      compact.getByRole('button', { name: 'Copy thoughts to clipboard' }).first(),
      compact,
    );

    /* Submit takes the pointer once there is an answer to send. */
    await page.getByRole('textbox', { name: 'Type your answer…' }).fill('Staging');
    await expectClearOfRail(
      page,
      'question Submit',
      page.getByRole('button', { name: 'Submit' }).first(),
    );

    const carousel = page.getByRole('button', { name: 'Scroll right' });
    const strip = carousel.locator('xpath=..');
    await expectClearOfRail(page, 'carousel Scroll right', carousel, strip);
  }
});
