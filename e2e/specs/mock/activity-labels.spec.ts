import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, selectMockEndpoint, sendMessage } from './helpers';

/** The endpoint dedicated to child-only `activityLabel` coverage. A label
 *  auto-collapses its tool group, hiding the tool cards other specs assert on.
 *  Both are non-spec `addedEndpoints`, the
 *  path the ephemeral MCP dropdown rides (mirroring steering.spec.ts) — a
 *  spec-backed endpoint would not surface the selector at all. */
const LABELED_ENDPOINT = { label: 'Mock Provider E', model: 'mock-model-e' };
/** Same path, no `activityLabel`: the control proving the config gates it. */
const UNLABELED_ENDPOINT = { label: 'Mock Provider D', model: 'mock-model-d' };
/** Distinct from the chat model, so a label request proves `activityModel` won. */
const LABEL_MODEL = 'mock-label-model';
const MCP_SERVER_TITLE = 'E2E Memory';
const LABEL_SERVER = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;

type LabelRequest = { model?: string; stream: boolean; prompt: string };

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function resetLabelServer(request: APIRequestContext) {
  const response = await request.post(`${LABEL_SERVER}/__e2e/reset`);
  expect(response.ok()).toBeTruthy();
}

async function setLabelBehavior(
  request: APIRequestContext,
  behavior: { mode?: 'ok' | 'blank' | 'error'; label?: string; delayMs?: number },
) {
  const response = await request.post(`${LABEL_SERVER}/__e2e/behavior`, { data: behavior });
  expect(response.ok()).toBeTruthy();
}

async function getLabelRequests(request: APIRequestContext): Promise<LabelRequest[]> {
  const response = await request.get(`${LABEL_SERVER}/__e2e/requests`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).requests as LabelRequest[];
}

/**
 * Label requests carrying THIS test's token, which reaches the server inside
 * the recorded tool arguments. Counting every request instead would be racy:
 * a 5xx label response is retried by the provider client, and a retry can land
 * after the next test has already reset the server.
 */
async function getLabelRequestsFor(
  request: APIRequestContext,
  token: string,
): Promise<LabelRequest[]> {
  return (await getLabelRequests(request)).filter((entry) => entry.prompt.includes(token));
}

/** Select the MCP server whose `remember_fact` tool creates the batch boundary. */
async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();
  const serverItem = page.getByRole('menuitemcheckbox', { name: new RegExp(MCP_SERVER_TITLE) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: new RegExp(MCP_SERVER_TITLE) })).toBeVisible();
}

/** Run one labeled turn: two parallel tool calls => exactly one PostToolBatch. */
async function runLabeledTurn(page: Page, label: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, LABELED_ENDPOINT);
  await selectEphemeralMCP(page);
  const run = await sendMessage(page, `E2E_ACTIVITY_REPLY:${label}`);
  expect(run.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(`E2E activity reply done ${label}`)).toBeVisible({
    timeout: 60000,
  });
}

