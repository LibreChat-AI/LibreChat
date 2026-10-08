/**
 * MCP OAuth guarantees that only a multi-process deployment can establish.
 *
 * Existing coverage runs two instances inside one Jest process, where a process-local single-flight
 * map can satisfy an assertion production cannot: real replicas share only Redis, Mongo and the
 * provider. These tests therefore fork REAL worker processes (`helpers/mcpOAuthWorkerBoot.cjs`) that
 * use the production adapters, and assert the outcomes a user experiences: one redemption per
 * rotation, an adopted result on the peer, and recovery after a replica dies.
 *
 * The negative control matters as much as the positive one. With coordination disabled the same
 * harness must produce TWO redemptions while the provider holds the first response open; without
 * that, a passing coordinated run could simply mean the workers never overlapped.
 */

import path from 'path';
import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import { fork } from 'child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ChildProcess } from 'child_process';
import type { OAuthTestServer } from './helpers/oauthTestServer';
import { createOAuthMCPServer } from './helpers/oauthTestServer';

const WORKER_BOOT = path.join(__dirname, 'helpers', 'mcpOAuthWorkerBoot.cjs');
const CLIENT_ID = 'librechat-multiprocess-harness';
/** Test-only material; the worker encrypts with the production helpers, which require both. */
const CREDS_KEY = 'a'.repeat(64);
const CREDS_IV = 'b'.repeat(32);
const BOOT_TIMEOUT_MS = 60_000;
const SETTLE_MS = 750;

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  /** Errors cross IPC as plain data; Error instances do not survive structured cloning. */
  error?: { name?: string; message?: string; stack?: string };
}

interface TokenOutcome {
  obtained: boolean;
  /** Which side of the coordination this replica took, from `getTokens`' own hooks. */
  role: 'refreshed' | 'adopted' | null;
  expiredAtEntry?: boolean;
  resourceStatus: number | null;
  refreshDigest: string | null;
  credentialSetId?: string | null;
}

/** One replica: a real child process speaking a small request/response protocol over IPC. */
class ReplicaProcess {
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private nextId = 1;
  private exited = false;
  /** Unsolicited worker notifications, used to establish overlap instead of assuming it. */
  public readonly progress: string[] = [];

  private constructor(
    public readonly name: string,
    private readonly child: ChildProcess,
    private readonly stderr: string[],
  ) {
    child.on('message', (message) => {
      const notification = message as { progress?: string };
      if (notification.progress) {
        this.progress.push(notification.progress);
        return;
      }
      const reply = message as WorkerReply;
      const waiter = this.pending.get(reply.id);
      if (!waiter) {
        return;
      }
      this.pending.delete(reply.id);
      if (reply.ok) {
        waiter.resolve(reply.result);
      } else {
        const failure = new Error(`[${name}] ${reply.error?.message ?? 'worker command failed'}`);
        failure.name = reply.error?.name ?? 'Error';
        if (reply.error?.stack) {
          failure.stack = `${failure.name}: ${failure.message}\n${reply.error.stack}`;
        }
        waiter.reject(failure);
      }
    });
    child.on('exit', (code, signal) => {
      this.exited = true;
      const reason = `[${name}] exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`;
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(reason));
      }
      this.pending.clear();
    });
  }

  static async start(options: {
    name: string;
    mongoUri: string;
    providerUrl: string;
    userId: string;
    serverName: string;
    flowNamespace: string;
    coordinate: boolean;
  }): Promise<ReplicaProcess> {
    const child = fork(WORKER_BOOT, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        USE_REDIS: 'true',
        CREDS_KEY,
        CREDS_IV,
        MCP_TEST_MONGO_URI: options.mongoUri,
        MCP_TEST_PROVIDER_URL: options.providerUrl,
        MCP_TEST_USER_ID: options.userId,
        MCP_TEST_SERVER_NAME: options.serverName,
        MCP_TEST_CLIENT_ID: CLIENT_ID,
        MCP_TEST_FLOW_NAMESPACE: options.flowNamespace,
        MCP_TEST_COORDINATE: String(options.coordinate),
      },
    });

    /** Keep worker stderr; silence is what makes a process harness hard to debug. */
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
    child.stdout?.resume();

    const replica = new ReplicaProcess(options.name, child, stderr);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `[${options.name}] not ready in ${BOOT_TIMEOUT_MS}ms. stderr: ${stderr.join('').slice(-2000)}`,
            ),
          );
        }, BOOT_TIMEOUT_MS);
        child.once('message', (message) => {
          clearTimeout(timer);
          if ((message as { ready?: boolean }).ready) {
            resolve();
          } else {
            reject(
              new Error(
                `[${options.name}] failed to initialize: ${(message as { error?: { message?: string } }).error?.message ?? 'no ready signal'}`,
              ),
            );
          }
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(
            new Error(
              `[${options.name}] exited during boot. stderr: ${stderr.join('').slice(-2000)}`,
            ),
          );
        });
      });
    } catch (error) {
      /**
       * A worker that never reported ready is still running, holding Mongo and Redis connections
       * that would outlive this suite and interfere with the rest of the integration lane. Reap it
       * before surfacing the boot failure.
       */
      await replica.kill();
      throw error;
    }
    return replica;
  }

  send<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error(`[${this.name}] is no longer running`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.child.send({ id, command, payload });
    });
  }

  /** Terminates without shutdown, standing in for a replica that dies mid-operation. */
  async kill(): Promise<void> {
    if (this.exited) {
      return;
    }
    const stopped = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.kill('SIGKILL');
    await stopped;
  }

  async stop(): Promise<void> {
    if (this.exited) {
      return;
    }
    await this.send('shutdown').catch(() => undefined);
    const stopped = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.kill('SIGTERM');
    await stopped;
  }
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const describeWithRedis = process.env.REDIS_URI ? describe : describe.skip;

