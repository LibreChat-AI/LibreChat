import axios from 'axios';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { CodeEnvRef, TFile } from 'librechat-data-provider';
import type { AddressInfo } from 'node:net';
import type { ServerRequest } from '~/types';
import { getCodeFileInfo, selectCodeFiles } from '../code/priming';
import { createCodeApiUploadRegistry } from '~/utils/code';
import { createProvisionService } from './service';

jest.mock('~/auth/codeapi', () => ({
  getCodeApiAuthHeaders: jest.fn(async () => ({})),
}));

const SESSION = 'retained-session';
const timestamp = new Date().toISOString();

function retainedFile(index: number): TFile {
  return {
    file_id: `local-${index}`,
    user: 'owner',
    filename: `report-${index}.csv`,
    filepath: `/stored/report-${index}.csv`,
    type: 'text/csv',
    source: FileSources.local,
    ...(index % 2 === 0 ? { context: FileContext.execute_code } : {}),
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: 'owner',
        storage_session_id: SESSION,
        file_id: `remote.${index}`,
      },
    },
  } as TFile;
}

describe('Code API summary liveness over HTTP', () => {
  let summary: unknown;
  let status: number;
  let requests: string[];
  let uploadedBodies: Buffer[];
  let objectTimestamp: string;
  let baseURL: string;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === `/v1/files/${SESSION}`) {
      response.writeHead(status).end(JSON.stringify(summary));
    } else if (url.pathname.startsWith(`/v1/sessions/${SESSION}/objects/`)) {
      response.end(JSON.stringify({ lastModified: objectTimestamp }));
    } else if (request.method === 'POST' && url.pathname === '/v1/upload') {
      uploadedBodies.push(await buffer(request));
      response.end(JSON.stringify({ storage_session_id: SESSION, file_id: 'restored' }));
    } else {
      response.writeHead(404).end('{}');
    }
  });
  const req = {
    user: { id: 'owner' },
    app: { locals: { codeApiUploadRegistry: createCodeApiUploadRegistry() } },
  } as unknown as ServerRequest;
  const request = axios.create({ proxy: false });
  const service = createProvisionService({
    getStrategyFunctions: (source) =>
      source === FileSources.execute_code
        ? {
            handleFileUpload: async ({ stream }) => {
              const response = await request.post(
                `${baseURL}/upload`,
                await buffer(stream as Readable),
              );
              return response.data;
            },
          }
        : { getDownloadStream: async () => Readable.from('immutable stored bytes') },
    uploadVectors: async () => undefined,
    loadAuthValues: async () => ({}),
  });
  const getFileInfo = (ref: CodeEnvRef) =>
    getCodeFileInfo({
      ref,
      req,
      route: { baseUrl: baseURL },
      request,
      getBaseURL: () => baseURL,
      getAuthHeaders: async () => ({}),
    });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    status = 200;
    objectTimestamp = timestamp;
    summary = [];
    requests = [];
    uploadedBodies = [];
  });

  it.each(['canonical', 'legacy', 'hosted'])(
    'retains 30 %s user/legacy files without uploading again',
    async (layout) => {
      const files = Array.from({ length: 30 }, (_, index) => retainedFile(index));
      summary = files.map((file) => {
        const id = file.metadata!.codeEnvRef!.file_id;
        return layout === 'hosted'
          ? { fileId: id }
          : {
              name:
                layout === 'canonical'
                  ? `${SESSION}/.codeapi-objects/${Buffer.from(id).toString('base64url')}`
                  : `${SESSION}/${id}.csv`,
              size: 22,
              lastModified: timestamp,
              etag: 'opaque',
            };
      });

      const retained = await service.checkSessionsAlive({ files, req, baseURL });
      for (const file of files) {
        if (!retained.has(file.file_id)) {
          await service.provisionToCodeEnv({ req, file, route: { baseUrl: baseURL } });
        }
      }
      const { selected } = await selectCodeFiles({ files, routeKey: 'default', getFileInfo });

      expect(uploadedBodies).toHaveLength(0);
      expect(retained.size).toBe(30);
      expect(selected).toHaveLength(30);
      expect(selected.every((file) => file.isActive)).toBe(true);
      expect(requests.filter((url) => url.startsWith('GET /v1/files/'))).toEqual([
        `GET /v1/files/${SESSION}?detail=summary&kind=user&id=owner`,
      ]);
    },
  );

  it.each([200, 404])(
    'restores genuinely missing files after a %s response',
    async (responseStatus) => {
      status = responseStatus;
      const file = retainedFile(1);
      const retained = await service.checkSessionsAlive({ files: [file], req, baseURL });
      expect(retained.has(file.file_id)).toBe(false);
      const result = await service.provisionToCodeEnv({ req, file, route: { baseUrl: baseURL } });
      expect(uploadedBodies).toEqual([Buffer.from('immutable stored bytes')]);
      expect(result.refUpdate.ref).toMatchObject({
        file_id: 'restored',
        provisionedAt: expect.any(Number),
      });
    },
  );

  it.each([401, 403, 429, 500])(
    'keeps unknown refs after %s without treating a response body as proof',
    async (responseStatus) => {
      status = responseStatus;
      summary = [{ fileId: 'remote.1' }];
      const file = retainedFile(1);
      const retained = await service.checkSessionsAlive({ files: [file], req, baseURL });
      expect(retained.has(file.file_id)).toBe(true);
      expect(file.metadata!.codeEnvRef!.provisionedAt).toBeUndefined();
      expect(uploadedBodies).toHaveLength(0);
    },
  );

  it('restores an expired legacy object from stored bytes instead of trusting its path', async () => {
    objectTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const file = retainedFile(1);
    const { selected } = await selectCodeFiles({ files: [file], routeKey: 'default', getFileInfo });
    expect(selected[0].isActive).toBe(false);
    await service.provisionToCodeEnv({ req, file: selected[0].file, route: { baseUrl: baseURL } });
    expect(uploadedBodies).toEqual([Buffer.from('immutable stored bytes')]);
  });

  it('never reuses a live path receipt as proof of immutable snapshot bytes', async () => {
    const file = { ...retainedFile(1), context: FileContext.execute_code_snapshot };
    file.metadata!.codeEnvRef!.provisionedAt = Date.now();
    const getInfo = jest.fn(getFileInfo);
    const { selected } = await selectCodeFiles({
      files: [file],
      routeKey: 'default',
      getFileInfo: getInfo,
    });
    expect(selected[0]).toMatchObject({ ref: undefined, isActive: false });
    expect(getInfo).not.toHaveBeenCalled();
    await service.provisionToCodeEnv({ req, file: selected[0].file, route: { baseUrl: baseURL } });
    expect(uploadedBodies).toEqual([Buffer.from('immutable stored bytes')]);
  });
});
