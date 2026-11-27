import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FileContext } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { Page, Request } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  fetchJson,
  uniqueName,
  sendMessage,
  messagesView,
  requestJson,
  getAccessToken,
  uploadViaUnifiedButton,
  sendMessageAndWaitForCompletion,
} from './helpers';

type LifecycleProof = { label: string; artifactId: string; publishedId?: string };
type LifecycleMode = 'concurrent' | 'cancel' | 'resume' | 'probe';
type GenerationStart = { conversationId: string };

const prompt = (
  mode: LifecycleMode,
  childId: string,
  label: string,
  inputId?: string,
  artifactId?: string,
) => `E2E_RUN_FILES_LIFECYCLE:${JSON.stringify({ mode, childId, label, inputId, artifactId })}`;

async function createAgents(page: Page) {
  const token = await getAccessToken(page);
  const create = (name: string, fields: Pick<AgentDetail, 'tools' | 'subagents'>) =>
    requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name,
        instructions: 'Follow the lifecycle test request exactly.',
        provider: MOCK_ENDPOINTS[1].label,
        model: MOCK_ENDPOINTS[1].model,
        ...fields,
      },
    });
  const child = await create(uniqueAgentName('E2E Lifecycle Child'), { tools: ['execute_code'] });
  const parent = await create(uniqueAgentName('E2E Lifecycle Parent'), {
    tools: ['ask_user_question'],
    subagents: { enabled: true, allowSelf: false, shareFiles: true, agent_ids: [child.id] },
  });
  return { parent, child };
}

async function selectAgent(page: Page, name: string) {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

async function uploadInput(page: Page, label: string): Promise<TFile> {
  const response = await uploadViaUnifiedButton(page, {
    name: `e2e-lifecycle-${label}.csv`,
    mimeType: 'text/csv',
    content: `scope,value\n${label},1\n`,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as TFile;
}

async function publishedFiles(page: Page, conversationId: string): Promise<TFile[]> {
  const files = await fetchJson<TFile[]>(page, '/api/files', await getAccessToken(page));
  return files.filter(
    (file) => file.context === FileContext.run_artifact && file.conversationId === conversationId,
  );
}

async function waitForCompletion(page: Page, conversationId: string, text: string) {
  await expect(messagesView(page)).toContainText(text, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
  const token = await getAccessToken(page);
  await expect
    .poll(async () => {
      const messages = await fetchJson<TMessage[]>(
        page,
        `/api/messages/${encodeURIComponent(conversationId)}`,
        token,
      );
      const assistant = messages.filter((message) => message.isCreatedByUser === false);
      return (
        assistant.length > 0 &&
        assistant.every((message) => message.unfinished === false && message.error !== true)
      );
    })
    .toBe(true);
}

async function snapshotDirectories(): Promise<string[]> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && /^librechat-run-files-[A-Za-z0-9]{6}$/.test(entry.name),
    )
    .map((entry) => join(tmpdir(), entry.name));
}

async function newSnapshotDirectories(before: ReadonlySet<string>): Promise<string[]> {
  return (await snapshotDirectories()).filter((directory) => !before.has(directory));
}

async function waitForPrivateSnapshot(before: ReadonlySet<string>): Promise<string[]> {
  let directories: string[] = [];
  await expect
    .poll(async () => {
      directories = await newSnapshotDirectories(before);
      return directories.length;
    })
    .toBe(1);
  const snapshots = await readdir(directories[0]);
  expect(snapshots).toHaveLength(1);
  expect(await readFile(join(directories[0], snapshots[0]), 'utf8')).toBe('source,count\npdf,1\n');
  return directories;
}

async function expectSnapshotsRemoved(directories: string[]) {
  await expect
    .poll(async () => {
      const existing = new Set(await snapshotDirectories());
      return directories.filter((directory) => existing.has(directory));
    })
    .toEqual([]);
}

async function readProof(page: Page, state: 'private' | 'pending'): Promise<LifecycleProof> {
  const pattern = new RegExp(`E2E lifecycle ${state} (\\{[^\\n]*\\})`);
  await expect(messagesView(page)).toContainText(pattern, { timeout: 45_000 });
  const match = (await messagesView(page).innerText()).match(pattern);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as LifecycleProof;
}

async function stopGeneration(page: Page) {
  const stop = page.getByRole('button', { name: 'Stop generating' });
  if (!(await stop.isVisible())) return;
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/agents/chat/abort',
    ),
    stop.click(),
  ]);
  await expect(stop).toBeHidden({ timeout: 20_000 });
}

