import fs from 'node:fs';
import os from 'node:os';
import Redis from 'ioredis';
import path from 'node:path';
import express from 'express';
import { Agent } from 'undici';
import mongoose from 'mongoose';
import { createServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createServer as createHttpServer } from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createBrowserSetupBackend, createMethods, createModels } from '@librechat/data-schemas';
import type { BrowserSetupSession, AppConfig } from '@librechat/data-schemas';
import type { Server } from 'node:http';
import type { Router } from 'express';
import { createCodeEnvironmentRegistry } from '../environments';
import { createSameOriginGuard } from '~/middleware/origin';
import { createCodeSetupRouter } from './router';

const upstreamCommit = 'a3207a75c8327ba1c9526eff8b06f3588f3739ed';
const upstreamRoot = process.env.CODE_SETUP_UPSTREAM;
const describeCompatibility = upstreamRoot == null ? describe.skip : describe;

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        reject(new Error('Expected a disposable TCP listener'));
        return;
      }
      resolve(`127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describeCompatibility(
  'merged browser setup CLI with disposable Code API and LibreChat authorities',
  () => {
    let mongo: MongoMemoryServer;
    let redis: Redis;
    let directory: string;
    let certificate: Buffer;
    let privateKey: Buffer;
    const originalEnvironment = {
      CODEAPI_JWT_ENABLED: process.env.CODEAPI_JWT_ENABLED,
      CODEAPI_JWT_PRIVATE_KEY: process.env.CODEAPI_JWT_PRIVATE_KEY,
      CODE_SETUP_COMPAT_ADMIN: process.env.CODE_SETUP_COMPAT_ADMIN,
    };

    beforeAll(async () => {
      if (upstreamRoot == null) throw new Error('The pinned upstream fixture is required');
      const fixtureCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: upstreamRoot,
        encoding: 'utf8',
      }).trim();
      if (fixtureCommit !== upstreamCommit)
        throw new Error('The upstream fixture must match the merged protocol commit');
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-enrollment-'));
      fs.chmodSync(directory, 0o700);
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=127.0.0.1',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
          '-keyout',
          path.join(directory, 'tls.key'),
          '-out',
          path.join(directory, 'tls.crt'),
        ],
        { stdio: 'ignore' },
      );
      certificate = fs.readFileSync(path.join(directory, 'tls.crt'));
      privateKey = fs.readFileSync(path.join(directory, 'tls.key'));
      fs.chmodSync(path.join(directory, 'tls.key'), 0o600);
      const signing = generateKeyPairSync('ed25519');
      process.env.CODEAPI_JWT_ENABLED = 'true';
      process.env.CODEAPI_JWT_PRIVATE_KEY = signing.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      process.env.CODE_SETUP_COMPAT_ADMIN = randomBytes(32).toString('base64url');
      const redisUrl = process.env.CODE_SETUP_REDIS_URI;
      if (redisUrl == null || new URL(redisUrl).pathname !== '/15') {
        throw new Error('Compatibility tests require the disposable CI Redis database 15');
      }
      redis = new Redis(redisUrl);
      await redis.ping();
      mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
      await mongoose.connect(mongo.getUri());
      createModels(mongoose);
      await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    }, 60_000);

    beforeEach(async () => {
      await redis.flushdb();
      await mongoose.connection.dropDatabase();
      await createMethods(mongoose).seedDefaultRoles();
    });

    afterAll(async () => {
      await mongoose.disconnect();
      await mongo?.stop();
      redis?.disconnect();
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      if (directory != null) fs.rmSync(directory, { recursive: true, force: true });
    });

    test.each(['normal', 'lost-issuance', 'lost-redemption'] as const)(
      '%s completes the exact CLI command and preserves its existing profile on retry',
      async (scenario) => {
        if (upstreamRoot == null) throw new Error('The pinned upstream fixture is required');
        const { createBridgeRouter } = jest.requireActual(
          path.join(upstreamRoot, 'service/src/bridge/router.ts'),
        ) as {
          createBridgeRouter: (options: {
            store: object;
            pairings: object;
            authMode: 'paired';
            adminToken: string;
            allowDynamicWorkers: boolean;
          }) => Router;
        };
        const { RedisBridgePairingStore } = jest.requireActual(
          path.join(upstreamRoot, 'service/src/bridge/pairing.ts'),
        ) as {
          RedisBridgePairingStore: new (
            client: Redis,
            pairingTtl: number,
            credentialTtl: number,
            skew: number,
            namespace: string,
            options: { serverId: string },
          ) => object;
        };
        const { RedisBridgeStore } = jest.requireActual(
          path.join(upstreamRoot, 'service/src/bridge/store.ts'),
        ) as {
          RedisBridgeStore: new (client: Redis) => object;
        };
        const codeApp = express();
        codeApp.use(express.json());
        const codeServer = createServer({ key: privateKey, cert: certificate }, codeApp);
        const codeOrigin = `https://${await listen(codeServer)}`;
        codeApp.use(
          '/v1/bridge',
          createBridgeRouter({
            store: new RedisBridgeStore(redis),
            pairings: new RedisBridgePairingStore(redis, 600, 900, 5_000, '', {
              serverId: codeOrigin,
            }),
            authMode: 'paired',
            adminToken: process.env.CODE_SETUP_COMPAT_ADMIN!,
            allowDynamicWorkers: true,
          }),
        );
        const user = await mongoose.models.User.create({
          name: 'Compatibility owner',
          email: `${scenario}@example.test`,
          provider: 'local',
          role: 'USER',
          emailVerified: true,
          termsAccepted: true,
        });
        const userId = user._id.toString();
        const browserToken = randomBytes(32).toString('base64url');
        const lifetime = new AbortController();
        const app = express();
        app.use(express.json());
        const server = createHttpServer(app);
        const instance = `http://${await listen(server)}`;
        const settings = {
          enabled: true,
          instance,
          maxPending: 8,
          maxPerIp: 8,
          requestsPerMinute: 1200,
          requestsPerIpMinute: 120,
          proofWindowMs: 60_000,
          maxProofsPerAttempt: 1024,
          reconcileIntervalMs: 10_000,
          retentionMs: 86_400_000,
        };
        const config = {
          endpoints: {
            agents: {
              statefulCodeSessions: {
                allowedEnvironments: ['user'],
                principalWorkers: { enabled: true, maxPerUser: 1, browserSetup: settings },
                environments: [
                  {
                    id: 'personal',
                    name: 'Disposable Code API',
                    type: 'attached',
                    owner: 'deployment',
                    baseURL: `${codeOrigin}/v1`,
                    pairing: { tokenEnv: 'CODE_SETUP_COMPAT_ADMIN', allowPrincipalWorkers: true },
                  },
                ],
              },
            },
          },
        } as AppConfig;
        // Authentication is a fixture boundary here; login and explicit confirmation have browser E2E coverage.
        const replica = () =>
          createCodeSetupRouter({
            backend: createBrowserSetupBackend(mongoose),
            signal: lifetime.signal,
            getAppConfig: async () => config,
            registry: () => createCodeEnvironmentRegistry(mongoose),
            requireJwtAuth: (req, res, next) => {
              if (req.headers.authorization !== `Bearer ${browserToken}`) {
                res.sendStatus(401);
                return;
              }
              Object.assign(req, { user: { id: userId } });
              next();
            },
            checkBan: (_req, _res, next) => next(),
            requireSameOrigin: createSameOriginGuard({ trustedOrigins: [instance] }),
            banStore: { get: async () => undefined },
          });
        let activeReplica = replica();
        app.use('/api/code-environments/setup', (req, res, next) => activeReplica(req, res, next));
        const tls = new Agent({ connect: { ca: certificate } });
        const realFetch = globalThis.fetch;
        let loseIssue = scenario === 'lost-issuance';
        let loseRedemption = scenario === 'lost-redemption';
        const upstreamFetch = jest
          .spyOn(globalThis, 'fetch')
          .mockImplementation(async (input, init) => {
            const url = String(input);
            const options = { ...init, ...(url.startsWith(codeOrigin) ? { dispatcher: tls } : {}) };
            const response = await realFetch(input, options);
            const lose =
              response.ok &&
              ((loseIssue && url === `${codeOrigin}/v1/bridge/enrollments`) ||
                (loseRedemption && url === `${codeOrigin}/v1/bridge/enrollments/redeem`));
            if (lose) {
              loseIssue = false;
              loseRedemption = false;
              await response.body?.cancel();
              throw new Error('Disposable transport lost an already committed response');
            }
            return response;
          });
        const profile = path.join(directory, `${scenario}.json`);
        const cli = path.join(upstreamRoot, 'packages/code/dist/cli.js');
        const children = new Set<ReturnType<typeof spawn>>();
        function runCli(): Promise<{ code: number | null; stdout: string; stderr: string }> {
          return new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                cli,
                'setup',
                '--instance',
                instance,
                '--machine-name',
                'Compatibility VM',
                '--profile',
                profile,
                '--non-interactive',
                '--default-workspace',
                '--no-browser',
              ],
              {
                env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(directory, 'tls.crt') },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            children.add(child);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (data: Buffer) => {
              stdout = (stdout + data.toString()).slice(-8192);
            });
            child.stderr.on('data', (data: Buffer) => {
              stderr = (stderr + data.toString()).slice(-8192);
            });
            child.once('error', reject);
            child.once('exit', (code) => {
              children.delete(child);
              resolve({ code, stdout, stderr });
            });
          });
        }
        async function browser(pathname: string, body?: object): Promise<Response> {
          return await realFetch(`${instance}${pathname}`, {
            method: body == null ? 'GET' : 'POST',
            headers: {
              Authorization: `Bearer ${browserToken}`,
              Origin: instance,
              'Content-Type': 'application/json',
            },
            ...(body == null ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(15_000),
          });
        }
        try {
          const first = runCli();
          const backend = createBrowserSetupBackend(mongoose);
          let pending: BrowserSetupSession | undefined;
          for (let index = 0; index < 150 && pending == null; index++) {
            const rows = await mongoose.connection
              .collection<BrowserSetupSession>('browser_setup_sessions')
              .find({})
              .limit(1)
              .toArray();
            pending = rows[0];
            if (pending == null) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (pending == null) {
            const result = await first;
            throw new Error(
              `Merged CLI did not create a setup session (exit ${result.code}); storage ownership must remain enforced`,
            );
          }
          const setupPath = `/api/code-environments/setup/${pending.attemptId}`;
          const inspect = await browser(setupPath);
          expect(inspect.status).toBe(200);
          const projection = (await inspect.json()) as {
            status: string;
            machineName: string;
            verificationCode: string;
          };
          expect(projection).toMatchObject({
            status: 'pending',
            machineName: 'Compatibility VM',
            verificationCode: pending.verificationCode,
          });
          const planned = JSON.parse(pending.requestCanonical) as Record<string, unknown>;
          expect(planned.workspace).toEqual({ type: 'private' });
          expect(planned).not.toHaveProperty('privateKey');
          expect(planned).not.toHaveProperty('path');
          const decision = await browser(`${setupPath}/approve`, { controlPlaneId: 'personal' });
          expect(decision.status).toBe(scenario === 'lost-issuance' ? 503 : 200);
          if (scenario === 'lost-issuance') {
            activeReplica = replica();
            expect((await browser(setupPath)).status).toBe(200);
          }
          const initial = await first;
          let output = initial.stdout;
          if (scenario === 'lost-redemption') {
            expect(initial.code).toBe(1);
            activeReplica = replica();
            expect((await browser(setupPath)).status).toBe(200);
            const resumed = await runCli();
            expect(resumed.code).toBe(0);
            output += resumed.stdout;
          } else expect(initial.code).toBe(0);
          expect(output).toContain('Machine enrolled. Profile saved.');
          expect(output).toContain('not connected or ready');
          expect(output).toContain(pending.verificationCode);
          const saved = JSON.parse(fs.readFileSync(profile, 'utf8')) as {
            identityPath: string;
            workspace: object;
            allowWorkspaceWrites: boolean;
            allowWorkspaceCommands: boolean;
          };
          expect(saved).toMatchObject({
            version: 1,
            workspace: { type: 'private' },
            allowWorkspaceWrites: false,
            allowWorkspaceCommands: false,
          });
          const identity = JSON.parse(fs.readFileSync(saved.identityPath, 'utf8')) as {
            workerId: string;
            publicKey: string;
            credential: string;
          };
          expect(identity.workerId).toBe(pending.workerId);
          expect(identity.publicKey).toBe(planned.publicKey);
          expect(identity.credential.length).toBeGreaterThanOrEqual(32);
          expect(fs.statSync(saved.identityPath).mode & 0o777).toBe(0o600);
          const receipt = JSON.parse(
            fs.readFileSync(`${profile}.setup/attempt.json`, 'utf8'),
          ) as Record<string, unknown>;
          expect(receipt.completed).toBe(true);
          expect(receipt).not.toHaveProperty('privateKey');
          expect((await backend.createStore().get(pending.attemptId))?.status).toBe('completed');
          expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
          expect(
            await createCodeEnvironmentRegistry(mongoose).listAccessible({ userId }),
          ).toHaveLength(1);
          const before = fs.readFileSync(saved.identityPath, 'utf8');
          expect((await runCli()).code).toBe(0);
          expect(fs.readFileSync(saved.identityPath, 'utf8')).toBe(before);
          expect(await mongoose.models.CodeEnvironment.countDocuments()).toBe(1);
        } finally {
          lifetime.abort();
          for (const child of children) child.kill('SIGKILL');
          await Promise.all([close(server), close(codeServer)]);
          await tls.close();
          upstreamFetch.mockRestore();
        }
      },
      60_000,
    );
  },
);
