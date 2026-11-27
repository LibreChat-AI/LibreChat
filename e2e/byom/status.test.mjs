import test from 'node:test';
import assert from 'node:assert/strict';
import { readGenerationStatus } from './status.mjs';

function response(status, body) {
  return { ok: () => status === 200, status: () => status, json: async () => body };
}

test('waits through explicit generation readiness without claiming completion', async () => {
  assert.deepEqual(await readGenerationStatus(response(503, { code: 'SERVER_NOT_READY' })), {
    active: true,
  });
  assert.deepEqual(await readGenerationStatus(response(200, { active: false })), {
    active: false,
  });
});

test('does not hide an authorization failure or unrelated service error', async () => {
  for (const status of [403, 404, 500, 503]) {
    await assert.rejects(readGenerationStatus(response(status, { code: 'UNEXPECTED' })), {
      message: `Generation status request failed with HTTP ${status}`,
    });
  }
});

test('does not retry an HTML gateway error as generation readiness', async () => {
  await assert.rejects(
    readGenerationStatus({
      ...response(503),
      json: async () => {
        throw new SyntaxError('Not JSON');
      },
    }),
    { message: 'Generation status request failed with HTTP 503' },
  );
});
