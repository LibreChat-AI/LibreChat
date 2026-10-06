import path from 'path';
import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'crypto';
import type { TFile, TMessage, TextDerivation } from 'librechat-data-provider';
import type { Page, Response } from '@playwright/test';
import type {
  AttachFile,
  MockEndpoint,
  ModelRunRecord,
  RagQueryRecord,
  RagEmbedRecord,
  ModelRequestRecord,
} from './helpers';
import type { UploadFixture } from '../../setup/uploads';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getModelRun,
  uniqueName,
  replyPrompt,
  sendMessage,
  getCodeExecs,
  requestJson,
  messagesView,
  uploadViaDrop,
  getRagQueries,
  getAccessToken,
  getRagEmbedded,
  uploadViaPaste,
  enableFileSearch,
  attachFileBuffer,
  resetProvisioning,
  supportsFilePaste,
  selectMockEndpoint,
  enableCodeInterpreter,
  uploadViaUnifiedButton,
  getCodeProvisionedUploads,
  sendMessageAndWaitForCompletion,
} from './helpers';
import {
  Q1_ROWS,
  Q2_ROWS,
  UPLOAD_FIXTURES,
  WORKBOOK_TOTALS,
  WORKBOOK_SENTINEL,
} from '../../setup/uploads';
import { cleanupAgent, uniqueAgentName } from './agents.helpers';
import { withMongo } from './db';

/**
 * The automatic reading policy end to end.
 *
 * Mock Auto Provider and Mock Auto Small Provider (e2e/config/librechat.e2e.yaml) select
 * `llmDeliveryPolicy: automatic` with no route overrides; Auto Small adds a 1 MB per-file limit.
 * The fixtures come from e2e/setup/uploads.ts, written by the global setup; the totals asserted
 * here are known constants checked against the rows the workbook was built from. Rows draw on up
 * to three observers:
 *
 * - the file record: `/api/files` for the route and marker, MongoDB for the stored text the API
 *   leaves out, and the user message's files for the delivery path the turn used;
 * - the fake model's request log (`e2e/.generated/last-request.json`): the system instructions
 *   with the file inventory, the message text, and the document parts the model was sent;
 * - the fake code and RAG servers: the bytes Run Code received (by sha256) and the files each exec
 *   mounted, and the File Search embeds and queries in the order they arrived.
 *
 * `E2E_ANALYZE_WORKBOOK` and `E2E_ANALYZE_CSV` make the fake model run code on the file the
 * instructions advertise to Run Code. The fake code server answers only from an upload the exec
 * itself mounted, and records which one, so a total on screen means code read the attached bytes.
 *
 * Mock Provider C keeps the classic policy with no file configuration; A-29 shows classic still
 * extracts a workbook at upload and writes none of the automatic policy's state.
 */

const [, , AUTO_ENDPOINT, AUTO_SMALL_ENDPOINT] = MOCK_ENDPOINTS;
const CLASSIC_ENDPOINT: MockEndpoint = { label: 'Mock Provider C', model: 'mock-model-c' };
const TEST_TIMEOUT = 120_000;
const MULTI_TURN_TIMEOUT = 180_000;
const TURN_TIMEOUT = 60_000;
const WORKBOOK_RESULT = JSON.stringify({ sheets: ['Q1', 'Q2', 'Notes'], totals: WORKBOOK_TOTALS });
const CSV_RESULT = JSON.stringify({ rows: Q1_ROWS.length, total: WORKBOOK_TOTALS.Q1 });
/** The error a turn ends with when File Search could not index its attachments. */
const PREPARATION_FAILED_ERROR = /File Search couldn't prepare the attached files/;
/** The heading of the model's file inventory, which only the automatic policy writes. */
const INVENTORY_HEADING = 'how you can read them on this turn';

type StoredText = { file_id: string; text?: string | null };
type AgentRecord = { id: string };
type ReadingRecord = Pick<TFile, 'llmDeliveryPath'> &
  Partial<Pick<TextDerivation, 'outcome' | 'extractor' | 'reason'>>;
type MessageFileReading = Pick<TFile, 'llmDeliveryPath'>;

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

/** The fixture's bytes and type under a name no earlier upload has used. */
const renamed = (fixture: UploadFixture, prefix: string): AttachFile => ({
  name: `${uniqueName(prefix)}${path.extname(fixture.name)}`,
  mimeType: fixture.mimeType,
  path: fixture.path,
});

const composerChip = (page: Page, filename: string) =>
  page.getByTestId('composer-tray').getByRole('button', { name: filename });

