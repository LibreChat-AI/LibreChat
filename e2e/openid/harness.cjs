const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoClient } = require('mongodb');

const root = path.resolve(__dirname, '../..');
const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.1.5@sha256:be6a86215213145bfb4fb3e2b3ab982a806d00262655abdcf3ffa6a38d241c7c';
const realmName = 'librechat-test';
const secret = () => randomBytes(32).toString('hex');
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}

/** Starts only disposable services. Call close() from the worker fixture's finally block. */
async function createHarness(options = {}) {
  if (fs.existsSync(path.join(root, '.env'))) {
    throw new Error('Run Keycloak tests from a checkout without a .env file');
  }
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'librechat-keycloak-'));
  fs.chmodSync(directory, 0o755);
  const suffix = randomBytes(6).toString('hex');
  const keycloak = `librechat-e2e-keycloak-${suffix}`;
  const mongoContainer = `librechat-e2e-mongo-${suffix}`;
  const database = `LibreChat-keycloak-${suffix}`;
  const certPath = path.join(directory, 'cert.pem');
  const keyPath = path.join(directory, 'key.pem');
  const gatePath = path.join(directory, 'gate.json');
  const configPath = path.join(directory, 'librechat.yaml');
  const logPath = path.join(directory, 'app.log');
  const writeGate = (state = {}) => {
    const pending = `${gatePath}.${process.pid}.tmp`;
    fs.writeFileSync(pending, JSON.stringify(state));
    fs.renameSync(pending, gatePath);
  };
  writeGate();
  const baseURL = `http://localhost:${await freePort()}`;
  const keycloakBase = `https://127.0.0.1:${await freePort()}`;
  const issuer = `${keycloakBase}/realms/${realmName}`;
  const credentials = {
    client: secret(),
    admin: secret(),
    password: 'local-test-password',
  };
  let child;
  let childClosed;
  let mongo;
  let db;
  let closePromise;
  let current = {
    reuse: true,
    mode: 'enforce',
    sessionExpiry: 300_000,
    loginMax: 1000,
    ...options,
  };
  const deliveries = [];
  const signedBodies = [];
  const appSecrets = {
    JWT_SECRET: secret(),
    JWT_REFRESH_SECRET: secret(),
    CREDS_KEY: secret(),
    CREDS_IV: randomBytes(16).toString('hex'),
    OPENID_SESSION_SECRET: secret(),
  };
  const sensitive = [...Object.values(credentials), ...Object.values(appSecrets)];
  const sanitize = (text) => {
    let safe = text.replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
      '[redacted-token]',
    );
    for (const value of sensitive) safe = safe.split(value).join('[redacted]');
    return safe;
  };

  async function forward(body) {
    try {
      const response = await fetch(`${baseURL}/oauth/openid/backchannel-logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = sanitize(text);
      }
      return { status: response.status, body: value };
    } catch {
      return { status: 502, body: 'Test app unavailable' };
    }
  }

  const proxy = http.createServer(async (request, response) => {
    if (request.url !== '/logout' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const token = new URLSearchParams(body).get('logout_token');
    let sid;
    try {
      sid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sid;
    } catch {
      /* Invalid payload still reaches the real route. */
    }
    signedBodies.push(body);
    const event = { sid, at: Date.now(), status: undefined };
    deliveries.push(event);
    const result = await forward(body);
    event.status = result.status;
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });

  async function stopApp() {
    if (!child) return;
    const running = child;
    let timer;
    if (running.pid && running.exitCode === null && running.signalCode === null) {
      timer = setTimeout(() => running.kill('SIGKILL'), 10_000);
      running.kill('SIGTERM');
    }
    await childClosed;
    clearTimeout(timer);
  }

  function close() {
    return (closePromise ??= (async () => {
      const failures = [];
      const attempt = async (label, operation) => {
        try {
          await operation();
        } catch {
          failures.push(label);
        }
      };
      await attempt('query gate', () => writeGate());
      await attempt('app', stopApp);
      await attempt('MongoDB client', () => mongo?.close());
      await attempt('delivery proxy', async () => {
        proxy.closeAllConnections();
        await new Promise((resolve) => proxy.close(resolve));
      });
      for (const container of [keycloak, mongoContainer]) {
        try {
          docker('rm', '-f', '-v', container);
        } catch (error) {
          if (!String(error.stderr).includes('No such container')) failures.push(container);
        }
      }
      await attempt('private directory', () =>
        fs.rmSync(directory, { recursive: true, force: true }),
      );
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (failures.length)
        throw new Error(`Could not clean up test resources: ${failures.join(', ')}`);
    })());
  }

  const onSignal = () => void close().finally(() => process.exit(1));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '0.0.0.0', resolve);
    });
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
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    );
    fs.chmodSync(keyPath, 0o644);
    const ca = fs.readFileSync(certPath);
    const providerRequest = (route, method = 'GET', body, headers = {}) =>
      new Promise((resolve, reject) => {
        const request = https.request(
          `${keycloakBase}${route}`,
          { method, ca, headers, timeout: 15_000 },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString();
              if (response.statusCode < 200 || response.statusCode >= 300) {
                reject(new Error(`Keycloak ${method} request failed: ${response.statusCode}`));
                return;
              }
              try {
                resolve(text ? JSON.parse(text) : null);
              } catch {
                reject(new Error('Keycloak returned invalid JSON'));
              }
            });
          },
        );
        request.on('error', () => reject(new Error('Keycloak connection failed')));
        request.on('timeout', () => request.destroy());
        request.end(body);
      });
    async function admin(route, method = 'GET', body) {
      const token = await providerRequest(
        '/realms/master/protocol/openid-connect/token',
        'POST',
        new URLSearchParams({
          client_id: 'admin-cli',
          username: 'admin',
          password: credentials.admin,
          grant_type: 'password',
        }).toString(),
        { 'content-type': 'application/x-www-form-urlencoded' },
      );
      return providerRequest(
        `/admin/realms/${realmName}${route}`,
        method,
        body === undefined ? undefined : JSON.stringify(body),
        { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
      );
    }
    const realmPath = path.join(directory, 'realm.json');
    fs.writeFileSync(
      realmPath,
      JSON.stringify({
        realm: realmName,
        enabled: true,
        accessTokenLifespan: 300,
        revokeRefreshToken: true,
        refreshTokenMaxReuse: 0,
        eventsEnabled: true,
        enabledEventTypes: ['LOGIN', 'LOGOUT', 'REFRESH_TOKEN', 'REFRESH_TOKEN_ERROR'],
        clients: [
          {
            clientId: 'librechat-test',
            secret: credentials.client,
            standardFlowEnabled: true,
            publicClient: false,
            redirectUris: [`${baseURL}/oauth/openid/callback`],
            defaultClientScopes: ['profile', 'email', 'roles'],
            attributes: {
              'backchannel.logout.url': `http://host.docker.internal:${proxy.address().port}/logout`,
              'backchannel.logout.session.required': 'true',
              'backchannel.logout.revoke.offline.tokens': 'true',
            },
          },
        ],
        users: ['a', 'b'].map((name) => ({
          username: name,
          email: `${name}@example.test`,
          emailVerified: true,
          firstName: 'User',
          lastName: name.toUpperCase(),
          enabled: true,
          credentials: [{ type: 'password', value: credentials.password, temporary: false }],
        })),
      }),
    );
    docker(
      'run',
      '-d',
      '--name',
      keycloak,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-p',
      `127.0.0.1:${new URL(keycloakBase).port}:8443`,
      '-v',
      `${directory}:/opt/keycloak/test:ro`,
      '-v',
      `${realmPath}:/opt/keycloak/data/import/librechat-test-realm.json:ro`,
      '-e',
      'KC_BOOTSTRAP_ADMIN_USERNAME=admin',
      '-e',
      `KC_BOOTSTRAP_ADMIN_PASSWORD=${credentials.admin}`,
      KEYCLOAK_IMAGE,
      'start-dev',
      '--import-realm',
      `--hostname=${keycloakBase}`,
      '--http-enabled=false',
      '--https-certificate-file=/opt/keycloak/test/cert.pem',
      '--https-certificate-key-file=/opt/keycloak/test/key.pem',
    );
    const waitForKeycloak = () =>
      until(
        async () => {
          try {
            await providerRequest(`/realms/${realmName}/.well-known/openid-configuration`);
            return true;
          } catch {
            return false;
          }
        },
        'Keycloak discovery did not become ready',
        120_000,
      );
    await waitForKeycloak();
    const mongoPort = await freePort();
    docker(
      'run',
      '-d',
      '--name',
      mongoContainer,
      '-p',
      `127.0.0.1:${mongoPort}:27017`,
      'mongo:8.0.20',
      '--bind_ip_all',
    );
    const mongoURI = `mongodb://127.0.0.1:${mongoPort}/${database}?serverSelectionTimeoutMS=2000`;
    mongo = new MongoClient(mongoURI);
    await until(async () => {
      try {
        await mongo.connect();
        return true;
      } catch {
        return false;
      }
    }, 'MongoDB did not become ready');
    db = mongo.db(database);

    async function startApp(next = {}) {
      await stopApp();
      current = { ...current, ...next };
      writeGate();
      fs.writeFileSync(
        configPath,
        `version: 1.3.18\ncache: true\nregistration:\n  socialLogins: [openid]\n  openidBackchannelLogout:\n    mode: ${current.mode}\n`,
      );
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'production',
        NODE_EXTRA_CA_CERTS: certPath,
        HOST: '127.0.0.1',
        PORT: new URL(baseURL).port,
        DOMAIN_CLIENT: baseURL,
        DOMAIN_SERVER: baseURL,
        MONGO_URI: mongoURI,
        ...appSecrets,
        CONFIG_PATH: configPath,
        KEYCLOAK_TEST_GATE: gatePath,
        NO_INDEX: 'true',
        USE_REDIS: 'false',
        USE_REDIS_STREAMS: 'false',
        SEARCH: 'false',
        ALLOW_SOCIAL_LOGIN: 'true',
        ALLOW_REGISTRATION: 'true',
        ALLOW_SOCIAL_REGISTRATION: 'true',
        ALLOW_EMAIL_LOGIN: 'false',
        ALLOW_EMAIL_REGISTRATION: 'false',
        OPENID_ISSUER: issuer,
        OPENID_CLIENT_ID: 'librechat-test',
        OPENID_CLIENT_SECRET: credentials.client,
        OPENID_CALLBACK_URL: '/oauth/openid/callback',
        OPENID_SCOPE: 'openid profile email',
        OPENID_REUSE_TOKENS: String(current.reuse),
        OPENID_USE_PKCE: 'true',
        OPENID_GENERATE_NONCE: 'true',
        OPENID_AUTO_REDIRECT: 'false',
        OPENID_BUTTON_LABEL: 'Keycloak',
        LOGIN_MAX: String(current.loginMax),
        OPENAI_API_KEY: 'test',
        OPENAI_MODELS: 'gpt-4o-mini',
        SCHEDULES_SINGLE_PROCESS: 'true',
        SESSION_EXPIRY: String(current.sessionExpiry),
        DEBUG_LOGGING: 'false',
        DEBUG_CONSOLE: 'false',
        LOG_TO_FILE: 'false',
        CONSOLE_LOG_LEVEL: 'info',
      };
      if (current.maxSessionAgeMs !== undefined)
        env.OPENID_REUSE_MAX_SESSION_AGE_MS = String(current.maxSessionAgeMs);
      child = spawn(
        process.execPath,
        ['--require', path.join(__dirname, 'gate.cjs'), 'api/server/index.js'],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      childClosed = new Promise((resolve) => child.once('close', resolve));
      let spawnError = false;
      let listening = false;
      child.once('error', () => {
        spawnError = true;
      });
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream.on('data', (chunk) => {
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) {
            if (line.includes(`Server listening at http://127.0.0.1:${env.PORT}`)) listening = true;
            fs.appendFileSync(logPath, `${sanitize(line)}\n`);
          }
        });
        stream.on('end', () => {
          if (pending) fs.appendFileSync(logPath, `${sanitize(pending)}\n`);
        });
      }
      await until(
        async () => {
          if (spawnError || child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Test app exited; inspect ${logPath}`);
          // A free port can be claimed between allocation and startup. Only probe after
          // this child has bound it, so another local app cannot satisfy readiness.
          if (!listening) return false;
          try {
            const response = await fetch(`${baseURL}/api/config`, {
              signal: AbortSignal.timeout(1000),
            });
            return response.ok && (await response.json()).openidLoginEnabled === true;
          } catch {
            return false;
          }
        },
        `Test app did not become ready; inspect ${logPath}`,
        60_000,
      );
    }

    await startApp();
    return {
      baseURL,
      issuer,
      db,
      directory,
      logPath,
      deliveries,
      admin,
      startApp,
      stopApp,
      close,
      async stopKeycloak() {
        docker('stop', '-t', '10', keycloak);
      },
      async startKeycloak() {
        docker('start', keycloak);
        await waitForKeycloak();
      },
      async stopMongo() {
        docker('stop', '-t', '2', mongoContainer);
      },
      async startMongo() {
        docker('start', mongoContainer);
        await until(async () => {
          try {
            await db.command({ ping: 1 });
            return true;
          } catch {
            return false;
          }
        }, 'MongoDB did not recover');
      },
      replay(index, edit) {
        if (!signedBodies[index]) throw new Error('No captured logout at that index');
        if (!edit) return forward(signedBodies[index]);
        const form = new URLSearchParams(signedBodies[index]);
        form.set('logout_token', edit(form.get('logout_token')));
        return forward(form.toString());
      },
      gate: {
        arm(kind, sid) {
          if (!['establish', 'authorize', 'revoke'].includes(kind))
            throw new Error('Unknown query gate');
          writeGate({ kind, sid, armed: true });
        },
        async wait() {
          await until(
            () => JSON.parse(fs.readFileSync(gatePath, 'utf8')).waiting,
            'Query gate was not reached',
          );
          return JSON.parse(fs.readFileSync(gatePath, 'utf8'));
        },
        release() {
          writeGate();
        },
      },
      async login(context, username = 'a') {
        const page = await context.newPage();
        await page.goto(`${baseURL}/login`);
        await page.getByRole('link', { name: 'Keycloak', exact: true }).click();
        await page.getByLabel('Username or email').fill(username);
        await page.getByLabel('Password', { exact: true }).fill(credentials.password);
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
        await page
          .getByRole('textbox', { name: 'Message input', exact: true })
          .waitFor({ state: 'visible' });
        return page;
      },
    };
  } catch (error) {
    // Preserve only redacted diagnostics when setup fails, before removing the private directory.
    if (fs.existsSync(logPath)) console.error(fs.readFileSync(logPath, 'utf8').slice(-8000));
    await close();
    throw new Error(sanitize(error.message));
  }
}

module.exports = { createHarness };
