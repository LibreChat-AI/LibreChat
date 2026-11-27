/**
 * `undici` (transitive dep of `@librechat/agents` and others) references
 * `globalThis.File` from `node:buffer`. Node 20+ exposes it as a global;
 * Node 18 / certain WSL toolchains do not, which surfaces as a
 * `ReferenceError: File is not defined` at module-load time the first
 * time a test imports `@librechat/agents`. Mirror the polyfill in
 * `packages/api/jest.setup.cjs` so this Jest suite boots on the same
 * Node versions; production code never relies on this — only Jest does.
 */
if (typeof globalThis.File === 'undefined') {
  try {
    const { File } = require('node:buffer');
    if (File != null) {
      globalThis.File = File;
    }
  } catch {
    // Older Node versions without `node:buffer.File`. LibreChat doesn't
    // support those anyway; let the test fail loudly.
  }
}

// See .env.test.example for an example of the '.env.test' file.
require('dotenv').config({ path: './test/.env.test' });

process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/dummy-uri';
process.env.BAN_VIOLATIONS = 'true';
process.env.BAN_DURATION = '7200000';
process.env.BAN_INTERVAL = '20';
process.env.CI = 'true';
process.env.JWT_SECRET = 'test';
process.env.JWT_REFRESH_SECRET = 'test';
// Startup rejects malformed explicitly configured AES credentials. Use valid test-only hex fixtures.
process.env.CREDS_KEY = '0123456789abcdef'.repeat(4);
process.env.CREDS_IV = '0123456789abcdef'.repeat(2);
process.env.ALLOW_EMAIL_LOGIN = 'true';

// Set global test timeout to 30 seconds
// This can be overridden in individual tests if needed
jest.setTimeout(30000);
process.env.OPENAI_API_KEY = 'test';