async function startChat(page: Page, endpoint: MockEndpoint) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, endpoint);
  await expect(page.getByRole('button', { name: 'Attach and tools', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await resetProvisioning(page);
}

/** Waits for an upload to land in the composer and returns the record it created. */
async function confirmUpload(page: Page, upload: Promise<Response>): Promise<TFile> {
  const response = await upload;
  expect(response.ok(), `upload returned ${response.status()}`).toBeTruthy();
  const uploaded = (await response.json()) as TFile;
  await expect(composerChip(page, uploaded.filename)).toBeVisible({ timeout: 15_000 });
  return uploaded;
}

async function getFileRecord(page: Page, fileId: string): Promise<TFile> {
  const token = await getAccessToken(page);
  const files = await fetchJson<TFile[]>(page, '/api/files', token);
  const record = files.find((file) => file.file_id === fileId);
  if (!record) {
    throw new Error(`/api/files does not list ${fileId}`);
  }
  return record;
}

/** The stored extracted text, which the file API never returns. */
function getStoredText(fileId: string): Promise<string | undefined> {
  return withMongo(async (db) => {
    const file = await db
      .collection<StoredText>('files')
      .findOne({ file_id: fileId }, { projection: { text: 1 } });
    return file?.text ?? undefined;
  });
}

/** What decides how a record is read, without the derivation timestamp. */
const readingRecord = ({ llmDeliveryPath, metadata }: TFile): ReadingRecord => ({
  llmDeliveryPath,
  outcome: metadata?.textDerivation?.outcome,
  extractor: metadata?.textDerivation?.extractor,
  reason: metadata?.textDerivation?.reason,
});

/** Kept for Run Code at upload: no model route, no extracted text, a deferred marker. */
async function expectDeferredRecord(page: Page, fileId: string) {
  expect(readingRecord(await getFileRecord(page, fileId))).toMatchObject({
    llmDeliveryPath: 'none',
    outcome: 'deferred',
  });
  expect(await getStoredText(fileId), 'a deferred upload stores no extracted text').toBeFalsy();
}

function conversationIdFromPage(page: Page): string {
  const conversationId = new URL(page.url()).pathname.split('/c/')[1] ?? '';
  expect(conversationId).toMatch(/^[0-9a-f-]{36}$/i);
  return conversationId;
}

/** The files the latest user message persisted, with the delivery path its turn gave each. */
async function getLatestUserMessageFiles(page: Page): Promise<Partial<TFile>[]> {
  const token = await getAccessToken(page);
  const conversationId = encodeURIComponent(conversationIdFromPage(page));
  const messages = await fetchJson<TMessage[]>(page, `/api/messages/${conversationId}`, token);
  return messages.filter((message) => message.isCreatedByUser).pop()?.files ?? [];
}

function messageFileReading(files: Partial<TFile>[], fileId: string): MessageFileReading {
  const file = files.find((entry) => entry.file_id === fileId);
  expect(file, `the user message should carry ${fileId}`).toBeTruthy();
  return { llmDeliveryPath: file?.llmDeliveryPath };
}

/** Sends a turn, waits for the stored answer, and returns what the model was sent for it. */
async function sendTurn(page: Page, prompt: string, minInvocations = 1): Promise<ModelRunRecord> {
  await sendMessageAndWaitForCompletion(page, prompt, { timeout: TURN_TIMEOUT });
  return getModelRun(prompt, { minInvocations });
}

/** A turn where the model calls Run Code and then answers, so two model requests. */
const sendAnalysisTurn = (page: Page, prompt: string): Promise<ModelRunRecord> =>
  sendTurn(page, prompt, 2);

/** The turn's first model request: what the model had before any tool ran. */
const initialRequest = (run: ModelRunRecord): ModelRequestRecord => run.invocations[0];

/** The inventory line naming `filename`; the queued-path note never quotes a name. */
const inventoryLine = (request: ModelRequestRecord, filename: string): string =>
  request.systemText.split('\n').find((line) => line.includes(JSON.stringify(filename))) ?? '';

/**
 * No request of the turn carried the workbook: not as a file part, and no cell as text (the
 * sentinel or an amount). Inline file data never reaches `promptText`, so the parts are checked
 * by name.
 */
function expectNoWorkbookCells(run: ModelRunRecord, filename: string) {
  expect(run.invocations.flatMap(({ documentFiles }) => documentFiles)).not.toContain(filename);
  const sent = run.invocations.map(({ promptText }) => promptText).join('\n');
  expect(sent).not.toContain(WORKBOOK_SENTINEL);
  [...Q1_ROWS, ...Q2_ROWS].forEach(([, amount]) => expect(sent).not.toContain(String(amount)));
}

/**
 * Run Code received exactly this upload's bytes under its name, and an exec mounted that upload;
 * with `analyzed`, the exec's analysis token read it. Renamed copies of a fixture share its
 * bytes, so the name ties the receipt to this test's upload.
 */
async function expectCodeReceived(
  page: Page,
  file: AttachFile,
  { analyzed = false }: { analyzed?: boolean } = {},
) {
  const expected = sha256(attachFileBuffer(file));
  let fileId: string | undefined;
  await expect
    .poll(
      async () => {
        const uploads = await getCodeProvisionedUploads(page);
        fileId = uploads.find(
          (upload) => upload.filename === file.name && upload.sha256 === expected,
        )?.fileId;
        return fileId != null;
      },
      { timeout: 30_000, message: `Run Code should receive the bytes of ${file.name}` },
    )
    .toBe(true);
  const execs = await getCodeExecs(page);
  const mounted = execs.filter((exec) => exec.files.some(({ id }) => id === fileId));
  expect(mounted.length, `an exec should mount ${file.name}`).toBeGreaterThan(0);
  if (analyzed) {
    expect(mounted.map((exec) => exec.analyzedFileId)).toContain(fileId);
  }
}

/** The inventory line a deferred workbook gets while Run Code can still open it. */
const expectQueuedForCode = (request: ModelRequestRecord, filename: string) =>
  expect(inventoryLine(request, filename)).toContain(
    `read it with Run Code at /mnt/data/${filename}`,
  );

const latestSeq = (records: ReadonlyArray<RagEmbedRecord | RagQueryRecord>): number =>
  records.reduce((latest, { seq }) => Math.max(latest, seq), 0);

/** The assistant's visible answer carries the code server's result. */
async function expectAnswer(page: Page, expected: string) {
  await expect(
    messagesView(page).getByText(expected).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 20_000 });
}

async function createAutoAgent(page: Page, name: string, tools: string[]): Promise<string> {
  const token = await getAccessToken(page);
  const agent = await requestJson<AgentRecord>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      provider: AUTO_ENDPOINT.label,
      model: AUTO_ENDPOINT.model,
      model_parameters: {},
      tools,
    },
  });
  return agent.id;
}

