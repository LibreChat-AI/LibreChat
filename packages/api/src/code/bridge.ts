import { createHash } from 'node:crypto';
import {
  CODE_ENVIRONMENT_COMMAND_TIMEOUT_HARD_MAX_MS,
  CODE_WORKSPACE_ID_PATTERN,
  CODE_WORKSPACE_MAX_COUNT,
  CODE_WORKSPACE_OPERATIONS,
  isCodeWorkspaceEnvironment,
  isRepositoryInstructionDescriptor,
} from 'librechat-data-provider';
import type { CodeWorkspaceDescriptor, CodeWorkspaceOperation } from 'librechat-data-provider';

const CODE_BRIDGE_REQUEST_TIMEOUT_MS = 10_000;
// Covers 32 roots with 32 bounded action names and escaped metadata per root.
const CODE_BRIDGE_STATUS_RESPONSE_MAX_BYTES = 256 * 1024;

export type CodeBridgePrincipalType = 'deployment' | 'tenant' | 'user' | 'role' | 'group';

export type CodeBridgeWorkerBinding = {
  tenantId: string;
  principal: {
    type: CodeBridgePrincipalType;
    id: string;
  };
};

export type CodeBridgePairing = {
  protocolVersion: 1;
  workerId: string;
  code: string;
  expiresAt: string;
};

export type CodeBridgeWorkerStatus = {
  status: 'offline' | 'starting' | 'ready';
  leaseExpiresInMs?: number;
  statefulWorkspace?: boolean;
  sandboxProfile?: string;
  runtimes?: string[];
  operations?: CodeWorkspaceOperation[];
  workspaces?: CodeWorkspaceDescriptor[];
  programmaticLanguages?: ['bash'];
  maxCommandTimeoutMs?: number;
};

export type CodeBridgeFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export class CodeBridgePairingError extends Error {
  constructor(
    public readonly reason: 'rejected' | 'invalid' | 'timeout' | 'failed',
    public readonly upstreamStatus?: number,
  ) {
    super(`Code bridge pairing ${reason}`);
    this.name = 'CodeBridgePairingError';
  }
}

export class CodeBridgeLifecycleError extends Error {
  constructor(
    public readonly reason: 'rejected' | 'invalid' | 'timeout' | 'failed',
    public readonly upstreamStatus?: number,
  ) {
    super(`Code bridge lifecycle request ${reason}`);
    this.name = 'CodeBridgeLifecycleError';
  }
}

export class CodeBridgeStatusError extends Error {
  constructor(
    public readonly reason: 'rejected' | 'invalid' | 'timeout' | 'failed' | 'busy',
    public readonly upstreamStatus?: number,
  ) {
    super(`Code bridge status request ${reason}`);
    this.name = 'CodeBridgeStatusError';
  }
}

export function createCodeBridgeStatusPoller({
  fetchImpl,
  maxConcurrent = 32,
  maxEntries = 1_000,
  cacheTtlMs = 2_000,
}: {
  fetchImpl?: CodeBridgeFetch;
  maxConcurrent?: number;
  maxEntries?: number;
  cacheTtlMs?: number;
} = {}): (params: {
  baseURL: string;
  token: string;
  workerId: string;
  /** Force a new upstream request, bypassing cached results and older in-flight polls. */
  bypassCache?: boolean;
}) => Promise<CodeBridgeWorkerStatus> {
  const requests = new Map<
    string,
    { expiresAt: number; request: Promise<CodeBridgeWorkerStatus> }
  >();
  let active = 0;
  return (params) => {
    if (params.bypassCache) {
      if (active >= maxConcurrent) return Promise.reject(new CodeBridgeStatusError('busy'));
      active += 1;
      // Mutation validation needs its own observation, but still shares the polling capacity.
      return getCodeBridgeWorkerStatus({ ...params, fetchImpl }).finally(() => {
        active -= 1;
      });
    }
    const credentialId = createHash('sha256').update(params.token).digest('base64url');
    const normalizedBaseURL = params.baseURL.trim().replace(/\/+$/, '');
    const key = `${normalizedBaseURL}\u0000${params.workerId}\u0000${credentialId}`;
    const now = Date.now();
    const cached = requests.get(key);
    if (cached != null && cached.expiresAt > now) return cached.request;
    if (cached != null) requests.delete(key);
    if (active >= maxConcurrent) return Promise.reject(new CodeBridgeStatusError('busy'));
    if (requests.size >= maxEntries) {
      for (const [cachedKey, entry] of requests) {
        if (entry.expiresAt <= now) requests.delete(cachedKey);
      }
      if (requests.size >= maxEntries) {
        return Promise.reject(new CodeBridgeStatusError('busy'));
      }
    }
    active += 1;
    const startedAt = Date.now();
    const request = getCodeBridgeWorkerStatus({ ...params, fetchImpl })
      .then((status) => {
        const completedAt = Date.now();
        const ttl =
          status.leaseExpiresInMs == null
            ? cacheTtlMs
            : Math.max(
                0,
                Math.min(cacheTtlMs, status.leaseExpiresInMs - (completedAt - startedAt)),
              );
        requests.set(key, {
          expiresAt: completedAt + ttl,
          request: Promise.resolve(status),
        });
        return status;
      })
      .catch((error: unknown) => {
        requests.delete(key);
        throw error;
      })
      .finally(() => {
        active -= 1;
      });
    requests.set(key, { expiresAt: Number.POSITIVE_INFINITY, request });
    return request;
  };
}

