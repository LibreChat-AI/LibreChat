import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { Tools, FileContext } from 'librechat-data-provider';
import { Constants as AgentConstants } from '@librechat/agents';
import type { TFile, TurnFileConsumers, CodeWorkspaceOperation } from 'librechat-data-provider';
import type { CodeEnvFile } from '@librechat/agents';
import type { WorkspaceAttachmentAgent, WorkspaceImportRecord } from './attachments';
import type { CodeExecutionContext } from '~/agents/execution';
import type { ProvisionState } from '~/agents/resources';
import type { CodeBridgeFetch } from './bridge';
import {
  toAttachmentName,
  ignoresWholeFolder,
  createWorkspaceAttachmentPrimer,
  assignAttachmentNames,
  primeWorkspaceAttachments,
  importWorkspaceAttachments,
  createWorkspaceAttachmentTurn,
} from './attachments';
import { prepareQueuedCodeFileContext } from '~/files/code/queued';
import { executeWorkspaceTool } from './workspace';

const USER_ID = 'user-1';
const CONVERSATION_ID = 'convo-1';

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

type WorkspaceRequest = {
  operation: string;
  workspaceId: string;
  workspaceInstanceId?: string;
  path: string;
  content?: string;
  overwrite?: boolean;
  source?: { storage_session_id: string; id: string };
  bytes?: number;
  sha256?: string;
};

/**
 * In-memory stand-in for the Code API and its attached worker, implementing the
 * `import_file` contract: stored objects are copied by reference, a same-digest file is left
 * unchanged, a different file at the path is a conflict, `write_file` is create-only, and
 * `read_file` returns what is stored. With `missingParents`, it is a worker that predates
 * LibreChat-AI/code-interpreter#360 on a root registered by path alone: a write or import into a
 * folder that does not exist yet is `NOT_FOUND`, because that worker never creates one.
 */
function createFakeWorker({
  objects = new Map<string, string>(),
  delayMs = 0,
  denyWrites = false,
  truncateReads = false,
  missingParents = false,
  legacyCodeApi = false,
}: {
  objects?: Map<string, string>;
  delayMs?: number;
  denyWrites?: boolean;
  truncateReads?: boolean;
  missingParents?: boolean;
  /** A Code API that predates `NOT_FOUND` relays it as `INVALID_PATH` with the same message. */
  legacyCodeApi?: boolean;
} = {}) {
  const files = new Map<string, string>();
  const requests: WorkspaceRequest[] = [];
  const reply = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl: CodeBridgeFetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as WorkspaceRequest;
    requests.push(request);
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
    }
    const key = `${request.workspaceInstanceId ?? 'root'}:${request.path}`;
    if (request.operation === 'read_file') {
      const content = files.get(key) ?? '';
      return reply(200, {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: request.workspaceId,
        path: request.path,
        content,
        startLine: 1,
        endLine: content.split('\n').length,
        truncated: truncateReads,
        ...(truncateReads ? { nextStartLine: content.split('\n').length + 1 } : {}),
      });
    }
    if (denyWrites) {
      return reply(403, { code: 'WRITE_DISABLED', error: 'File writes are disabled' });
    }
    const folder = key.slice(0, key.lastIndexOf('/') + 1);
    if (missingParents && ![...files.keys()].some((path) => path.startsWith(folder))) {
      return reply(422, {
        code: legacyCodeApi ? 'INVALID_PATH' : 'NOT_FOUND',
        error: 'Workspace path does not exist',
      });
    }
    if (request.operation === 'write_file') {
      if (files.has(key) && request.overwrite === false) {
        return reply(409, { code: 'EDIT_CONFLICT', error: 'Workspace file already exists' });
      }
      files.set(key, request.content ?? '');
      return reply(200, {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: request.workspaceId,
        path: request.path,
        created: true,
        bytesWritten: Buffer.byteLength(request.content ?? ''),
      });
    }
    const content = objects.get(`${request.source?.storage_session_id}/${request.source?.id}`);
    if (content == null || sha(content) !== request.sha256) {
      return reply(422, { code: 'INVALID_REQUEST', error: 'source mismatch' });
    }
    const existing = files.get(key);
    if (existing != null && sha(existing) === request.sha256) {
      return reply(200, {
        protocolVersion: 1,
        operation: 'import_file',
        workspaceId: request.workspaceId,
        path: request.path,
        created: false,
        unchanged: true,
        bytesWritten: 0,
        sha256: request.sha256,
      });
    }
    if (existing != null) {
      return reply(409, { code: 'EDIT_CONFLICT', error: 'A different file exists' });
    }
    files.set(key, content);
    return reply(200, {
      protocolVersion: 1,
      operation: 'import_file',
      workspaceId: request.workspaceId,
      path: request.path,
      created: true,
      bytesWritten: Buffer.byteLength(content),
      sha256: request.sha256,
    });
  };
  return { fetchImpl, files, requests, objects };
}

