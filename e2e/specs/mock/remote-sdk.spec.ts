import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessage,
  uploadViaUnifiedButton,
} from './helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import { approvalCards, collapseComposerApproval } from './approvals.helpers';

let worker: ChildProcess;
let workerOutput = '';
test.describe.configure({ mode: 'serial' });
async function startWorker(graph = 'complex') {
  const outputStart = workerOutput.length;
  worker = spawn(
    process.execPath,
    [graph === 'files' ? 'e2e/setup/remote-sdk-files.cjs' : 'examples/sdk-runtime/server.cjs'],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SDK_RUNTIME_ID: 'remote-example',
        SDK_RUNTIME_PORT: '8804',
        SDK_RUNTIME_SECRET: 'e2e-remote-sdk-fixture-secret-not-a-production-key',
        SDK_EXAMPLE_GRAPH: graph,
        SDK_EXAMPLE_LIVE_MODEL: 'false',
        SDK_EXAMPLE_STEP_DELAY_MS: '10000',
        SDK_RUNTIME_AGENT_IDS: '',
        OPENAI_API_KEY: '',
      },
    },
  );
  worker.stdout?.on('data', (data) => {
    workerOutput += data.toString();
  });
  worker.stderr?.on('data', (data) => {
    workerOutput += data.toString();
  });
  await expect
    .poll(() => workerOutput.slice(outputStart), { timeout: 30_000 })
    .toContain('listening on loopback');
}
async function stopWorker() {
  if (worker && worker.exitCode == null) {
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    worker.kill('SIGTERM');
    await exited;
  }
}
test.beforeAll(async () => {
  await startWorker();
});
test.afterAll(stopWorker);

test('a separate custom SDK graph uses native approval, reload, events, and saved history', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  let agentId: string | undefined;
  try {
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const agent = await requestJson<{ id: string; name: string }>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('Remote SDK graph'),
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        sdk_runtime: { id: 'remote-example', protocolVersion: 1 },
      },
    });
    agentId = agent.id;
    const builder = await openAgentBuilder(page);
    await builder.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agent.name }).click();
    await builder.getByRole('button', { name: 'Select Agent' }).click();
    const startedAt = performance.now();
    await sendMessage(page, 'Inspect the runtime bridge fixture and review the findings.');
    await expect(approvalCards(page).first(), workerOutput).toBeVisible({ timeout: 30_000 });
    const approvalVisibleMs = performance.now() - startedAt;
    const conversationUrl = page.url();
    await stopWorker();
    await startWorker();
    await page.reload();
    const card = approvalCards(page).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await collapseComposerApproval(page);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    const resumedAt = performance.now();
    await card.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(
      messagesView(page)
        .getByText(/Custom graph complete:/)
        .last(),
      workerOutput,
    ).toBeVisible({ timeout: 30_000 });
    await expect(approvalCards(page)).toHaveCount(0, { timeout: 30_000 });
    const resumeToVisibleMs = performance.now() - resumedAt;
    await page.reload();
    await expect(
      messagesView(page)
        .getByText(/Custom graph complete:/)
        .last(),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(new URL(conversationUrl).pathname);
    await info.attach('remote-sdk-latency', {
      body: JSON.stringify({ configuredPlanDelayMs: 10000, approvalVisibleMs, resumeToVisibleMs }),
      contentType: 'application/json',
    });
    await page.screenshot({ path: info.outputPath('remote-sdk-graph.png'), fullPage: true });
    expect(workerOutput).not.toContain('Remote SDK run failed');
  } finally {
    await cleanupAgent(page, agentId);
  }
});

