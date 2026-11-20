import axios from 'axios';
import FormData from 'form-data';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Constants } from '@librechat/agents';
import { buffer } from 'node:stream/consumers';
import { logger } from '@librechat/data-schemas';
import {
  FileContext,
  FileSources,
  EModelEndpoint,
  EToolResources,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { FileProvisionCommit, AppConfig, IUser } from '@librechat/data-schemas';
import type { CodeEnvRef, TAgentsEndpoint, TFile } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import type { ProvisionToolContext } from './callback';
import type { ServerRequest } from '~/types';
import { createFileProvisionRecovery, FileProvisionOutcomeUnknownError } from '../operations';
import { CODE_UPLOAD_BATCH_MAX_BYTES, CODE_UPLOAD_BATCH_MAX_FILES } from '../code/batch';
import { getCodeFileInfo, selectCodeFiles } from '../code/priming';
import { createCodeApiUploadRegistry } from '~/utils/code';
import { createProvisionFilesCallback } from './callback';
import { dispatchCodeApiUpload } from '../dispatch';
import { primeResources } from '~/agents/resources';
import { createProvisionService } from './service';

jest.mock('~/auth/codeapi', () => ({
  getCodeApiAuthHeaders: jest.fn(async (req?: { user?: { id?: string } }) => ({
    Authorization: `Bearer ${req?.user?.id}`,
  })),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

const USER = 'user1';
const HOUR = 3_600_000;

interface StoredObject {
  bytes: Buffer;
  filename: string;
  lastModified: string;
}

interface MultipartPart {
  name: string;
  filename?: string;
  content: Buffer;
}

function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const boundary = Buffer.from(`--${/boundary=([^;]+)/.exec(contentType)![1]}`);
  const parts: MultipartPart[] = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = body.subarray(start + boundary.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, headerEnd).toString('utf8');
    parts.push({
      name: /name="([^"]*)"/.exec(headers)![1],
      filename: /filename="([^"]*)"/.exec(headers)?.[1],
      content: part.subarray(headerEnd + 4),
    });
    start = next;
  }
  return parts;
}

/**
 * A Code API stand-in: object storage that reports MD5 entity tags, a counting limiter, and
 * the service's storage session keys. A `user` session belongs to whoever is authenticated,
 * whatever `id` the request names; an `agent` session belongs to the agent id alone.
 */