function attachedContext(
  operations: CodeWorkspaceOperation[] = ['read_file', 'write_file', 'import_file'],
  overrides: Partial<CodeExecutionContext> = {},
  workspaceInstanceId?: string,
): CodeExecutionContext {
  return {
    baseUrl: 'https://code.example/v1',
    codeSessionKey: 'session',
    executionProfile: 'stateful',
    executionRouteKey: 'stateful:machine',
    statefulSessions: true,
    environmentType: 'attached',
    environmentId: 'machine',
    bridgeWorkerId: 'worker',
    codeWorkspace: {
      environmentId: 'machine',
      workspaceId: 'primary',
      operations,
      ...(workspaceInstanceId ? { workspaceInstanceId } : {}),
    },
    ...overrides,
  };
}

let fileCounter = 0;
function chatFile(
  filename: string,
  content: string,
  objects: Map<string, string>,
  overrides: Partial<TFile> = {},
): {
  file: TFile;
  destination: string;
  agentScoped: boolean;
  source: { storage_session_id: string; file_id: string };
} {
  fileCounter += 1;
  const source = { storage_session_id: `session${fileCounter}`, file_id: `object${fileCounter}` };
  objects.set(`${source.storage_session_id}/${source.file_id}`, content);
  return {
    file: {
      file_id: `file-${fileCounter}`,
      user: USER_ID,
      filename,
      filepath: `/uploads/${filename}`,
      type: 'application/octet-stream',
      bytes: Buffer.byteLength(content),
      object: 'file',
      usage: 0,
      createdAt: new Date(2026, 0, 1, 0, 0, fileCounter).toISOString(),
      ...overrides,
    } as TFile,
    destination: filename,
    agentScoped: false,
    source,
  };
}

function createDeps(worker: ReturnType<typeof createFakeWorker>) {
  const records: WorkspaceImportRecord[] = [];
  const digests: string[] = [];
  return {
    records,
    digests,
    deps: {
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      getAuthHeaders: async () => ({ Authorization: 'Bearer token' }),
      digestFile: async (file: TFile) => {
        digests.push(file.file_id);
        const content = worker.objects.get(sourceOf.get(file.file_id) ?? '') ?? '';
        return { sha256: sha(content), bytes: Buffer.byteLength(content) };
      },
      recordImport: async (record: WorkspaceImportRecord) => {
        records.push(record);
      },
      codeApiMaxRetryWaitMs: 0,
      fetchImpl: worker.fetchImpl,
    },
  };
}

/** Which stored object each test file was primed from, so the digest reads the same bytes. */
const sourceOf = new Map<string, string>();
const consumers: TurnFileConsumers = { executeCode: true, fileSearch: false };
function remember<
  T extends { file: TFile; source: { storage_session_id: string; file_id: string } },
>(entry: T): T {
  sourceOf.set(entry.file.file_id, `${entry.source.storage_session_id}/${entry.source.file_id}`);
  return entry;
}

function agentWith(
  context: CodeExecutionContext,
  entries: WorkspaceAttachmentAgent['codeContextEntries'],
  extra: Partial<WorkspaceAttachmentAgent> = {},
): WorkspaceAttachmentAgent {
  return {
    id: 'agent-1',
    codeExecutionContext: context,
    codeContextEntries: entries,
    dynamicToolContextMap: { [Tools.execute_code]: 'stale programmatic note' },
    toolDefinitions: [{ name: AgentConstants.BASH_TOOL }],
    ...extra,
  };
}

beforeEach(() => {
  sourceOf.clear();
});