describeWithRedis('MCP OAuth credential lifecycle across separate replica processes', () => {
  let mongod: MongoMemoryServer;
  let server: OAuthTestServer;
  const replicas: ReplicaProcess[] = [];
  let holdRefresh = false;
  let releaseRefresh: (() => void) | undefined;
  let gatePromise: Promise<void> | undefined;

  const refreshGrants = () =>
    server.tokenRequests.filter((request) => request.grantType === 'refresh_token').length;
  const consentGrants = () =>
    server.tokenRequests.filter((request) => request.grantType === 'authorization_code').length;

  beforeAll(async () => {
    /**
     * `--nounixsocket` keeps mongod off its hardcoded /tmp socket path, which a read-only root
     * filesystem rejects with an opaque fassert failure. It changes nothing about the server.
     */
    mongod = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await mongod?.stop();
  });

  beforeEach(async () => {
    holdRefresh = false;
    gatePromise = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    server = await createOAuthMCPServer({
      issueRefreshTokens: true,
      rotateRefreshTokens: true,
      refreshGate: () => (holdRefresh ? gatePromise : undefined),
    });
  });

  afterEach(async () => {
    releaseRefresh?.();
    await Promise.all(replicas.splice(0).map((replica) => replica.stop()));
    await server?.close();
  });

  /** Each scenario owns its principal, server name and flow namespace, so state never bleeds. */
  const scenario = () => {
    const suffix = randomUUID().slice(0, 8);
    return {
      userId: new mongoose.Types.ObjectId().toString(),
      serverName: `multiprocess-server-${suffix}`,
      flowNamespace: `MCPOAuthMultiProcess-${process.pid}-${suffix}`,
    };
  };

  const startReplica = async (
    name: string,
    context: ReturnType<typeof scenario>,
    coordinate: boolean,
  ): Promise<ReplicaProcess> => {
    const replica = await ReplicaProcess.start({
      name,
      mongoUri: mongod.getUri(),
      providerUrl: server.url,
      coordinate,
      ...context,
    });
    replicas.push(replica);
    return replica;
  };

  it(
    'redeems a rotating refresh token once when both replicas refresh together',
    async () => {
      const context = scenario();
      const [replicaA, replicaB] = await Promise.all([
        startReplica('replica-A', context, true),
        startReplica('replica-B', context, true),
      ]);

      await replicaA.send('authorize');
      await replicaA.send('expireAccess');
      expect(consentGrants()).toBe(1);

      /** Hold the provider's response so the two reads genuinely overlap. */
      holdRefresh = true;
      const readA = replicaA.send<TokenOutcome>('getTokens');
      const readB = replicaB.send<TokenOutcome>('getTokens');

      /**
       * Establish the overlap before releasing anything. Waiting only for a provider hit would let
       * a slow peer arrive after the winner had already persisted, read a fresh credential, and
       * never contend: the redemption count would still be 1 and the assertion would pass while
       * proving nothing. Both replicas must have entered the refresh path on an expired credential.
       */
      await waitFor(() => refreshGrants() >= 1, 'the first replica to reach the provider');
      await waitFor(
        () => replicaA.progress.includes('entered-refresh-path'),
        'replica A to enter the refresh path',
      );
      await waitFor(
        () => replicaB.progress.includes('entered-refresh-path'),
        'replica B to enter the refresh path',
      );
      /** The peer must wait for the winner, not start a second redemption of the same token. */
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      expect(refreshGrants()).toBe(1);

      releaseRefresh?.();
      const [outcomeA, outcomeB] = await Promise.all([readA, readB]);

      expect(outcomeA.obtained).toBe(true);
      expect(outcomeB.obtained).toBe(true);
      /** Both saw an expired credential, so neither read was a cache hit on a fresh token. */
      expect(outcomeA.expiredAtEntry).toBe(true);
      expect(outcomeB.expiredAtEntry).toBe(true);
      /**
       * `getTokens` reports which side each replica took. Exactly one redeemed and the other
       * adopted what it published: that pair is the coordination itself, and it cannot be produced
       * by a replica that merely arrived late and loaded an already-valid credential.
       */
      expect([outcomeA.role, outcomeB.role].sort()).toEqual(['adopted', 'refreshed']);
      /** Both replicas hold a credential the resource server accepts. */
      expect(outcomeA.resourceStatus).toBe(200);
      expect(outcomeB.resourceStatus).toBe(200);
      /** Both converged on one rotated credential, and consent was never requested again. */
      expect(outcomeB.refreshDigest).toBe(outcomeA.refreshDigest);
      expect(refreshGrants()).toBe(1);
      expect(consentGrants()).toBe(1);

      /**
       * The rotation that was actually persisted has to be the one the provider now expects, so a
       * later cycle must succeed. A lost replacement would only surface here.
       */
      await replicaB.send('expireAccess');
      const nextCycle = await replicaB.send<TokenOutcome>('getTokens');
      expect(nextCycle.obtained).toBe(true);
      expect(nextCycle.resourceStatus).toBe(200);
      expect(nextCycle.refreshDigest).not.toBe(outcomeA.refreshDigest);
      expect(refreshGrants()).toBe(2);
      expect(consentGrants()).toBe(1);
    },
    BOOT_TIMEOUT_MS * 2,
  );

  it(
    'observes two redemptions without coordination, proving the replicas truly overlap',
    async () => {
      const context = scenario();
      const [replicaA, replicaB] = await Promise.all([
        startReplica('replica-A', context, false),
        startReplica('replica-B', context, false),
      ]);

      await replicaA.send('authorize');
      await replicaA.send('expireAccess');

      holdRefresh = true;
      const readA = replicaA.send<TokenOutcome>('getTokens').catch(() => null);
      const readB = replicaB.send<TokenOutcome>('getTokens').catch(() => null);

      /**
       * This is the control for the test above: uncoordinated replicas reach the provider twice
       * while the first response is still open. If this ever stops happening, the coordinated
       * assertion is no longer evidence of coordination.
       */
      await waitFor(
        () => replicaA.progress.includes('entered-refresh-path'),
        'replica A to enter the refresh path',
      );
      await waitFor(
        () => replicaB.progress.includes('entered-refresh-path'),
        'replica B to enter the refresh path',
      );
      await waitFor(
        () => refreshGrants() >= 2,
        'both uncoordinated replicas to reach the provider',
      );
      expect(refreshGrants()).toBe(2);

      releaseRefresh?.();
      await Promise.all([readA, readB]);
    },
    BOOT_TIMEOUT_MS * 2,
  );

  it(
    'recovers on a replacement replica after the authorizing replica is killed',
    async () => {
      const context = scenario();
      const original = await startReplica('replica-original', context, true);

      await original.send('authorize');
      await original.send('expireAccess');
      const rotated = await original.send<TokenOutcome>('getTokens');
      expect(rotated.obtained).toBe(true);
      expect(refreshGrants()).toBe(1);

      /** No graceful shutdown: nothing in memory survives, only what was persisted. */
      await original.kill();

      const replacement = await startReplica('replica-replacement', context, true);
      /** The durable claim: credentials outlived the process that obtained them. */
      const restored = await replacement.send<TokenOutcome & { hasClient: boolean }>('readStored');
      expect(restored.obtained).toBe(true);
      expect(restored.hasClient).toBe(true);
      expect(restored.refreshDigest).toEqual(expect.any(String));
      expect(restored.credentialSetId).toEqual(expect.any(String));

      await replacement.send('expireAccess');
      const afterRestart = await replacement.send<TokenOutcome>('getTokens');

      /** Recovery came from durable credentials alone: still one consent for the whole scenario. */
      expect(afterRestart.obtained).toBe(true);
      expect(afterRestart.resourceStatus).toBe(200);
      expect(afterRestart.refreshDigest).not.toBe(rotated.refreshDigest);
      expect(refreshGrants()).toBe(2);
      expect(consentGrants()).toBe(1);
    },
    BOOT_TIMEOUT_MS * 2,
  );
});
