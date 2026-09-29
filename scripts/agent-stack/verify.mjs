import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function rows(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const attributes = (items = []) =>
  Object.fromEntries(
    items.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue]),
  );
export function verifyEvidence(directory, metadata) {
  const traceText = fs.readFileSync(path.join(directory, 'traces.jsonl'), 'utf8');
  const logText = fs.readFileSync(path.join(directory, 'logs.jsonl'), 'utf8');
  assert(
    !/PILOT_PRIVATE_|sk-lf-local-pilot/.test(traceText + logText),
    'Private payload escaped the collector',
  );
  const spans = [];
  let probeSpans = 0;
  for (const batch of rows(path.join(directory, 'traces.jsonl'))) {
    for (const resource of batch.resourceSpans ?? []) {
      const attrs = attributes(resource.resource?.attributes);
      assert.equal(attrs['test.run.id'], metadata.runId);
      assert.equal(attrs['test.cache.mode'], metadata.mode);
      assert.equal(attrs['vcs.ref.head.revision'], metadata.commit);
      for (const scope of resource.scopeSpans ?? []) {
        if (scope.scope?.name === 'pilot.privacy.probe') {
          probeSpans += scope.spans?.length ?? 0;
          continue;
        }
        for (const span of scope.spans ?? [])
          spans.push({ ...span, scope: scope.scope?.name, attrs: attributes(span.attributes) });
      }
    }
  }
  assert.equal(probeSpans, 1, 'Redaction probe must arrive, not be silently dropped');
  const mongo = spans.filter((s) => s.attrs['db.system'] === 'mongodb');
  const mongoose = spans.filter((s) => s.attrs['db.system'] === 'mongoose');
  const database = [...mongo, ...mongoose];
  const redis = spans.filter((s) => s.attrs['db.system'] === 'redis');
  const http = spans.filter((s) => /http|express/.test(s.scope ?? ''));
  const agents = spans.filter(
    (s) => /langfuse/.test(s.scope ?? '') || s.attrs['langfuse.observation.type'],
  );
  assert(http.length > 0, 'Missing real HTTP traces');
  assert(database.length > 0, 'Missing MongoDB/Mongoose spans');
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'persistence.json'), 'utf8'));
  assert(
    persisted.users > 0 && persisted.conversations > 0 && persisted.messages > 0,
    'Missing persisted database rows',
  );
  assert(
    metadata.mode === 'redis' ? redis.length > 0 : redis.length === 0,
    'Wrong observed Redis mode',
  );
  if (metadata.mode === 'redis') {
    const redisState = JSON.parse(
      fs.readFileSync(path.join(directory, 'redis-state.json'), 'utf8'),
    );
    assert(redisState.keys > 0, 'Redis mode wrote no Redis state');
  }
  assert(agents.length > 0, 'Missing agent execution traces');
  const httpTraces = new Set(http.map((s) => s.traceId));
  assert(
    database.some((s) => httpTraces.has(s.traceId)),
    'HTTP and MongoDB traces are not correlated',
  );
  if (metadata.mode === 'redis')
    assert(
      redis.some((s) => httpTraces.has(s.traceId)),
      'Redis spans are not correlated with HTTP',
    );
  const logs = rows(path.join(directory, 'logs.jsonl'))
    .flatMap((b) => b.resourceLogs ?? [])
    .flatMap((r) => r.scopeLogs ?? [])
    .filter((s) => s.scope?.name !== 'pilot.privacy.probe')
    .flatMap((s) => s.logRecords ?? []);
  assert(logs.length > 0, 'Missing application logs');
  const stats = JSON.parse(
    fs.readFileSync(path.join(directory, 'browser-results.json'), 'utf8'),
  ).stats;
  const selectedScenarios =
    metadata.focusedHandoff === true ? 1 : 4 + Number(metadata.persistentHandoffs === true);
  assert.equal(stats.expected, selectedScenarios, 'Browser selected too few or too many scenarios');
  assert.equal(stats.unexpected, 0, 'Browser failures');
  assert.equal(stats.skipped, 0, 'Browser skipped scenarios');
  assert.equal(stats.flaky, 0, 'Browser retries must not mask failures');
  const agentTraces = new Set(agents.map((span) => span.traceId));
  const agentTracesWithHttp = [...agentTraces].filter((id) => httpTraces.has(id)).length;
  return {
    browserPassed: stats.expected,
    persisted,
    mongooseSpans: mongoose.length,
    mongoSpans: mongo.length,
    redisSpans: redis.length,
    agentTraces: agentTraces.size,
    agentTracesWithHttp,
    spans: spans.length,
    http: http.length,
    mongo: mongo.length,
    redis: redis.length,
    agents: agents.length,
    logs: logs.length,
    httpMongoCorrelated: true,
    redactionProbe: 'passed',
  };
}