function validStatusString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validStatusStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length <= 32 && value.every((item) => validStatusString(item))
  );
}

function validWorkspaceOperations(value: unknown): value is CodeWorkspaceOperation[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CODE_WORKSPACE_OPERATIONS.length &&
    value.every((operation) =>
      CODE_WORKSPACE_OPERATIONS.includes(operation as CodeWorkspaceOperation),
    ) &&
    new Set(value).size === value.length
  );
}

function validWorkspaceCapabilities(value: unknown): value is {
  protocolVersion: 1;
  operations: CodeWorkspaceOperation[];
  workspaces: CodeWorkspaceDescriptor[];
  programmaticLanguages?: unknown;
} {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const capabilities = value as Record<string, unknown>;
  if (
    capabilities.protocolVersion !== 1 ||
    !validWorkspaceOperations(capabilities.operations) ||
    !Array.isArray(capabilities.workspaces) ||
    capabilities.workspaces.length < 1 ||
    capabilities.workspaces.length > CODE_WORKSPACE_MAX_COUNT
  ) {
    return false;
  }
  const operations = capabilities.operations;
  const ids = new Set<string>();
  return capabilities.workspaces.every((value) => {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
    const workspace = value as Record<string, unknown>;
    if (
      Object.keys(workspace).some(
        (key) =>
          key !== 'id' &&
          key !== 'name' &&
          key !== 'operations' &&
          key !== 'workspaceInstances' &&
          key !== 'environment' &&
          key !== 'instructions',
      ) ||
      typeof workspace.id !== 'string' ||
      !CODE_WORKSPACE_ID_PATTERN.test(workspace.id) ||
      ids.has(workspace.id) ||
      (workspace.instructions !== undefined &&
        (!Array.isArray(workspace.instructions) ||
          workspace.instructions.length > 1 ||
          !workspace.instructions.every(isRepositoryInstructionDescriptor))) ||
      (workspace.environment !== undefined && !isCodeWorkspaceEnvironment(workspace.environment)) ||
      (workspace.workspaceInstances !== undefined &&
        (!Array.isArray(workspace.workspaceInstances) ||
          workspace.workspaceInstances.length !== 1 ||
          workspace.workspaceInstances[0] !== 'git_worktree')) ||
      (workspace.name !== undefined &&
        (typeof workspace.name !== 'string' ||
          workspace.name.trim().length === 0 ||
          workspace.name.length > 128)) ||
      (workspace.operations !== undefined &&
        (!validWorkspaceOperations(workspace.operations) ||
          workspace.operations.length > operations.length ||
          workspace.operations.some((operation) => !operations.includes(operation))))
    ) {
      return false;
    }
    ids.add(workspace.id);
    return true;
  });
}

/** Keep the status endpoint readable during worker-first rolling upgrades.
 * Legacy capabilities remain non-selectable and are surfaced as an explicit
 * update-required state; they never regain an implicit `primary` binding. */
