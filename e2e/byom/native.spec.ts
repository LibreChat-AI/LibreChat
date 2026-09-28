import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import {
  getAccessToken,
  requestJson,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from '../specs/mock/helpers';

interface Pairing {
  environment: { id: string };
  pairing: { workerId: string; code: string; endpoint: string };
}
interface Message {
  messageId: string;
  isCreatedByUser: boolean;
  unfinished: boolean;
  content?: { tool_call?: { name?: string; output?: string } }[];
}
interface Worker {
  child: ChildProcess;
  root: string;
  environmentId: string;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('native BYOM saves, persists, isolates workers, and fails closed', async ({
  page,
}, testInfo) => {
  const runDir = process.env.BYOM_ACCEPTANCE_DIR!;
  const cli = process.env.BYOM_CODE_CLI!;
  const workspaceTransitions = process.env.BYOM_WORKSPACE_TRANSITIONS === 'true';
  const workers: Worker[] = [];
  // Emit only conversation identifiers on failure, never raw browser arguments or worker logs.
  const conversationEvents: unknown[] = [];
  page.on('console', async (message) => {
    if (!/^\[(conversation|ResumableSSE)\]/.test(message.text())) return;
    const values = await Promise.all(
      message.args().map((value, index) =>
        value
          .evaluate((item, position) => {
            if (position < 2) return typeof item === 'string' ? item : undefined;
            if (item == null || typeof item !== 'object') return undefined;
            const record = item as Record<string, unknown>;
            return {
              conversationId: record.conversationId,
              endpoint: record.endpoint,
              agent_id: record.agent_id,
              streamId: record.streamId,
              isResume: record.isResume,
              hasResponseMessage: record.hasResponseMessage,
            };
          }, index)
          .catch(() => undefined),
      ),
    );
    conversationEvents.push(values);
    if (conversationEvents.length > 100) conversationEvents.shift();
  });
  let selectedWorker: Worker;
  let selectedApprovalMode: 'ask' | 'acceptEdits' | 'fullAccess' = 'ask';
  const password = `Acceptance-${randomUUID()}`;
  const email = `native-${randomUUID()}@example.com`;
  const registered = await page.request.post('/api/auth/register', {
    data: { email, name: 'Native acceptance', password, confirm_password: password },
  });
  expect(registered.ok()).toBe(true);
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByTestId('login-button').click();
  await expect(page).toHaveURL(/\/c\/new/, { timeout: 30_000 });
  const token = await getAccessToken(page);

  async function startWorker(label: string): Promise<Worker> {
    const paired = await requestJson<Pairing>(page, {
      path: '/api/code-environments/pairings',
      token,
      method: 'POST',
      body: { name: `Acceptance ${label}`, controlPlaneId: 'native' },
    });
    const directory = path.join(runDir, 'workers', label);
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const identity = path.join(directory, 'identity.json');
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    );
    const log = await open(path.join(directory, 'worker.log'), 'a', 0o600);
    const enrollment = spawn(
      process.execPath,
      [
        cli,
        'pair',
        paired.pairing.endpoint,
        paired.pairing.code,
        '--worker-id',
        paired.pairing.workerId,
        '--identity',
        identity,
      ],
      {
        cwd: directory,
        env,
        stdio: ['ignore', log.fd, log.fd],
      },
    );
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        enrollment.kill('SIGKILL');
        reject(new Error('Pairing timed out'));
      }, 30_000);
      enrollment.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      enrollment.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exit, 'CLI pairing must succeed').toBe(0);
    const child = spawn(
      process.execPath,
      [
        cli,
        'run',
        '--worker-dir',
        workspace,
        '--allow-workspace-writes',
        '--allow-workspace-commands',
      ],
      {
        cwd: directory,
        env: { ...env, LIBRECHAT_CODE_IDENTITY_FILE: identity },
        stdio: ['ignore', log.fd, log.fd],
      },
    );
    await log.close();
    const worker = { child, root: workspace, environmentId: paired.environment.id };
    workers.push(worker);
    await expect
      .poll(
        async () => {
          const status = await requestJson<{ status: string; sandboxProfile?: string }>(page, {
            path: `/api/code-environments/${worker.environmentId}/status`,
            token,
          });
          return status.status === 'ready' ? status.sandboxProfile : status.status;
        },
        { timeout: 30_000 },
      )
      .toBe('anthropic-srt');
    return worker;
  }

  async function select(worker: Worker) {
    selectedWorker = worker;
    const agent = await requestJson<{ id: string }>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: `Native ${worker.environmentId}`,
        provider: 'Acceptance',
        model: 'acceptance',
        instructions: 'Run exactly the requested tool.',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        stateful_code_environment: 'conversation',
        code_environment_id: worker.environmentId,
      },
    });
    await page.goto(`/c/new?agent_id=${encodeURIComponent(agent.id)}`);
    await expect(page.getByTestId('code-approval-mode')).toContainText('Ask before changes', {
      timeout: 30_000,
    });
    selectedApprovalMode = 'ask';
    return agent;
  }

  async function turn(operation: string, decision?: 'Approve' | 'Reject') {
    const id = new URL(page.url()).pathname.slice(3);
    const before =
      id === 'new'
        ? []
        : await requestJson<Message[]>(page, { path: `/api/messages/${id}`, token });
    const oldIds = new Set(before.map((message) => message.messageId));
    const requestPromise = page.waitForRequest((request) => {
      const pathname = new URL(request.url()).pathname;
      return (
        request.method() === 'POST' &&
        (pathname === '/api/agents/chat' || pathname.startsWith('/api/agents/chat/'))
      );
    });
    const admitted = await sendMessage(page, `BYOM_ACCEPTANCE:${operation}`);
    const request = await requestPromise;
    expect(admitted.ok()).toBe(true);
    expect(request.postDataJSON()).toMatchObject({ codeApprovalMode: selectedApprovalMode });
    const { conversationId } = (await admitted.json()) as { conversationId: string };
    if (decision) {
      const reviewPanel = page.locator('#pending-tool-approval-panel');
      await expect(reviewPanel).toBeVisible({ timeout: 30_000 });
      /** The side effect must not occur before the user has decided. */
      if (operation === 'create')
        expect(await readdir(selectedWorker.root)).not.toContain('proof.txt');
      await reviewPanel.getByRole('button', { name: decision, exact: true }).click();
      await reviewPanel.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    let result: Message | undefined;
    await expect
      .poll(
        async () => {
          const messages = await requestJson<Message[]>(page, {
            path: `/api/messages/${conversationId}`,
            token,
          });
          result = messages.find(
            (message) =>
              !oldIds.has(message.messageId) &&
              !message.isCreatedByUser &&
              message.unfinished === false,
          );
          return result != null;
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    /** Never count echoed tool arguments or the deterministic model's final text as proof. */
    const outputs =
      result!.content?.flatMap((part) =>
        typeof part.tool_call?.output === 'string' ? [part.tool_call.output] : [],
      ) ?? [];
    expect(outputs.length, 'A persisted tool result is required').toBeGreaterThan(0);
    return outputs.join('\n');
  }

  async function chat(text: string) {
    const admitted = await sendMessageAndWaitForCompletion(page, text);
    expect(admitted.ok()).toBe(true);
    const { conversationId } = (await admitted.json()) as { conversationId: string };
    await expect
      .poll(
        async () => {
          const status = await requestJson<{ active: boolean }>(page, {
            path: `/api/agents/chat/status/${conversationId}`,
            token,
          });
          return status.active;
        },
        { timeout: 30_000 },
      )
      .toBe(false);
    await expect(page.getByText(text, { exact: true }).last()).toBeVisible();
    await expect(page.getByText('Acceptance model ready.', { exact: true }).last()).toBeVisible();
    await expect(page.getByTestId('stop-generation-button')).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`));
    return conversationId;
  }

  async function readDecision(conversationId: string) {
    return requestJson<{
      codeEnvironmentMode?: string;
      codeWorkspaces?: Array<{ environmentId: string; workspaceId: string }>;
    }>(page, { path: `/api/convos/${conversationId}`, token });
  }

  async function selectApprovalMode(mode: 'Ask before changes' | 'Accept edits' | 'Full access') {
    const selector = page.getByTestId('code-approval-mode');
    await expect(selector).toBeVisible();
    await selector.click();
    await expect(selector).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('menuitemradio', { name: new RegExp(`^${mode}`) }).click();
    await expect(selector).toContainText(mode, { timeout: 10_000 });
    const modes = {
      'Full access': 'fullAccess',
      'Accept edits': 'acceptEdits',
      'Ask before changes': 'ask',
    } as const;
    selectedApprovalMode = modes[mode];
  }

  try {
    const a = await startWorker('a');
    const coding = await select(a);
    if (workspaceTransitions) {
      const ordinary = await requestJson<{ id: string }>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: 'Acceptance ordinary chat',
          provider: 'Acceptance',
          model: 'acceptance',
          tools: [],
        },
      });
      await page.goto(`/c/new?agent_id=${encodeURIComponent(ordinary.id)}`);
      await expect(page.getByTestId('model-selector-button')).toContainText(
        'Acceptance ordinary chat',
      );
      await expect(page).toHaveURL(/\/c\/new$/);
      // Reproduce a first turn that settles before the browser attaches. Do not rely on
      // machine speed to cover the missing-stream recovery that must preserve saved identity.
      const streamRoute = '**/api/agents/chat/stream/**';
      await page.route(streamRoute, async (route) => {
        const streamId = new URL(route.request().url()).pathname.split('/').pop();
        await expect
          .poll(
            async () => {
              const status = await requestJson<{ active: boolean }>(page, {
                path: `/api/agents/chat/status/${streamId}`,
                token,
              });
              return status.active;
            },
            { timeout: 30_000 },
          )
          .toBe(false);
        await route.continue();
      });
      const conversationId = await chat('Keep this conversation and its history.');
      await page.unroute(streamRoute);
      const ordinaryDecision = await readDecision(conversationId);
      expect(ordinaryDecision.codeEnvironmentMode).toBe('without_attached');
      expect(ordinaryDecision.codeWorkspaces ?? []).toEqual([]);
      await page.getByTestId('model-selector-button').click();
      await page.locator('#model-search').fill(`Native ${a.environmentId}`);
      await page.getByRole('option', { name: new RegExp(`Native ${a.environmentId}`) }).click();
      await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`));
      await expect(page.getByTestId('code-workspace')).toContainText('No workspace');
      expect(await chat('Continue without granting workspace access.')).toBe(conversationId);
      expect(await readDecision(conversationId)).toMatchObject({
        codeEnvironmentMode: 'without_attached',
      });
      await page.reload();
      await expect(page.getByTestId('model-selector-button')).toContainText(
        `Native ${a.environmentId}`,
      );
      await expect(page.getByTestId('code-workspace')).toContainText('No workspace');
      await page.getByTestId('code-workspace').click();
      await page.getByRole('menuitem', { name: /^Attach / }).click();
      await expect
        .poll(async () => (await readDecision(conversationId)).codeEnvironmentMode)
        .toBe('attached');
      expect((await readDecision(conversationId)).codeWorkspaces).toEqual([
        expect.objectContaining({ environmentId: a.environmentId }),
      ]);
      await expect(
        page.getByText('Keep this conversation and its history.', { exact: true }),
      ).toBeVisible();
      expect(coding.id).toBeTruthy();
      expect(await turn('command', 'Approve')).toContain('native-command-ok');
      await stop(a.child);
      // A stopped process stays online in the registry until its 60-second heartbeat lease
      // expires. Observe that boundary rather than expecting the UI to contradict a live lease.
      await expect
        .poll(
          async () => {
            const status = await requestJson<{ status: string }>(page, {
              path: `/api/code-environments/${a.environmentId}/status`,
              token,
            });
            return status.status;
          },
          { timeout: 90_000 },
        )
        .toBe('offline');
      await page.reload();
      const workspace = page.getByTestId('code-workspace');
      await expect(workspace).toBeVisible({ timeout: 30_000 });
      await workspace.click();
      await page.getByTestId('code-workspace-detach').click();
      await expect
        .poll(async () => (await readDecision(conversationId)).codeEnvironmentMode)
        .toBe('without_attached');
      expect((await readDecision(conversationId)).codeWorkspaces ?? []).toEqual([]);
      expect(await chat('Continue chatting after leaving the offline workspace.')).toBe(
        conversationId,
      );
      await page.reload();
      await expect(
        page.getByText('Keep this conversation and its history.', { exact: true }),
      ).toBeVisible();
      expect((await readDecision(conversationId)).codeEnvironmentMode).toBe('without_attached');
      await testInfo.attach('workspace-transitions', {
        body: JSON.stringify({
          savedChatPreserved: true,
          noImplicitWorkspaceAccess: true,
          noWorkspaceSurvivesReload: true,
          explicitAttach: true,
          approvedNativeCommand: true,
          offlineDetach: true,
          detachedChatSurvivesReload: true,
        }),
        contentType: 'application/json',
      });
      return;
    }
    expect(await turn('create', 'Approve')).toContain('Created workspace/proof.txt');
    expect(await readFile(path.join(a.root, 'proof.txt'), 'utf8')).toBe('native-original');
    expect(await turn('read')).toContain('native-original');
    await selectApprovalMode('Accept edits');
    await turn('edit');
    expect(await readFile(path.join(a.root, 'proof.txt'), 'utf8')).toBe('native-edited');
    await page.reload();
    expect(await turn('read')).toContain('native-edited');
    /** Accept edits does not weaken command execution approval. */
    expect(await turn('command', 'Approve')).toContain('native-command-ok');
    await selectApprovalMode('Full access');
    expect(await turn('command')).toContain('native-command-ok');
    await turn('fullCreate');
    expect(await readFile(path.join(a.root, 'unattended.txt'), 'utf8')).toBe('native-unattended');
    await page.reload();
    await expect(page.getByTestId('code-approval-mode')).toContainText('Full access');
    expect(await turn('command')).toContain('native-command-ok');
    await selectApprovalMode('Ask before changes');
    expect(await turn('reject', 'Reject')).toMatch(/blocked|reject|denied|declined/i);
    expect(await readdir(a.root)).not.toContain('rejected.txt');

    const b = await startWorker('b');
    await select(b);
    expect(await turn('read')).toMatch(/could not be read|not found/i);
    expect(await readdir(b.root)).not.toContain('proof.txt');
    expect(await turn('create', 'Approve')).toContain('Created workspace/proof.txt');
    expect(await readFile(path.join(b.root, 'proof.txt'), 'utf8')).toBe('native-original');
    expect(await readFile(path.join(a.root, 'proof.txt'), 'utf8')).toBe('native-edited');

    await stop(b.child);
    const offline = await turn('offline', 'Approve');
    expect(offline).toMatch(/failed|offline|unavailable|could not|not ready/i);
    expect(offline).not.toMatch(/Created workspace\/offline/);
    expect(await readdir(a.root)).not.toContain('offline.txt');
    expect(await readdir(b.root)).not.toContain('offline.txt');
    await testInfo.attach('acceptance', {
      body: JSON.stringify({
        nativeCommand: true,
        physicalCreate: true,
        acceptEditsWithoutPrompt: true,
        commandsStillRequireApproval: true,
        fullAccessCommandsWithoutPrompt: true,
        fullAccessWritesWithoutPrompt: true,
        fullAccessSurvivesReload: true,
        crossTurnEdit: true,
        rejectedWriteAbsent: true,
        twoWorkerIsolation: true,
        offlineFailsClosed: true,
      }),
      contentType: 'application/json',
    });
  } catch (error) {
    console.log('Native acceptance conversation metadata:', JSON.stringify(conversationEvents));
    throw error;
  } finally {
    for (const worker of workers) await stop(worker.child);
  }
});
