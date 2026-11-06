import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  escapeRegExp,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
} from '../helpers';

/**
 * The fake model (e2e/setup/fake-model.js) pauses a real agent run at
 * `ask_user_question` with a three-question batch for `E2E_ASK_USER_QUESTIONS:`,
 * and with a maximum-size first prompt for `E2E_ASK_USER_LONG_QUESTIONS:`. The
 * popover, card, form state and resume request are all the production ones.
 */

/* The agent setup goes through the desktop agent builder side panel, so these scenarios pin a
   desktop pointer context; the long-prompt one shrinks the height to keep its bound meaningful. */
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

type BatchQuestion = {
  id: string;
  question: string;
  description?: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; value: string }>;
};

type AskResumeBody = { actionId?: string; answers?: Record<string, string> };

const ASK_TOOL_ID = 'ask_user_question';
const MOVE_TO_CHAT = 'Answer later in the chat';
const MOVE_TO_COMPOSER = 'Answer from the message box';

const isResumeRequest = (request: Request) =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/chat/resume';

/** A new generation (not a resume or abort): what a composer submit would start. */
const isGenerationStart = (request: Request) => {
  const { pathname } = new URL(request.url());
  return (
    request.method() === 'POST' &&
    pathname.startsWith('/api/agents/chat') &&
    !pathname.endsWith('/resume') &&
    !pathname.endsWith('/abort')
  );
};

/** The batch the fake model asks, in order. */
function buildBatch(label: string): BatchQuestion[] {
  return [
    { id: 'environment', question: `Which environment for ${label}?` },
    { id: 'region', question: `Which region for ${label}?` },
    { id: 'notes', question: `Anything else for ${label}?` },
  ];
}

async function createAgent(page: Page): Promise<AgentDetail> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const token = await getAccessToken(page);
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Ask Batch Agent'),
      description: 'Pauses at ask_user_question for the batched question scenarios.',
      instructions: 'Ask the user the question the test requests.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [ASK_TOOL_ID],
    },
  });
  expect(agent.tools).toEqual(expect.arrayContaining([ASK_TOOL_ID]));
  return agent;
}

async function selectAgent(page: Page, agent: AgentDetail) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name ?? '');
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

/**
 * Pauses a real run at ask_user_question with the fake model's batch and
 * returns the chat, where the batch's card arrives; the composer popover
 * opens only from that card's move-to-composer control.
 */
