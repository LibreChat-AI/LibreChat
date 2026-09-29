#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyEvidence } from './verify.mjs';

const [memoryPath, redisPath] = process.argv.slice(2);
assert(
  memoryPath && redisPath,
  'Usage: node scripts/agent-stack/compare.mjs <memory-evidence> <redis-evidence>',
);
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const memory = read(memoryPath);
const redis = read(redisPath);
assert.equal(memory.mode, 'memory');
assert.equal(redis.mode, 'redis');
assert.equal(memory.result, 'passed');
assert.equal(redis.result, 'passed');
assert.equal(memory.commit, redis.commit, 'Compare the same tested commit');
assert.equal(
  memory.sourceFingerprint,
  redis.sourceFingerprint,
  'Source changed between cache-mode runs',
);
assert.notEqual(memory.runId, redis.runId, 'Runs must have isolated data and identity');
assert.equal(
  memory.persistentHandoffs === true,
  redis.persistentHandoffs === true,
  'Memory and Redis lanes must exercise the same handoff scenarios',
);
assert.equal(
  memory.focusedHandoff === true,
  redis.focusedHandoff === true,
  'Memory and Redis lanes must use the same focused/full browser selection',
);
for (const name of ['mongo', 'collector', 'browser'])
  assert.equal(memory.images[name], redis.images[name]);
const results = {
  memory: verifyEvidence(memoryPath, memory),
  redis: verifyEvidence(redisPath, redis),
};
assert.equal(results.memory.browserPassed, results.redis.browserPassed);
assert.deepEqual(
  results.memory.persisted,
  results.redis.persisted,
  'Functional persistence differs',
);
console.log(
  JSON.stringify(
    {
      commit: memory.commit,
      result: 'same functional scenarios and persisted counts',
      results,
      limitation:
        'One run per mode is not a performance benchmark; agent and HTTP traces are separate.',
    },
    null,
    2,
  ),
);