function createCodeApiFixture() {
  const objects = new Map<string, StoredObject>();
  const owners = new Map<string, string>();
  const sessionKey = (
    kind: string | null | undefined,
    id: string | null | undefined,
    authorization: string | undefined,
  ) => (kind === 'agent' ? `agent:${id}` : `user:${authorization?.replace(/^Bearer /, '')}`);
  const uploads: Array<{ path: string; files: string[]; status: number; bytes: number }> = [];
  const probes: string[] = [];
  const state = {
    /** Upload requests to answer 429 before accepting again. */
    refuse: 0,
    retryAfterSeconds: 1,
    /** Names the service reports as failed inside an otherwise stored batch. */
    rejectNames: new Set<string>(),
    /** Names the service stores but leaves out of its batch answer. */
    omitNames: new Set<string>(),
    /** Answer session listings with a server error. */
    failListings: false,
    sessions: 0,
    ids: 0,
  };
  const describe = (key: string, object: StoredObject) => ({
    name: key,
    size: object.bytes.length,
    lastModified: object.lastModified,
    etag: createHash('md5').update(object.bytes).digest('hex'),
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      response
        .writeHead(status, { 'Content-Type': 'application/json', ...headers })
        .end(JSON.stringify(body));
    const upload = /^\/v1\/upload(\/batch)?$/.exec(url.pathname);
    if (request.method === 'POST' && upload) {
      const body = await buffer(request);
      if (state.refuse > 0) {
        state.refuse--;
        uploads.push({ path: url.pathname, files: [], status: 429, bytes: body.length });
        return send(
          429,
          { error: `Too many file uploads. Please retry in ${state.retryAfterSeconds} seconds.` },
          { 'Retry-After': String(state.retryAfterSeconds) },
        );
      }
      const parts = parseMultipart(body, request.headers['content-type']!);
      const field = (name: string) =>
        parts.find((part) => part.name === name)?.content.toString('utf8');
      const files = parts.filter((part) => part.name === 'file');
      const session = `session-${++state.sessions}`;
      owners.set(session, sessionKey(field('kind'), field('id'), request.headers.authorization));
      const results = files.map((part) => {
        const filename = part.filename!;
        if (state.rejectNames.has(filename)) {
          return { status: 'error', filename, error: 'File size limit exceeded' };
        }
        const fileId = `object${++state.ids}`;
        objects.set(`${session}/${fileId}`, {
          bytes: Buffer.from(part.content),
          filename,
          lastModified: new Date().toISOString(),
        });
        return { status: 'success', filename, fileId };
      });
      const failed = results.filter((result) => result.status === 'error').length;
      const status = upload[1] && failed === results.length ? 400 : 200;
      uploads.push({
        path: url.pathname,
        files: files.map((part) => part.filename!),
        status,
        bytes: body.length,
      });
      if (!upload[1]) {
        return send(200, { message: 'success', storage_session_id: session, files: results });
      }
      const partial = status === 400 ? 'error' : 'partial_success';
      return send(status, {
        message: failed === 0 ? 'success' : partial,
        storage_session_id: session,
        files: results.filter((result) => !state.omitNames.has(result.filename)),
        succeeded: results.length - failed,
        failed,
      });
    }
    const authorized = (session: string) =>
      owners.get(session) ===
      sessionKey(
        url.searchParams.get('kind'),
        url.searchParams.get('id'),
        request.headers.authorization,
      );
    const metadata = /^\/v1\/sessions\/([^/]+)\/objects\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && metadata) {
      probes.push(url.pathname);
      if (!authorized(metadata[1])) return send(403, { error: 'Unauthorized' });
      const key = `${metadata[1]}/${metadata[2]}`;
      const object = objects.get(key);
      if (!object) return send(404, { error: 'File not found' });
      return send(200, { ...describe(key, object), originalFilename: object.filename });
    }
    const listing = /^\/v1\/files\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && listing) {
      probes.push(url.pathname);
      if (!authorized(listing[1])) return send(403, { error: 'Unauthorized' });
      if (state.failListings) return send(500, { error: 'Error fetching file information' });
      const prefix = `${listing[1]}/`;
      return send(
        200,
        [...objects].flatMap(([key, object]) =>
          key.startsWith(prefix) ? [describe(key, object)] : [],
        ),
      );
    }
    return send(404, {});
  });
  return { server, objects, owners, uploads, probes, state };
}

