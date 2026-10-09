import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { cleanupAgent } from '../specs/mock/agents.helpers';
import { NEW_CHAT_PATH, getAccessToken, messagesView, requestJson } from '../specs/mock/helpers';

type AgentResponse = {
  id: string;
  name?: string | null;
  tools?: string[];
  mcpServerNames?: string[];
};

type BrowserLatencyState = {
  startedAt: number | null;
  acknowledgedAt: number | null;
  firstContentAt: number | null;
};

type LatencySample = {
  submitToAckMs: number;
  submitToFirstContentMs: number;
  ackToFirstContentMs: number;
};

type Summary = {
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
};

type CpuSnapshot = {
  idle: number;
  total: number;
};

const BENCHMARK_REPLY = process.env.MOCK_LLM_REPLY ?? 'BENCH_TOKEN';
const WARMUP_COUNT = parseCount('E2E_LATENCY_WARMUPS', 5);
const SAMPLE_COUNT = parseCount('E2E_LATENCY_SAMPLES', 30, 1);
const SIMULATED_MONGO_DELAY_MS = parseCount('E2E_LATENCY_MONGO_DELAY_MS', 0);
const BENCHMARK_PROFILE = process.env.E2E_LATENCY_PROFILE ?? 'minimal';
if (!['minimal', 'mcp-memory'].includes(BENCHMARK_PROFILE)) {
  throw new Error(`Unsupported E2E_LATENCY_PROFILE: ${BENCHMARK_PROFILE}`);
}
const BENCHMARK_TURN = process.env.E2E_LATENCY_TURN ?? 'first';
if (!['first', 'follow-up'].includes(BENCHMARK_TURN)) {
  throw new Error(`Unsupported E2E_LATENCY_TURN: ${BENCHMARK_TURN}`);
}
const MCP_SERVER_NAME = 'e2e-memory';
const MCP_TOOLS = [
  'memory',
  `sys__server__sys_mcp_${MCP_SERVER_NAME}`,
  `remember_fact_mcp_${MCP_SERVER_NAME}`,
];

function parseCount(name: string, fallback: number, minimum = 0) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function captureCpuSnapshot(): CpuSnapshot {
  return cpus().reduce<CpuSnapshot>(
    (snapshot, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      snapshot.idle += cpu.times.idle;
      snapshot.total += total;
      return snapshot;
    },
    { idle: 0, total: 0 },
  );
}

function calculateCpuUtilization(before: CpuSnapshot, after: CpuSnapshot) {
  const idleDelta = after.idle - before.idle;
  const totalDelta = after.total - before.total;
  return totalDelta > 0 ? round(100 * (1 - idleDelta / totalDelta)) : 0;
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const position = (sortedValues.length - 1) * percentileValue;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

function summarize(values: number[]): Summary {
  const sortedValues = [...values].sort((left, right) => left - right);
  return {
    p50: round(percentile(sortedValues, 0.5)),
    p95: round(percentile(sortedValues, 0.95)),
    mean: round(values.reduce((total, value) => total + value, 0) / values.length),
    min: round(sortedValues[0]),
    max: round(sortedValues.at(-1)!),
  };
}

function summarizeSamples(samples: LatencySample[]) {
  return {
    submitToAckMs: summarize(samples.map((sample) => sample.submitToAckMs)),
    submitToFirstContentMs: summarize(samples.map((sample) => sample.submitToFirstContentMs)),
    ackToFirstContentMs: summarize(samples.map((sample) => sample.ackToFirstContentMs)),
  };
}

function modelTrigger(page: Page) {
  return page.getByRole('button', { name: 'Select a model' }).first();
}

async function createAgent(page: Page, name: string) {
  const token = await getAccessToken(page);
  return requestJson<AgentResponse>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
      ...(BENCHMARK_PROFILE === 'mcp-memory' ? { tools: MCP_TOOLS } : {}),
    },
  });
}