function validLegacyWorkspaceCapabilities(value: unknown): value is {
  operations: CodeWorkspaceOperation[];
} {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const capabilities = value as Record<string, unknown>;
  return (
    capabilities.protocolVersion === undefined &&
    capabilities.workspaces === undefined &&
    validWorkspaceOperations(capabilities.operations)
  );
}

async function readBoundedStatusJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader == null) throw new CodeBridgeStatusError('invalid');
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > CODE_BRIDGE_STATUS_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new CodeBridgeStatusError('invalid');
    }
    json += decoder.decode(value, { stream: true });
  }
  json += decoder.decode();
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new CodeBridgeStatusError('invalid');
  }
}

export async function getCodeBridgeWorkerStatus({
  baseURL,
  token,
  workerId,
  fetchImpl = fetch,
}: {
  baseURL: string;
  token: string;
  workerId: string;
  fetchImpl?: CodeBridgeFetch;
}): Promise<CodeBridgeWorkerStatus> {
  try {
    const response = await fetchImpl(
      `${baseURL.trim().replace(/\/+$/, '')}/bridge/workers/${encodeURIComponent(workerId)}/status`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(CODE_BRIDGE_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodeBridgeStatusError('rejected', response.status);
    }
    const payload = await readBoundedStatusJson(response);
    if (typeof payload !== 'object' || payload == null) {
      throw new CodeBridgeStatusError('invalid');
    }
    const status = payload as {
      protocolVersion?: unknown;
      workerId?: unknown;
      online?: unknown;
      ready?: unknown;
      leaseExpiresInMs?: unknown;
      maxCommandTimeoutMs?: unknown;
      capabilities?: {
        statefulWorkspace?: unknown;
        sandboxProfile?: unknown;
        runtimes?: unknown;
        workspaceTools?: unknown;
      };
    };
    const capabilities = status.capabilities;
    const validLease =
      status.leaseExpiresInMs == null ||
      (typeof status.leaseExpiresInMs === 'number' &&
        Number.isSafeInteger(status.leaseExpiresInMs) &&
        status.leaseExpiresInMs > 0 &&
        status.leaseExpiresInMs <= 60_000);
    const validCommandTimeout =
      status.maxCommandTimeoutMs == null ||
      (typeof status.maxCommandTimeoutMs === 'number' &&
        Number.isSafeInteger(status.maxCommandTimeoutMs) &&
        status.maxCommandTimeoutMs >= 1 &&
        status.maxCommandTimeoutMs <= CODE_ENVIRONMENT_COMMAND_TIMEOUT_HARD_MAX_MS);
    const validCapabilities =
      capabilities == null || validStatusString(capabilities.sandboxProfile);
    const validRuntimes = capabilities == null || validStatusStringArray(capabilities.runtimes);
    const validWorkspaceTools =
      capabilities?.workspaceTools == null ||
      validWorkspaceCapabilities(capabilities.workspaceTools) ||
      validLegacyWorkspaceCapabilities(capabilities.workspaceTools);
    if (
      status.protocolVersion !== 1 ||
      status.workerId !== workerId ||
      typeof status.online !== 'boolean' ||
      typeof status.ready !== 'boolean' ||
      (status.ready && !status.online) ||
      (status.online && (status.leaseExpiresInMs == null || capabilities == null)) ||
      (!status.online && (status.leaseExpiresInMs != null || capabilities != null)) ||
      !validLease ||
      !validCommandTimeout ||
      !validCapabilities ||
      !validRuntimes ||
      !validWorkspaceTools ||
      (capabilities?.statefulWorkspace != null &&
        typeof capabilities.statefulWorkspace !== 'boolean')
    ) {
      throw new CodeBridgeStatusError('invalid');
    }
    let workerStatus: CodeBridgeWorkerStatus['status'] = 'offline';
    if (status.online) {
      workerStatus = status.ready ? 'ready' : 'starting';
    }
    let workspaceStatus: Pick<
      CodeBridgeWorkerStatus,
      'operations' | 'workspaces' | 'programmaticLanguages'
    > = {};
    if (validWorkspaceCapabilities(capabilities?.workspaceTools)) {
      workspaceStatus = {
        operations: [...capabilities.workspaceTools.operations],
        workspaces: capabilities.workspaceTools.workspaces.map((workspace) => ({
          ...workspace,
          ...(workspace.operations ? { operations: [...workspace.operations] } : {}),
        })),
      };
      if (
        Array.isArray(capabilities.workspaceTools.programmaticLanguages) &&
        capabilities.workspaceTools.programmaticLanguages.every(
          (language) => typeof language === 'string',
        ) &&
        capabilities.workspaceTools.programmaticLanguages.includes('bash')
      ) {
        workspaceStatus.programmaticLanguages = ['bash'];
      }
    } else if (validLegacyWorkspaceCapabilities(capabilities?.workspaceTools)) {
      workspaceStatus = { operations: [...capabilities.workspaceTools.operations] };
    }
    return {
      status: workerStatus,
      ...(typeof capabilities?.statefulWorkspace === 'boolean'
        ? { statefulWorkspace: capabilities.statefulWorkspace }
        : {}),
      ...(typeof status.leaseExpiresInMs !== 'number'
        ? {}
        : { leaseExpiresInMs: status.leaseExpiresInMs }),
      ...(typeof status.maxCommandTimeoutMs !== 'number'
        ? {}
        : { maxCommandTimeoutMs: status.maxCommandTimeoutMs }),
      ...(typeof capabilities?.sandboxProfile !== 'string'
        ? {}
        : { sandboxProfile: capabilities.sandboxProfile }),
      ...(validStatusStringArray(capabilities?.runtimes)
        ? { runtimes: capabilities.runtimes }
        : {}),
      ...workspaceStatus,
    };
  } catch (error) {
    if (error instanceof CodeBridgeStatusError) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new CodeBridgeStatusError('timeout');
    }
    throw new CodeBridgeStatusError('failed');
  }
}

