import {
  isBrowserEnrollmentApproval,
  isBrowserEnrollmentStatusRequest,
  isBrowserEnrollmentRedemption,
} from '@librechat/code/browser-enrollment';
import type {
  BrowserEnrollmentApproval,
  BrowserEnrollmentRedemptionContract,
} from '@librechat/code/browser-enrollment';
import type { CodeBridgeFetch } from '../bridge';

export type SetupCredential = {
  protocolVersion: 1;
  workerId: string;
  credential: string;
  expiresAt: string;
};

export class SetupBridgeError extends Error {
  constructor(public readonly status: number) {
    super('Code API enrollment is unavailable');
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader == null) throw new SetupBridgeError(502);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024) throw new SetupBridgeError(502);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new SetupBridgeError(502);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Only this projection crosses the strict Code API status/redemption boundary. */
export function setupRedemptionContract(
  approval: BrowserEnrollmentRedemptionContract,
): BrowserEnrollmentRedemptionContract {
  return {
    operation: 'enrollment.redeem',
    serverId: approval.serverId,
    instance: approval.instance,
    attemptId: approval.attemptId,
    requestHash: approval.requestHash,
    workerId: approval.workerId,
    expiresAt: approval.expiresAt,
  };
}

export function createSetupBridge(fetchImpl: CodeBridgeFetch = fetch) {
  async function request(
    baseURL: string,
    token: string,
    path: string,
    body?: object,
  ): Promise<unknown> {
    try {
      const response = await fetchImpl(`${baseURL}/bridge/enrollments${path}`, {
        method: body == null ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SetupBridgeError(response.status);
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof SetupBridgeError) throw error;
      throw new SetupBridgeError(503);
    }
  }

  return {
    async capabilities(baseURL: string, token: string): Promise<string> {
      const payload = await request(baseURL, token, '/capabilities');
      if (
        !record(payload) ||
        payload.browserEnrollmentVersion !== 1 ||
        typeof payload.serverId !== 'string'
      )
        throw new SetupBridgeError(502);
      const server = new URL(payload.serverId);
      if (
        server.protocol !== 'https:' ||
        server.origin !== payload.serverId ||
        server.origin !== new URL(baseURL).origin
      )
        throw new SetupBridgeError(502);
      return payload.serverId;
    },
    async issue(
      baseURL: string,
      token: string,
      approval: BrowserEnrollmentApproval,
    ): Promise<void> {
      if (!isBrowserEnrollmentApproval(approval)) throw new SetupBridgeError(502);
      const payload = await request(baseURL, token, '', approval);
      if (
        !isBrowserEnrollmentApproval(payload) ||
        JSON.stringify(setupRedemptionContract(payload)) !==
          JSON.stringify(setupRedemptionContract(approval)) ||
        payload.publicKey !== approval.publicKey ||
        payload.binding.tenantId !== approval.binding.tenantId ||
        payload.binding.principal.type !== approval.binding.principal.type ||
        payload.binding.principal.id !== approval.binding.principal.id
      )
        throw new SetupBridgeError(502);
    },
    async status(
      baseURL: string,
      token: string,
      approval: BrowserEnrollmentRedemptionContract,
    ): Promise<'pending' | 'completed' | 'revoked' | 'unknown'> {
      const body = { protocolVersion: 1 as const, ...setupRedemptionContract(approval) };
      if (!isBrowserEnrollmentStatusRequest(body)) throw new SetupBridgeError(502);
      let payload: unknown;
      try {
        payload = await request(baseURL, token, '/status', body);
      } catch (error) {
        if (error instanceof SetupBridgeError && error.status === 409) return 'unknown';
        throw error;
      }
      if (
        !record(payload) ||
        payload.protocolVersion !== 1 ||
        payload.workerId !== approval.workerId ||
        !['pending', 'completed', 'revoked'].includes(String(payload.status))
      )
        throw new SetupBridgeError(502);
      return payload.status as 'pending' | 'completed' | 'revoked';
    },
    async redeem(
      baseURL: string,
      token: string,
      approval: BrowserEnrollmentRedemptionContract,
      signature: string,
    ): Promise<SetupCredential> {
      const body = { protocolVersion: 1 as const, ...setupRedemptionContract(approval), signature };
      if (!isBrowserEnrollmentRedemption(body)) throw new SetupBridgeError(502);
      const payload = await request(baseURL, token, '/redeem', body);
      if (
        !record(payload) ||
        payload.protocolVersion !== 1 ||
        payload.workerId !== approval.workerId ||
        typeof payload.credential !== 'string' ||
        payload.credential.length < 32 ||
        payload.credential.length > 4096 ||
        typeof payload.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(payload.expiresAt)) ||
        Date.parse(payload.expiresAt) <= Date.now()
      )
        throw new SetupBridgeError(502);
      return {
        protocolVersion: 1,
        workerId: approval.workerId,
        credential: payload.credential,
        expiresAt: payload.expiresAt,
      };
    },
  };
}

export type SetupBridge = ReturnType<typeof createSetupBridge>;