async function openBatch(page: Page, agent: AgentDetail, label: string, long = false) {
  await selectAgent(page, agent);
  const marker = long ? 'E2E_ASK_USER_LONG_QUESTIONS' : 'E2E_ASK_USER_QUESTIONS';
  const response = await sendMessage(page, `${marker}:${label}`);
  expect(response.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
  const chat = messagesView(page);
  await expect(chat.getByRole('button', { name: MOVE_TO_COMPOSER })).toBeVisible({
    timeout: 30000,
  });
  await expect(chat.getByRole('group', { name: 'Question navigation' })).toBeVisible();
  await expect(popoverOf(page)).toHaveCount(0);
  return chat;
}

/** Moves the live batch from its chat card into the composer popover. */
async function openPopover(page: Page) {
  await messagesView(page).getByRole('button', { name: MOVE_TO_COMPOSER }).click();
  const popover = popoverOf(page);
  await expect(popover).toBeVisible();
  return popover;
}

const popoverOf = (page: Page) =>
  page.locator('.popover').filter({ has: page.getByRole('button', { name: MOVE_TO_CHAT }) });

type Scope = Page | ReturnType<Page['locator']>;

const answerField = (scope: Scope, question: string) =>
  scope.getByRole('textbox', { name: new RegExp(`^${escapeRegExp(question)}`) });

const optionRow = (scope: Scope, name: string) =>
  scope.getByRole('button', { name: new RegExp(`${escapeRegExp(name)}$`) });

test.describe('ask question batch refinements', () => {
  test('Enter in an answer field confirms the step instead of sending the composer @scenario:ask-batch-enter-confirms-answer', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const questions = buildBatch(label);
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const card = await openBatch(page, agent, label);

      const generationStarts: string[] = [];
      page.on('request', (request) => {
        if (isGenerationStart(request)) {
          generationStarts.push(request.url());
        }
      });

      const first = answerField(card, questions[0].question);
      await expect(first).toBeVisible();
      await first.fill('typed-first-answer');
      await first.press('Enter');

      await expect(card.getByText(questions[1].question, { exact: true })).toBeVisible();
      await expect(card.getByText(questions[0].question, { exact: true })).toBeHidden();
      expect(generationStarts).toEqual([]);
      await expect(card.getByText('typed-first-answer')).toHaveCount(0);

      const middle = answerField(card, questions[1].question);
      await middle.fill('typed-middle-answer');
      await middle.press('Enter');
      await expect(card.getByText(questions[2].question, { exact: true })).toBeVisible();

      const last = answerField(card, questions[2].question);
      await last.fill('typed-last-answer');
      const [resumeRequest] = await Promise.all([
        page.waitForRequest(isResumeRequest),
        last.press('Enter'),
      ]);
      const body = resumeRequest.postDataJSON() as AskResumeBody;
      expect(body.answers).toEqual({
        [questions[0].id]: 'typed-first-answer',
        [questions[1].id]: 'typed-middle-answer',
        [questions[2].id]: 'typed-last-answer',
      });
      await expect(card.getByRole('button', { name: MOVE_TO_COMPOSER })).toBeHidden({
        timeout: 30000,
      });
      expect(generationStarts).toEqual([]);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a very long prompt keeps the popover inside the viewport and scrolls @scenario:ask-batch-long-prompt-fits-viewport', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1280, height: 640 });
    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      await openBatch(page, agent, label, true);
      const popover = await openPopover(page);

      const prompt = popover.locator('div[class*="max-h-[25vh]"]').first();
      await expect(prompt).toContainText(`Line 60 of the long clarification for ${label}`);

      /** The card eases to its height, so wait for the settled box. */
      await expect
        .poll(async () => (await popover.boundingBox())?.y ?? -1, { timeout: 5000 })
        .toBeGreaterThanOrEqual(0);
      const metrics = await prompt.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        viewportHeight: window.innerHeight,
      }));
      expect(metrics.overflowY).toBe('auto');
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      expect(metrics.clientHeight).toBeLessThanOrEqual(
        Math.ceil(metrics.viewportHeight * 0.25) + 1,
      );

      const box = await popover.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.height).toBeLessThanOrEqual(Math.ceil(metrics.viewportHeight * 0.7) + 1);

      /* With both regions at their caps, scrolling the card reaches the answer field rather
         than leaving it clipped below the footer. */
      await popover.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await popover.locator('div[class*="max-h-[45vh]"]').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(popover.getByRole('textbox')).toBeInViewport();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('option rows skip their fade under reduced motion @scenario:ask-option-rows-skip-fade-under-reduced-motion', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const questions = buildBatch(label);
    let agentId: string | undefined;

    const fadeOf = (row: ReturnType<typeof optionRow>) =>
      row.evaluate((element) => {
        const style = getComputedStyle(element);
        return { property: style.transitionProperty, duration: style.transitionDuration };
      });
    const expectNoFade = (fade: { property: string; duration: string }) => {
      const instant = fade.property === 'none' || /^(0s)(,\s*0s)*$/.test(fade.duration);
      expect(instant, `transition ${fade.property} / ${fade.duration}`).toBe(true);
    };

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const card = await openBatch(page, agent, label);

      const row = optionRow(card, 'Staging');
      await expect(row).toBeEnabled();
      expectNoFade(await fadeOf(row));

      await answerField(card, questions[0].question).fill('locks the rows');
      await expect(row).toBeDisabled();
      expectNoFade(await fadeOf(row));
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('typed answers survive moving the batch between the chat and the composer @scenario:ask-batch-answers-survive-move', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const questions = buildBatch(label);
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const card = await openBatch(page, agent, label);

      await answerField(card, questions[0].question).fill('kept-across-surfaces');
      await card.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(card.getByText(questions[1].question, { exact: true })).toBeVisible();

      /** The popover resumes on step 2, not step 1. */
      const popover = await openPopover(page);
      await expect(popover.getByText(questions[1].question, { exact: true })).toBeVisible();
      await expect(popover.getByText(questions[0].question, { exact: true })).toBeHidden();

      await popover.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(answerField(popover, questions[0].question)).toHaveValue('kept-across-surfaces');

      await popover.getByRole('button', { name: MOVE_TO_CHAT }).click();
      await expect(popover).toBeHidden();
      await expect(card.getByRole('button', { name: MOVE_TO_COMPOSER })).toBeVisible();
      await expect(answerField(card, questions[0].question)).toHaveValue('kept-across-surfaces');
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a long composer draft keeps the batch card and its controls on screen @scenario:ask-batch-fits-above-long-draft', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1280, height: 640 });
    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const questions = buildBatch(label);
    const draft = Array.from({ length: 40 }, (_, line) => `draft line ${line + 1}`).join('\n');
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      await openBatch(page, agent, label);

      /** The composer is only writable while the card owns the batch, so the draft is
       *  typed there and the batch moved over it, the order a user would hit. */
      const composer = page.getByRole('textbox', { name: 'Message input' });
      await composer.fill(draft);
      await expect
        .poll(async () => (await composer.boundingBox())?.height ?? 0)
        .toBeGreaterThan(640 * 0.4);

      const popover = await openPopover(page);
      await expect(composer).toBeDisabled();
      await expect(composer).toHaveValue(draft);

      await expect
        .poll(async () => (await popover.boundingBox())?.y ?? -1, { timeout: 5000 })
        .toBeGreaterThanOrEqual(0);
      await expect(popover.getByText(questions[0].question, { exact: true })).toBeInViewport();
      await expect(popover.getByRole('button', { name: MOVE_TO_CHAT })).toBeInViewport();

      await popover.getByRole('button', { name: MOVE_TO_CHAT }).click();
      await expect(popover).toBeHidden();
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue(draft);
      await expect
        .poll(async () => (await composer.boundingBox())?.height ?? 0)
        .toBeGreaterThan(640 * 0.4);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('a typed answer deselects the option and locks the rows until cleared @scenario:ask-typed-answer-locks-options', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const questions = buildBatch(label).slice(0, 2);
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const card = await openBatch(page, agent, label);

      /** A single-select choice records the answer and advances; come back to it. */
      await optionRow(card, 'Staging').click();
      await expect(card.getByText(questions[1].question, { exact: true })).toBeVisible();
      await card.getByRole('button', { name: 'Go to question 1, answered' }).click();

      const staging = optionRow(card, 'Staging');
      const production = optionRow(card, 'Production');
      await expect(staging).toHaveAttribute('aria-pressed', 'true');

      const field = answerField(card, questions[0].question);
      await field.fill('something else');
      await expect(staging).toHaveAttribute('aria-pressed', 'false');
      await expect(staging).toBeDisabled();
      await expect(production).toBeDisabled();

      await field.fill('');
      await expect(staging).toBeEnabled();
      await expect(production).toBeEnabled();
      await expect(staging).toHaveAttribute('aria-pressed', 'false');
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('on a phone-width screen the batch stays in the chat and the composer stays usable @scenario:ask-batch-inline-on-phone', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const questions = buildBatch(label);
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const card = await openBatch(page, agent, label);
      /* The agent builder needs the desktop side panel; the question itself is checked at a
         phone's width once the run is paused. */
      await page.setViewportSize({ width: 390, height: 844 });

      const prompt = card.getByText(questions[0].question, { exact: true });
      await prompt.scrollIntoViewIfNeeded();
      await expect(prompt).toBeInViewport();
      await expect(popoverOf(page)).toHaveCount(0);

      const field = answerField(card, questions[0].question);
      await field.scrollIntoViewIfNeeded();
      const box = await field.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      const composer = page.getByRole('textbox', { name: 'Message input' });
      await expect(composer).toBeEnabled();
      await expect(composer).toBeInViewport();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
