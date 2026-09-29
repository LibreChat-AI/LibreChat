import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { verifyEvidence } from './verify.mjs';

const metadata = { runId: 'run', mode: 'memory', commit: 'abc' };
function fixture(t, mode = 'memory') {
  const base = path.resolve('.agent-stack/unit');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const attr = (key, stringValue) => ({ key, value: { stringValue } });
  const resource = {
    attributes: [
      attr('test.run.id', 'run'),
      attr('test.cache.mode', mode),
      attr('vcs.ref.head.revision', 'abc'),
    ],
  };
  const span = (system) => ({
    traceId: '1',
    attributes: system ? [attr('db.system', system)] : [],
  });
  const scopeSpans = [
    { scope: { name: '@opentelemetry/instrumentation-http' }, spans: [span()] },
    { scope: { name: '@opentelemetry/instrumentation-mongoose' }, spans: [span('mongoose')] },
    { scope: { name: 'langfuse-sdk' }, spans: [span()] },
    { scope: { name: 'pilot.privacy.probe' }, spans: [span()] },
  ];
  if (mode === 'redis')
    scopeSpans.push({
      scope: { name: '@opentelemetry/instrumentation-ioredis' },
      spans: [span('redis')],
    });
  fs.writeFileSync(
    path.join(dir, 'traces.jsonl'),
    JSON.stringify({ resourceSpans: [{ resource, scopeSpans }] }) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'logs.jsonl'),
    JSON.stringify({
      resourceLogs: [
        {
          resource,
          scopeLogs: [{ logRecords: [{ body: { stringValue: '[pilot log body omitted]' } }] }],
        },
      ],
    }) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'browser-results.json'),
    JSON.stringify({ stats: { expected: 4, skipped: 0, unexpected: 0, flaky: 0 } }),
  );
  fs.writeFileSync(
    path.join(dir, 'persistence.json'),
    JSON.stringify({ users: 1, conversations: 4, messages: 12 }),
  );
  if (mode === 'redis') fs.writeFileSync(path.join(dir, 'redis-state.json'), '{"keys":3}');
  return dir;
}

test('accepts real Mongoose-backed persistence without claiming native MongoDB instrumentation', (t) => {
  const result = verifyEvidence(fixture(t), metadata);
  assert.equal(result.mongoSpans, 0);
  assert.equal(result.mongooseSpans, 1);
  assert.equal(result.browserPassed, 4);
});
test('requires exactly five scenarios when permanent handoffs are selected', (t) => {
  const dir = fixture(t);
  const report = path.join(dir, 'browser-results.json');
  assert.throws(
    () => verifyEvidence(dir, { ...metadata, persistentHandoffs: true }),
    /too few or too many/,
  );
  fs.writeFileSync(
    report,
    JSON.stringify({ stats: { expected: 5, skipped: 0, unexpected: 0, flaky: 0 } }),
  );
  assert.equal(verifyEvidence(dir, { ...metadata, persistentHandoffs: true }).browserPassed, 5);
});

test('focused diagnostic runs require exactly one browser scenario', (t) => {
  const dir = fixture(t);
  const report = path.join(dir, 'browser-results.json');
  assert.throws(
    () => verifyEvidence(dir, { ...metadata, persistentHandoffs: true, focusedHandoff: true }),
    /too few or too many/,
  );
  fs.writeFileSync(
    report,
    JSON.stringify({ stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 } }),
  );
  assert.equal(
    verifyEvidence(dir, { ...metadata, persistentHandoffs: true, focusedHandoff: true })
      .browserPassed,
    1,
  );
});

test('requires actual Redis instrumentation in the Redis lane', (t) => {
  const dir = fixture(t, 'redis');
  assert.equal(verifyEvidence(dir, { ...metadata, mode: 'redis' }).redisSpans, 1);
  const file = path.join(dir, 'traces.jsonl');
  const body = JSON.parse(fs.readFileSync(file));
  body.resourceSpans[0].scopeSpans.pop();
  fs.writeFileSync(file, JSON.stringify(body));
  assert.throws(() => verifyEvidence(dir, { ...metadata, mode: 'redis' }), /Redis mode/);
});
test('rejects mixed run identities', (t) => {
  assert.throws(() => verifyEvidence(fixture(t), { ...metadata, runId: 'other-run' }));
});
test('rejects leaked prompt or credential canaries', (t) => {
  const dir = fixture(t);
  fs.appendFileSync(path.join(dir, 'logs.jsonl'), '{"body":"PILOT_PRIVATE_LOG"}\n');
  assert.throws(() => verifyEvidence(dir, metadata), /Private payload/);
});
test('rejects telemetry without database writes', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(
    path.join(dir, 'persistence.json'),
    '{"users":1,"messages":0,"conversations":0}',
  );
  assert.throws(() => verifyEvidence(dir, metadata), /persisted/);
});
test('rejects a passing browser report when agent traces are absent', (t) => {
  const dir = fixture(t);
  const f = path.join(dir, 'traces.jsonl');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('langfuse-sdk', 'not-an-agent-sdk'));
  assert.throws(() => verifyEvidence(dir, metadata), /agent execution traces/);
});
test('rejects empty browser selection or failed scenarios', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(
    path.join(dir, 'browser-results.json'),
    '{"stats":{"expected":0,"unexpected":0}}',
  );
  assert.throws(() => verifyEvidence(dir, metadata), /too few/);
});
