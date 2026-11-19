import express from 'express';
import request from 'supertest';
import { Registry } from 'prom-client';
import { createMetrics, recordDiscordObservation } from '~/app/metrics';
import { createDiscordMetrics } from './metrics';

it('exports bounded Discord labels and rejects invalid queue samples', async () => {
  const registry = new Registry();
  const observe = createDiscordMetrics(registry);
  observe({ type: 'submission', kind: 'interaction', result: 'accepted' });
  observe({ type: 'submission', kind: 'dm', result: 'duplicate' });
  observe({ type: 'inbox', event: 'deferred' });
  observe({ type: 'message', kind: 'guild', result: 'duplicate' });
  observe({ type: 'message', kind: 'dm', result: 'admitted' });
  observe({ type: 'queue', seconds: 0.25 });
  for (const seconds of [-1, Infinity, NaN]) observe({ type: 'queue', seconds });
  observe({ type: 'command', action: 'confirm', outcome: 'linked' });
  // Model an untyped runtime caller without making identifiers part of the observer contract.
  Reflect.apply(observe, undefined, [
    {
      type: 'command',
      action: 'private-user-id',
      outcome: 'private-prompt-text',
    },
  ]);
  const text = await registry.metrics();
  expect(text).toContain('discord_inbox_submissions_total{kind="interaction",result="accepted"} 1');
  expect(text).toContain('discord_inbox_submissions_total{kind="dm",result="duplicate"} 1');
  expect(text).toContain('discord_inbox_events_total{event="deferred"} 1');
  expect(text).toContain('discord_inbox_queue_seconds_count 1');
  expect(text).toContain('discord_inbox_queue_seconds_sum 0.25');
  expect(text).toContain('discord_command_outcomes_total{action="confirm",outcome="linked"} 1');
  expect(text).toContain('discord_command_outcomes_total{action="other",outcome="other"} 1');
  expect(text).toContain('discord_message_submissions_total{kind="guild",result="duplicate"} 1');
  expect(text).toContain('discord_message_submissions_total{kind="dm",result="admitted"} 1');
  expect(text).not.toContain('private-user-id');
  expect(text).not.toContain('private-prompt-text');
});

it('wires the recorder only into configured authenticated metrics and resets when disabled', async () => {
  const previous = process.env.METRICS_SECRET;
  try {
    process.env.METRICS_SECRET = 'discord-metrics-test';
    const metrics = createMetrics();
    const app = express();
    app.use('/metrics', metrics.metricsRouter);
    recordDiscordObservation({ type: 'command', action: 'ask', outcome: 'queued' });
    await request(app).get('/metrics').expect(401);
    const first = await request(app)
      .get('/metrics')
      .set('authorization', 'Bearer discord-metrics-test')
      .expect(200);
    expect(first.text).toContain('discord_command_outcomes_total{action="ask",outcome="queued"} 1');
    delete process.env.METRICS_SECRET;
    const disabled = createMetrics();
    app.use('/disabled', disabled.metricsRouter);
    recordDiscordObservation({ type: 'command', action: 'ask', outcome: 'queued' });
    await request(app).get('/disabled').expect(401);
    process.env.METRICS_SECRET = 'discord-metrics-test';
    const last = await request(app)
      .get('/metrics')
      .set('authorization', 'Bearer discord-metrics-test')
      .expect(200);
    expect(last.text).toContain('discord_command_outcomes_total{action="ask",outcome="queued"} 1');
  } finally {
    if (previous === undefined) delete process.env.METRICS_SECRET;
    else process.env.METRICS_SECRET = previous;
    createMetrics();
  }
});
