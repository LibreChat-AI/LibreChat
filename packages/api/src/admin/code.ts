import { EModelEndpoint, isSecureCodeEnvironmentControlURL } from 'librechat-data-provider';

import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';

import { getCodeApiTenantId } from '~/auth/codeapi';

const CODE_BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

type AgentsEndpointConfig = NonNullable<AppConfig['endpoints']>[EModelEndpoint.agents];
type StatefulCodeSessionsConfig = NonNullable<
  NonNullable<AgentsEndpointConfig>['statefulCodeSessions']
>;
type ConfiguredCodeEnvironment = NonNullable<StatefulCodeSessionsConfig['environments']>[number];
type FetchImpl = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

interface CodePairingResponse {
  protocolVersion: number;
  workerId: string;
  code: string;
  expiresAt: string;
}

interface CodeRevocationResponse {
  protocolVersion: number;
  revoked: true;
}

export interface AdminCodeEnvironmentDeps {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  resolveTenantId?: (req: ServerRequest) => string;
  readSecret?: (name: string) => string | undefined;
  fetchImpl?: FetchImpl;
}

function environmentId(req: ServerRequest): string {
  const params = req.params as { environmentId?: string };
  return params.environmentId?.trim() ?? '';
}

function findEnvironment(appConfig: AppConfig, id: string): ConfiguredCodeEnvironment | undefined {
  return appConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments?.find(
    (environment) => environment.id === id,
  );
}

function pairingConfig(environment: ConfiguredCodeEnvironment):
  | {
      workerId: string;
      tokenEnv: string;
    }
  | undefined {
  if (environment.type !== 'attached' || environment.owner !== 'deployment') {
    return undefined;
  }
  const pairing = environment.pairing;
  if (pairing?.workerId == null) {
    return undefined;
  }
  return { workerId: pairing.workerId, tokenEnv: pairing.tokenEnv };
}

function bridgeUrl(environment: ConfiguredCodeEnvironment, path: string): string {
  return `${environment.baseURL.trim().replace(/\/+$/, '')}${path}`;
}

function validPairingResponse(value: unknown, workerId: string): value is CodePairingResponse {
  if (typeof value !== 'object' || value == null) return false;
  const response = value as Partial<CodePairingResponse>;
  const expiresAt = typeof response.expiresAt === 'string' ? Date.parse(response.expiresAt) : NaN;
  return (
    response.protocolVersion === 1 &&
    response.workerId === workerId &&
    typeof response.code === 'string' &&
    /^[A-Za-z0-9_-]{32}$/.test(response.code) &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now()
  );
}

function validRevocationResponse(value: unknown): value is CodeRevocationResponse {
  if (typeof value !== 'object' || value == null) return false;
  const response = value as Partial<CodeRevocationResponse>;
  return response.protocolVersion === 1 && response.revoked === true;
}

export function createAdminCodeEnvironmentHandlers(deps: AdminCodeEnvironmentDeps): {
  createPairing: (req: ServerRequest, res: Response) => Promise<Response>;
  revokeWorker: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveTenantId = deps.resolveTenantId ?? getCodeApiTenantId;
  const readSecret =
    deps.readSecret ??
    ((name: string) =>
      Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined);

  async function resolve(
    req: ServerRequest,
    res: Response,
  ): Promise<
    | {
        id: string;
        environment: ConfiguredCodeEnvironment;
        pairing: { workerId: string; tokenEnv: string };
        token: string;
      }
    | Response
  > {
    const id = environmentId(req);
    /** Pairing credentials are deployment control-plane state. Resolve only
     * YAML-backed configuration; writable database overrides must never
     * choose tokenEnv or the outbound destination. */
    const appConfig = await deps.getAppConfig({ baseOnly: true });
    const environment = findEnvironment(appConfig, id);
    if (environment == null) {
      return res.status(404).json({ error: 'Code environment was not found' });
    }
    const pairing = pairingConfig(environment);
    if (pairing == null) {
      return res.status(409).json({ error: 'Code environment does not support pairing' });
    }
    if (!isSecureCodeEnvironmentControlURL(environment.baseURL)) {
      return res.status(409).json({ error: 'Code environment pairing requires secure transport' });
    }
    const token = readSecret(pairing.tokenEnv)?.trim();
    if (!token) {
      return res.status(503).json({ error: 'Code environment pairing is not configured' });
    }
    return { id, environment, pairing, token };
  }

  async function createPairing(req: ServerRequest, res: Response): Promise<Response> {
    const resolved = await resolve(req, res);
    if ('statusCode' in resolved) return resolved;
    let tenantId: string;
    try {
      tenantId = resolveTenantId(req);
    } catch {
      return res.status(503).json({ error: 'Code environment tenant context is unavailable' });
    }
    try {
      const response = await fetchImpl(bridgeUrl(resolved.environment, '/bridge/pairings'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolved.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workerId: resolved.pairing.workerId,
          binding: {
            tenantId,
            principal: { type: 'deployment', id: resolved.id },
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(CODE_BRIDGE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return res.status(502).json({
          error: 'Code API rejected the pairing request',
          upstreamStatus: response.status,
        });
      }
      const payload = (await response.json()) as unknown;
      if (!validPairingResponse(payload, resolved.pairing.workerId)) {
        return res.status(502).json({ error: 'Code API returned an invalid pairing response' });
      }
      return res.status(200).json({
        environmentId: resolved.id,
        workerId: payload.workerId,
        code: payload.code,
        expiresAt: payload.expiresAt,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut ? 'Code API pairing request timed out' : 'Code API pairing request failed',
      });
    }
  }

  async function revokeWorker(req: ServerRequest, res: Response): Promise<Response> {
    const resolved = await resolve(req, res);
    if ('statusCode' in resolved) return resolved;
    try {
      const workerId = encodeURIComponent(resolved.pairing.workerId);
      const response = await fetchImpl(
        bridgeUrl(resolved.environment, `/bridge/workers/${workerId}/revoke`),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resolved.token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
          redirect: 'error',
          signal: AbortSignal.timeout(CODE_BRIDGE_REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        return res.status(502).json({
          error: 'Code API rejected the revocation request',
          upstreamStatus: response.status,
        });
      }
      const payload = (await response.json()) as unknown;
      if (!validRevocationResponse(payload)) {
        return res.status(502).json({ error: 'Code API returned an invalid revocation response' });
      }
      return res.status(200).json({
        environmentId: resolved.id,
        workerId: resolved.pairing.workerId,
        revoked: true,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut
          ? 'Code API revocation request timed out'
          : 'Code API revocation request failed',
      });
    }
  }

  return { createPairing, revokeWorker };
}