function validPairing(value: unknown, workerId: string): value is CodeBridgePairing {
  if (typeof value !== 'object' || value == null) return false;
  const pairing = value as Partial<CodeBridgePairing>;
  const expiresAt = typeof pairing.expiresAt === 'string' ? Date.parse(pairing.expiresAt) : NaN;
  return (
    pairing.protocolVersion === 1 &&
    pairing.workerId === workerId &&
    typeof pairing.code === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(pairing.code) &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now()
  );
}

export async function createCodeBridgePairing({
  baseURL,
  token,
  workerId,
  binding,
  fetchImpl = fetch,
}: {
  baseURL: string;
  token: string;
  workerId: string;
  binding?: CodeBridgeWorkerBinding;
  fetchImpl?: CodeBridgeFetch;
}): Promise<CodeBridgePairing> {
  try {
    const response = await fetchImpl(`${baseURL.trim().replace(/\/+$/, '')}/bridge/pairings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workerId, ...(binding != null ? { binding } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(CODE_BRIDGE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new CodeBridgePairingError('rejected', response.status);
    }
    const payload = (await response.json()) as unknown;
    if (!validPairing(payload, workerId)) {
      throw new CodeBridgePairingError('invalid');
    }
    return payload;
  } catch (error) {
    if (error instanceof CodeBridgePairingError) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new CodeBridgePairingError('timeout');
    }
    throw new CodeBridgePairingError('failed');
  }
}

export async function revokeCodeBridgeWorker({
  baseURL,
  token,
  workerId,
  fetchImpl = fetch,
}: {
  baseURL: string;
  token: string;
  workerId: string;
  fetchImpl?: CodeBridgeFetch;
}): Promise<void> {
  try {
    const response = await fetchImpl(
      `${baseURL.trim().replace(/\/+$/, '')}/bridge/workers/${encodeURIComponent(workerId)}/revoke`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(CODE_BRIDGE_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new CodeBridgeLifecycleError('rejected', response.status);
    }
    const payload = (await response.json()) as unknown;
    if (
      typeof payload !== 'object' ||
      payload == null ||
      (payload as { protocolVersion?: unknown }).protocolVersion !== 1 ||
      (payload as { revoked?: unknown }).revoked !== true
    ) {
      throw new CodeBridgeLifecycleError('invalid');
    }
  } catch (error) {
    if (error instanceof CodeBridgeLifecycleError) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new CodeBridgeLifecycleError('timeout');
    }
    throw new CodeBridgeLifecycleError('failed');
  }
}

export function readCodeBridgeSecret(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
}
