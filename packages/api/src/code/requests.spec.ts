import { codeEnvironmentAdmissionSchema } from 'librechat-data-provider';
import { executeWorkspaceTool } from './workspace';

const request = {
  protocolVersion: 1 as const,
  operation: 'read_file' as const,
  workspaceId: 'root',
  path: 'README.md',
};
const result = { ...request, content: 'hello', startLine: 1, endLine: 1, truncated: false };
const requestId = 'durable-request-000001';
const input = {
  baseURL: 'https://code.example/v1',
  request,
  requestId,
  authHeaders: () => ({ Authorization: 'fresh' }),
  maxQueueWaitMs: 1000,
  admission: codeEnvironmentAdmissionSchema.parse({ durableRequests: true, pollIntervalMs: 100 }),
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const status = (state: string) =>
  json({ requestId, state, ...(state === 'completed' ? { result } : {}) }, 202);

test('keeps one logical request across admission polls, with refreshed credentials', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(status('admitted'))
    .mockResolvedValueOnce(status('completed'));
  const authHeaders = jest.fn(input.authHeaders);
  expect(await executeWorkspaceTool({ ...input, authHeaders, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual([
    'GET',
    'POST',
    'GET',
    'GET',
  ]);
  expect(fetchImpl.mock.calls[1][1].headers['X-LibreChat-Workspace-Request-Id']).toBe(requestId);
  expect(authHeaders).toHaveBeenCalledTimes(4);
});

test('recovers a lost submission response by lookup without rejoining admission', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockRejectedValueOnce(new TypeError('lost response'))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('falls back only when capability discovery explicitly says unsupported', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(json(result));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  expect(fetchImpl.mock.calls[1][0]).toBe('https://code.example/v1/workspace-tools/execute');
});

test('never falls back or resubmits a previously observed handle after a missing lookup', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(json({}, 404));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toThrow('invalid');
  expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

test('abort cancels the same handle with an independent signal', async () => {
  const controller = new AbortController();
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockImplementationOnce(async () => {
      controller.abort();
      return status('queued');
    })
    .mockResolvedValueOnce(status('cancelled'));
  await expect(
    executeWorkspaceTool({ ...input, signal: controller.signal, fetchImpl }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl.mock.calls[2][0]).toContain(requestId);
  expect(fetchImpl.mock.calls[2][1].method).toBe('DELETE');
  expect(fetchImpl.mock.calls[2][1].signal.aborted).toBe(false);
});

test('terminal upstream diagnostics do not expose submitted content', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(
      json(
        {
          requestId,
          state: 'failed',
          error: { code: 'ASSIGNMENT_EXPIRED', message: 'secret command' },
        },
        202,
      ),
    );
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.not.toThrow('secret command');
});

test('a short transport ceiling does not consume the execution reserve on durable servers', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockResolvedValueOnce(status('queued'))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, maxRequestTimeoutMs: 1000, fetchImpl })).toEqual(
    result,
  );
});

test('malformed discovery fails closed instead of dispatching synchronously', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(json({ unsupported: true }));
  await expect(executeWorkspaceTool({ ...input, fetchImpl })).rejects.toThrow('invalid');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('lost submission with absent lookup retries only the identical request identity', async () => {
  const fetchImpl = jest
    .fn()
    .mockResolvedValueOnce(json({ durableWorkspaceRequests: 1 }))
    .mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(status('completed'));
  expect(await executeWorkspaceTool({ ...input, fetchImpl })).toEqual(result);
  const posts = fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0][1].headers['X-LibreChat-Workspace-Request-Id']).toBe(
    posts[1][1].headers['X-LibreChat-Workspace-Request-Id'],
  );
  expect(posts[0][1].body).toBe(posts[1][1].body);
});

test('rejects a run unable to reserve the complete execution budget before submission', async () => {
  const fetchImpl = jest.fn();
  await expect(
    executeWorkspaceTool({ ...input, maxRunTimeoutMs: 1000, fetchImpl }),
  ).rejects.toThrow('cannot fit');
  expect(fetchImpl).not.toHaveBeenCalled();
});
