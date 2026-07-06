/**
 * Inline sanity test for api/csfle/provider.js
 * Run: node api/csfle/__tests__/provider.sanity.js
 * No dependencies on jest or mongodb — uses only core Node.js.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGcpCredentials, buildKmsProviders } = require('../provider');

let passed = 0;
let failed = 0;

function assert(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

function assertEqual(a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertThrows(fn, pattern) {
  let threw = false;
  try { fn(); } catch (err) {
    threw = true;
    if (pattern && !pattern.test(err.message)) {
      throw new Error(`Error message "${err.message}" did not match ${pattern}`);
    }
  }
  if (!threw) throw new Error('Expected function to throw but it did not');
}

// helpers ---------------------------------------------------------------
const tmpFile = (content) => {
  const p = path.join(os.tmpdir(), `csfle-test-${Date.now()}.json`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
};

const cleanup = [];

function withEnv(vars, fn) {
  const original = {};
  for (const [k, v] of Object.entries(vars)) {
    original[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// -----------------------------------------------------------------------
console.log('\nloadGcpCredentials()');

assert('returns null when no file env vars are set', () => {
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: undefined, GOOGLE_SERVICE_KEY_FILE: undefined }, () => {
    assertEqual(loadGcpCredentials(), null);
  });
});

assert('reads CSFLE_GCP_SERVICE_ACCOUNT_FILE (preferred)', () => {
  const p = tmpFile(JSON.stringify({ client_email: 'sa@proj.iam', private_key: 'PK' }));
  cleanup.push(p);
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: p, GOOGLE_SERVICE_KEY_FILE: undefined }, () => {
    const creds = loadGcpCredentials();
    assertEqual(creds.email, 'sa@proj.iam');
    assertEqual(creds.privateKey, 'PK');
  });
});

assert('falls back to GOOGLE_SERVICE_KEY_FILE when preferred var not set', () => {
  const p = tmpFile(JSON.stringify({ client_email: 'fb@proj.iam', private_key: 'FBPK' }));
  cleanup.push(p);
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: undefined, GOOGLE_SERVICE_KEY_FILE: p }, () => {
    const creds = loadGcpCredentials();
    assertEqual(creds.email, 'fb@proj.iam');
    assertEqual(creds.privateKey, 'FBPK');
  });
});

assert('prefers CSFLE_GCP_SERVICE_ACCOUNT_FILE over GOOGLE_SERVICE_KEY_FILE', () => {
  const p1 = tmpFile(JSON.stringify({ client_email: 'preferred@proj.iam', private_key: 'PPK' }));
  const p2 = tmpFile(JSON.stringify({ client_email: 'fallback@proj.iam', private_key: 'FPK' }));
  cleanup.push(p1, p2);
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: p1, GOOGLE_SERVICE_KEY_FILE: p2 }, () => {
    const creds = loadGcpCredentials();
    assertEqual(creds.email, 'preferred@proj.iam');
  });
});

assert('throws with file path and var name when file not found', () => {
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: '/nonexistent/path/sa.json', GOOGLE_SERVICE_KEY_FILE: undefined }, () => {
    assertThrows(() => loadGcpCredentials(), /CSFLE_GCP_SERVICE_ACCOUNT_FILE/);
  });
});

assert('throws with GOOGLE_SERVICE_KEY_FILE in message when that var is used', () => {
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: undefined, GOOGLE_SERVICE_KEY_FILE: '/nonexistent/sa.json' }, () => {
    assertThrows(() => loadGcpCredentials(), /GOOGLE_SERVICE_KEY_FILE/);
  });
});

assert('throws on invalid JSON', () => {
  const p = tmpFile('not json {');
  cleanup.push(p);
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: p, GOOGLE_SERVICE_KEY_FILE: undefined }, () => {
    assertThrows(() => loadGcpCredentials(), /not valid JSON/);
  });
});

assert('throws when client_email is missing', () => {
  const p = tmpFile(JSON.stringify({ private_key: 'PK' }));
  cleanup.push(p);
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: p, GOOGLE_SERVICE_KEY_FILE: undefined }, () => {
    assertThrows(() => loadGcpCredentials(), /missing required fields/);
  });
});

assert('throws when private_key is missing', () => {
  const p = tmpFile(JSON.stringify({ client_email: 'sa@proj.iam' }));
  cleanup.push(p);
  withEnv({ CSFLE_GCP_SERVICE_ACCOUNT_FILE: p, GOOGLE_SERVICE_KEY_FILE: undefined }, () => {
    assertThrows(() => loadGcpCredentials(), /missing required fields/);
  });
});

// -----------------------------------------------------------------------
console.log('\nbuildKmsProviders() — local key mode');

assert('returns local provider with correct key', () => {
  const key = require('crypto').randomBytes(96).toString('base64');
  withEnv({
    GCP_KMS_PROJECT_ID: undefined,
    MONGO_CSFLE_LOCAL_MASTER_KEY: key,
    CSFLE_GCP_SERVICE_ACCOUNT_FILE: undefined,
    GOOGLE_SERVICE_KEY_FILE: undefined,
  }, () => {
    const result = buildKmsProviders();
    assertEqual(result.provider, 'local');
    if (!result.kmsProviders.local?.key) throw new Error('key buffer missing');
    assertEqual(result.masterKey, undefined);
  });
});

assert('throws when neither GCP nor local key is configured', () => {
  withEnv({
    GCP_KMS_PROJECT_ID: undefined,
    MONGO_CSFLE_LOCAL_MASTER_KEY: undefined,
    CSFLE_GCP_SERVICE_ACCOUNT_FILE: undefined,
    GOOGLE_SERVICE_KEY_FILE: undefined,
  }, () => {
    assertThrows(() => buildKmsProviders(), /No KMS configured/);
  });
});

assert('throws when local key decodes to wrong length', () => {
  withEnv({
    GCP_KMS_PROJECT_ID: undefined,
    MONGO_CSFLE_LOCAL_MASTER_KEY: Buffer.from('tooshort').toString('base64'),
    CSFLE_GCP_SERVICE_ACCOUNT_FILE: undefined,
    GOOGLE_SERVICE_KEY_FILE: undefined,
  }, () => {
    assertThrows(() => buildKmsProviders(), /96 bytes/);
  });
});

console.log('\nbuildKmsProviders() — GCP mode');

assert('uses ADC when no file vars set', () => {
  withEnv({
    GCP_KMS_PROJECT_ID: 'my-project',
    GCP_KMS_KEY_NAME: 'my-key',
    CSFLE_GCP_SERVICE_ACCOUNT_FILE: undefined,
    GOOGLE_SERVICE_KEY_FILE: undefined,
  }, () => {
    const result = buildKmsProviders();
    assertEqual(result.provider, 'gcp');
    const gcpCreds = result.kmsProviders.gcp;
    if (Object.keys(gcpCreds).length !== 0) throw new Error('Expected empty gcp object for ADC');
    assertEqual(result.masterKey.projectId, 'my-project');
  });
});

assert('injects explicit credentials when key file is set', () => {
  const p = tmpFile(JSON.stringify({ client_email: 'sa@p.iam', private_key: 'GCPPK' }));
  cleanup.push(p);
  withEnv({
    GCP_KMS_PROJECT_ID: 'my-project',
    GCP_KMS_KEY_NAME: 'my-key',
    CSFLE_GCP_SERVICE_ACCOUNT_FILE: p,
    GOOGLE_SERVICE_KEY_FILE: undefined,
  }, () => {
    const result = buildKmsProviders();
    assertEqual(result.kmsProviders.gcp.email, 'sa@p.iam');
    assertEqual(result.kmsProviders.gcp.privateKey, 'GCPPK');
  });
});

// -----------------------------------------------------------------------
for (const p of cleanup) {
  try { fs.unlinkSync(p); } catch (_) {}
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);