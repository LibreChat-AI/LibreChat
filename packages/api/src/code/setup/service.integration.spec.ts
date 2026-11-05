import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createMethods, createModels, createBrowserSetupStore } from '@librechat/data-schemas';
import {
  browserSetupRequestHash,
  signBrowserEnrollmentRedemption,
  isBrowserEnrollmentApproval,
  isBrowserEnrollmentStatusRequest,
  isBrowserEnrollmentRedemption,
  verifyBrowserEnrollmentRedemption,
} from '@librechat/code/browser-enrollment';
import type {
  BrowserEnrollmentApproval,
  BrowserEnrollmentRequest,
} from '@librechat/code/browser-enrollment';
import type { AppConfig, BrowserSetupSession } from '@librechat/data-schemas';
import type { CodeBridgeFetch } from '../bridge';
import { createCodeEnvironmentRegistry } from '../environments';
import { createSetupService, SetupError } from './service';
import { createSetupPolicy } from './policy';
import { createSetupBridge } from './bridge';

const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ownerId = new Types.ObjectId().toHexString();
const strangerId = new Types.ObjectId().toHexString();
const ipHash = createHash('sha256').update('127.0.0.1').digest('hex');

function configuration(): AppConfig {
  return {
    endpoints: {
      agents: {
        statefulCodeSessions: {
          allowedEnvironments: ['user'],
          principalWorkers: {
            enabled: true,
            maxPerUser: 1,
            browserSetup: {
              enabled: true,
              instance: 'https://chat.example.test/base',
              maxPending: 8,
              maxPerIp: 5,
              requestsPerMinute: 1200,
              requestsPerIpMinute: 120,
              proofWindowMs: 60_000,
              maxProofsPerAttempt: 1024,
              reconcileIntervalMs: 10_000,
              retentionMs: 86_400_000,
            },
          },
          environments: [
            {
              id: 'code-api',
              name: 'Personal machines',
              type: 'attached',
              owner: 'deployment',
              baseURL: 'https://code.example.test/v1',
              pairing: { tokenEnv: 'CODE_ADMIN_TOKEN', allowPrincipalWorkers: true },
            },
          ],
        },
      },
    },
  } as AppConfig;
}