describe('generated-file snapshots in the code environment', () => {
  const fixture = createCodeApiFixture();
  const request = axios.create({ proxy: false });
  let baseURL: string;
  /** File records, as the database holds them. */
  let records: Map<string, TFile>;
  /** Primary storage, keyed by filepath. */
  let stored: Map<string, Buffer>;
  let recovery = createFileProvisionRecovery();

  const req = {
    user: { id: USER, role: 'USER' },
    app: { locals: { codeApiUploadRegistry: createCodeApiUploadRegistry() } },
    config: { endpoints: { agents: { codeApiMaxRetryWaitMs: 5000 } } },
  } as unknown as ServerRequest & { user: IUser };
  const appConfig = {
    endpoints: {
      [EModelEndpoint.agents]: {
        capabilities: [AgentCapabilities.execute_code],
      } as TAgentsEndpoint,
    },
  } as AppConfig;

  const service = createProvisionService({
    getStrategyFunctions: (source) =>
      source === FileSources.execute_code
        ? {
            /* The single-file transport lives in the api workspace; this mirrors it. */
            handleFileUpload: async ({
              req: uploader,
              stream,
              filename,
              kind,
              id,
              codeApiBaseUrl,
              onUploadStart,
            }) => {
              const form = new FormData();
              form.append('kind', kind as string);
              form.append('id', id as string);
              form.append('file', stream as Readable, { filename: filename as string });
              const response = await dispatchCodeApiUpload(
                [onUploadStart as (outcome?: 'rejected') => void],
                () =>
                  request.post(
                    `${(codeApiBaseUrl as string | undefined) ?? baseURL}/upload`,
                    form,
                    {
                      headers: {
                        ...form.getHeaders(),
                        Authorization: `Bearer ${(uploader as ServerRequest).user?.id}`,
                      },
                    },
                  ),
              );
              return {
                storage_session_id: response.data.storage_session_id,
                file_id: response.data.files[0].fileId,
                filename: response.data.files[0].filename,
              };
            },
          }
        : {
            getDownloadStream: async (_req, filepath) => {
              const bytes = stored.get(filepath);
              if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
              return Readable.from([bytes]);
            },
          },
    uploadVectors: async () => undefined,
    loadAuthValues: async () => ({}),
  });

  const fileStorage = {
    get recovery() {
      return recovery;
    },
    acquireFileProvision: jest.fn(async () => true),
    releaseFileProvision: jest.fn(async () => true),
    commitFileProvision: jest.fn(async ({ claim, code }: FileProvisionCommit) => {
      const record = records.get(claim.file_id);
      if (!record || !code) return false;
      record.metadata = {
        ...record.metadata,
        codeEnvRefs: { ...record.metadata?.codeEnvRefs, [code.routeKey]: code.ref },
        ...(code.legacyRef ? { codeEnvRef: code.legacyRef } : {}),
      };
      return true;
    }),
  };

  function addFile(name: string, content: string | Buffer, overrides: Partial<TFile> = {}): TFile {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const file_id = `file-${records.size + 1}`;
    const filepath = `/uploads/${file_id}`;
    stored.set(filepath, bytes);
    const time = Date.now() - 60_000 + records.size;
    const record = {
      file_id,
      user: USER,
      filename: name,
      filepath,
      source: FileSources.local,
      type: name.endsWith('.png') ? 'image/png' : 'text/plain',
      bytes: bytes.length,
      object: 'file',
      embedded: false,
      usage: 0,
      context: FileContext.execute_code_snapshot,
      createdAt: new Date(time),
      metadata: {
        codeDestination: true,
        sourceDispatchedAt: time,
        codeOutput: {
          messageId: 'message',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
      ...overrides,
    } as TFile;
    records.set(file_id, record);
    return record;
  }

  const snapshots = (count: number): TFile[] =>
    Array.from({ length: count }, (_, index) =>
      addFile(`edit-${index}.png`, `image bytes ${index}`),
    );

  const getFileInfoAs = (userId: string) => (ref: CodeEnvRef) =>
    getCodeFileInfo({
      ref,
      req,
      route: { baseUrl: baseURL },
      request,
      getBaseURL: () => baseURL,
      getAuthHeaders: async () => ({ Authorization: `Bearer ${userId}` }),
    });
  const getFileInfo = getFileInfoAs(USER);

  /**
   * One turn that uses the code tool: resource priming decides what is queued, the first code
   * call provisions the queue, and the live references are primed for the sandbox. Returns the
   * upload requests the turn cost and the bytes each mounted reference names.
   */
  async function turn(routeKey = 'default', apiUrl = baseURL) {
    const firstUpload = fixture.uploads.length;
    const firstProbe = fixture.probes.length;
    const attachments = [...records.values()].map((record) => structuredClone(record));
    const primed = await primeResources({
      req,
      appConfig,
      getFiles: jest.fn(async () => []),
      filterFiles: jest.fn(async ({ files }) => files),
      tool_resources: {},
      attachments: Promise.resolve(attachments),
      requestFileSet: new Set<string>(),
      agentId: 'agent',
      enabledToolResources: new Set([EToolResources.execute_code]),
      checkSessionsAlive: service.checkSessionsAlive,
      codeRouteKey: routeKey,
      codeBaseUrl: apiUrl,
      codeExecutionProfile: routeKey === 'default' ? 'default' : 'stateful',
    });
    const queued = primed.provisionState?.codeEnvFiles.map((file) => file.file_id) ?? [];
    const context: ProvisionToolContext = {
      provisionState: primed.provisionState,
      tool_resources: primed.tool_resources,
      codeExecutionContext: {
        baseUrl: apiUrl,
        executionProfile: routeKey === 'default' ? 'default' : 'stateful',
        ...(routeKey === 'default' ? {} : { executionRouteKey: routeKey }),
      },
    };
    const provisionFiles = createProvisionFilesCallback({
      req,
      fileStorage,
      agentToolContexts: new Map([['agent', context]]),
      provisionToCodeEnv: service.provisionToCodeEnv,
      provisionBatchToCodeEnv: service.provisionBatchToCodeEnv,
      provisionToVectorDB: service.provisionToVectorDB,
      updateFile: async () => ({}),
      updateCodeEnvRef: async () => ({}),
      addEmbeddedEntity: async () => ({}),
    });
    let error: unknown;
    try {
      await provisionFiles([Constants.EXECUTE_CODE], 'agent');
    } catch (caught) {
      error = caught;
    }
    const { selected } = await selectCodeFiles({
      files: [...records.values()].map((record) => structuredClone(record)),
      routeKey,
      identity: { userId: USER, agentId: 'agent' },
      getFileInfo,
    });
    const mounted = new Map<string, Buffer | undefined>();
    for (const entry of selected) {
      if (!entry.isActive || !entry.ref) continue;
      mounted.set(
        entry.file.file_id,
        fixture.objects.get(`${entry.ref.storage_session_id}/${entry.ref.file_id}`)?.bytes,
      );
    }
    return {
      error,
      queued,
      mounted,
      selected,
      uploads: fixture.uploads.slice(firstUpload),
      probes: fixture.probes.slice(firstProbe),
    };
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      fixture.server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    records = new Map();
    stored = new Map();
    recovery = createFileProvisionRecovery();
    fixture.objects.clear();
    fixture.owners.clear();
    fixture.uploads.length = 0;
    fixture.probes.length = 0;
    fixture.state.refuse = 0;
    fixture.state.retryAfterSeconds = 1;
    fixture.state.rejectNames.clear();
    fixture.state.omitNames.clear();
    fixture.state.failListings = false;
    jest.clearAllMocks();
  });

  const expectStoredBytes = (mounted: Map<string, Buffer | undefined>, files: TFile[]) => {
    expect(mounted.size).toBe(files.length);
    for (const file of files) {
      expect(mounted.get(file.file_id)).toEqual(stored.get(file.filepath));
    }
  };

  it('uploads a conversation of snapshots in one request, then not at all while unchanged', async () => {
    const files = snapshots(30);

    const first = await turn();
    expect(first.error).toBeUndefined();
    expect(first.uploads.map(({ path }) => path)).toEqual(['/v1/upload/batch']);
    expect(first.uploads[0].files).toHaveLength(30);
    expect(new Set([...fixture.objects.keys()].map((key) => key.split('/')[0])).size).toBe(1);
    expect(new Set([...fixture.objects.keys()]).size).toBe(30);
    expectStoredBytes(first.mounted, files);

    for (let pass = 0; pass < 3; pass++) {
      const next = await turn();
      expect(next.error).toBeUndefined();
      expect(next.queued).toEqual([]);
      expect(next.uploads).toEqual([]);
      expectStoredBytes(next.mounted, files);
    }
  });

  it('uploads only what a later turn adds', async () => {
    const files = snapshots(3);
    await turn();
    const added = addFile('edit-new.png', 'a later edit');

    const next = await turn();
    expect(next.queued).toEqual([added.file_id]);
    expect(next.uploads).toHaveLength(1);
    expect(next.uploads[0].files).toEqual(['edit-new.png']);
    expectStoredBytes(next.mounted, [...files, added]);
    expect((await turn()).uploads).toEqual([]);
  });

  it('restores the snapshot bytes over a sandbox copy that changed', async () => {
    const files = snapshots(4);
    await turn();
    const changed = records.get(files[1].file_id)!.metadata!.codeEnvRefs!.default!;
    const key = `${changed.storage_session_id}/${changed.file_id}`;
    fixture.objects.get(key)!.bytes = Buffer.from('rewritten by later code');

    /* A fresh receipt is not probed at admission, so priming is what refuses the object. */
    const refused = await turn();
    expect(refused.uploads).toEqual([]);
    expect(refused.mounted.has(files[1].file_id)).toBe(false);
    expect(refused.selected.find(({ file }) => file.file_id === files[1].file_id)).toMatchObject({
      ref: undefined,
      isActive: false,
      sandboxName: 'edit-1.png',
    });
    expect(refused.mounted.size).toBe(3);

    /* Past the liveness window the session listing answers, and the queue restores it. */
    for (const record of records.values()) {
      record.metadata!.codeEnvRefs!.default!.provisionedAt = Date.now() - 7 * HOUR;
    }
    const restored = await turn();
    expect(restored.queued).toEqual([files[1].file_id]);
    expect(restored.uploads).toHaveLength(1);
    expect(restored.uploads[0].files).toEqual(['edit-1.png']);
    expect(restored.probes.filter((path) => path.startsWith('/v1/files/'))).toHaveLength(1);
    expectStoredBytes(restored.mounted, files);
    expect(fixture.objects.get(key)!.bytes).toEqual(Buffer.from('rewritten by later code'));
  });

  it('uploads again once the stored objects are older than the freshness window', async () => {
    const files = snapshots(3);
    await turn();
    for (const object of fixture.objects.values()) {
      object.lastModified = new Date(Date.now() - 24 * HOUR).toISOString();
    }
    for (const record of records.values()) {
      record.metadata!.codeEnvRefs!.default!.provisionedAt = Date.now() - 24 * HOUR;
    }

    const next = await turn();
    expect(next.queued).toHaveLength(3);
    expect(next.uploads.map(({ path }) => path)).toEqual(['/v1/upload/batch']);
    expectStoredBytes(next.mounted, files);
  });

  it('treats an unanswered probe as no proof for a snapshot, unlike an attached file', async () => {
    const attachment = addFile('notes.txt', 'attached by the user', {
      context: FileContext.message_attachment,
      metadata: { codeDestination: true },
    });
    const files = snapshots(3);
    await turn();
    for (const record of records.values()) {
      record.metadata!.codeEnvRefs!.default!.provisionedAt = Date.now() - 7 * HOUR;
    }
    fixture.state.failListings = true;

    const next = await turn();
    expect(next.error).toBeUndefined();
    expect(next.queued.sort()).toEqual(files.map((file) => file.file_id).sort());
    expect(next.uploads.map(({ path, files: sent }) => [path, sent.length])).toEqual([
      ['/v1/upload/batch', 3],
    ]);
    expectStoredBytes(next.mounted, [attachment, ...files]);
  });

  it('never reuses a receipt recorded for other content', async () => {
    const files = snapshots(2);
    await turn();
    const record = records.get(files[0].file_id)!;
    stored.set(record.filepath, Buffer.from('a different capture'));
    record.metadata!.codeOutput!.sha256 = createHash('sha256')
      .update('a different capture')
      .digest('hex');

    const next = await turn();
    expect(next.queued).toEqual([files[0].file_id]);
    expect(next.uploads).toHaveLength(1);
    expectStoredBytes(next.mounted, files);
  });

  it('keeps uploading on a route whose sandbox keeps its own copies, one request per turn', async () => {
    snapshots(5);
    const route = 'stateful:workspace';

    for (let pass = 0; pass < 2; pass++) {
      const next = await turn(route);
      expect(next.error).toBeUndefined();
      expect(next.queued).toHaveLength(5);
      expect(next.uploads.map(({ path }) => path)).toEqual(['/v1/upload/batch']);
      expect(next.selected.every(({ ref, isActive }) => ref === undefined && !isActive)).toBe(true);
    }
  });

  it('splits a turn into requests the batch endpoint accepts', async () => {
    const files = snapshots(CODE_UPLOAD_BATCH_MAX_FILES + 1);
    const oversized = addFile('declared-large.bin', 'small', {
      bytes: CODE_UPLOAD_BATCH_MAX_BYTES + 1,
    });

    const first = await turn();
    expect(first.error).toBeUndefined();
    expect(first.uploads.map(({ path, files: sent }) => [path, sent.length])).toEqual(
      expect.arrayContaining([
        ['/v1/upload/batch', CODE_UPLOAD_BATCH_MAX_FILES],
        ['/v1/upload/batch', 1],
        ['/v1/upload', 1],
      ]),
    );
    expect(first.uploads).toHaveLength(3);
    expectStoredBytes(first.mounted, files);
    expect(records.get(oversized.file_id)!.metadata!.codeEnvRefs!.default).toBeDefined();
  });

  it('streams a file whose stored bytes outgrew what a batch holds in memory', async () => {
    const large = addFile('grown.bin', Buffer.alloc(CODE_UPLOAD_BATCH_MAX_BYTES + 1024, 7), {
      bytes: 1024,
    });
    const small = addFile('small.png', 'small');

    const first = await turn();
    expect(first.error).toBeUndefined();
    expect(first.uploads.map(({ path, files: sent }) => [path, sent])).toEqual(
      expect.arrayContaining([
        ['/v1/upload', ['grown.bin']],
        ['/v1/upload/batch', ['small.png']],
      ]),
    );
    const ref = records.get(large.file_id)!.metadata!.codeEnvRefs!.default!;
    expect(fixture.objects.get(`${ref.storage_session_id}/${ref.file_id}`)!.bytes.length).toBe(
      CODE_UPLOAD_BATCH_MAX_BYTES + 1024,
    );
    expect(first.mounted.get(small.file_id)).toEqual(Buffer.from('small'));
  });

  it('waits out a short rate limit instead of failing the tool call', async () => {
    const files = snapshots(6);
    fixture.state.refuse = 1;
    fixture.state.retryAfterSeconds = 1;

    const first = await turn();
    expect(first.error).toBeUndefined();
    expect(first.uploads.map(({ status }) => status)).toEqual([429, 200]);
    expectStoredBytes(first.mounted, files);
  });

  it('reports a long rate limit once, with a known outcome, and recovers on a later turn', async () => {
    const files = snapshots(30);
    fixture.state.refuse = 1;
    fixture.state.retryAfterSeconds = 219;

    const limited = await turn();
    expect(limited.uploads.map(({ status }) => status)).toEqual([429]);
    expect(limited.error).toMatchObject({
      name: 'CodeApiRateLimitError',
      code: 'CODE_API_RATE_LIMITED',
      retryAfterMs: 219_000,
      message:
        'Code API rate limit reached while uploading 30 file(s) to the code environment (retry in 219s).',
    });
    expect(limited.error).not.toBeInstanceOf(FileProvisionOutcomeUnknownError);
    expect(
      jest
        .mocked(logger.error)
        .mock.calls.filter(([message]) => String(message).includes('provisioning failed')),
    ).toHaveLength(1);
    expect(fileStorage.releaseFileProvision).toHaveBeenCalledTimes(30);

    const recovered = await turn();
    expect(recovered.error).toBeUndefined();
    expect(recovered.uploads.map(({ path }) => path)).toEqual(['/v1/upload/batch']);
    expectStoredBytes(recovered.mounted, files);
  });

  it('knows nothing was stored when the Code API cannot be reached', async () => {
    const files = snapshots(3);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const unreachable = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/v1`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const failed = await turn('default', unreachable);
    expect(failed.error).toMatchObject({ cause: { code: 'ECONNREFUSED' } });
    expect((failed.error as { errors: unknown[] }).errors).toHaveLength(3);
    for (const reason of (failed.error as { errors: unknown[] }).errors) {
      expect(reason).not.toBeInstanceOf(FileProvisionOutcomeUnknownError);
    }
    expect(fileStorage.releaseFileProvision).toHaveBeenCalledTimes(3);
    expect(fixture.uploads).toEqual([]);

    const recovered = await turn();
    expect(recovered.error).toBeUndefined();
    expect(recovered.uploads).toHaveLength(1);
    expectStoredBytes(recovered.mounted, files);
  });

  it('fails only the file the service refused and keeps the rest', async () => {
    const files = snapshots(4);
    fixture.state.rejectNames.add('edit-2.png');

    const partial = await turn();
    expect(partial.uploads.map(({ path, status }) => [path, status])).toEqual([
      ['/v1/upload/batch', 200],
    ]);
    expect(partial.error).toMatchObject({
      message: expect.stringContaining('Failed to provision 1 file(s)'),
      cause: { message: expect.stringContaining('File size limit exceeded') },
    });
    expect(partial.mounted.size).toBe(3);

    fixture.state.rejectNames.clear();
    const next = await turn();
    expect(next.error).toBeUndefined();
    expect(next.queued).toEqual([files[2].file_id]);
    expect(next.uploads).toHaveLength(1);
    expect(next.uploads[0].files).toEqual(['edit-2.png']);
    expectStoredBytes(next.mounted, files);
  });

  it('keeps the claim of a file the service stored a batch without answering for', async () => {
    const files = snapshots(3);
    fixture.state.omitNames.add('edit-1.png');

    const partial = await turn();
    expect(partial.uploads.map(({ path, status }) => [path, status])).toEqual([
      ['/v1/upload/batch', 200],
    ]);
    expect((partial.error as { errors: unknown[] }).errors).toEqual([
      expect.any(FileProvisionOutcomeUnknownError),
    ]);
    expect(fileStorage.releaseFileProvision).toHaveBeenCalledTimes(2);
    expectStoredBytes(
      partial.mounted,
      files.filter((file) => file.file_id !== files[1].file_id),
    );

    fixture.state.omitNames.clear();
    const next = await turn();
    expect(next.queued).toEqual([files[1].file_id]);
    expect(next.uploads).toEqual([]);
    expect((next.error as { errors: unknown[] }).errors).toEqual([
      expect.any(FileProvisionOutcomeUnknownError),
    ]);
  });

  it('never holds more than one request may carry, however many records understate their size', async () => {
    const half = Math.floor(CODE_UPLOAD_BATCH_MAX_BYTES / 2);
    const files = Array.from({ length: 4 }, (_, index) =>
      addFile(`grown-${index}.bin`, Buffer.alloc(half - 1024, index + 1), { bytes: 1024 }),
    );

    const first = await turn();
    expect(first.error).toBeUndefined();
    const batches = first.uploads.filter(({ path }) => path === '/v1/upload/batch');
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toHaveLength(2);
    expect(batches[0].bytes).toBeLessThanOrEqual(CODE_UPLOAD_BATCH_MAX_BYTES + 4096);
    expect(first.uploads.filter(({ path }) => path === '/v1/upload')).toHaveLength(2);
    for (const file of files) {
      const ref = records.get(file.file_id)!.metadata!.codeEnvRefs!.default!;
      const object = fixture.objects.get(`${ref.storage_session_id}/${ref.file_id}`)!;
      expect(object.bytes.equals(stored.get(file.filepath)!)).toBe(true);
    }
  });

  it("does not mount another user's upload, which the Code API would not answer for either", async () => {
    const [file] = snapshots(1);
    await turn();
    const receipt = records.get(file.file_id)!.metadata!.codeEnvRefs!.default!;
    expect(receipt).toMatchObject({ kind: 'user', id: USER });
    await expect(getFileInfoAs('user2')(receipt)).resolves.toBeNull();

    const probes = fixture.probes.length;
    const { selected } = await selectCodeFiles({
      files: [structuredClone(records.get(file.file_id)!)],
      routeKey: 'default',
      identity: { userId: 'user2', agentId: 'agent' },
      getFileInfo: getFileInfoAs('user2'),
    });
    expect(fixture.probes).toHaveLength(probes);
    expect(selected[0]).toMatchObject({ ref: undefined, isActive: false });
    expect(selected[0].sourceRef).toEqual({ kind: 'user', id: 'user2' });
  });

  it('does not mount an upload filed under another agent, although the Code API answers for it', async () => {
    const [file] = snapshots(1);
    const [uploaded] = await service.provisionBatchToCodeEnv({
      req,
      entity_id: 'agent-other',
      route: { baseUrl: baseURL },
      files: [{ file }],
    });
    if (uploaded.status !== 'fulfilled') throw uploaded.reason;
    const receipt = uploaded.value.refUpdate.ref;
    records.get(file.file_id)!.metadata = { ...file.metadata, ...uploaded.value.referenceSet };
    expect(receipt).toMatchObject({ kind: 'agent', id: 'agent-other' });
    /* An agent session key has no user in it, so any user of the deployment may read it. */
    await expect(getFileInfoAs('user2')(receipt)).resolves.toMatchObject({
      etag: receipt.content!.md5,
      size: receipt.content!.bytes,
    });

    const probes = fixture.probes.length;
    const { selected } = await selectCodeFiles({
      files: [structuredClone(records.get(file.file_id)!)],
      routeKey: 'default',
      identity: { userId: 'user2', agentId: 'agent' },
      getFileInfo: getFileInfoAs('user2'),
    });
    expect(fixture.probes).toHaveLength(probes);
    expect(selected[0]).toMatchObject({ ref: undefined, isActive: false });
    expect(selected[0].sourceRef).toEqual({ kind: 'user', id: 'user2' });

    /* Resource priming refuses it by the same rule, so the turn files its own upload. */
    const next = await turn();
    expect(next.error).toBeUndefined();
    expect(next.queued).toEqual([file.file_id]);
    expect(next.uploads.map(({ path }) => path)).toEqual(['/v1/upload/batch']);
    expect(records.get(file.file_id)!.metadata!.codeEnvRefs!.default).toMatchObject({
      kind: 'user',
      id: USER,
    });
    expectStoredBytes(next.mounted, [file]);
    expect((await turn()).uploads).toEqual([]);
  });

  it('leaves an attached file on its existing liveness rule and batches it with snapshots', async () => {
    const attachment = addFile('notes.txt', 'attached by the user', {
      context: FileContext.message_attachment,
      metadata: { codeDestination: true },
    });
    const files = snapshots(2);

    const first = await turn();
    expect(first.uploads.map(({ path }) => path)).toEqual(['/v1/upload/batch']);
    expect(first.uploads[0].files).toHaveLength(3);
    expectStoredBytes(first.mounted, [attachment, ...files]);

    const ref = records.get(attachment.file_id)!.metadata!.codeEnvRefs!.default!;
    fixture.objects.get(`${ref.storage_session_id}/${ref.file_id}`)!.bytes = Buffer.from('edited');
    const next = await turn();
    expect(next.uploads).toEqual([]);
    expect(next.mounted.get(attachment.file_id)).toEqual(Buffer.from('edited'));
  });
});
