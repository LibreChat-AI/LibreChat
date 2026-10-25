import { Keyv } from 'keyv';
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { runAsSystem } from '@librechat/data-schemas';
import { ViolationTypes } from 'librechat-data-provider';
import {
  isBrowserEnrollmentRequest,
  isBrowserSetupProof,
  isBrowserEnrollmentSignature,
  isBrowserEnrollmentToken,
  hashBrowserEnrollmentRequest,
  canonicalBrowserEnrollmentRequest,
  verifyBrowserSetupProof,
  verifyBrowserEnrollmentRedemption,
} from '@librechat/code/browser-enrollment';
import type {
  BrowserSetupSession,
  BrowserSetupBackend,
  BrowserSetupStore,
} from '@librechat/data-schemas';
import type {
  BrowserSetupProof,
  BrowserEnrollmentRequest,
} from '@librechat/code/browser-enrollment';
import type { RequestHandler, Request, Response } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import type { SetupRegistry, SetupService } from './service';
import type { GetAppConfigOptions } from '~/app/service';
import type { SetupConfig } from './policy';
import { isCodeApiJwtAuthEnabled, assertCodeApiJwtSigningReady } from '~/auth/codeapi';
import { createSetupPolicy, readSetupConfig, SetupPolicyError } from './policy';
import { readCodeBridgeSecret, revokeCodeBridgeWorker } from '../bridge';
import { createSetupBridge, SetupBridgeError } from './bridge';
import { createSetupService, SetupError } from './service';
import { isEnabled } from '~/utils/common';
import { keyvMongo } from '~/cache';

interface SetupRouterDependencies {
  backend: BrowserSetupBackend;
  signal?: AbortSignal;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  registry: () => SetupRegistry;
  requireJwtAuth: RequestHandler;
  requireSameOrigin: RequestHandler;
  checkBan: RequestHandler;
  banStore: { get: (key: string) => Promise<unknown> };
}

