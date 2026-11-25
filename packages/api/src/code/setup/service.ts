import { tenantStorage } from '@librechat/data-schemas';
import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import {
  isBrowserEnrollmentRequest,
  canonicalBrowserEnrollmentRequest,
  verifyBrowserEnrollmentRedemption,
  isBrowserEnrollmentApproval,
} from '@librechat/code/browser-enrollment';
import type {
  BrowserSetupSession,
  BrowserSetupStore,
  BrowserSetupPatch,
} from '@librechat/data-schemas';
import type { BrowserEnrollmentRequest } from '@librechat/code/browser-enrollment';
import type { CodeSetupAttempt } from 'librechat-data-provider';
import type { CodeEnvironmentSetupInput, CodeEnvironmentSummary } from '../environments';
import type { SetupPolicyReader, SetupConfig, ExistingSetupPolicy } from './policy';
import type { SetupBridge, SetupCredential } from './bridge';
import { setupRedemptionContract } from './bridge';
import { SetupPolicyError } from './policy';

export class SetupError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export type SetupRegistry = {
  reserveSetup: (input: CodeEnvironmentSetupInput) => Promise<CodeEnvironmentSummary>;
  completeSetup: (input: CodeEnvironmentSetupInput) => Promise<CodeEnvironmentSummary>;
  discardSetup: (input: CodeEnvironmentSetupInput) => Promise<void>;
};

export interface SetupServiceDependencies {
  store: BrowserSetupStore;
  policy: SetupPolicyReader;
  bridge: SetupBridge;
  registry: SetupRegistry;
  readSecret: (name: string) => string | undefined;
  revoke: (input: { baseURL: string; token: string; workerId: string }) => Promise<void>;
  now?: () => number;
}

export type SetupMachineResponse = {
  version: 1;
  status: 'pending' | 'approved' | 'completed' | 'denied' | 'cancelled' | 'expired';
  expiresAt: string;
  verificationUrl: string;
  verificationCode: string;
  approval?: ReturnType<typeof setupRedemptionContract> & { codeApiUrl: string };
  credential?: SetupCredential;
};

type Outcome = { session: BrowserSetupSession; credential?: SetupCredential };

function request(session: BrowserSetupSession): BrowserEnrollmentRequest {
  const value: unknown = JSON.parse(session.requestCanonical);
  if (
    !isBrowserEnrollmentRequest(value) ||
    canonicalBrowserEnrollmentRequest(value) !== session.requestCanonical
  ) {
    throw new SetupError(503, 'SETUP_UNAVAILABLE');
  }
  return value;
}

function terminal(session: BrowserSetupSession): boolean {
  return ['completed', 'denied', 'cancelled', 'expired', 'failed'].includes(session.status);
}

