import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { ContentTypes, FileContext } from 'librechat-data-provider';
import type { Agents, TFile, TMessage } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import {
  fetchJson,
  uniqueName,
  RAG_API_BASE,
  messagesView,
  requestJson,
  getAccessToken,
  getRagEmbedded,
  resetProvisioning,
  uploadViaUnifiedButton,
  getCodeProvisionedUploads,
  sendMessageAndWaitForCompletion,
} from './helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';

type Catalog = {
  files: Array<{ file_id: string; filename: string }>;
  artifacts: Array<{ artifact_id: string; filename: string }>;
};

type PersistedToolCall = Agents.ToolCall & {
  subagent_content?: NonNullable<TMessage['content']>;
};

function inputPdf(text: string): string {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function createAgent(
  page: Page,
  token: string,
  agents: AgentDetail[],
  fields: Pick<AgentDetail, 'tools' | 'subagents'> = {},
): Promise<AgentDetail> {
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Run File Delivery'),
      description: 'Shared-file delivery and authorization integration fixture.',
      instructions: 'Follow the test request exactly.',
      provider: 'Mock Run Files',
      model: 'mock-run-files',
      ...fields,
    },
  });
  agents.push(agent);
  return agent;
}

async function selectAgent(page: Page, agent: AgentDetail): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: agent.name, exact: true }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(agent.name ?? '');
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

async function upload(
  page: Page,
  files: TFile[],
  name: string,
  mimeType: string,
  content: string,
): Promise<TFile> {
  const response = await uploadViaUnifiedButton(page, { name, mimeType, content });
  expect(response.ok()).toBeTruthy();
  const file = (await response.json()) as TFile;
  expect(file.file_id).toBeTruthy();
  files.push(file);
  return file;
}

async function cleanup(page: Page, agents: AgentDetail[], files: TFile[]): Promise<void> {
  if (files.length > 0) {
    await requestJson(page, {
      path: '/api/files',
      token: await getAccessToken(page),
      method: 'DELETE',
      body: { files },
    });
  }
  for (const agent of [...agents].reverse()) await cleanupAgent(page, agent.id);
}

function toolCalls(messages: TMessage[]): PersistedToolCall[] {
  const calls: PersistedToolCall[] = [];
  const visit = (content: NonNullable<TMessage['content']>): void => {
    for (const part of content) {
      if (part?.type === ContentTypes.TOOL_CALL && 'tool_call' in part) {
        const call = part.tool_call as PersistedToolCall;
        calls.push(call);
        if (Array.isArray(call.subagent_content)) visit(call.subagent_content);
      }
    }
  };
  for (const message of messages) visit(message.content ?? []);
  return calls;
}

function output(messages: TMessage[], label: string, phase: string): string {
  const id = `call_e2e_run_file_delivery_${label}_${phase}`;
  const result = toolCalls(messages).find((call) => call.id === id)?.output;
  expect(result, `Expected persisted output for ${phase}`).toBeDefined();
  return result ?? '';
}

function catalog(messages: TMessage[], label: string, phase: string): Catalog {
  return JSON.parse(output(messages, label, phase)) as Catalog;
}

