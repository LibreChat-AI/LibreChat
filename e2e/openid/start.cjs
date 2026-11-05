const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { startProvider } = require('./provider.cjs');

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'librechat-openid-'));
  const cert = path.join(directory, 'cert.pem');
  const key = path.join(directory, 'key.pem');
  const openssl = path.join(directory, 'openssl.cnf');
  writeFileSync(
    openssl,
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
  );
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
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      openssl,
    ],
    { stdio: 'ignore' },
  );
  const config = path.join(directory, 'librechat.yaml');
  writeFileSync(
    config,
    'version: 1.4.0\ncache: true\nregistration:\n  socialLogins: [openid]\n  openidSessionCheck: true\n',
  );
  const provider = await startProvider({
    port: 4400,
    tls: { key: readFileSync(key), cert: readFileSync(cert) },
  });
  const secret = () => randomBytes(32).toString('hex');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'CI',
    NODE_EXTRA_CA_CERTS: cert,
    HOST: '127.0.0.1',
    PORT: '3080',
    MONGO_URI: 'mongodb://127.0.0.1:27017/LibreChat-oidc-e2e',
    E2E_USE_MEMORY_MONGO: 'true',
    E2E_RUNTIME_ENV_PATH: path.join(directory, 'runtime.json'),
    DOMAIN_CLIENT: 'http://localhost:3080',
    DOMAIN_SERVER: 'http://localhost:3080',
    JWT_SECRET: secret(),
    JWT_REFRESH_SECRET: secret(),
    CREDS_KEY: secret(),
    CREDS_IV: randomBytes(16).toString('hex'),
    CONFIG_PATH: config,
    NO_INDEX: 'true',
    USE_REDIS: 'false',
    USE_REDIS_STREAMS: 'false',
    ALLOW_SOCIAL_LOGIN: 'true',
    ALLOW_REGISTRATION: 'true',
    ALLOW_SOCIAL_REGISTRATION: 'true',
    ALLOW_EMAIL_LOGIN: 'false',
    ALLOW_EMAIL_REGISTRATION: 'false',
    OPENID_ISSUER: provider.issuer,
    OPENID_CLIENT_ID: 'librechat-test',
    OPENID_CLIENT_SECRET: 'local-test-secret',
    OPENID_CALLBACK_URL: '/oauth/openid/callback',
    OPENID_SCOPE: 'openid profile email offline_access',
    OPENID_REUSE_TOKENS: 'true',
    OPENID_USE_PKCE: 'true',
    OPENID_GENERATE_NONCE: 'true',
    OPENID_SESSION_SECRET: secret(),
    OPENID_AUTO_REDIRECT: 'true',
    LOGIN_MAX: '1000',
    OPENAI_API_KEY: 'test',
    SEARCH: 'false',
  };
  const child = spawn(process.execPath, ['e2e/setup/start-server.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env,
    stdio: 'inherit',
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    await provider.close();
    rmSync(directory, { recursive: true, force: true });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.once('exit', async (code) => {
    await stop();
    process.exitCode = code ?? 1;
  });
  console.log(`Test Console: ${provider.issuer}/console\nLibreChat: http://localhost:3080`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