test('reconnects the native running-job stream and stops the separate graph', async ({ page }) => {
  test.setTimeout(90_000);
  let agentId: string | undefined;
  try {
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const agent = await requestJson<{ id: string; name: string }>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('Remote SDK cancellation'),
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        sdk_runtime: { id: 'remote-example', protocolVersion: 1 },
      },
    });
    agentId = agent.id;
    const builder = await openAgentBuilder(page);
    await builder.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agent.name }).click();
    await builder.getByRole('button', { name: 'Select Agent' }).click();
    await sendMessage(page, 'Start the inspection so I can cancel it.');
    await expect(page.getByTestId('stop-generation-button')).toBeVisible();
    await expect(page).toHaveURL(/\/c\/(?!new)[^?]+/);
    await page.reload();
    await expect(page.getByTestId('stop-generation-button')).toBeVisible();
    await page.getByTestId('stop-generation-button').click();
    await expect(page.getByTestId('stop-generation-button')).toBeHidden();
    await expect.poll(() => workerOutput).toContain('Example node cancelled');
    await expect(approvalCards(page)).toHaveCount(0);
    await page.reload();
    await expect(
      messagesView(page).getByText('Start the inspection so I can cancel it.'),
    ).toBeVisible();
    await expect(messagesView(page)).not.toContainText('An error occurred while processing');
  } finally {
    await cleanupAgent(page, agentId);
  }
});

test('runs the minimal SDK example through the real native UI', async ({ page }, info) => {
  await stopWorker();
  await startWorker('simple');
  let agentId: string | undefined;
  try {
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const agent = await requestJson<{ id: string; name: string }>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('Minimal remote SDK'),
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        sdk_runtime: { id: 'remote-example', protocolVersion: 1 },
      },
    });
    agentId = agent.id;
    const builder = await openAgentBuilder(page);
    await builder.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agent.name }).click();
    await builder.getByRole('button', { name: 'Select Agent' }).click();
    await sendMessage(page, 'Hello remote SDK.');
    await expect(
      messagesView(page).getByText('Hello from the separate SDK runtime.'),
    ).toBeVisible();
    await expect(page.getByTestId('stop-generation-button')).toBeHidden();
    await page.reload();
    await expect(
      messagesView(page).getByText('Hello from the separate SDK runtime.'),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath('remote-sdk-minimal.png'), fullPage: true });
  } finally {
    await cleanupAgent(page, agentId);
  }
});

test('reads an uploaded native attachment in a separate SDK process and saves the reply', async ({
  page,
}) => {
  test.setTimeout(90000);
  await stopWorker();
  await startWorker('files');
  let agentId: string | undefined;
  try {
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const agent = await requestJson<{ id: string; name: string }>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('SDK native attachment'),
        provider: MOCK_ENDPOINTS[1].label,
        model: MOCK_ENDPOINTS[1].model,
        sdk_runtime: { id: 'remote-example', protocolVersion: 1 },
      },
    });
    agentId = agent.id;
    const builder = await openAgentBuilder(page);
    await builder.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agent.name }).click();
    await builder.getByRole('button', { name: 'Select Agent' }).click();
    const content = 'sdk-native-attachment-proof,42';
    const uploaded = await uploadViaUnifiedButton(page, {
      name: 'sdk-native.csv',
      mimeType: 'text/csv',
      content,
    });
    expect(uploaded.ok()).toBe(true);
    await sendMessage(page, 'Read the attached file through the host file service.');
    await expect(approvalCards(page).first(), workerOutput).toBeVisible({ timeout: 30000 });
    await stopWorker();
    await startWorker('files');
    await page.reload();
    const card = approvalCards(page).first();
    await expect(card).toBeVisible();
    await collapseComposerApproval(page);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await card.getByRole('button', { name: 'Submit', exact: true }).click();
    const reply = `Remote attachment bytes: ${content}`;
    await expect(messagesView(page).getByText(reply).last(), workerOutput).toBeVisible({
      timeout: 30000,
    });
    await page.reload();
    await expect(messagesView(page).getByText(reply).last()).toBeVisible();
  } finally {
    await cleanupAgent(page, agentId);
    await stopWorker();
    await startWorker();
  }
});