async function setAgentTools(page: Page, agentId: string, tools: string[]) {
  const token = await getAccessToken(page);
  await requestJson<AgentRecord>(page, {
    path: `/api/agents/${encodeURIComponent(agentId)}`,
    token,
    method: 'PATCH',
    body: { tools },
  });
}

async function startAgentChat(page: Page, agentName: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  const trigger = page.getByRole('button', { name: 'Select a model' }).first();
  await trigger.click();
  await page.getByRole('option', { name: 'My Agents' }).click();
  await page.getByRole('option', { name: agentName }).click();
  await expect(trigger).toContainText(agentName);
  await resetProvisioning(page);
}

/** Reloads the open conversation, so the next turn starts from restored state. */
async function reloadConversation(page: Page) {
  await page.reload({ timeout: 20_000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 20_000,
  });
}

/** Posts an upload straight to the server, past the client's own size check. */
async function postUpload(
  page: Page,
  endpoint: MockEndpoint,
  file: AttachFile,
  toolResource?: 'execute_code' | 'file_search',
) {
  const token = await getAccessToken(page);
  return page.request.post('/api/files', {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      endpoint: endpoint.label,
      endpointType: 'custom',
      file_id: randomUUID(),
      message_file: 'true',
      ...(toolResource != null && { tool_resource: toolResource }),
      file: { name: file.name, mimeType: file.mimeType, buffer: attachFileBuffer(file) },
    },
  });
}