type MachineBody = {
  request: BrowserEnrollmentRequest;
  proof: BrowserSetupProof;
  signature: string;
  redemptionSignature?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseBody(value: unknown, operation: BrowserSetupProof['operation']): MachineBody {
  const keys =
    operation === 'setup.complete'
      ? ['request', 'proof', 'signature', 'redemptionSignature']
      : ['request', 'proof', 'signature'];
  if (
    !record(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !isBrowserEnrollmentRequest(value.request) ||
    !isBrowserSetupProof(value.proof) ||
    !isBrowserEnrollmentSignature(value.signature)
  )
    throw new SetupError(400, 'SETUP_PROOF_INVALID');
  const { request, proof, signature } = value;
  if (
    proof.operation !== operation ||
    proof.instance !== request.instance ||
    proof.attemptId !== request.attemptId ||
    proof.requestHash !== hashBrowserEnrollmentRequest(request) ||
    !verifyBrowserSetupProof(request.publicKey, proof, signature)
  )
    throw new SetupError(401, 'SETUP_PROOF_INVALID');
  if (operation === 'setup.complete' && !isBrowserEnrollmentSignature(value.redemptionSignature))
    throw new SetupError(400, 'SETUP_PROOF_INVALID');
  return {
    request,
    proof,
    signature,
    ...(typeof value.redemptionSignature === 'string'
      ? { redemptionSignature: value.redemptionSignature }
      : {}),
  };
}

function sendError(error: unknown, res: Response): void {
  if (res.headersSent) return;
  res.set('Cache-Control', 'no-store');
  if (error instanceof SetupError) {
    if (error.status === 429) res.set('Retry-After', '60');
    res.status(error.status).json({ code: error.code });
    return;
  }
  if (error instanceof SetupPolicyError) {
    res.status(error.code === 'SETUP_UNAVAILABLE' ? 503 : 403).json({ code: error.code });
    return;
  }
  if (error instanceof SetupBridgeError) {
    res.status(503).json({ code: 'SETUP_RETRY_REQUIRED' });
    return;
  }
  res.status(503).json({ code: 'SETUP_RETRY_REQUIRED' });
}

/** Browser routes keep every normal auth gate. Machine proofs never enter that middleware. */
export function createCodeSetupRouter(deps: SetupRouterDependencies): Router {
  const router = Router();
  let banCache: Keyv | undefined;
  let runtime:
    | {
        service: SetupService;
        store: BrowserSetupStore;
        policy: ReturnType<typeof createSetupPolicy>;
      }
    | undefined;
  let nextSweep = 0;
  let sweeping = false;

  function getRuntime(): NonNullable<typeof runtime> {
    if (runtime != null) return runtime;
    const store = deps.backend.createStore();
    const policy = createSetupPolicy({
      getAppConfig: deps.getAppConfig,
      principalAuthEnabled: isCodeApiJwtAuthEnabled,
      principalAuthReady: assertCodeApiJwtSigningReady,
      getUser: deps.backend.getUser,
      userIsBanned: async (id) => {
        if (!isEnabled(process.env.BAN_VIOLATIONS)) return false;
        banCache ??= new Keyv({ store: keyvMongo, namespace: ViolationTypes.BAN, ttl: 0 });
        const [cached, logged] = await Promise.all([banCache.get(id), deps.banStore.get(id)]);
        return [cached, logged].some(
          (value) =>
            value != null &&
            (!record(value) ||
              value.expiresAt == null ||
              !Number.isFinite(Number(value.expiresAt)) ||
              Number(value.expiresAt) > Date.now()),
        );
      },
    });
    const service = createSetupService({
      store,
      policy,
      registry: deps.registry(),
      bridge: createSetupBridge(),
      readSecret: readCodeBridgeSecret,
      revoke: revokeCodeBridgeWorker,
    });
    runtime = { service, store, policy };
    return runtime;
  }

  function boundary(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return (req, res) => {
      res.set('Cache-Control', 'no-store');
      void handler(req, res).catch((error: unknown) => sendError(error, res));
    };
  }

  async function limit(req: Request, config: SetupConfig): Promise<string> {
    // Express resolves the deployment's configured trusted proxy chain. The independent global
    // ceiling bounds allocation even when a deployment permits a client-controlled forwarded IP.
    const ipHash = createHash('sha256')
      .update(req.ip ?? 'unknown')
      .digest('hex');
    const allowed = await getRuntime().store.consumeRequest({
      ipHash,
      now: Date.now(),
      limits: {
        global: config.requestsPerMinute,
        perIp: Math.min(config.requestsPerIpMinute, config.requestsPerMinute),
        windowMs: 60_000,
      },
    });
    if (!allowed) throw new SetupError(429, 'SETUP_RATE_LIMITED');
    return ipHash;
  }

  async function admit(req: Request): Promise<string> {
    const cached = await deps.getAppConfig({ baseOnly: true, failClosed: true });
    return await limit(req, readSetupConfig(cached, false));
  }

  async function machine(
    req: Request,
    operation: BrowserSetupProof['operation'],
  ): Promise<{ session: BrowserSetupSession; body: MachineBody }> {
    const current = getRuntime();
    const ipHash = await admit(req);
    const body = parseBody(req.body, operation);
    let session = await current.store.get(body.request.attemptId);
    const deployment = await current.policy.deployment({ existing: session != null });
    if (
      body.request.instance !== deployment.config.instance ||
      Math.abs(Date.now() - Date.parse(body.proof.timestamp)) > deployment.config.proofWindowMs
    )
      throw new SetupError(401, 'SETUP_PROOF_INVALID');
    if (session == null && operation === 'setup.start') {
      await deps.backend.ensureRegistration();
      if ((await current.service.availablePlanes(deployment)).length === 0)
        throw new SetupError(503, 'SETUP_UNAVAILABLE');
      session = await current.service.start(body.request, ipHash, deployment.config);
    }
    if (session == null) throw new SetupError(404, 'SETUP_NOT_FOUND');
    if (
      session.requestHash !== body.proof.requestHash ||
      session.requestCanonical !== canonicalBrowserEnrollmentRequest(body.request)
    )
      throw new SetupError(409, 'SETUP_CONFLICT');
    if (
      operation === 'setup.complete' &&
      (session.approval == null ||
        !verifyBrowserEnrollmentRedemption(
          body.request.publicKey,
          session.approval,
          body.redemptionSignature!,
        ))
    )
      throw new SetupError(401, 'SETUP_PROOF_INVALID');
    const claimed = await current.store.claimNonce({
      attemptId: session.attemptId,
      requestHash: session.requestHash,
      nonce: body.proof.nonce,
      now: Date.now(),
      expiresAt: Date.parse(body.proof.timestamp) + deployment.config.proofWindowMs + 1,
      maxNonces: 256,
      maxOperations: deployment.config.maxProofsPerAttempt,
    });
    if (claimed !== 'claimed')
      throw new SetupError(
        claimed === 'limited' ? 429 : 409,
        claimed === 'limited' ? 'SETUP_RATE_LIMITED' : 'SETUP_PROOF_REPLAYED',
      );
    return { session, body };
  }

  router.get(
    '/capabilities',
    boundary(async (req, res) => {
      const current = getRuntime();
      await admit(req);
      const policy = await current.policy.deployment();
      await deps.backend.ensureRegistration();
      if ((await current.service.availablePlanes(policy)).length === 0)
        throw new SetupError(503, 'SETUP_UNAVAILABLE');
      res.json({ browserEnrollmentVersion: 1 });
    }),
  );
  for (const action of ['start', 'poll', 'cancel', 'complete'] as const) {
    router.post(
      `/${action}`,
      boundary(async (req, res) => {
        const { session, body } = await machine(req, `setup.${action}`);
        const service = getRuntime().service;
        const outcome =
          action === 'cancel'
            ? await service.cancel(session)
            : await service.advance(
                session,
                action === 'complete' ? body.redemptionSignature : undefined,
              );
        res.json(service.machineResponse(outcome));
      }),
    );
  }

  const browser = Router();
  browser.use(deps.requireJwtAuth, deps.checkBan);
  async function browserSession(
    req: Request,
  ): Promise<{ session: BrowserSetupSession; userId: string }> {
    const attemptId = req.params.attemptId;
    const userId = (req.user as { id?: string } | undefined)?.id;
    if (!userId) throw new SetupError(401, 'AUTH_REQUIRED');
    if (!isBrowserEnrollmentToken(attemptId)) throw new SetupError(404, 'SETUP_NOT_FOUND');
    const session = await getRuntime().store.get(attemptId);
    if (session == null || (session.ownerId != null && session.ownerId !== userId))
      throw new SetupError(404, 'SETUP_NOT_FOUND');
    return { session, userId };
  }
  browser.get(
    '/:attemptId',
    boundary(async (req, res) => {
      const { session, userId } = await browserSession(req);
      res.json(await getRuntime().service.inspect(session, userId));
    }),
  );
  browser.post(
    '/:attemptId/approve',
    deps.requireSameOrigin,
    boundary(async (req, res) => {
      const { session, userId } = await browserSession(req);
      if (
        !record(req.body) ||
        Object.keys(req.body).length !== 1 ||
        typeof req.body.controlPlaneId !== 'string' ||
        req.body.controlPlaneId.length > 128
      )
        throw new SetupError(400, 'SETUP_INVALID_DECISION');
      res.json(await getRuntime().service.approve(session, userId, req.body.controlPlaneId));
    }),
  );
  browser.post(
    '/:attemptId/deny',
    deps.requireSameOrigin,
    boundary(async (req, res) => {
      const { session, userId } = await browserSession(req);
      if (!record(req.body) || Object.keys(req.body).length !== 0)
        throw new SetupError(400, 'SETUP_INVALID_DECISION');
      res.json(await getRuntime().service.deny(session, userId));
    }),
  );
  router.use(browser);

  // The timer only schedules work. Mongo owns intent, deadlines, leases and retry progress.
  const timer = setInterval(() => {
    if (sweeping || !deps.backend.isConnected() || Date.now() < nextSweep) return;
    sweeping = true;
    void runAsSystem(async () => {
      const current = getRuntime();
      // Cleanup must keep running after an operator withdraws the capability.
      let interval = 10_000;
      try {
        interval = (await current.policy.deployment()).config.reconcileIntervalMs;
      } catch {
        /* Frozen cleanup destinations remain server-owned durable intent. */
      }
      nextSweep = Date.now() + interval;
      await current.service.reconcile();
    })
      .catch(() => undefined)
      .finally(() => {
        sweeping = false;
      });
  }, 1_000);
  timer.unref();
  if (deps.signal?.aborted) clearInterval(timer);
  else deps.signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  return router;
}