describe('attachment names', () => {
  it('keeps a name that is already portable', () => {
    expect(toAttachmentName('Release notes (final).pdf')).toBe('Release notes (final).pdf');
    expect(toAttachmentName('données-été.csv')).toBe('données-été.csv');
  });

  it('removes directories, unsafe characters, leading dots and reserved device names', () => {
    expect(toAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(toAttachmentName('C:\\Users\\me\\report.docx')).toBe('report.docx');
    expect(toAttachmentName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(toAttachmentName('tab\there\u0000.txt')).toBe('tab_here_.txt');
    expect(toAttachmentName('.env')).toBe('env');
    expect(toAttachmentName('...hidden.tar.gz')).toBe('hidden.tar.gz');
    expect(toAttachmentName('trailing. . ')).toBe('trailing');
    expect(toAttachmentName('CON.txt')).toBe('_CON.txt');
    expect(toAttachmentName('...')).toBe('attachment');
  });

  it('shortens an overlong name but keeps its extension', () => {
    const name = toAttachmentName(`${'x'.repeat(300)}.zip`);
    expect(name.length).toBe(120);
    expect(name.endsWith('.zip')).toBe(true);
  });

  it('de-duplicates collisions deterministically, ignoring case', () => {
    expect(
      assignAttachmentNames(['data.csv', 'DATA.csv', 'data.csv', 'notes', 'notes', 'a/data.csv']),
    ).toEqual(['data.csv', 'DATA (2).csv', 'data (3).csv', 'notes', 'notes (2)', 'data (4).csv']);
  });
});

describe('import_file contract validation', () => {
  it('rejects a result whose digest does not match the request', async () => {
    const fetchImpl: CodeBridgeFetch = async () =>
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'import_file',
          workspaceId: 'primary',
          path: '.librechat/attachments/a.txt',
          created: true,
          bytesWritten: 1,
          sha256: 'f'.repeat(64),
        }),
        { status: 200 },
      );
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'import_file',
          workspaceId: 'primary',
          path: '.librechat/attachments/a.txt',
          source: { storage_session_id: 's', id: 'o' },
          bytes: 1,
          sha256: 'a'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('accepts nanoid storage ids that start with a symbol', async () => {
    const fetchImpl: CodeBridgeFetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as WorkspaceRequest;
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          operation: 'import_file',
          workspaceId: 'primary',
          path: request.path,
          created: false,
          unchanged: true,
          bytesWritten: 0,
          sha256: request.sha256,
        }),
        { status: 200 },
      );
    };
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'import_file',
          workspaceId: 'primary',
          path: '.librechat/attachments/a.txt',
          source: { storage_session_id: '-V1StGXR8_Z5jdHi6B-my', id: '_ZvTqYz0fN3pX8kLm2Qw1' },
          bytes: 1,
          sha256: 'a'.repeat(64),
        },
      }),
    ).resolves.toMatchObject({ unchanged: true, bytesWritten: 0 });
  });

  it('refuses to send a path that escapes the workspace', async () => {
    const fetchImpl = jest.fn<ReturnType<CodeBridgeFetch>, Parameters<CodeBridgeFetch>>();
    await expect(
      executeWorkspaceTool({
        baseURL: 'https://code.example',
        authHeaders: {},
        fetchImpl,
        request: {
          protocolVersion: 1,
          operation: 'import_file',
          workspaceId: 'primary',
          path: '../outside.txt',
          source: { storage_session_id: 's', id: 'o' },
          bytes: 1,
          sha256: 'a'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({ reason: 'invalid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('primeWorkspaceAttachments', () => {
  it('copies chat files into .librechat/attachments and lists their workspace paths', async () => {
    const worker = createFakeWorker();
    const { deps, records } = createDeps(worker);
    const zip = remember(chatFile('release prep.zip', 'zip-bytes', worker.objects));
    const csv = remember(chatFile('data.csv', 'a,b\n1,2\n', worker.objects));
    const agent = agentWith(attachedContext(), [zip, csv]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.files.get('root:.librechat/attachments/release prep.zip')).toBe('zip-bytes');
    expect(worker.files.get('root:.librechat/attachments/data.csv')).toBe('a,b\n1,2\n');
    expect(worker.files.get('root:.librechat/attachments/.gitignore')).toBe('*\n');
    const imports = worker.requests.filter((request) => request.operation === 'import_file');
    expect(imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: 'primary',
          path: '.librechat/attachments/release prep.zip',
          source: { storage_session_id: zip.source.storage_session_id, id: zip.source.file_id },
          bytes: 9,
          sha256: sha('zip-bytes'),
          overwrite: false,
        }),
      ]),
    );
    const note = agent.dynamicToolContextMap?.[Tools.execute_code] as string;
    expect(note).toContain('every workspace tool');
    expect(note).toContain('.librechat/attachments/release prep.zip (attached by user)');
    expect(note).toContain('.librechat/attachments/data.csv (attached by user)');
    expect(note).not.toContain('$LIBRECHAT_CODE_DATA_DIR');
    expect(records.map((record) => record.copy?.target.path).sort()).toEqual([
      '.librechat/attachments/data.csv',
      '.librechat/attachments/release prep.zip',
    ]);
    expect(records[0].digest).toEqual(
      expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    );
  });

  it('does not send a file again once this conversation recorded it in the workspace', async () => {
    const worker = createFakeWorker();
    const { deps, digests } = createDeps(worker);
    const report = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const firstAgent = agentWith(attachedContext(), [report]);
    await primeWorkspaceAttachments({ agents: [firstAgent], deps });
    expect(worker.requests).toHaveLength(2);

    const nextAgent = agentWith(attachedContext(), [report]);
    await primeWorkspaceAttachments({ agents: [nextAgent], deps });

    expect(worker.requests).toHaveLength(2);
    expect(digests).toEqual([report.file.file_id]);
    expect(nextAgent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/report.pdf',
    );
  });

  it('treats a same-digest file already in the workspace as imported', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const report = remember(chatFile('report.pdf', 'pdf', worker.objects));
    worker.files.set('root:.librechat/attachments/report.pdf', 'pdf');

    const agent = agentWith(attachedContext(), [report]);
    await primeWorkspaceAttachments({
      agents: [agent],
      deps: { ...deps, conversationId: undefined },
    });

    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/report.pdf (attached by user)',
    );
  });

  it('moves a file to the next free name when a different file holds its name', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const report = remember(chatFile('report.pdf', 'new pdf', worker.objects));
    worker.files.set('root:.librechat/attachments/report.pdf', 'someone else');

    const agent = agentWith(attachedContext(), [report]);
    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.files.get('root:.librechat/attachments/report (2).pdf')).toBe('new pdf');
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/report (2).pdf (attached by user)',
    );
  });

  it('gives same-named attachments distinct names in upload order', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const first = remember(chatFile('notes.txt', 'one', worker.objects));
    const second = remember(chatFile('Notes.txt', 'two', worker.objects));

    const agent = agentWith(attachedContext(), [second, first]);
    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.files.get('root:.librechat/attachments/notes.txt')).toBe('one');
    expect(worker.files.get('root:.librechat/attachments/Notes (2).txt')).toBe('two');
    const note = agent.dynamicToolContextMap?.[Tools.execute_code] as string;
    expect(note).toContain(
      '.librechat/attachments/Notes (2).txt (attached by user) (uploaded as Notes.txt)',
    );
  });

  it('creates the ignore file once and checks it again on a later turn', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const files = ['a.txt', 'b.txt', 'c.txt'].map((name) =>
      remember(chatFile(name, name, worker.objects)),
    );
    await primeWorkspaceAttachments({ agents: [agentWith(attachedContext(), files)], deps });
    const later = remember(chatFile('d.txt', 'd', worker.objects));
    await primeWorkspaceAttachments({ agents: [agentWith(attachedContext(), [later])], deps });

    expect(worker.requests.filter((request) => request.operation === 'write_file')).toHaveLength(2);
    expect(worker.requests.filter((request) => request.operation === 'read_file')).toHaveLength(1);
    expect(worker.requests.filter((request) => request.operation === 'import_file')).toHaveLength(
      4,
    );
    expect(worker.files.get('root:.librechat/attachments/.gitignore')).toBe('*\n');
  });

  it('stops copying once the user changes the ignore file', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const first = remember(chatFile('a.txt', 'a', worker.objects));
    await primeWorkspaceAttachments({ agents: [agentWith(attachedContext(), [first])], deps });
    worker.files.set('root:.librechat/attachments/.gitignore', '*.log\n');

    const later = remember(chatFile('b.txt', 'b', worker.objects));
    const agent = agentWith(attachedContext(), [later]);
    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.files.has('root:.librechat/attachments/b.txt')).toBe(false);
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'b.txt (attached by user): the existing .librechat/attachments/.gitignore',
    );
  });

  it('treats a truncated read of the ignore file as not ignored', async () => {
    const worker = createFakeWorker({ truncateReads: true });
    worker.files.set('root:.librechat/attachments/.gitignore', '*\n');
    const { deps } = createDeps(worker);
    const file = remember(chatFile('keep.txt', 'k', worker.objects));
    const agent = agentWith(attachedContext(), [file]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.files.has('root:.librechat/attachments/keep.txt')).toBe(false);
  });

  it('names a converted image for the bytes it holds', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const photo = remember(chatFile('photo.heic', 'webp', worker.objects, { type: 'image/webp' }));
    const agent = agentWith(attachedContext(), [photo]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.files.get('root:.librechat/attachments/photo.webp')).toBe('webp');
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/photo.webp (attached by user) (uploaded as photo.heic)',
    );
  });

  it('caps workspace requests for the whole turn, across agents', async () => {
    const worker = createFakeWorker({ delayMs: 20 });
    const { deps } = createDeps(worker);
    let inFlight = 0;
    let peak = 0;
    const counted: typeof worker.fetchImpl = async (input, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await worker.fetchImpl(input, init);
      } finally {
        inFlight--;
      }
    };
    const firstFiles = ['a', 'b', 'c'].map((name) =>
      remember(chatFile(`${name}.txt`, name, worker.objects)),
    );
    const secondFiles = ['d', 'e', 'f'].map((name) =>
      remember(chatFile(`${name}.txt`, name, worker.objects)),
    );
    const first = agentWith(attachedContext(), firstFiles);
    const second = { ...agentWith(attachedContext(), secondFiles), id: 'agent-2' };

    await primeWorkspaceAttachments({
      agents: [first, second],
      deps: { ...deps, fetchImpl: counted, concurrency: 2 },
    });

    expect(worker.requests.filter((request) => request.operation === 'import_file')).toHaveLength(
      6,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('admits no more tasks than the limit at once', async () => {
    const turn = createWorkspaceAttachmentTurn(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      turn.limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 7 }, task));
    expect(peak).toBe(2);
  });

  it('keeps an ignore file the user already has when it ignores the folder', async () => {
    const worker = createFakeWorker();
    worker.files.set('root:.librechat/attachments/.gitignore', '# mine\n*\n');
    const { deps } = createDeps(worker);
    const file = remember(chatFile('a.txt', 'a', worker.objects));

    await primeWorkspaceAttachments({ agents: [agentWith(attachedContext(), [file])], deps });

    expect(worker.files.get('root:.librechat/attachments/.gitignore')).toBe('# mine\n*\n');
    expect(worker.files.get('root:.librechat/attachments/a.txt')).toBe('a');
  });

  it('copies nothing into a folder whose existing ignore file does not ignore it', async () => {
    const worker = createFakeWorker();
    worker.files.set('root:.librechat/attachments/.gitignore', '# mine\n*.log\n');
    const { deps } = createDeps(worker);
    const file = remember(chatFile('a.txt', 'a', worker.objects));
    const agent = agentWith(attachedContext(), [file]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.files.has('root:.librechat/attachments/a.txt')).toBe(false);
    expect(worker.requests.some((request) => request.operation === 'import_file')).toBe(false);
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'a.txt (attached by user): the existing .librechat/attachments/.gitignore does not ignore the folder',
    );
  });

  it('recognizes only rules that ignore the whole folder', () => {
    expect(ignoresWholeFolder('*\n')).toBe(true);
    expect(ignoresWholeFolder('# keep out\n/**\n')).toBe(true);
    expect(ignoresWholeFolder('*.zip\n')).toBe(false);
    expect(ignoresWholeFolder('*\n!keep.txt\n')).toBe(false);
    expect(ignoresWholeFolder('')).toBe(false);
  });

  it('copies into the conversation checkout and keeps its marker apart from the root', async () => {
    const worker = createFakeWorker();
    const { deps, records } = createDeps(worker);
    const instance = 'a'.repeat(64);
    const file = remember(chatFile('lane.txt', 'lane', worker.objects));

    const isolated = agentWith(attachedContext(undefined, {}, instance), [file]);
    await primeWorkspaceAttachments({ agents: [isolated], deps });
    const root = agentWith(attachedContext(), [file]);
    await primeWorkspaceAttachments({ agents: [root], deps });

    const imports = worker.requests.filter((request) => request.operation === 'import_file');
    expect(imports.map((request) => request.workspaceInstanceId)).toEqual([instance, undefined]);
    expect(worker.files.get(`${instance}:.librechat/attachments/lane.txt`)).toBe('lane');
    expect(worker.files.get('root:.librechat/attachments/lane.txt')).toBe('lane');
    expect(new Set(records.map((record) => record.copy?.key)).size).toBe(2);
  });

  it('says plainly that files are unavailable when the worker cannot import', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const agent = agentWith(attachedContext(['read_file', 'write_file']), [file]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.requests).toHaveLength(0);
    const note = agent.dynamicToolContextMap?.[Tools.execute_code] as string;
    expect(note).toContain('not available on this machine');
    expect(note).toContain('report.pdf (attached by user)');
    expect(note).toContain('cannot receive attachments yet');
    expect(note).not.toContain('$LIBRECHAT_CODE_DATA_DIR');
  });

  it('offers the programmatic Bash path only to an agent that has that tool', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const agent = agentWith(attachedContext(['read_file']), [file], {
      toolDefinitions: [{ name: AgentConstants.BASH_PROGRAMMATIC_TOOL_CALLING }],
    });

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'programmatic Bash tool can read it at $LIBRECHAT_CODE_DATA_DIR/report.pdf',
    );
  });

  it('skips imports when this machine denies file writes', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const context = attachedContext(undefined, {
      codeEnvironmentConfigSchema: {
        permissions: { fileWrite: { default: 'deny', allowed: ['deny'] } },
      } as CodeExecutionContext['codeEnvironmentConfigSchema'],
    });
    const agent = agentWith(context, [file]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.requests).toHaveLength(0);
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'file writes are not allowed in this workspace',
    );
  });

  it('imports under an ask policy, since the upload is the consent', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const context = attachedContext(undefined, {
      codeEnvironmentConfigSchema: {
        permissions: { fileWrite: { default: 'ask', allowed: ['ask', 'allow'] } },
      } as CodeExecutionContext['codeEnvironmentConfigSchema'],
    });

    await primeWorkspaceAttachments({ agents: [agentWith(context, [file])], deps });

    expect(worker.files.get('root:.librechat/attachments/report.pdf')).toBe('pdf');
  });

  it.each([
    ['NOT_FOUND', false],
    ['INVALID_PATH', true],
  ])(
    'tells the user to update a worker that cannot create the attachments folder (%s)',
    async (upstreamCode, legacyCodeApi) => {
      const warn = jest.spyOn(logger, 'warn');
      const worker = createFakeWorker({ missingParents: true, legacyCodeApi });
      const { deps, records } = createDeps(worker);
      const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
      const agent = agentWith(attachedContext(), [file]);

      await primeWorkspaceAttachments({ agents: [agent], deps });

      expect(worker.requests.map((request) => request.operation)).toEqual(['write_file']);
      expect(worker.files.size).toBe(0);
      expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
        "report.pdf (attached by user): this machine's LibreChat worker cannot receive attachments yet; updating the worker enables it",
      );
      expect(records.every((record) => record.copy == null)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[workspaceAttachments] Could not create .librechat/attachments/.gitignore in workspace primary: unsupported',
        {
          type: 'WorkspaceToolHttpError',
          reason: 'rejected',
          upstreamStatus: 422,
          upstreamCode,
        },
      );
      warn.mockRestore();
    },
  );

  it('logs the worker code of a refused import without its message', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const agent = agentWith(attachedContext(), [file]);

    await primeWorkspaceAttachments({
      agents: [agent],
      deps: { ...deps, digestFile: async () => ({ sha256: sha('other bytes'), bytes: 3 }) },
    });

    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'report.pdf (attached by user): copying it to this machine failed',
    );
    expect(warn).toHaveBeenCalledWith(
      `[workspaceAttachments] Import of file ${file.file.file_id} into workspace primary failed: failed`,
      {
        type: 'WorkspaceToolHttpError',
        reason: 'rejected',
        upstreamStatus: 422,
        upstreamCode: 'INVALID_REQUEST',
      },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('source mismatch');
    warn.mockRestore();
  });

  it('reports a worker-side write refusal instead of a path', async () => {
    const worker = createFakeWorker({ denyWrites: true });
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const agent = agentWith(attachedContext(), [file]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'report.pdf (attached by user): file writes are not allowed in this workspace',
    );
  });

  it('keeps the digest of a refused file so the next turn does not hash it again', async () => {
    const worker = createFakeWorker({ denyWrites: true });
    const { deps, digests, records } = createDeps(worker);
    const file = remember(chatFile('big.iso', 'iso', worker.objects));

    await primeWorkspaceAttachments({ agents: [agentWith(attachedContext(), [file])], deps });
    await primeWorkspaceAttachments({ agents: [agentWith(attachedContext(), [file])], deps });

    expect(digests).toEqual([file.file.file_id]);
    expect(records).toEqual([
      expect.objectContaining({ digest: expect.objectContaining({ bytes: 3 }) }),
    ]);
    expect(records[0].copy).toBeUndefined();
  });

  it('never copies the agent’s own files or another user’s', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const agentFile = remember({
      ...chatFile('setup.md', 'setup', worker.objects),
      agentScoped: true,
    });
    const foreign = remember(
      chatFile('shared.txt', 'shared', worker.objects, { user: 'someone-else' }),
    );
    const agent = agentWith(attachedContext(), [agentFile, foreign]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.requests).toHaveLength(0);
    const note = agent.dynamicToolContextMap?.[Tools.execute_code] as string;
    expect(note).toContain("setup.md: it is one of the agent's own files");
    expect(note).toContain('shared.txt (attached by user): only files you uploaded yourself');
  });

  it('falls back to the unavailable note when the copy does not finish in time', async () => {
    const worker = createFakeWorker({ delayMs: 5_000 });
    const { deps, records } = createDeps(worker);
    const file = remember(chatFile('big.zip', 'zip', worker.objects));
    const agent = agentWith(attachedContext(), [file]);

    const startedAt = Date.now();
    await primeWorkspaceAttachments({ agents: [agent], deps: { ...deps, timeoutMs: 100 } });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(records.map((record) => record.copy)).toEqual([undefined]);
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'big.zip (attached by user): copying it to this machine did not finish in time',
    );
  });

  it('does not import without write_file, since the folder could not ignore itself', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const agent = agentWith(attachedContext(['read_file', 'import_file']), [file]);

    await primeWorkspaceAttachments({ agents: [agent], deps });

    expect(worker.requests).toHaveLength(0);
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'cannot receive attachments yet',
    );
  });

  it('starts nothing when the turn is already cancelled', async () => {
    const worker = createFakeWorker();
    const { deps, digests } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      primeWorkspaceAttachments({
        agents: [agentWith(attachedContext(), [file])],
        deps,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(digests).toHaveLength(0);
    expect(worker.requests).toHaveLength(0);
  });

  it('does not hold the turn for a stalled metadata write', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const agent = agentWith(attachedContext(), [file]);

    const startedAt = Date.now();
    await primeWorkspaceAttachments({
      agents: [agent],
      deps: { ...deps, timeoutMs: 100, recordImport: () => new Promise<void>(() => undefined) },
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/report.pdf',
    );
  });

  it('copies again when the same environment id now names a different worker', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));

    await primeWorkspaceAttachments({ agents: [agentWith(attachedContext(), [file])], deps });
    const replaced = attachedContext(undefined, { bridgeWorkerId: 'replacement-worker' });
    await primeWorkspaceAttachments({ agents: [agentWith(replaced, [file])], deps });

    expect(worker.requests.filter((request) => request.operation === 'import_file')).toHaveLength(
      2,
    );
  });

  it('primes each agent once, including a subagent that joins later', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const primary = agentWith(attachedContext(), [file]);
    const lazy = { ...agentWith(attachedContext(), [file]), id: 'lazy-subagent' };
    const provisionFiles = jest.fn(async () => []);
    const prime = createWorkspaceAttachmentPrimer({
      deps,
      getProvisionFiles: () => provisionFiles,
    });

    await prime([primary]);
    lazy.dynamicToolContextMap = { [Tools.execute_code]: 'stale programmatic note' };
    await prime([lazy, primary], { toolContexts: new Map([[lazy.id, {}]]) });

    expect(lazy.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/report.pdf',
    );
    expect(worker.requests.filter((request) => request.operation === 'import_file')).toHaveLength(
      1,
    );
  });

  it('leaves sandbox routes and unselected attached machines alone', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('report.pdf', 'pdf', worker.objects));
    const sandbox = agentWith({ ...attachedContext(), environmentType: undefined }, [file]);
    const unselected = agentWith({ ...attachedContext(), codeWorkspace: undefined }, [file]);

    await primeWorkspaceAttachments({ agents: [sandbox, unselected], deps });

    expect(worker.requests).toHaveLength(0);
    expect(sandbox.dynamicToolContextMap?.[Tools.execute_code]).toBe('stale programmatic note');
    expect(unselected.dynamicToolContextMap?.[Tools.execute_code]).toBe('stale programmatic note');
  });

  it('stages queued uploads, copies them, and keeps the queued note from repeating them', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const queued = chatFile('fresh.zip', 'fresh', worker.objects);
    remember(queued);
    const provisionState: ProvisionState = {
      codeEnvFiles: [queued.file],
      codeEnvDestinations: new Map([[queued.file.file_id, 'fresh.zip']]),
      vectorDBFiles: [],
      aliveFileIds: new Set(),
      agentScopedFileIds: new Set(),
    };
    const staged: CodeEnvFile = {
      id: queued.source.file_id,
      storage_session_id: queued.source.storage_session_id,
      name: 'fresh.zip',
    } as CodeEnvFile;
    const provisionFiles = jest.fn(async (toolNames: string[]) => {
      expect(toolNames).toEqual([AgentConstants.READ_FILE]);
      queued.file.metadata = {
        codeEnvRefs: {
          'stateful:machine': {
            kind: 'user',
            id: USER_ID,
            storage_session_id: queued.source.storage_session_id,
            file_id: queued.source.file_id,
            sandboxFilename: 'fresh.zip',
          },
        },
      };
      provisionState.codeEnvFiles = [];
      return [staged];
    });
    const agent = agentWith(attachedContext(), [], {
      provisionState,
      fileConsumers: consumers,
      dynamicToolContextMap: { queued_code_files: 'stale queued note' },
    });

    await primeWorkspaceAttachments({ agents: [agent], deps, provisionFiles });

    expect(provisionFiles).toHaveBeenCalledTimes(1);
    expect(agent.primedCodeFiles).toEqual([staged]);
    expect(worker.files.get('root:.librechat/attachments/fresh.zip')).toBe('fresh');
    expect(agent.dynamicToolContextMap?.queued_code_files).toBeUndefined();
    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/fresh.zip (attached by user)',
    );

    provisionState.codeEnvFiles = [queued.file];
    prepareQueuedCodeFileContext(
      { ...agent, provisionState, fileConsumers: consumers },
      [],
      USER_ID,
    );
    expect(agent.dynamicToolContextMap?.queued_code_files).toBeUndefined();
  });

  it('hands late provisioning refs to the first code tool call', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const queued = remember(chatFile('slow.zip', 'slow', worker.objects));
    let finish: (files: CodeEnvFile[]) => void = () => undefined;
    const provisionFiles = jest.fn(
      () => new Promise<CodeEnvFile[]>((resolve) => (finish = resolve)),
    );
    const toolContext: { pendingProvisionedCodeFiles?: CodeEnvFile[] } = {};
    const agent = agentWith(attachedContext(), [], {
      provisionState: {
        codeEnvFiles: [queued.file],
        codeEnvDestinations: new Map([[queued.file.file_id, 'slow.zip']]),
        vectorDBFiles: [],
        aliveFileIds: new Set(),
        agentScopedFileIds: new Set(),
      },
      fileConsumers: consumers,
    });

    await primeWorkspaceAttachments({
      agents: [agent],
      toolContexts: new Map([[agent.id, toolContext]]),
      provisionFiles,
      deps: { ...deps, timeoutMs: 50 },
    });

    expect(agent.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      'slow.zip (attached by user): copying it to this machine did not finish in time',
    );
    const late = { id: 'late', storage_session_id: 's', name: 'slow.zip' } as CodeEnvFile;
    finish([late]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(toolContext.pendingProvisionedCodeFiles).toEqual([late]);
    expect(agent.primedCodeFiles).toBeUndefined();
  });

  it('copies a file shared by two agents on the same workspace once', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const file = remember(chatFile('shared.csv', 'x', worker.objects));
    const first = agentWith(attachedContext(), [file]);
    const second = { ...agentWith(attachedContext(), [file]), id: 'agent-2' };

    await primeWorkspaceAttachments({ agents: [first, second], deps });

    expect(worker.requests.filter((request) => request.operation === 'import_file')).toHaveLength(
      1,
    );
    expect(second.dynamicToolContextMap?.[Tools.execute_code]).toContain(
      '.librechat/attachments/shared.csv',
    );
  });

  it('copies a displaced code output under its original name', async () => {
    const worker = createFakeWorker();
    const { deps } = createDeps(worker);
    const output = remember(
      chatFile('chart.png', 'png', worker.objects, { context: FileContext.execute_code }),
    );
    const result = await importWorkspaceAttachments({
      context: attachedContext(),
      candidates: [{ ...output, destination: 'chart-1.png' }],
      deps,
      signal: new AbortController().signal,
    });
    expect(result.get(output.file.file_id)).toEqual({
      status: 'imported',
      path: '.librechat/attachments/chart.png',
    });
  });
});