async function cleanup(page: Page, agents: string[], files: TFile[]) {
  await stopGeneration(page);
  if (files.length > 0) {
    await requestJson(page, {
      path: '/api/files',
      token: await getAccessToken(page),
      method: 'DELETE',
      body: { files },
    });
  }
  for (const agent of agents) await cleanupAgent(page, agent);
}

async function downloadFile(page: Page, file: TFile) {
  const download = page.waitForEvent('download');
  await messagesView(page)
    .getByRole('button', { name: `Download ${file.filename}`, exact: true })
    .click();
  const result = await download;
  expect(await result.failure()).toBeNull();
  expect(result.suggestedFilename()).toBe(file.filename);
  expect(await readFile(await result.path(), 'utf8')).toBe('source,count\npdf,1\n');
}

function isResumeRequest(request: Request) {
  return (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/chat/resume'
  );
}

test.describe('run-file lifecycle', () => {
  test('isolates two overlapping runs of the same parent and child agents', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const secondContext = await browser.newContext({
      baseURL,
      storageState: await page.context().storageState(),
    });
    const second = await secondContext.newPage();
    const files: TFile[] = [];
    const agents: string[] = [];
    try {
      await page.goto('/c/new');
      const { parent, child } = await createAgents(page);
      agents.push(parent.id, child.id);
      const labels = [uniqueName('parallel-a'), uniqueName('parallel-b')];
      await selectAgent(page, parent.name!);
      files.push(await uploadInput(page, labels[0]));
      await selectAgent(second, parent.name!);
      files.push(await uploadInput(second, labels[1]));
      const admissions = [
        await sendMessage(page, prompt('concurrent', child.id, labels[0], files[0].file_id)),
        await sendMessage(second, prompt('concurrent', child.id, labels[1], files[1].file_id)),
      ];
      const starts = (await Promise.all(
        admissions.map((response) => response.json()),
      )) as Array<GenerationStart>;
      expect(starts[0].conversationId).not.toBe(starts[1].conversationId);
      const token = await getAccessToken(page);
      const active = await Promise.all(
        starts.map(({ conversationId }) =>
          fetchJson<{ active: boolean }>(
            page,
            `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
            token,
          ),
        ),
      );
      expect(active.map((status) => status.active)).toEqual([true, true]);
      await Promise.all(
        [page, second].map((current, index) =>
          waitForCompletion(
            current,
            starts[index].conversationId,
            `E2E lifecycle passed concurrent ${labels[index]}`,
          ),
        ),
      );
      const publications: TFile[] = [];
      for (const [index, current] of [page, second].entries()) {
        const outputs = await publishedFiles(current, starts[index].conversationId);
        files.push(...outputs);
        expect(outputs).toHaveLength(1);
        publications.push(outputs[0]);
        expect(outputs[0].metadata?.runFile).toMatchObject({
          agentId: child.id,
          parentAgentId: parent.id,
          inputFileIds: [files[index].file_id],
        });
        await current.reload();
        await expect(messagesView(current)).toContainText(
          `E2E lifecycle passed concurrent ${labels[index]}`,
        );
        await downloadFile(current, outputs[0]);
      }
      expect(publications[0].metadata?.runFile?.runId).not.toBe(
        publications[1].metadata?.runFile?.runId,
      );
      expect(publications[0].metadata?.runFile?.executionId).not.toBe(
        publications[1].metadata?.runFile?.executionId,
      );
    } finally {
      await stopGeneration(second);
      await secondContext.close();
      await cleanup(page, agents, files);
    }
  });

  test('cancellation deletes private snapshots and a later turn cannot publish their IDs', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const label = uniqueName('cancelled');
    const files: TFile[] = [];
    const agents: string[] = [];
    try {
      await page.goto('/c/new');
      const { parent, child } = await createAgents(page);
      agents.push(parent.id, child.id);
      await selectAgent(page, parent.name!);
      const input = await uploadInput(page, label);
      files.push(input);
      const before = new Set(await snapshotDirectories());
      const admission = await sendMessage(page, prompt('cancel', child.id, label, input.file_id));
      const { conversationId } = (await admission.json()) as GenerationStart;
      const proof = await readProof(page, 'private');
      expect(proof.label).toBe(label);
      expect(proof.artifactId).toBeTruthy();
      const directories = await waitForPrivateSnapshot(before);
      expect(await publishedFiles(page, conversationId)).toEqual([]);
      await stopGeneration(page);
      await expectSnapshotsRemoved(directories);
      expect(await publishedFiles(page, conversationId)).toEqual([]);
      await page.reload();
      await sendMessageAndWaitForCompletion(
        page,
        prompt('probe', child.id, label, undefined, proof.artifactId),
        { timeout: 60_000 },
      );
      await expect(messagesView(page)).toContainText(`E2E lifecycle passed probe ${label}`);
      expect(await publishedFiles(page, conversationId)).toEqual([]);
      await expectSnapshotsRemoved(directories);
    } finally {
      await cleanup(page, agents, files);
    }
  });

  test('a checkpoint resume restores publications and requires private outputs to be regenerated', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = uniqueName('resumed');
    const files: TFile[] = [];
    const agents: string[] = [];
    try {
      await page.goto('/c/new');
      const { parent, child } = await createAgents(page);
      agents.push(parent.id, child.id);
      await selectAgent(page, parent.name!);
      const input = await uploadInput(page, label);
      files.push(input);
      const before = new Set(await snapshotDirectories());
      const admission = await sendMessage(page, prompt('resume', child.id, label, input.file_id));
      const { conversationId } = (await admission.json()) as GenerationStart;
      const proof = await readProof(page, 'pending');
      expect(proof.label).toBe(label);
      expect(proof.artifactId).toBeTruthy();
      expect(proof.publishedId).toBeTruthy();
      const directories = await waitForPrivateSnapshot(before);
      const question = page
        .getByRole('paragraph')
        .filter({ hasText: `Resume shared files ${label}?` });
      await expect(question).toBeVisible({ timeout: 30_000 });
      await expectSnapshotsRemoved(directories);
      const initial = await publishedFiles(page, conversationId);
      files.push(...initial);
      expect(initial.map((file) => file.file_id)).toEqual([proof.publishedId]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(question).toBeVisible({ timeout: 30_000 });
      await downloadFile(page, initial[0]);
      await page.getByRole('button', { name: new RegExp(`Continue ${label}$`) }).click();
      const [request, response] = await Promise.all([
        page.waitForRequest(isResumeRequest),
        page.waitForResponse((candidate) => isResumeRequest(candidate.request())),
        page.getByRole('button', { name: 'Submit', exact: true }).click(),
      ]);
      expect(response.ok()).toBeTruthy();
      expect(request.postDataJSON()).toMatchObject({
        conversationId,
        agent_id: parent.id,
        answers: { confirmation: `continue-${label}` },
      });
      await waitForCompletion(page, conversationId, `E2E lifecycle passed resume ${label}`);
      const completed = await publishedFiles(page, conversationId);
      const regenerated = completed.filter((file) => file.file_id !== proof.publishedId);
      files.push(...regenerated);
      expect(completed).toHaveLength(2);
      expect(regenerated).toHaveLength(1);
      expect(regenerated[0].metadata?.runFile?.runId).toBe(initial[0].metadata?.runFile?.runId);
      expect(regenerated[0].metadata?.runFile?.sourceFileId).not.toBe(proof.artifactId);
      expect(regenerated[0].metadata?.runFile?.inputFileIds).toEqual([input.file_id]);
      expect(regenerated[0].metadata?.runFile?.agentId).toBe(child.id);
      await page.reload();
      await expect(messagesView(page)).toContainText(`E2E lifecycle passed resume ${label}`);
      await downloadFile(page, initial[0]);
      await downloadFile(page, regenerated[0]);
      await expectSnapshotsRemoved(directories);
    } finally {
      await cleanup(page, agents, files);
    }
  });
});