export function createSetupService(deps: SetupServiceDependencies): {
  availablePlanes: (
    policy: ExistingSetupPolicy,
  ) => Promise<Array<{ id: string; name: string; serverId: string }>>;
  start: (
    input: BrowserEnrollmentRequest,
    ipHash: string,
    config: SetupConfig,
  ) => Promise<BrowserSetupSession>;
  inspect: (session: BrowserSetupSession, userId: string) => Promise<CodeSetupAttempt>;
  approve: (
    session: BrowserSetupSession,
    userId: string,
    planeId: string,
  ) => Promise<CodeSetupAttempt>;
  deny: (session: BrowserSetupSession, userId: string) => Promise<CodeSetupAttempt>;
  cancel: (session: BrowserSetupSession) => Promise<Outcome>;
  advance: (session: BrowserSetupSession, redemptionSignature?: string) => Promise<Outcome>;
  machineResponse: (outcome: Outcome) => SetupMachineResponse;
  reconcile: () => Promise<void>;
} {
  const now = deps.now ?? Date.now;

  function token(session: BrowserSetupSession): string {
    const value = session.tokenEnv == null ? undefined : deps.readSecret(session.tokenEnv)?.trim();
    if (!value) throw new SetupError(503, 'SETUP_UNAVAILABLE');
    return value;
  }

  async function availablePlanes(
    policy: ExistingSetupPolicy,
  ): Promise<Array<{ id: string; name: string; serverId: string }>> {
    const results = await Promise.all(
      policy.planes.map(async (plane) => {
        const secret = deps.readSecret(plane.pairing!.tokenEnv)?.trim();
        const baseURL = plane.baseURL.replace(/\/+$/, '');
        if (!secret || new URL(baseURL).protocol !== 'https:') return null;
        try {
          const serverId = await deps.bridge.capabilities(baseURL, secret);
          return { id: plane.id, name: plane.name, serverId };
        } catch {
          return null;
        }
      }),
    );
    return results.filter((value): value is NonNullable<typeof value> => value != null);
  }

  async function start(
    input: BrowserEnrollmentRequest,
    ipHash: string,
    config: SetupConfig,
  ): Promise<BrowserSetupSession> {
    const created = Date.parse(input.createdAt);
    if (created > now() + config.proofWindowMs || created + 600_000 <= now()) {
      throw new SetupError(410, 'SETUP_EXPIRED');
    }
    const canonical = canonicalBrowserEnrollmentRequest(input);
    const result = await deps.store.start({
      session: {
        attemptId: input.attemptId,
        requestCanonical: canonical,
        requestHash: createHash('sha256').update(canonical).digest('hex'),
        createdAt: input.createdAt,
        expiresAt: new Date(created + 600_000).toISOString(),
        verificationCode: `${randomBytes(3).toString('hex').toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`,
        workerId: `code-${randomUUID()}`,
        status: 'pending',
        revision: 0,
      },
      ipHash,
      now: now(),
      limits: {
        global: config.maxPending,
        perIp: Math.min(config.maxPending, config.maxPerIp),
        windowMs: 600_000 + config.proofWindowMs,
      },
    });
    if (result.status === 'conflict') throw new SetupError(409, 'SETUP_CONFLICT');
    if (!('session' in result)) throw new SetupError(429, 'SETUP_RATE_LIMITED');
    return result.session;
  }

  function assertOwner(
    session: BrowserSetupSession,
    userId: string,
    policy: ExistingSetupPolicy,
  ): void {
    if (
      session.ownerId != null &&
      (session.ownerId !== userId || session.tenantId !== policy.tenantId)
    ) {
      throw new SetupError(404, 'SETUP_NOT_FOUND');
    }
  }

  async function project(
    session: BrowserSetupSession,
    policy: ExistingSetupPolicy,
  ): Promise<CodeSetupAttempt> {
    const input = request(session);
    const choices =
      session.status === 'pending'
        ? await availablePlanes(policy)
        : policy.planes.map(({ id, name }) => ({ id, name }));
    let status: CodeSetupAttempt['status'] =
      session.status === 'completing' ? 'provisioning' : session.status;
    if (session.status === 'pending' && Date.parse(session.expiresAt) <= now()) status = 'expired';
    return {
      version: 1,
      attemptId: session.attemptId,
      status,
      expiresAt: session.expiresAt,
      verificationCode: session.verificationCode,
      machineName: input.machineName,
      workspace: input.workspace,
      allowWorkspaceWrites: input.allowWorkspaceWrites,
      allowWorkspaceCommands: input.allowWorkspaceCommands,
      keyFingerprint: createHash('sha256')
        .update(createPublicKey(input.publicKey).export({ type: 'spki', format: 'der' }))
        .digest('hex'),
      controlPlanes: choices.map(({ id, name }) => ({ id, name })),
      ...(session.planeId == null ? {} : { controlPlaneId: session.planeId }),
      ...(session.failureCode
        ? { failure: { code: session.failureCode, retryable: !terminal(session) } }
        : {}),
    };
  }

  async function inspect(session: BrowserSetupSession, userId: string): Promise<CodeSetupAttempt> {
    const policy =
      session.status === 'completed'
        ? await deps.policy.frozen(session, { completed: true })
        : await deps.policy.user(userId);
    assertOwner(session, userId, policy);
    const needsProgress =
      session.status === 'provisioning' ||
      session.status === 'completing' ||
      (session.status === 'pending' && Date.parse(session.expiresAt) <= now()) ||
      (session.stopReason != null && session.progress?.cleanup !== true);
    const current = needsProgress ? (await advance(session)).session : session;
    assertOwner(current, userId, policy);
    return await project(current, policy);
  }

  async function approve(
    session: BrowserSetupSession,
    userId: string,
    planeId: string,
  ): Promise<CodeSetupAttempt> {
    if (session.status === 'completed') return await inspect(session, userId);
    const policy = await deps.policy.user(userId);
    assertOwner(session, userId, policy);
    if (terminal(session)) return await project(session, policy);
    if (session.status !== 'pending') {
      if (session.planeId !== planeId) throw new SetupError(409, 'SETUP_CONFLICT');
      return await project((await advance(session)).session, policy);
    }
    if (Date.parse(session.expiresAt) <= now()) throw new SetupError(410, 'SETUP_EXPIRED');
    const plane = policy.planes.find(({ id }) => id === planeId);
    const supported = (await availablePlanes(policy)).find(({ id }) => id === planeId);
    if (plane == null || supported == null || policy.codeTenantId == null)
      throw new SetupError(403, 'SETUP_POLICY_UNAVAILABLE');
    const input = request(session);
    const approval = {
      protocolVersion: 1 as const,
      operation: 'enrollment.redeem' as const,
      serverId: supported.serverId,
      instance: input.instance,
      attemptId: session.attemptId,
      requestHash: session.requestHash,
      workerId: session.workerId,
      expiresAt: session.expiresAt,
      publicKey: input.publicKey,
      binding: { tenantId: policy.codeTenantId, principal: { type: 'user' as const, id: userId } },
    };
    if (input.instance !== policy.config.instance || !isBrowserEnrollmentApproval(approval))
      throw new SetupError(403, 'SETUP_POLICY_UNAVAILABLE');
    // This CAS is the explicit approval and ownership linearization point, before all effects.
    const frozen = await deps.store.update({
      attemptId: session.attemptId,
      requestHash: session.requestHash,
      revision: session.revision,
      patch: {
        status: 'provisioning',
        ownerId: userId,
        tenantId: policy.tenantId,
        planeId,
        baseURL: plane.baseURL.replace(/\/+$/, ''),
        tokenEnv: plane.pairing!.tokenEnv,
        approval,
      },
    });
    if (frozen == null) {
      const current = await deps.store.get(session.attemptId);
      if (current == null) throw new SetupError(404, 'SETUP_NOT_FOUND');
      assertOwner(current, userId, policy);
      if (current.planeId !== planeId) throw new SetupError(409, 'SETUP_CONFLICT');
      return await project((await advance(current)).session, policy);
    }
    return await project((await advance(frozen)).session, policy);
  }

  async function deny(session: BrowserSetupSession, userId: string): Promise<CodeSetupAttempt> {
    const policy = await deps.policy.user(userId);
    assertOwner(session, userId, policy);
    const stopped = await advance(session, undefined, 'denied', userId, policy.tenantId);
    assertOwner(stopped.session, userId, policy);
    return await project(stopped.session, policy);
  }

  async function cancel(session: BrowserSetupSession): Promise<Outcome> {
    return await advance(session, undefined, 'cancelled');
  }

  function registration(
    session: BrowserSetupSession,
    maxOwned?: number,
  ): CodeEnvironmentSetupInput {
    if (
      session.approval == null ||
      session.ownerId == null ||
      session.baseURL == null ||
      session.planeId == null
    ) {
      throw new SetupError(503, 'SETUP_UNAVAILABLE');
    }
    return {
      actor: { userId: session.ownerId },
      setupAttemptId: session.attemptId,
      requestHash: session.requestHash,
      maxOwned,
      environment: {
        id: session.workerId,
        name: request(session).machineName,
        type: 'attached',
        baseURL: session.baseURL,
        workerId: session.workerId,
        controlPlaneId: session.planeId,
        revocationTokenEnv: session.tokenEnv,
        workerPrincipal: session.approval.binding.principal,
      },
    };
  }

  async function advance(
    initial: BrowserSetupSession,
    redemptionSignature?: string,
    stop?: 'denied' | 'cancelled',
    denyOwner?: string,
    denyTenant?: string,
  ): Promise<Outcome> {
    if (terminal(initial) && initial.status !== 'completed' && initial.progress?.cleanup === true)
      return { session: initial };
    const leaseId = randomUUID();
    let session = await deps.store.claim({
      attemptId: initial.attemptId,
      requestHash: initial.requestHash,
      revision: initial.revision,
      leaseId,
      now: now(),
      leaseMs: 120_000,
    });
    if (session == null) {
      const current = await deps.store.get(initial.attemptId);
      if (current == null) throw new SetupError(404, 'SETUP_NOT_FOUND');
      if (redemptionSignature != null || stop != null) throw new SetupError(409, 'SETUP_BUSY');
      return { session: current };
    }
    const current = (): BrowserSetupSession => session!;
    async function save(patch: BrowserSetupPatch): Promise<void> {
      const value = current();
      const changed = await deps.store.update({
        attemptId: value.attemptId,
        requestHash: value.requestHash,
        revision: value.revision,
        leaseId,
        patch,
      });
      if (changed == null) throw new SetupError(409, 'SETUP_BUSY');
      session = changed;
    }
    async function fence(): Promise<void> {
      const live = await deps.store.get(current().attemptId);
      if (
        live?.leaseId !== leaseId ||
        live.revision !== current().revision ||
        (live.leaseExpiresAt ?? 0) < now() + 15_000
      )
        throw new SetupError(409, 'SETUP_BUSY');
    }
    async function scoped<T>(job: () => Promise<T>): Promise<T> {
      return await tenantStorage.run(
        { tenantId: current().tenantId || undefined, userId: current().ownerId },
        job,
      );
    }
    async function finish(
      status: BrowserSetupSession['status'],
      retentionMs = 86_400_000,
    ): Promise<void> {
      await save({
        status,
        progress: { cleanup: true },
        purgeAt: new Date(now() + retentionMs).toISOString(),
      });
    }
    async function cleanup(
      reason: NonNullable<BrowserSetupSession['stopReason']>,
      alreadyRevoked = false,
    ): Promise<void> {
      await save({ stopReason: reason });
      const value = current();
      if (value.approval != null) {
        await fence();
        // Issuance can have succeeded without a response. Revocation also fences late issuance.
        if (!alreadyRevoked) {
          await deps.revoke({
            baseURL: value.baseURL!,
            token: token(value),
            workerId: value.workerId,
          });
        }
        await fence();
        await scoped(async () => deps.registry.discardSetup(registration(value)));
      }
      await finish(reason === 'withdrawn' ? 'failed' : reason);
    }
    try {
      let value = current();
      if (value.approval == null) {
        if (stop != null || Date.parse(value.expiresAt) <= now()) {
          await save({
            ...(denyOwner == null ? {} : { ownerId: denyOwner, tenantId: denyTenant }),
            stopReason: stop ?? 'expired',
          });
          await finish(stop ?? 'expired');
        }
        return { session: current() };
      }
      await fence();
      const remote = await deps.bridge.status(value.baseURL!, token(value), value.approval!);
      let policy: ExistingSetupPolicy | undefined;
      try {
        policy = await deps.policy.frozen(value, { completed: remote === 'completed' });
      } catch (error) {
        if (!(error instanceof SetupPolicyError)) throw error;
        await save({ stopReason: 'withdrawn', failureCode: error.code });
      }
      value = current();
      // Enrollment, not the setup deadline or a profile acknowledgement, owns completion.
      if (remote === 'completed' && value.stopReason !== 'withdrawn') {
        await fence();
        await scoped(async () => deps.registry.completeSetup(registration(value)));
        await save({ progress: { registryCompleted: true, redemption: true } });
        await finish('completed', policy?.config.retentionMs);
        if (redemptionSignature == null) return { session: current() };
        if (
          !verifyBrowserEnrollmentRedemption(
            request(value).publicKey,
            value.approval!,
            redemptionSignature,
          )
        )
          throw new SetupError(401, 'SETUP_PROOF_INVALID');
        const credential = await deps.bridge.redeem(
          value.baseURL!,
          token(value),
          value.approval!,
          redemptionSignature,
        );
        return { session: current(), credential };
      }
      if (remote === 'revoked') {
        await save({
          failureCode: 'SETUP_REVOKED',
          stopReason:
            value.stopReason ??
            stop ??
            (Date.parse(value.expiresAt) <= now() ? 'expired' : 'withdrawn'),
        });
        // The exact contract is already fenced. A newer manual generation must not be revoked.
        await cleanup(current().stopReason!, true);
        return { session: current() };
      }
      const reason =
        value.stopReason ?? stop ?? (Date.parse(value.expiresAt) <= now() ? 'expired' : undefined);
      if (reason != null) {
        await cleanup(reason);
        return { session: current() };
      }
      if (policy == null) throw new SetupError(503, 'SETUP_UNAVAILABLE');
      await fence();
      await scoped(async () =>
        deps.registry.reserveSetup(registration(current(), policy.maxOwned)),
      );
      await save({ progress: { registryReserved: true } });
      // Recheck current authority after capacity/ACL writes and before remote trust issuance.
      await deps.policy.frozen(current());
      if (remote === 'unknown') {
        if (current().progress?.issued === true)
          throw new SetupError(503, 'SETUP_RECONCILIATION_REQUIRED');
        await fence();
        await deps.bridge.issue(current().baseURL!, token(current()), current().approval!);
      }
      await save({ status: 'approved', progress: { issued: true } });
      if (redemptionSignature == null) return { session: current() };
      value = current();
      if (
        !verifyBrowserEnrollmentRedemption(
          request(value).publicKey,
          value.approval!,
          redemptionSignature,
        )
      )
        throw new SetupError(401, 'SETUP_PROOF_INVALID');
      await deps.policy.frozen(value);
      // Holding the durable lease makes explicit cancellation lose to this completion intent.
      await save({ status: 'completing' });
      await fence();
      const credential = await deps.bridge.redeem(
        value.baseURL!,
        token(value),
        value.approval!,
        redemptionSignature,
      );
      await save({ progress: { redemption: true } });
      // Existing trust still needs current account/tenant/plane authorization, not a new enrollment slot.
      await deps.policy.frozen(current(), { completed: true });
      await fence();
      await scoped(async () => deps.registry.completeSetup(registration(current())));
      await save({ progress: { registryCompleted: true } });
      await finish('completed', policy.config.retentionMs);
      return { session: current(), credential };
    } catch (error) {
      if (error instanceof SetupPolicyError && current().approval != null) {
        await save({ stopReason: 'withdrawn', failureCode: error.code });
        await cleanup('withdrawn');
        return { session: current() };
      }
      if (!(error instanceof SetupError && error.status < 500)) {
        await save({ failureCode: 'SETUP_RETRY_REQUIRED' });
      }
      throw error;
    } finally {
      const value = current();
      await deps.store.release({
        attemptId: value.attemptId,
        requestHash: value.requestHash,
        revision: value.revision,
        leaseId,
      });
    }
  }

  function machineResponse({ session, credential }: Outcome): SetupMachineResponse {
    let status: SetupMachineResponse['status'] = 'pending';
    if (['approved', 'completed', 'denied', 'cancelled', 'expired'].includes(session.status)) {
      status = session.status as SetupMachineResponse['status'];
    } else if (session.status === 'failed') {
      status = 'denied';
    }
    const input = request(session);
    return {
      version: 1,
      status,
      expiresAt: session.expiresAt,
      verificationUrl: `${input.instance}/code/setup/${session.attemptId}`,
      verificationCode: session.verificationCode,
      ...(session.approval == null
        ? {}
        : {
            approval: {
              ...setupRedemptionContract(session.approval),
              codeApiUrl: session.baseURL!,
            },
          }),
      ...(credential == null ? {} : { credential }),
    };
  }

  async function reconcile(): Promise<void> {
    const candidates = await deps.store.listReconcile(25, now());
    for (const candidate of candidates) {
      try {
        await advance(candidate);
      } catch {
        /* Durable intent remains for another replica; no request or provider payload is logged. */
      }
    }
  }

  return {
    availablePlanes,
    start,
    inspect,
    approve,
    deny,
    cancel,
    advance,
    machineResponse,
    reconcile,
  };
}

export type SetupService = ReturnType<typeof createSetupService>;