async function selectAgent(page: Page, agentName: string) {
  const trigger = modelTrigger(page);
  await expect(trigger).toBeVisible();
  if ((await trigger.textContent())?.includes(agentName)) {
    return;
  }
  await trigger.click();
  await page.getByRole('option', { name: 'My Agents' }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(trigger).toContainText(agentName);
}

async function prepareFreshChat(page: Page, agentName: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await selectAgent(page, agentName);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  await expect(messagesView(page).getByText(BENCHMARK_REPLY, { exact: true })).toHaveCount(0);
}

async function prepareConversation(page: Page, agentName: string, sequence: number) {
  await prepareFreshChat(page, agentName);
  if (BENCHMARK_TURN === 'first') {
    return;
  }

  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill(`agent startup latency seed ${sequence}`);
  await input.press('Enter');
  await expect(messagesView(page).getByText(BENCHMARK_REPLY, { exact: true })).toHaveCount(1, {
    timeout: 30000,
  });
  await expect(page.getByTestId('stop-generation-button')).toHaveCount(0, { timeout: 10000 });
}

async function installBrowserObservers(input: Locator) {
  return input.evaluate((inputElement, replyText) => {
    const latencyWindow = window as typeof window & {
      __agentStartupLatency?: BrowserLatencyState;
    };
    const state: BrowserLatencyState = {
      startedAt: null,
      acknowledgedAt: null,
      firstContentAt: null,
    };
    latencyWindow.__agentStartupLatency = state;
    performance.clearResourceTimings();
    const countReplies = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.message-render .agent-turn .message-content'),
      ).filter((element) => element.textContent?.includes(replyText)).length;
    const replyCountBefore = countReplies();

    inputElement.addEventListener(
      'keydown',
      (event) => {
        if (
          event instanceof KeyboardEvent &&
          event.key === 'Enter' &&
          !event.shiftKey &&
          state.startedAt === null
        ) {
          state.startedAt = performance.now();
        }
      },
      { capture: true },
    );

    const resourceObserver = new PerformanceObserver((entries) => {
      if (state.startedAt === null || state.acknowledgedAt !== null) {
        return;
      }
      for (const entry of entries.getEntries()) {
        const url = new URL(entry.name);
        if (url.origin === location.origin && url.pathname === '/api/agents/chat/agents') {
          state.acknowledgedAt = entry.responseEnd;
          resourceObserver.disconnect();
          break;
        }
      }
    });
    resourceObserver.observe({ type: 'resource', buffered: true });

    const mutationObserver = new MutationObserver(() => {
      if (
        state.startedAt !== null &&
        state.firstContentAt === null &&
        countReplies() > replyCountBefore
      ) {
        state.firstContentAt = performance.now();
        mutationObserver.disconnect();
      }
    });
    mutationObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return replyCountBefore;
  }, BENCHMARK_REPLY);
}

async function deleteMeasuredConversation(page: Page, token: string) {
  const match = new URL(page.url()).pathname.match(/^\/c\/([^/]+)$/);
  const conversationId = match?.[1];
  if (!conversationId || conversationId === 'new') {
    throw new Error(`Expected a persisted conversation URL, got: ${page.url()}`);
  }
  await requestJson(page, {
    path: '/api/convos',
    token,
    method: 'DELETE',
    body: { arg: { conversationId } },
  });
}