test.describe('activity labels', () => {
  test.beforeEach(async ({ request }) => {
    await resetLabelServer(request);
  });

  /**
   * The header is the feature: once a label lands it REPLACES the generic
   * "Ran N actions" verb above the same tool cards.
   */
  test('renders the generated label as the tool-group header', async ({ page, request }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('activity');
    await setLabelBehavior(request, { label: 'Stored two facts in memory' });

    await runLabeledTurn(page, label);

    await expect(
      messagesView(page).getByRole('button', { name: 'Stored two facts in memory' }),
    ).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByRole('button', { name: /^Ran 2 actions/ })).toHaveCount(0);
  });

  /**
   * Regression for the bug that made real output "abysmal": the wiring passed a
   * prompt ONLY when `activityPrompt` was configured, so a default install ran
   * the SDK's own generic prompt and this repo's register never reached the
   * model. Asserting on the request the model actually received is the only way
   * to catch that — rendered text looks identical either way.
   *
   * Also pins the two things that make the header worth a row: it runs on the
   * configured `activityModel`, and it sees the tool OUTPUTS (only available
   * because the hook fires AFTER the batch), not just the arguments.
   */
  test('sends the register, the tool outputs, and the configured model', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('prompt');

    await runLabeledTurn(page, label);

    await expect
      .poll(async () => (await getLabelRequestsFor(request, label)).length, { timeout: 30000 })
      .toBe(1);
    const [labelRequest] = await getLabelRequestsFor(request, label);

    /** `activityModel` beat the agent's own model. */
    expect(labelRequest.model).toBe(LABEL_MODEL);

    /** This repo's register reached the model, not the SDK's built-in prompt. */
    expect(labelRequest.prompt).toMatch(/never name the tools/i);
    expect(labelRequest.prompt).toMatch(/outcome, not the attempt/i);
    /** Deliberately NOT asserted: the "do not restate these" entry framing
     *  lives in `buildPrompt`, which only the direct fallback path uses. The
     *  SDK path builds the entry list with its own `buildActivityLabelPrompt`,
     *  so the two paths agree on the register (above) but not on that framing.
     *  Asserting it here would encode a divergence the SDK owns. */

    /** Tool OUTPUTS, not just inputs — the reason this runs post-batch. */
    expect(labelRequest.prompt).toContain(`E2E MCP memory noted: activity alpha ${label}`);
    expect(labelRequest.prompt).toContain(`E2E MCP memory noted: activity beta ${label}`);
  });

  /**
   * A whitespace-only label must fill null. There is deliberately no templated
   * stand-in ("Ran 2 actions" only restates the cards), so the block renders
   * exactly as it would without the feature.
   */
  test('leaves the generic header when the model returns a blank label', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('blank');
    await setLabelBehavior(request, { mode: 'blank' });

    await runLabeledTurn(page, label);

    await expect(messagesView(page).getByRole('button', { name: /^Ran 2 actions/ })).toBeVisible({
      timeout: 30000,
    });
  });

  /** Label generation is best-effort: a failing label must not fail the run. */
  test('completes the run cleanly when label generation errors', async ({ page, request }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('failure');
    await setLabelBehavior(request, { mode: 'error' });

    await runLabeledTurn(page, label);

    /** The turn still finished (asserted in runLabeledTurn) and the block kept
     *  its generic header rather than rendering an empty row. */
    await expect(messagesView(page).getByRole('button', { name: /^Ran 2 actions/ })).toBeVisible({
      timeout: 30000,
    });
    /** At least one attempt was made and failed; the client may retry a 5xx,
     *  so the exact count is not part of the contract. */
    expect((await getLabelRequestsFor(request, label)).length).toBeGreaterThanOrEqual(1);
  });

  /** `activityLabel` is per-endpoint: an endpoint without it must not call out. */
  test('makes no label request on an endpoint without activityLabel', async ({ page, request }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('disabled');

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, UNLABELED_ENDPOINT);
    await selectEphemeralMCP(page);
    const run = await sendMessage(page, `E2E_ACTIVITY_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E activity reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });

    await expect(messagesView(page).getByRole('button', { name: /^Ran 2 actions/ })).toBeVisible();
    expect(await getLabelRequestsFor(request, label)).toHaveLength(0);
  });

  /**
   * The label is a persisted content part at a claimed index, not a live-only
   * decoration: it must survive a reload at the same position.
   */
  test('persists the label across a page reload', async ({ page, request }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('persist');
    await setLabelBehavior(request, { label: 'Recorded both facts for later' });

    await runLabeledTurn(page, label);
    const header = messagesView(page).getByRole('button', {
      name: 'Recorded both facts for later',
    });
    await expect(header).toBeVisible({ timeout: 30000 });

    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
    await page.reload();

    await expect(
      messagesView(page).getByRole('button', { name: 'Recorded both facts for later' }),
    ).toBeVisible({ timeout: 30000 });
    /** Reload replays persisted content; it must not trigger a new generation. */
    expect(await getLabelRequestsFor(request, label)).toHaveLength(1);
  });
});