async function loadMessages(page: Page, conversationId: string): Promise<TMessage[]> {
  return fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId)}`,
    await getAccessToken(page),
  );
}

test.describe('run-file delivery and authorization', () => {
  test('delivers native PDF bytes and extracted text to the child without eager tool provisioning', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueName('delivery');
    const files: TFile[] = [];
    const agents: AgentDetail[] = [];
    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const child = await createAgent(page, token, agents, {
        tools: ['execute_code', 'file_search'],
      });
      const parent = await createAgent(page, token, agents, {
        subagents: { enabled: true, allowSelf: false, shareFiles: true, agent_ids: [child.id] },
      });
      await selectAgent(page, parent);
      await resetProvisioning(page);
      const pdfBytes = inputPdf(`E2E PDF canary ${randomUUID()}`);
      const textBytes = `E2E extracted text canary ${randomUUID()}`;
      const pdf = await upload(
        page,
        files,
        `e2e-delivery-${label}.pdf`,
        'application/pdf',
        pdfBytes,
      );
      const text = await upload(page, files, `e2e-delivery-${label}.txt`, 'text/plain', textBytes);
      expect(pdf.llmDeliveryPath).toBe('provider');
      expect(text.llmDeliveryPath).toBe('text');
      const pdfHash = sha256(pdfBytes);
      const textHash = sha256(textBytes);
      const admission = await sendMessageAndWaitForCompletion(
        page,
        `E2E_RUN_FILE_DELIVERY:${child.id}:${label}:${pdf.file_id}:${text.file_id}:${pdfHash}:${textHash}`,
        { timeout: 60_000 },
      );
      const { conversationId } = (await admission.json()) as { conversationId: string };
      const complete = `E2E run file delivery verified ${label} pdf=${pdfHash} text=${textHash}`;
      await expect(messagesView(page)).toContainText(complete);
      const messages = await loadMessages(page, conversationId);
      expect(output(messages, label, 'delivery_child')).toContain(complete);
      expect(
        catalog(messages, label, 'delivery_catalog')
          .files.map((file) => file.file_id)
          .sort(),
      ).toEqual([pdf.file_id, text.file_id].sort());
      expect(
        toolCalls(messages)
          .map((call) => call.name)
          .sort(),
      ).toEqual(['list_run_files', 'subagent']);
      expect(await getCodeProvisionedUploads(page)).toEqual([]);
      expect(await getRagEmbedded(page)).toEqual([]);
      await page.reload();
      await expect(messagesView(page)).toContainText(complete);
    } finally {
      await cleanup(page, agents, files);
    }
  });

  test('authorizes a nested child for current files and rejects an agent outside the roster', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = uniqueName('nested');
    const files: TFile[] = [];
    const agents: AgentDetail[] = [];
    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const leaf = await createAgent(page, token, agents);
      const outsider = await createAgent(page, token, agents);
      const middle = await createAgent(page, token, agents, {
        subagents: { enabled: true, allowSelf: false, shareFiles: true, agent_ids: [leaf.id] },
      });
      const parent = await createAgent(page, token, agents, {
        subagents: { enabled: true, allowSelf: false, shareFiles: true, agent_ids: [middle.id] },
      });
      await selectAgent(page, parent);
      const previous = await upload(
        page,
        files,
        `e2e-previous-${label}.csv`,
        'text/csv',
        'scope,value\nprevious,secret\n',
      );
      await sendMessageAndWaitForCompletion(page, `E2E_REPLY:previous-${label}`);
      const current = await upload(
        page,
        files,
        `e2e-current-${label}.csv`,
        'text/csv',
        'scope,value\ncurrent,authorized\n',
      );
      const admission = await sendMessageAndWaitForCompletion(
        page,
        `E2E_RUN_FILE_NESTED:${middle.id}:${leaf.id}:${outsider.id}:${label}:${current.file_id}`,
        { timeout: 90_000 },
      );
      const { conversationId } = (await admission.json()) as { conversationId: string };
      await expect(messagesView(page)).toContainText(
        `E2E nested sharing complete ${label} file=${current.file_id}`,
      );
      const messages = await loadMessages(page, conversationId);
      const leafResult = output(messages, label, 'leaf_child');
      expect(leafResult).toContain(`E2E nested leaf verified ${label} file=${current.file_id}`);
      const encodedEvidence = leafResult.match(/E2E_LEAF_CATALOG:(.+)/)?.[1];
      expect(encodedEvidence, 'Leaf must return its actual catalog tool result').toBeDefined();
      if (!encodedEvidence) throw new Error('Nested catalog evidence missing');
      const leafEvidence = JSON.parse(encodedEvidence) as { toolCallId: string; catalog: Catalog };
      expect(leafEvidence.toolCallId).toBe(`call_e2e_run_file_delivery_${label}_leaf_catalog`);
      for (const observed of [catalog(messages, label, 'middle_catalog'), leafEvidence.catalog]) {
        const ids = observed.files.map((file) => file.file_id);
        expect(ids).toEqual([current.file_id]);
        expect(ids).not.toContain(previous.file_id);
      }
      const rejected = toolCalls(messages).find(
        (call) => call.id === `call_e2e_run_file_delivery_${label}_outsider_child`,
      );
      expect(output(messages, label, 'outsider_child')).toContain(
        'Received tool input did not match expected schema',
      );
      expect(JSON.parse(String(rejected?.args))).toMatchObject({ subagent_type: outsider.id });
      expect(rejected?.subagent_content).toBeUndefined();
      const delegated = toolCalls(messages).find(
        (call) => call.id === `call_e2e_run_file_delivery_${label}_leaf_child`,
      );
      expect(JSON.parse(String(delegated?.args))).toMatchObject({ subagent_type: leaf.id });
    } finally {
      await cleanup(page, agents, files);
    }
  });

  test('grants a published file only to its named sibling and allows that sibling to search it', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = uniqueName('recipients');
    const files: TFile[] = [];
    const agents: AgentDetail[] = [];
    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const producer = await createAgent(page, token, agents, { tools: ['execute_code'] });
      const reader = await createAgent(page, token, agents, { tools: ['file_search'] });
      const observer = await createAgent(page, token, agents);
      const outsider = await createAgent(page, token, agents);
      const parent = await createAgent(page, token, agents, {
        subagents: {
          enabled: true,
          allowSelf: false,
          shareFiles: true,
          agent_ids: [producer.id, reader.id, observer.id],
        },
      });
      await selectAgent(page, parent);
      await resetProvisioning(page);
      const input = await upload(
        page,
        files,
        `e2e-recipient-input-${label}.csv`,
        'text/csv',
        'source,count\npdf,1\n',
      );
      const admission = await sendMessageAndWaitForCompletion(
        page,
        `E2E_RUN_FILE_RECIPIENTS:${producer.id}:${reader.id}:${observer.id}:${outsider.id}:${label}:${input.file_id}`,
        { timeout: 120_000 },
      );
      const { conversationId } = (await admission.json()) as { conversationId: string };
      const durableFiles = await fetchJson<TFile[]>(page, '/api/files', token);
      const published = durableFiles.filter(
        (file) =>
          file.conversationId === conversationId && file.context === FileContext.run_artifact,
      );
      files.push(...published);
      expect(published).toHaveLength(1);
      const file = published[0];
      expect(file.metadata?.runFile).toMatchObject({
        agentId: producer.id,
        parentAgentId: parent.id,
        recipientAgentIds: [reader.id],
        inputFileIds: [input.file_id],
      });
      await expect(messagesView(page)).toContainText(
        `E2E recipient sharing complete ${label} file=${file.file_id}`,
      );
      const messages = await loadMessages(page, conversationId);
      expect(output(messages, label, 'publish_outsider')).toContain(
        'sharing policy does not authorize',
      );
      const beforeRejection = catalog(messages, label, 'producer_private').artifacts;
      expect(catalog(messages, label, 'producer_retry').artifacts).toEqual(beforeRejection);
      expect(beforeRejection).toHaveLength(1);
      expect(catalog(messages, label, 'observer_catalog')).toMatchObject({
        files: [{ file_id: input.file_id }],
        artifacts: [],
      });
      expect(
        catalog(messages, label, 'reader_catalog')
          .files.map((entry) => entry.file_id)
          .sort(),
      ).toEqual([input.file_id, file.file_id].sort());
      expect(output(messages, label, 'reader_search')).toContain('No content found in the files.');
      expect((await getRagEmbedded(page)).map((entry) => entry.file_id)).toContain(file.file_id);
      const queryResponse = await page.request.get(`${RAG_API_BASE}/__debug/embedded`);
      expect(queryResponse.ok()).toBeTruthy();
      const { queries } = (await queryResponse.json()) as {
        queries: Array<{ file_id: string; query: string }>;
      };
      expect(queries).toContainEqual({ file_id: file.file_id, query: file.filename });
      expect(
        messages.some((message) =>
          message.attachments?.some((attachment) =>
            'file_id' in attachment ? attachment.file_id === file.file_id : false,
          ),
        ),
      ).toBe(true);
    } finally {
      await cleanup(page, agents, files);
    }
  });
});
