import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

const PHASE_ENDPOINT = { label: 'Mock Provider F', model: 'mock-model-f' };
const CHILD_LABEL_MODEL = 'mock-label-model';
const PHASE_LABEL_MODEL = 'mock-phase-label-model';
const MCP_SERVER_TITLE = 'E2E Memory';
const LABEL_SERVER = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;
const PARENT_LABEL = 'Verified both memory facts across the sequential research phase';
const FIRST_CHILD_LABEL = 'Recorded the first phase fact in memory';
const SECOND_CHILD_LABEL = 'Recorded the second phase fact in memory';

type LabelRequest = { model?: string; stream: boolean; prompt: string };

type PersistedContentPart = {
  type?: string;
  text?: string | { value?: string };
  error?: string;
  activity_label?: string;
  activity_label_type?: string;
  activity_start_index?: number;
  activity_end_index?: number;
  activity_count?: number;
  pending?: boolean;
  tool_call?: { id?: string };
};

type PersistedMessage = {
  messageId: string;
  text?: string;
  content?: Array<PersistedContentPart | null>;
  isCreatedByUser?: boolean;
  error?: boolean;
  unfinished?: boolean;
};

const uniqueLabel = () => `phase-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function phaseChildLabels(label: string) {
  return {
    first: `${FIRST_CHILD_LABEL} ${label}`,
    second: `${SECOND_CHILD_LABEL} ${label}`,
  };
}

async function resetLabelServer(request: APIRequestContext) {
  const response = await request.post(`${LABEL_SERVER}/__e2e/reset`);
  expect(response.ok()).toBeTruthy();
}

async function setPhaseLabels(request: APIRequestContext, label: string) {
  const childLabels = phaseChildLabels(label);
  const response = await request.post(`${LABEL_SERVER}/__e2e/behavior`, {
    data: {
      phaseLabel: PARENT_LABEL,
      labelsByPrompt: {
        [`activity phase alpha ${label}`]: childLabels.first,
        [`activity phase beta ${label}`]: childLabels.second,
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function getLabelRequests(request: APIRequestContext): Promise<LabelRequest[]> {
  const response = await request.get(`${LABEL_SERVER}/__e2e/requests`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).requests as LabelRequest[];
}

async function getLabelRequestsFor(
  request: APIRequestContext,
  label: string,
): Promise<LabelRequest[]> {
  return (await getLabelRequests(request)).filter((entry) => entry.prompt.includes(label));
}

async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const serverItem = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true })).toBeVisible();
}

function contentPartText(part: PersistedContentPart | null): string {
  if (!part) {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.text?.value === 'string') {
    return part.text.value;
  }
  if (typeof part.activity_label === 'string') {
    return part.activity_label;
  }
  return part.error ?? '';
}

function messageText(message: PersistedMessage): string {
  return [message.text, ...(message.content?.map(contentPartText) ?? [])]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

async function getConversationId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/, { timeout: 15000 });
  const conversationId = new URL(page.url()).pathname.split('/').pop();
  if (!conversationId) {
    throw new Error(`Could not parse conversation id from ${page.url()}`);
  }
  return conversationId;
}

test.describe('parent activity phases', () => {
  test.beforeEach(async ({ request }) => {
    await resetLabelServer(request);
  });

  test('renders and persists two sequential activities under a clean parent phase', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const finalText = `E2E activity phase reply done ${label}`;
    const firstToolCallId = `call_e2e_activity_phase_alpha_${label}`;
    const secondToolCallId = `call_e2e_activity_phase_beta_${label}`;
    const childLabels = phaseChildLabels(label);
    await setPhaseLabels(request, label);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PHASE_ENDPOINT);
    await selectEphemeralMCP(page);
    const run = await sendMessage(page, `E2E_ACTIVITY_PHASE_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    /**
     * A parent phase only exists once the turn completes, the phase closes, and
     * its summary round-trips to the phase-label model. Gate on the durable
     * projection first: the DOM cannot show a `summary` before the server has
     * written one, so asserting the DOM up front races that whole pipeline and
     * leaves retries as the only thing hiding it. Waiting for the persisted
     * phase also keeps failures attributable — a phase the server never wrote
     * fails on the content assertions below rather than as a bare "not visible".
     */
    const conversationId = await getConversationId(page);
    const token = await getAccessToken(page);
    let assistant: PersistedMessage | undefined;
    await expect
      .poll(
        async () => {
          const messages = await fetchJson<PersistedMessage[]>(
            page,
            `/api/messages/${encodeURIComponent(conversationId)}`,
            token,
          );
          assistant = messages.find(
            (message) =>
              message.isCreatedByUser === false && messageText(message).includes(finalText),
          );
          if (assistant?.unfinished !== false) {
            return false;
          }
          return (assistant.content ?? []).some(
            (part) => part?.type === 'activity_label' && part.activity_label_type === 'phase',
          );
        },
        { timeout: 60000 },
      )
      .toBe(true);

    expect(assistant).toBeDefined();
    expect(assistant?.error).not.toBe(true);
    const content = assistant?.content ?? [];
    expect(content.some((part) => part?.type === 'error')).toBe(false);
    const phaseIndex = content.findIndex(
      (part) => part?.type === 'activity_label' && part.activity_label_type === 'phase',
    );
    expect(phaseIndex).toBeGreaterThanOrEqual(0);
    const phasePart = content[phaseIndex];
    expect(phasePart).toMatchObject({
      type: 'activity_label',
      activity_label: PARENT_LABEL,
      activity_label_type: 'phase',
      activity_count: 2,
      pending: false,
    });
    expect(phasePart?.activity_start_index).toBeGreaterThanOrEqual(0);
    expect(phasePart?.activity_end_index).toBeGreaterThan(phasePart?.activity_start_index ?? -1);
    expect(phasePart?.activity_end_index).toBeLessThanOrEqual(phaseIndex);
    const phaseChildren = content.slice(
      phasePart?.activity_start_index ?? phaseIndex,
      phasePart?.activity_end_index ?? phaseIndex,
    );
    expect(phaseChildren.map((part) => part?.tool_call?.id).filter(Boolean)).toEqual(
      expect.arrayContaining([firstToolCallId, secondToolCallId]),
    );
    expect(phaseChildren.map(contentPartText)).toEqual(
      expect.arrayContaining([childLabels.first, childLabels.second]),
    );
    const finalTextIndex = content.findIndex((part) => contentPartText(part).includes(finalText));
    expect(finalTextIndex).toBe(phasePart?.activity_end_index);

    const parent = messagesView(page).getByRole('button', { name: PARENT_LABEL, exact: true });
    await expect(parent).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByText(finalText)).toBeVisible({ timeout: 30000 });
    await parent.click();
    await expect(messagesView(page).getByRole('button', { name: childLabels.first })).toBeVisible();
    await expect(
      messagesView(page).getByRole('button', { name: childLabels.second }),
    ).toBeVisible();

    await expect.poll(async () => (await getLabelRequestsFor(request, label)).length).toBe(3);
    const labelRequests = await getLabelRequestsFor(request, label);
    const phaseRequest = labelRequests.find((entry) => entry.model === PHASE_LABEL_MODEL);
    const childRequests = labelRequests.filter((entry) => entry !== phaseRequest);
    expect(phaseRequest).toMatchObject({ model: PHASE_LABEL_MODEL, stream: false });
    expect(childRequests).toHaveLength(2);
    expect(childRequests.map((entry) => entry.model)).toEqual([
      CHILD_LABEL_MODEL,
      CHILD_LABEL_MODEL,
    ]);
    expect(
      childRequests.some((entry) => entry.prompt.includes(`activity phase alpha ${label}`)),
    ).toBe(true);
    expect(
      childRequests.some((entry) => entry.prompt.includes(`activity phase beta ${label}`)),
    ).toBe(true);

    await page.reload();
    const reloadedParent = messagesView(page).getByRole('button', {
      name: PARENT_LABEL,
      exact: true,
    });
    await expect(reloadedParent).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByText(finalText)).toBeVisible();
    await reloadedParent.click();
    await expect(messagesView(page).getByRole('button', { name: childLabels.first })).toBeVisible();
    await expect(
      messagesView(page).getByRole('button', { name: childLabels.second }),
    ).toBeVisible();
    expect(await getLabelRequestsFor(request, label)).toHaveLength(3);
  });
});