/** The stored original's bytes, as the download route serves them. */
async function downloadOriginal(page: Page, record: TFile): Promise<Buffer> {
  const token = await getAccessToken(page);
  const response = await page.request.get(
    `/api/files/download/${encodeURIComponent(record.user)}/${encodeURIComponent(record.file_id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.ok(), `download returned ${response.status()}`).toBeTruthy();
  return response.body();
}

/** Attaches an earlier upload from the palette's file list, which re-stages the stored record. */
async function attachExisting(page: Page, file: TFile) {
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  await page.getByTestId('composer-palette-search').fill(file.filename);
  await page.locator(`[data-row-key="file:${file.file_id}"]`).getByRole('button').first().click();
  await expect(composerChip(page, file.filename)).toBeVisible({ timeout: 15_000 });
}

async function expectWorkbookTextPreview(page: Page, file: TFile) {
  /* The latest message carrying the workbook; earlier turns in the conversation attached it too. */
  await messagesView(page).getByRole('button', { name: file.filename, exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(WORKBOOK_SENTINEL);
  await expect(dialog).not.toContainText('[Content_Types].xml');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
}

/** Fail one original's external indexing until the retry explicitly restores the service. */
async function setEmbeddingFailure(page: Page, fileId: string, enabled: boolean) {
  const port = process.env.E2E_RAG_API_PORT || '8791';
  const response = await page.request.post(`http://127.0.0.1:${port}/__debug/embedding-failure`, {
    data: { file_id: fileId, enabled },
  });
  expect(response.ok()).toBe(true);
}

