import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
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
} from './helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import { approvalCards, collapseComposerApproval } from './approvals.helpers';

let worker: ChildProcess;
const sockets = new Set<Socket>();
let offline = false;
let connections = 0;
const proxy = createServer((client) => {
  connections++;
  if (offline) {
    client.destroy();
    return;
  }
  const upstream = connect(8807, '127.0.0.1');
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  }
  client.pipe(upstream).pipe(client);
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
async function interruptWire() {
  offline = true;
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 500));
  offline = false;
}

let workerOutput = '';
test.describe.configure({ mode: 'serial' });
async function startWorker(graph = 'complex') {
  const outputStart = workerOutput.length;
  worker = spawn(process.execPath, ['examples/sdk-runtime/server.cjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SDK_RUNTIME_ID: 'remote-recovery',
      SDK_RUNTIME_RECOVERY: 'true',
      SDK_RUNTIME_REDIS_URI: process.env.REDIS_URI || 'redis://127.0.0.1:6379',
      SDK_RUNTIME_JOURNAL_PREFIX: `E2E-Recovery-${process.pid}`,
      SDK_RUNTIME_PORT: '8807',
      SDK_RUNTIME_SECRET: 'e2e-remote-sdk-fixture-secret-not-a-production-key',
      SDK_EXAMPLE_GRAPH: graph,
      SDK_EXAMPLE_LIVE_MODEL: 'false',
      SDK_EXAMPLE_STEP_DELAY_MS: '2000',
      SDK_RUNTIME_AGENT_IDS: '',
      OPENAI_API_KEY: '',
    },
  });
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
test.skip(process.env.E2E_STREAM_STORE !== 'redis', 'Requires the Redis transport lane');
test.beforeAll(async () => {
  await new Promise<void>((resolve) => proxy.listen(8806, '127.0.0.1', resolve));
  await startWorker();
});
test.afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await stopWorker();
});

test('recovers a separate custom graph during approval continuation and persists native history', async ({
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
        sdk_runtime: { id: 'remote-recovery', protocolVersion: 1 },
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
    await page.reload();
    const card = approvalCards(page).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await collapseComposerApproval(page);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    const resumedAt = performance.now();
    await card.getByRole('button', { name: 'Submit', exact: true }).click();
    await interruptWire();
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
      body: JSON.stringify({
        configuredPlanDelayMs: 2000,
        connections,
        approvalVisibleMs,
        resumeToVisibleMs,
      }),
      contentType: 'application/json',
    });
    await page.screenshot({ path: info.outputPath('remote-sdk-graph.png'), fullPage: true });
    expect(connections).toBeGreaterThanOrEqual(3);
    expect(workerOutput).not.toContain('Remote SDK run failed');
  } finally {
    await cleanupAgent(page, agentId);
  }
});
