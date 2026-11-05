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
 * Keyboard control of a live `ask_user_question` batch. The fake model
 * (e2e/setup/fake-model.js) pauses a real agent run with three questions for
 * `E2E_ASK_USER_QUESTIONS:`, each with two options; popover, card, form state
 * and resume request are the production ones.
 */

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

type AskResumeBody = { actionId?: string; answers?: Record<string, string> };

const ASK_TOOL_ID = 'ask_user_question';
const MOVE_TO_CHAT = 'Answer later in the chat';
const MOVE_TO_COMPOSER = 'Answer from the message box';
const DECLINED = 'The user chose not to answer this question.';

const isResumeRequest = (request: Request) =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/chat/resume';

const questionsFor = (label: string) => ({
  environment: `Which environment for ${label}?`,
  region: `Which region for ${label}?`,
  notes: `Anything else for ${label}?`,
});

async function createAgent(page: Page): Promise<AgentDetail> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const token = await getAccessToken(page);
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Ask Keyboard Agent'),
      description: 'Pauses at ask_user_question for the keyboard scenarios.',
      instructions: 'Ask the user the question the test requests.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [ASK_TOOL_ID],
    },
  });
  expect(agent.tools).toEqual(expect.arrayContaining([ASK_TOOL_ID]));
  return agent;
}

async function openBatch(page: Page, agent: AgentDetail, label: string) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name ?? '');
  await form.getByRole('button', { name: 'Select Agent' }).click();

  const response = await sendMessage(page, `E2E_ASK_USER_QUESTIONS:${label}`);
  expect(response.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
  const popover = page
    .locator('.popover')
    .filter({ has: page.getByRole('button', { name: MOVE_TO_CHAT }) });
  await expect(popover).toBeVisible({ timeout: 30000 });
  return popover;
}

type Scope = Page | ReturnType<Page['locator']>;

const answerField = (scope: Scope, question: string) =>
  scope.getByRole('textbox', { name: new RegExp(`^${escapeRegExp(question)}`) });

const optionRow = (scope: Scope, name: string) =>
  scope.getByRole('button', { name: new RegExp(`${escapeRegExp(name)}$`) });

const uniqueLabel = () => `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

test.describe('ask question keyboard control', () => {
  test('a batch is answered and submitted from the keyboard alone @scenario:ask-batch-completes-from-keyboard', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const questions = questionsFor(label);
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const popover = await openBatch(page, agent, label);

      /* The batch arrives while focus sits in the empty composer that sent it. */
      await expect(optionRow(popover, 'Staging')).toBeFocused();
      await page.keyboard.press('Enter');

      /* The next question has no pick yet, so focus lands in its answer field,
         never on an unpicked option a held Enter could choose. */
      await expect(popover.getByText(questions.region, { exact: true })).toBeVisible();
      await expect(answerField(popover, questions.region)).toBeFocused();
      await page.keyboard.type('typed-region');
      await page.keyboard.press('Enter');

      await expect(popover.getByText(questions.notes, { exact: true })).toBeVisible();
      await expect(answerField(popover, questions.notes)).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(optionRow(popover, 'Call me first')).toBeFocused();

      const resumes: Request[] = [];
      page.on('request', (request) => {
        if (isResumeRequest(request)) {
          resumes.push(request);
        }
      });

      /* On the last question the first Enter only picks. */
      await page.keyboard.press('Enter');
      await expect(optionRow(popover, 'Call me first')).toHaveAttribute('aria-pressed', 'true');
      expect(resumes).toHaveLength(0);

      const [resume] = await Promise.all([
        page.waitForRequest(isResumeRequest),
        page.keyboard.press('Enter'),
      ]);
      expect((resume.postDataJSON() as AskResumeBody).answers).toEqual({
        environment: 'staging',
        region: 'typed-region',
        notes: 'call',
      });
      await expect(popover).toBeHidden({ timeout: 30000 });
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('Escape in the composer popover moves the batch to the chat and returns to the composer @scenario:ask-popover-escape-moves-to-chat', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const questions = questionsFor(label);
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const popover = await openBatch(page, agent, label);

      const resumes: string[] = [];
      page.on('request', (request) => {
        if (isResumeRequest(request)) {
          resumes.push(request.url());
        }
      });

      await expect(optionRow(popover, 'Staging')).toBeFocused();
      await page.keyboard.press('Escape');

      await expect(popover).toBeHidden();
      const chat = messagesView(page);
      await expect(chat.getByText(questions.environment, { exact: true })).toBeVisible();
      await expect(chat.getByRole('button', { name: MOVE_TO_COMPOSER })).toBeVisible();
      const composer = page.getByRole('textbox', { name: 'Message input' });
      await expect(composer).toBeEnabled();
      await expect(composer).toBeFocused();
      expect(resumes).toEqual([]);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('Escape in the chat card skips the batch only while nothing is answered @scenario:ask-card-escape-skips-only-when-empty', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const questions = questionsFor(label);
    let agentId: string | undefined;

    try {
      const agent = await createAgent(page);
      agentId = agent.id;
      const popover = await openBatch(page, agent, label);
      await popover.getByRole('button', { name: MOVE_TO_CHAT }).click();
      await expect(popover).toBeHidden();

      const chat = messagesView(page);
      const field = answerField(chat, questions.environment);
      await expect(field).toBeVisible();

      const resumes: Request[] = [];
      page.on('request', (request) => {
        if (isResumeRequest(request)) {
          resumes.push(request);
        }
      });

      /* A typed answer is kept: Escape neither clears it nor resumes the run. */
      await field.fill('half-typed');
      await field.press('Escape');
      await expect(field).toHaveValue('half-typed');
      await expect(chat.getByRole('button', { name: 'Skip', exact: true })).toBeEnabled();

      await field.fill('');
      const [resume] = await Promise.all([
        page.waitForRequest(isResumeRequest),
        field.press('Escape'),
      ]);
      expect((resume.postDataJSON() as AskResumeBody).answers).toEqual({
        environment: DECLINED,
        region: DECLINED,
        notes: DECLINED,
      });
      expect(resumes).toHaveLength(1);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