test.describe('automatic upload reading', () => {
  test.describe.configure({ timeout: TEST_TIMEOUT });

  const CODE_FORMATS = [
    { fixture: UPLOAD_FIXTURES.xlsx, prompt: 'E2E_ANALYZE_WORKBOOK', result: WORKBOOK_RESULT },
    { fixture: UPLOAD_FIXTURES.csv, prompt: 'E2E_ANALYZE_CSV', result: CSV_RESULT },
  ];

  for (const { fixture, prompt, result } of CODE_FORMATS) {
    test(`A-01/A-02: ${fixture.name} is kept for Run Code, parsed there, and never sent as cells`, async ({
      page,
    }) => {
      await startChat(page, AUTO_ENDPOINT);
      await enableCodeInterpreter(page);

      const file = renamed(fixture, 'a02-quarterly');
      const uploaded = await confirmUpload(page, uploadViaUnifiedButton(page, file));
      await expectDeferredRecord(page, uploaded.file_id);

      const run = await sendAnalysisTurn(page, `${prompt} ${uniqueName('a02')}`);
      expectQueuedForCode(initialRequest(run), file.name);
      expectNoWorkbookCells(run, file.name);
      await expectCodeReceived(page, file, { analyzed: true });
      await expectAnswer(page, result);
    });
  }

  test('A-15: a workbook goes to Run Code and a small PDF to the provider in one message', async ({
    page,
  }) => {
    await startChat(page, AUTO_ENDPOINT);
    await enableCodeInterpreter(page);

    const workbook = renamed(UPLOAD_FIXTURES.xlsx, 'a15-quarterly');
    const pdf = renamed(UPLOAD_FIXTURES.smallPdf, 'a15-small');
    await confirmUpload(page, uploadViaUnifiedButton(page, workbook));
    await confirmUpload(page, uploadViaUnifiedButton(page, pdf));

    const run = await sendAnalysisTurn(page, `E2E_ANALYZE_WORKBOOK ${uniqueName('a15')}`);
    const request = initialRequest(run);
    expect(request.documentFiles).toContain(pdf.name);
    expect(inventoryLine(request, pdf.name)).toContain('Run Code can also open it');
    expectQueuedForCode(request, workbook.name);
    expectNoWorkbookCells(run, workbook.name);
    await expectCodeReceived(page, workbook, { analyzed: true });
    await expectCodeReceived(page, pdf);
    await expectAnswer(page, WORKBOOK_RESULT);
  });

  test('A-16: enabling Run Code later reads an extracted workbook with code, across reloads', async ({
    page,
  }) => {
    test.setTimeout(MULTI_TURN_TIMEOUT);
    const agentName = uniqueAgentName('E2E Auto Later Code');
    let agentId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
      agentId = await createAutoAgent(page, agentName, []);
      await startAgentChat(page, agentName);

      /* Without Run Code at upload, the workbook is extracted as it is under classic. */
      const workbook = renamed(UPLOAD_FIXTURES.xlsx, 'a16-quarterly');
      const uploaded = await confirmUpload(page, uploadViaUnifiedButton(page, workbook));
      const record = await getFileRecord(page, uploaded.file_id);
      expect(record.llmDeliveryPath).toBe('text');
      expect(record.metadata?.textDerivation).toBeUndefined();
      expect(await getStoredText(uploaded.file_id)).toContain(WORKBOOK_SENTINEL);

      const firstTurn = await sendTurn(page, replyPrompt(uniqueName('a16-turn1')));
      expect(initialRequest(firstTurn).promptText).toContain(WORKBOOK_SENTINEL);

      await setAgentTools(page, agentId, ['execute_code']);
      await reloadConversation(page);
      await resetProvisioning(page);
      const secondTurn = await sendAnalysisTurn(
        page,
        `E2E_ANALYZE_WORKBOOK ${uniqueName('a16-turn2')}`,
      );
      expectNoWorkbookCells(secondTurn, workbook.name);
      await expectCodeReceived(page, workbook, { analyzed: true });
      await expectAnswer(page, WORKBOOK_RESULT);

      await reloadConversation(page);
      const thirdTurn = await sendTurn(page, replyPrompt(uniqueName('a16-turn3')));
      expect(initialRequest(thirdTurn).promptText).not.toContain(WORKBOOK_SENTINEL);
      expect(readingRecord(await getFileRecord(page, uploaded.file_id))).toEqual(
        readingRecord(record),
      );
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('A-17: disabling Run Code derives the workbook text once for later turns, across reloads', async ({
    page,
  }) => {
    test.setTimeout(MULTI_TURN_TIMEOUT);
    const agentName = uniqueAgentName('E2E Auto Drop Code');
    let agentId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
      agentId = await createAutoAgent(page, agentName, ['execute_code']);
      await startAgentChat(page, agentName);

      const workbook = renamed(UPLOAD_FIXTURES.xlsx, 'a17-quarterly');
      const uploaded = await confirmUpload(page, uploadViaUnifiedButton(page, workbook));
      await expectDeferredRecord(page, uploaded.file_id);

      const firstTurn = await sendAnalysisTurn(
        page,
        `E2E_ANALYZE_WORKBOOK ${uniqueName('a17-turn1')}`,
      );
      expectNoWorkbookCells(firstTurn, workbook.name);
      await expectCodeReceived(page, workbook, { analyzed: true });
      await expectAnswer(page, WORKBOOK_RESULT);

      await setAgentTools(page, agentId, []);
      await reloadConversation(page);
      const secondTurn = await sendTurn(page, replyPrompt(uniqueName('a17-turn2')));
      const secondRequest = initialRequest(secondTurn);
      expect(secondRequest.promptText).toContain(WORKBOOK_SENTINEL);
      /* Run Code is gone, so nothing may still say the workbook can be opened there. */
      expect(secondRequest.systemText).not.toContain(`/mnt/data/${workbook.name}`);
      expect(inventoryLine(secondRequest, workbook.name)).not.toContain('Run Code can');
      await expect
        .poll(async () => readingRecord(await getFileRecord(page, uploaded.file_id)).outcome, {
          timeout: 15_000,
          message: 'the derived text should be saved onto the deferred record',
        })
        .toBe('complete');
      const derivation = (await getFileRecord(page, uploaded.file_id)).metadata?.textDerivation;
      expect(derivation?.at, 'the derivation should be stamped when it was saved').toEqual(
        expect.any(Number),
      );
      expect(await getStoredText(uploaded.file_id)).toContain(WORKBOOK_SENTINEL);

      /* Derived once: a later turn reads the saved text and leaves the derivation, stamp and
       * all, as it was. */
      await reloadConversation(page);
      await attachExisting(page, uploaded);
      const thirdTurn = await sendTurn(page, replyPrompt(uniqueName('a17-turn3')));
      expect(initialRequest(thirdTurn).promptText).toContain(WORKBOOK_SENTINEL);
      expect((await getFileRecord(page, uploaded.file_id)).metadata?.textDerivation).toEqual(
        derivation,
      );
      expect(messageFileReading(await getLatestUserMessageFiles(page), uploaded.file_id)).toEqual({
        llmDeliveryPath: 'text',
      });
      await expectWorkbookTextPreview(page, uploaded);
      expect(await downloadOriginal(page, uploaded)).toEqual(attachFileBuffer(workbook));
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('A-06/A-13: a PDF over the small endpoint limit is searched there, and refused as a new upload', async ({
    page,
  }) => {
    test.setTimeout(MULTI_TURN_TIMEOUT);
    await startChat(page, AUTO_ENDPOINT);
    await sendTurn(page, replyPrompt(uniqueName('a06-open')));

    /* Uploaded where it fits natively; the conversation keeps it across the model switch. */
    const pdf = renamed(UPLOAD_FIXTURES.largePdf, 'a06-large');
    const uploaded = await confirmUpload(page, uploadViaUnifiedButton(page, pdf));
    expect(uploaded.llmDeliveryPath).toBe('provider');

    await selectMockEndpoint(page, AUTO_SMALL_ENDPOINT);
    await expect(composerChip(page, pdf.name)).toBeVisible();
    await enableFileSearch(page);

    /* Read as late as possible before the turn, so an index built at upload has had time to
     * land: nothing may hold the PDF yet, and everything after this mark happened in the turn. */
    const beforeTurn = await getRagEmbedded(page);
    expect(beforeTurn.map((entry) => entry.file_id)).not.toContain(uploaded.file_id);
    const mark = Math.max(latestSeq(beforeTurn), latestSeq(await getRagQueries(page)));

    const run = await sendTurn(page, `E2E_FILE_SEARCH:${uniqueName('a06')}`);
    const request = initialRequest(run);
    expect(request.documentFiles).not.toContain(pdf.name);
    const line = inventoryLine(request, pdf.name);
    expect(line).toContain('too large to send directly');
    expect(line).toContain('file_search');
    expect(line).toContain('it is indexed when you first search');

    /* Embedded once, during the turn, and before any search of it. */
    let embeds: RagEmbedRecord[] = [];
    await expect
      .poll(
        async () => {
          embeds = (await getRagEmbedded(page)).filter(
            (entry) => entry.file_id === uploaded.file_id,
          );
          return embeds.length;
        },
        { timeout: 30_000, message: 'the PDF should be indexed for File Search during the turn' },
      )
      .toBe(1);
    let searches: RagQueryRecord[] = [];
    await expect
      .poll(async () => {
        searches = (await getRagQueries(page)).filter(
          (query) => query.file_id === uploaded.file_id,
        );
        return searches.length;
      })
      .toBeGreaterThan(0);
    const [embed] = embeds;
    expect(embed.seq).toBeGreaterThan(mark);
    expect(embed.seq).toBeLessThan(Math.min(...searches.map(({ seq }) => seq)));

    /* A fresh conversation receives this indexed original through message resources.files,
     * not an agent's configured file_ids. It must remain searchable without another embed. */
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, AUTO_ENDPOINT);
    await sendTurn(page, replyPrompt(uniqueName('a06-reuse-open')));
    await attachExisting(page, uploaded);
    await selectMockEndpoint(page, AUTO_SMALL_ENDPOINT);
    if (
      !(await page.getByRole('button', { name: 'Remove File Search', exact: true }).isVisible())
    ) {
      await enableFileSearch(page);
    }
    const reuseMark = latestSeq(await getRagQueries(page));
    const reusedRun = await sendTurn(page, `E2E_FILE_SEARCH:${uniqueName('a06-reuse')}`);
    expect(initialRequest(reusedRun).documentFiles).not.toContain(pdf.name);
    expect(inventoryLine(initialRequest(reusedRun), pdf.name)).toContain('file_search');
    expect(messageFileReading(await getLatestUserMessageFiles(page), uploaded.file_id)).toEqual({
      llmDeliveryPath: 'none',
    });
    expect(
      (await getRagEmbedded(page)).filter((entry) => entry.file_id === uploaded.file_id),
    ).toHaveLength(1);
    expect(
      (await getRagQueries(page)).some(
        (query) => query.file_id === uploaded.file_id && query.seq > reuseMark,
      ),
    ).toBe(true);
    await reloadConversation(page);
    expect(messageFileReading(await getLatestUserMessageFiles(page), uploaded.file_id)).toEqual({
      llmDeliveryPath: 'none',
    });

    /* Refused as before this policy existed, on every route: the size check throws inside the
     * upload handler, which answers with its generic error, and no tool receives the bytes. The
     * small PDF on the same route shows size decides. */
    const direct = renamed(UPLOAD_FIXTURES.largePdf, 'a13-large');
    const largeSha = sha256(attachFileBuffer(direct));
    for (const toolResource of [undefined, 'execute_code', 'file_search'] as const) {
      const rejected = await postUpload(page, AUTO_SMALL_ENDPOINT, direct, toolResource);
      const route = toolResource ?? 'message file';
      expect(rejected.status(), `${route} upload status`).toBe(500);
      expect(await rejected.json(), `${route} upload body`).toEqual({
        message: 'Error processing file',
      });
    }
    expect((await getCodeProvisionedUploads(page)).map((upload) => upload.sha256)).not.toContain(
      largeSha,
    );
    expect((await getRagEmbedded(page)).map((entry) => entry.filename)).not.toContain(direct.name);
    const control = await postUpload(
      page,
      AUTO_SMALL_ENDPOINT,
      renamed(UPLOAD_FIXTURES.smallPdf, 'a13-small'),
    );
    expect(control.ok(), await control.text()).toBe(true);
    const token = await getAccessToken(page);
    const files = await fetchJson<TFile[]>(page, '/api/files', token);
    expect(files.map((file) => file.filename)).not.toContain(direct.name);
  });

  test('failed indexing fails the turn with a retryable error, and retry reuses the original', async ({
    page,
  }) => {
    test.setTimeout(MULTI_TURN_TIMEOUT);
    await startChat(page, AUTO_ENDPOINT);
    await sendTurn(page, replyPrompt(uniqueName('search-failure-open')));
    const pdf = renamed(UPLOAD_FIXTURES.largePdf, 'search-retry');
    const uploaded = await confirmUpload(page, uploadViaUnifiedButton(page, pdf));
    await selectMockEndpoint(page, AUTO_SMALL_ENDPOINT);
    await enableFileSearch(page);
    await setEmbeddingFailure(page, uploaded.file_id, true);
    try {
      const response = await sendMessage(page, `E2E_FILE_SEARCH:${uniqueName('search-failure')}`);
      expect(response.ok()).toBe(true);
      /* The turn ends with the retryable preparation error rather than a search over an index
       * that was never built, and the message keeps its attachment. */
      await expect(messagesView(page).getByText(PREPARATION_FAILED_ERROR)).toBeVisible({
        timeout: TURN_TIMEOUT,
      });
      expect(messageFileReading(await getLatestUserMessageFiles(page), uploaded.file_id)).toEqual({
        llmDeliveryPath: 'none',
      });
      expect(
        (await getRagQueries(page)).filter((query) => query.file_id === uploaded.file_id),
      ).toHaveLength(0);
      const port = process.env.E2E_RAG_API_PORT || '8791';
      const debugResponse = await page.request.get(`http://127.0.0.1:${port}/__debug/embedded`);
      const debug = (await debugResponse.json()) as { failedEmbeds: { file_id: string }[] };
      expect(debug.failedEmbeds.some((entry) => entry.file_id === uploaded.file_id)).toBe(true);
      await reloadConversation(page);
      await expect(messagesView(page).getByText(PREPARATION_FAILED_ERROR)).toBeVisible();

      await setEmbeddingFailure(page, uploaded.file_id, false);
      await selectMockEndpoint(page, AUTO_ENDPOINT);
      await attachExisting(page, uploaded);
      await selectMockEndpoint(page, AUTO_SMALL_ENDPOINT);
      const recovered = await sendTurn(page, `E2E_FILE_SEARCH:${uniqueName('search-recovery')}`);
      expect(inventoryLine(initialRequest(recovered), pdf.name)).toContain('file_search');
      expect(messageFileReading(await getLatestUserMessageFiles(page), uploaded.file_id)).toEqual({
        llmDeliveryPath: 'none',
      });
      const embeds = (await getRagEmbedded(page)).filter(
        (entry) => entry.file_id === uploaded.file_id,
      );
      const queries = (await getRagQueries(page)).filter(
        (entry) => entry.file_id === uploaded.file_id,
      );
      expect(embeds).toHaveLength(1);
      expect(queries.length).toBeGreaterThan(0);
      expect(embeds[0].seq).toBeLessThan(Math.min(...queries.map(({ seq }) => seq)));
    } finally {
      await setEmbeddingFailure(page, uploaded.file_id, false);
    }
  });

  test('A-10: with no file tool loaded, a spreadsheet reads as it does under classic routing', async ({
    page,
  }) => {
    await startChat(page, AUTO_ENDPOINT);

    const csv = renamed(UPLOAD_FIXTURES.csv, 'a10-sheet');
    const uploaded = await confirmUpload(page, uploadViaUnifiedButton(page, csv));
    await expectDeferredRecord(page, uploaded.file_id);

    /* Neither Run Code nor File Search is loaded, so the automatic policy stands aside: the
     * text is derived from the stored original and sent the way classic routing sends extracted
     * text, under the same limits, and no inventory tells the model anything about the file. */
    const run = await sendTurn(page, replyPrompt(uniqueName('a10')));
    const request = initialRequest(run);
    expect(request.promptText).toContain(`${Q1_ROWS[0][0]},${Q1_ROWS[0][1]}`);
    expect(request.systemText).not.toContain(INVENTORY_HEADING);
    expect(inventoryLine(request, csv.name)).toBe('');
    expect(messageFileReading(await getLatestUserMessageFiles(page), uploaded.file_id)).toEqual({
      llmDeliveryPath: 'text',
    });
    await expect
      .poll(async () => readingRecord(await getFileRecord(page, uploaded.file_id)).outcome, {
        timeout: 15_000,
        message: 'the derived text should be saved onto the deferred record',
      })
      .toBe('complete');

    /* The record and its stored original are untouched by the derivation. */
    const record = await getFileRecord(page, uploaded.file_id);
    expect(sha256(await downloadOriginal(page, record))).toBe(sha256(attachFileBuffer(csv)));
  });

  test('A-26: palette, drop, paste and attach-existing give the same automatic reading', async ({
    page,
  }) => {
    await startChat(page, AUTO_ENDPOINT);
    await enableCodeInterpreter(page);

    const picked = await confirmUpload(
      page,
      uploadViaUnifiedButton(page, renamed(UPLOAD_FIXTURES.xlsx, 'a26-palette')),
    );
    const dropped = await confirmUpload(
      page,
      uploadViaDrop(page, renamed(UPLOAD_FIXTURES.xlsx, 'a26-drop')),
    );
    /* A browser that exposes no files on a synthetic paste event skips the third chip. */
    const pasted = (await supportsFilePaste(page))
      ? await confirmUpload(page, uploadViaPaste(page, renamed(UPLOAD_FIXTURES.xlsx, 'a26-paste')))
      : undefined;
    if (pasted) {
      expect(pasted.filename).toMatch(/^clipboard_\d+_a26-paste-/);
    }
    const uploads = [picked, dropped, ...(pasted ? [pasted] : [])];
    const pickedRecord = readingRecord(await getFileRecord(page, picked.file_id));
    expect(pickedRecord).toMatchObject({ llmDeliveryPath: 'none', outcome: 'deferred' });
    for (const { file_id } of uploads) {
      expect(readingRecord(await getFileRecord(page, file_id))).toEqual(pickedRecord);
    }

    const firstRun = await sendTurn(page, replyPrompt(uniqueName('a26-first')));
    const firstFiles = await getLatestUserMessageFiles(page);
    const pickedReading = messageFileReading(firstFiles, picked.file_id);
    expect(pickedReading).toEqual({ llmDeliveryPath: 'none' });
    for (const { filename, file_id } of uploads) {
      expect(inventoryLine(initialRequest(firstRun), filename)).toContain('read it with Run Code');
      expect(messageFileReading(firstFiles, file_id)).toEqual(pickedReading);
    }

    await attachExisting(page, picked);
    const existingRun = await sendTurn(page, replyPrompt(uniqueName('a26-existing')));
    expect(inventoryLine(initialRequest(existingRun), picked.filename)).toContain(
      'read it with Run Code',
    );
    const existingFiles = await getLatestUserMessageFiles(page);
    expect(messageFileReading(existingFiles, picked.file_id)).toEqual(pickedReading);
    expect(readingRecord(await getFileRecord(page, picked.file_id))).toEqual(pickedRecord);
  });

  test('A-29: a classic endpoint still extracts at upload and stores no marker or inventory', async ({
    page,
  }) => {
    test.setTimeout(MULTI_TURN_TIMEOUT);
    /* Run Code is on, so a classic upload would be deferred if the policy gate broke. */
    await startChat(page, CLASSIC_ENDPOINT);
    await enableCodeInterpreter(page);
    const workbook = renamed(UPLOAD_FIXTURES.xlsx, 'a29-quarterly');
    const uploaded = await confirmUpload(page, uploadViaUnifiedButton(page, workbook));
    const record = await getFileRecord(page, uploaded.file_id);
    expect(record.llmDeliveryPath).toBe('text');
    expect(record.metadata?.textDerivation).toBeUndefined();
    expect(await getStoredText(uploaded.file_id)).toContain(WORKBOOK_SENTINEL);

    const run = await sendTurn(page, replyPrompt(uniqueName('a29')));
    const request = initialRequest(run);
    expect(request.promptText).toContain(WORKBOOK_SENTINEL);
    expect(request.systemText).not.toContain(INVENTORY_HEADING);
    expect(inventoryLine(request, workbook.name)).toBe('');
    expect(messageFileReading(await getLatestUserMessageFiles(page), uploaded.file_id)).toEqual({
      llmDeliveryPath: 'text',
    });
    const after = await getFileRecord(page, uploaded.file_id);
    expect(readingRecord(after)).toEqual(readingRecord(record));
    expect(after.metadata?.textDerivation).toBeUndefined();
  });
});