async function measureSample(page: Page, agentName: string, token: string, sequence: number) {
  await prepareConversation(page, agentName, sequence);
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill(`agent startup latency sample ${sequence}`);
  await expect(page.getByTestId('send-button')).toBeEnabled();
  const replyCountBefore = await installBrowserObservers(input);

  await input.press('Enter');
  await page.waitForFunction(
    () => {
      const latencyWindow = window as typeof window & {
        __agentStartupLatency?: BrowserLatencyState;
      };
      const state = latencyWindow.__agentStartupLatency;
      return (
        state?.startedAt != null && state.acknowledgedAt != null && state.firstContentAt != null
      );
    },
    null,
    { timeout: 30000 },
  );

  const state = await page.evaluate(() => {
    const latencyWindow = window as typeof window & {
      __agentStartupLatency?: BrowserLatencyState;
    };
    return latencyWindow.__agentStartupLatency;
  });
  if (state?.startedAt == null || state.acknowledgedAt == null || state.firstContentAt == null) {
    throw new Error('Browser latency observers did not capture all timestamps');
  }

  await expect(messagesView(page).getByText(BENCHMARK_REPLY, { exact: true })).toHaveCount(
    replyCountBefore + 1,
  );
  await expect(page.getByTestId('stop-generation-button')).toHaveCount(0, { timeout: 10000 });

  const sample = {
    submitToAckMs: round(state.acknowledgedAt - state.startedAt),
    submitToFirstContentMs: round(state.firstContentAt - state.startedAt),
    ackToFirstContentMs: round(state.firstContentAt - state.acknowledgedAt),
  };
  await deleteMeasuredConversation(page, token);
  return sample;
}

async function saveReport(report: object, testInfo: TestInfo) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await testInfo.attach('agent-startup-latency.json', {
    body: Buffer.from(serialized),
    contentType: 'application/json',
  });

  const outputPath = process.env.E2E_LATENCY_OUTPUT;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
  }
}

test('measures agent-chat startup latency', async ({ page }, testInfo) => {
  test.setTimeout(Math.max(120000, (WARMUP_COUNT + SAMPLE_COUNT + 1) * 30000));

  const hostLoadBefore = loadavg();
  const hostCpuBefore = captureCpuSnapshot();
  const agentName = `E2E Agent Startup Benchmark ${Date.now()}`;
  let agent: AgentResponse | undefined;
  try {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    agent = await createAgent(page, agentName);
    if (BENCHMARK_PROFILE === 'mcp-memory') {
      expect(agent.tools).toEqual(expect.arrayContaining(MCP_TOOLS));
      expect(agent.mcpServerNames).toContain(MCP_SERVER_NAME);
    }
    const token = await getAccessToken(page);

    const cold = await measureSample(page, agentName, token, 0);
    for (let index = 0; index < WARMUP_COUNT; index++) {
      await measureSample(page, agentName, token, index + 1);
    }

    const samples: LatencySample[] = [];
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      samples.push(await measureSample(page, agentName, token, WARMUP_COUNT + index + 1));
    }

    const report = {
      label: process.env.E2E_LATENCY_LABEL ?? 'unlabeled',
      gitSha: process.env.E2E_LATENCY_GIT_SHA ?? 'unknown',
      streamMode: process.env.E2E_LATENCY_STREAM_MODE ?? 'in-memory',
      profile: BENCHMARK_PROFILE,
      turn: BENCHMARK_TURN,
      simulatedLatency: {
        mongoQueryMs: SIMULATED_MONGO_DELAY_MS,
      },
      cold,
      warmups: WARMUP_COUNT,
      samples: SAMPLE_COUNT,
      host: {
        logicalCpus: availableParallelism(),
        loadAverageBefore: hostLoadBefore,
        loadAverageAfter: loadavg(),
        cpuUtilizationPct: calculateCpuUtilization(hostCpuBefore, captureCpuSnapshot()),
      },
      raw: {
        submitToAckMs: samples.map((sample) => sample.submitToAckMs),
        submitToFirstContentMs: samples.map((sample) => sample.submitToFirstContentMs),
        ackToFirstContentMs: samples.map((sample) => sample.ackToFirstContentMs),
      },
      summary: summarizeSamples(samples),
    };

    console.log(`AGENT_STARTUP_LATENCY ${JSON.stringify(report)}`);
    await saveReport(report, testInfo);
  } finally {
    await cleanupAgent(page, agent?.id);
  }
});