/** External service fixture validates the actual shared strict schemas at every boundary. */
function codeApi() {
  let approval: BrowserEnrollmentApproval | undefined;
  let completed = false;
  let revoked = false;
  let issueLost = false;
  let redeemLost = false;
  let unavailable = false;
  let issueCount = 0;
  let redeemCount = 0;
  let revokeCount = 0;
  const credential = {
    protocolVersion: 1 as const,
    workerId: '',
    credential: randomBytes(32).toString('base64url'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const fetchImpl: CodeBridgeFetch = async (input, init) => {
    if (unavailable) throw new Error('external outage');
    expect(init?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer administrator-only' }),
    );
    const url = String(input);
    if (url.endsWith('/capabilities'))
      return Response.json({ browserEnrollmentVersion: 1, serverId: 'https://code.example.test' });
    const body: unknown = JSON.parse(String(init?.body));
    if (url.endsWith('/status')) {
      expect(isBrowserEnrollmentStatusRequest(body)).toBe(true);
      if (!approval) return Response.json({ code: 'ENROLLMENT_INVALID' }, { status: 409 });
      let status = 'pending';
      if (completed) status = 'completed';
      if (revoked || (!completed && Date.parse(approval.expiresAt) <= Date.now()))
        status = 'revoked';
      return Response.json({ protocolVersion: 1, workerId: approval.workerId, status });
    }
    if (url.endsWith('/redeem')) {
      expect(isBrowserEnrollmentRedemption(body)).toBe(true);
      if (
        !isBrowserEnrollmentRedemption(body) ||
        !approval ||
        revoked ||
        !verifyBrowserEnrollmentRedemption(approval.publicKey, body, body.signature)
      )
        return Response.json({}, { status: 409 });
      completed = true;
      redeemCount++;
      if (redeemLost) {
        redeemLost = false;
        throw new Error('response lost after redemption');
      }
      return Response.json({ ...credential, workerId: approval.workerId });
    }
    expect(isBrowserEnrollmentApproval(body)).toBe(true);
    if (!isBrowserEnrollmentApproval(body) || revoked) return Response.json({}, { status: 409 });
    if (approval) expect(body).toEqual(approval);
    approval = body;
    issueCount++;
    if (issueLost) {
      issueLost = false;
      throw new Error('response lost after issuance');
    }
    return Response.json(body);
  };
  return {
    fetchImpl,
    loseIssue: () => {
      issueLost = true;
    },
    loseRedeem: () => {
      redeemLost = true;
    },
    outage: (value: boolean) => {
      unavailable = value;
    },
    revoke: async () => {
      revoked = true;
      revokeCount++;
    },
    status: () => ({ approval, completed, revoked, issueCount, redeemCount, revokeCount }),
  };
}

function input(createdAt = new Date().toISOString()): BrowserEnrollmentRequest {
  return {
    version: 1,
    instance: 'https://chat.example.test/base',
    attemptId: randomBytes(32).toString('base64url'),
    createdAt,
    publicKey,
    machineName: 'Development VM',
    workspace: { type: 'directory' },
    allowWorkspaceWrites: false,
    allowWorkspaceCommands: true,
  };
}

async function fixture() {
  const base = configuration();
  let effective = base;
  const policy = createSetupPolicy({
    getAppConfig: async (options) => (options.baseOnly ? base : effective),
    principalAuthEnabled: () => true,
    principalAuthReady: () => undefined,
    getUser: async (id) => {
      const user = await createMethods(mongoose).getUserById(id);
      return user == null
        ? null
        : {
            id: user._id.toString(),
            provider: user.provider,
            emailVerified: user.emailVerified,
            termsAccepted: user.termsAccepted,
            role: user.role,
            tenantId: user.tenantId,
          };
    },
    userIsBanned: async () => false,
  });
  const external = codeApi();
  const registry = createCodeEnvironmentRegistry(mongoose);
  const make = () => {
    const store = createBrowserSetupStore(mongoose);
    const service = createSetupService({
      store,
      policy,
      registry,
      bridge: createSetupBridge(external.fetchImpl),
      readSecret: () => 'administrator-only',
      revoke: external.revoke,
    });
    return { store, service };
  };
  const { store, service } = make();
  const request = input();
  const config = (await policy.deployment()).config;
  const session = await service.start(request, ipHash, config);
  const latest = async (): Promise<BrowserSetupSession> => (await store.get(session.attemptId))!;
  const signature = async () =>
    signBrowserEnrollmentRedemption(privateKey, (await latest()).approval!);
  return {
    request,
    session,
    config,
    store,
    service,
    registry,
    external,
    latest,
    signature,
    make,
    disableEnrollment: () => {
      base.endpoints!.agents!.statefulCodeSessions!.principalWorkers!.maxPerUser = 0;
    },
    disableBrowserSetup: () => {
      base.endpoints!.agents!.statefulCodeSessions!.principalWorkers!.browserSetup!.enabled = false;
    },
    deleteAccount: async () => {
      await mongoose.models.User.deleteOne({ _id: ownerId });
    },
    changeTenant: async () => {
      await mongoose.models.User.collection.updateOne(
        { _id: new Types.ObjectId(ownerId) },
        { $set: { tenantId: 'other-tenant' } },
      );
    },
    withdraw: () => {
      effective = {
        ...base,
        endpoints: {
          ...base.endpoints,
          agents: {
            ...base.endpoints!.agents,
            statefulCodeSessions: {
              ...base.endpoints!.agents!.statefulCodeSessions!,
              principalWorkers: { enabled: false },
            },
          },
        },
      };
    },
  };
}

describe('browser setup durable lifecycle', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await createMethods(mongoose).seedDefaultRoles();
    await mongoose.models.User.create(
      [ownerId, strangerId].map((id) => ({
        _id: id,
        name: 'Setup owner',
        email: `${id}@example.test`,
        provider: 'local',
        emailVerified: true,
        termsAccepted: true,
        role: 'USER',
      })),
    );
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  test('resumes immutable starts, returns the CLI approval, and idempotently completes the final owner slot', async () => {
    const f = await fixture();
    const second = f.make();
    expect((await second.service.start(f.request, ipHash, f.config)).workerId).toBe(
      f.session.workerId,
    );
    await expect(
      second.service.start({ ...f.request, allowWorkspaceWrites: true }, ipHash, f.config),
    ).rejects.toMatchObject({ code: 'SETUP_CONFLICT' });
    expect(await f.registry.listAccessible({ userId: ownerId })).toEqual([]);
    const confirmation = await f.service.inspect(await f.latest(), ownerId);
    expect(confirmation.status).toBe('pending');
    expect(confirmation.keyFingerprint).toBe(
      createHash('sha256')
        .update(key.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
    );
    expect(f.external.status().approval).toBeUndefined();
    const approved = await f.service.approve(await f.latest(), ownerId, 'code-api');
    expect(approved.status).toBe('approved');
    expect(await f.registry.listAccessible({ userId: ownerId })).toEqual([]);
    const outcome = await second.service.advance(await f.latest(), await f.signature());
    const response = second.service.machineResponse(outcome);
    expect(response.status).toBe('completed');
    expect(response.verificationUrl).toBe(
      `${f.request.instance}/code/setup/${f.request.attemptId}`,
    );
    expect(response.expiresAt).toBe(f.session.expiresAt);
    expect(response.approval).toEqual({
      operation: 'enrollment.redeem',
      serverId: 'https://code.example.test',
      instance: f.request.instance,
      attemptId: f.request.attemptId,
      requestHash: browserSetupRequestHash(f.request),
      workerId: f.session.workerId,
      expiresAt: f.session.expiresAt,
      codeApiUrl: 'https://code.example.test/v1',
    });
    const replay = await f.service.advance(await f.latest(), await f.signature());
    expect(replay.credential).toEqual(outcome.credential);
    expect(await f.registry.listAccessible({ userId: ownerId })).toHaveLength(1);
    expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
    expect(JSON.stringify(await f.service.inspect(await f.latest(), ownerId))).not.toMatch(
      /administrator-only|credential|codeApiUrl|publicKey|binding/,
    );
  });

  test('lost issuance response resumes the exact operation on another replica without another worker', async () => {
    const f = await fixture();
    f.external.loseIssue();
    await expect(f.service.approve(await f.latest(), ownerId, 'code-api')).rejects.toThrow();
    const before = await f.latest();
    expect(before.status).toBe('provisioning');
    const second = f.make();
    expect((await second.service.advance(before)).session.status).toBe('approved');
    expect(f.external.status().issueCount).toBe(1);
    expect((await f.latest()).approval).toEqual(before.approval);
    expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
  });

  test('lost redemption response is completed before cancellation or expiry cleanup can revoke it', async () => {
    const f = await fixture();
    await f.service.approve(await f.latest(), ownerId, 'code-api');
    f.external.loseRedeem();
    await expect(f.service.advance(await f.latest(), await f.signature())).rejects.toThrow();
    expect((await f.latest()).status).toBe('completing');
    const second = f.make();
    expect((await second.service.cancel(await f.latest())).session.status).toBe('completed');
    expect(f.external.status().revoked).toBe(false);
    expect(
      (await second.service.advance(await f.latest(), await f.signature())).credential,
    ).toBeDefined();
  });

  test.each(['deleteAccount', 'withdraw', 'changeTenant'] as const)(
    'revalidates %s during provisioning and persists compensation',
    async (change) => {
      const f = await fixture();
      f.external.loseIssue();
      await expect(f.service.approve(await f.latest(), ownerId, 'code-api')).rejects.toThrow();
      await f[change]();
      expect((await f.make().service.advance(await f.latest())).session.status).toBe('failed');
      expect(f.external.status().revoked).toBe(true);
      expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(0);
      expect((await f.latest()).progress?.cleanup).toBe(true);
    },
  );

  test('outage retains ambiguous redemption and cleanup intent across process restart', async () => {
    const f = await fixture();
    await f.service.approve(await f.latest(), ownerId, 'code-api');
    f.external.loseRedeem();
    await expect(f.service.advance(await f.latest(), await f.signature())).rejects.toThrow();
    f.external.outage(true);
    await expect(f.make().service.cancel(await f.latest())).rejects.toThrow();
    expect((await f.latest()).purgeAt).toBeUndefined();
    f.external.outage(false);
    expect((await f.make().service.advance(await f.latest())).session.status).toBe('completed');
    expect(f.external.status().revoked).toBe(false);
  });

  test('explicit denial and cancellation do not allocate remote trust or allow later approval', async () => {
    for (const denied of [false, true]) {
      const f = await fixture();
      const result = denied
        ? await f.service.deny(await f.latest(), ownerId)
        : f.service.machineResponse(await f.service.cancel(await f.latest()));
      expect(result.status).toBe(denied ? 'denied' : 'cancelled');
      expect((await f.service.approve(await f.latest(), ownerId, 'code-api')).status).toBe(
        result.status,
      );
      expect(f.external.status().approval).toBeUndefined();
    }
  });

  test('frozen ownership rejects a different user without disclosing request details', async () => {
    const f = await fixture();
    await f.service.approve(await f.latest(), ownerId, 'code-api');
    await expect(f.service.inspect(await f.latest(), strangerId)).rejects.toEqual(
      new SetupError(404, 'SETUP_NOT_FOUND'),
    );
    await expect(f.service.approve(await f.latest(), strangerId, 'code-api')).rejects.toMatchObject(
      { status: 404 },
    );
  });

  test('concurrent approval freezes one binding and allocates one owner slot', async () => {
    const f = await fixture();
    const initial = await f.latest();
    const results = await Promise.all([
      f.service.approve(initial, ownerId, 'code-api'),
      f.make().service.approve(initial, ownerId, 'code-api'),
    ]);
    expect(results.every((value) => ['provisioning', 'approved'].includes(value.status))).toBe(
      true,
    );
    expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
    expect(f.external.status().issueCount).toBe(1);
    expect((await f.latest()).ownerId).toBe(ownerId);
  });

  test('registry commit followed by response loss retries successfully at full capacity', async () => {
    const f = await fixture();
    await f.service.approve(await f.latest(), ownerId, 'code-api');
    const commit = f.registry.completeSetup.bind(f.registry);
    jest.spyOn(f.registry, 'completeSetup').mockImplementationOnce(async (params) => {
      await commit(params);
      throw new Error('registry commit response lost');
    });
    await expect(f.service.advance(await f.latest(), await f.signature())).rejects.toThrow(
      'registry commit response lost',
    );
    expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
    expect(
      (await f.make().service.advance(await f.latest(), await f.signature())).session.status,
    ).toBe('completed');
    expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
  });

  test('completed enrollment survives ordinary setup expiry without revocation', async () => {
    const f = await fixture();
    await f.service.approve(await f.latest(), ownerId, 'code-api');
    await f.service.advance(await f.latest(), await f.signature());
    const time = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(time + 601_000);
    try {
      expect((await f.make().service.advance(await f.latest())).session.status).toBe('completed');
      expect(f.external.status().revoked).toBe(false);
      expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([false, true])(
    'already revoked enrollment is not revoked again after completion=%s',
    async (completed) => {
      const f = await fixture();
      await f.service.approve(await f.latest(), ownerId, 'code-api');
      if (completed) await f.service.advance(await f.latest(), await f.signature());
      await f.external.revoke();
      expect((await f.make().service.advance(await f.latest())).session.status).toBe('failed');
      expect(f.external.status().revokeCount).toBe(1);
      expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(0);
    },
  );

  test.each(['disableEnrollment', 'disableBrowserSetup'] as const)(
    'lost redemption remains completed after %s without revocation or another slot',
    async (disable) => {
      const f = await fixture();
      await f.service.approve(await f.latest(), ownerId, 'code-api');
      const approved = (await f.latest()).approval;
      f.external.loseRedeem();
      await expect(f.service.advance(await f.latest(), await f.signature())).rejects.toThrow();
      f[disable]();
      expect((await f.make().service.advance(await f.latest())).session.status).toBe('completed');
      expect(f.external.status().revoked).toBe(false);
      expect((await f.latest()).approval).toEqual(approved);
      expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
      expect((await f.service.inspect(await f.latest(), ownerId)).status).toBe('completed');
      expect(
        (await f.make().service.advance(await f.latest(), await f.signature())).credential,
      ).toBeDefined();
    },
  );

  test('authorization withdrawal after completion deliberately revokes instead of treating it as TTL cleanup', async () => {
    const f = await fixture();
    await f.service.approve(await f.latest(), ownerId, 'code-api');
    await f.service.advance(await f.latest(), await f.signature());
    await f.deleteAccount();
    expect((await f.make().service.advance(await f.latest())).session.status).toBe('failed');
    expect(f.external.status().revoked).toBe(true);
    expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(0);
  });

  test('stale or far-future creation time cannot allocate or reopen an attempt', async () => {
    const f = await fixture();
    for (const createdAt of [
      new Date(Date.now() - 601_000).toISOString(),
      new Date(Date.now() + 61_000).toISOString(),
    ]) {
      await expect(f.service.start(input(createdAt), ipHash, f.config)).rejects.toMatchObject({
        code: 'SETUP_EXPIRED',
      });
    }
  });
});
