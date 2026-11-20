import { Counter, Histogram } from 'prom-client';
import type { Registry } from 'prom-client';
import type { DiscordObserver } from './observe';
import { discordCommandOutcomes, safeDiscordObserver } from './observe';

const label = (value: string, allowed: readonly string[]) =>
  allowed.includes(value) ? value : 'other';

/** Only closed labels reach Prometheus, even if an untyped caller violates the observer type. */
export function createDiscordMetrics(registry: Registry): DiscordObserver {
  const submissions = new Counter({
    name: 'discord_inbox_submissions_total',
    help: 'Discord interaction inbox submission outcomes',
    labelNames: ['kind', 'result'] as const,
    registers: [registry],
  });
  const messages = new Counter({
    name: 'discord_message_submissions_total',
    help: 'Discord Gateway message admission and replay outcomes',
    labelNames: ['kind', 'result'] as const,
    registers: [registry],
  });
  const inbox = new Counter({
    name: 'discord_inbox_events_total',
    help: 'Successful Discord inbox expiry and deferral transitions',
    labelNames: ['event'] as const,
    registers: [registry],
  });
  const queue = new Histogram({
    name: 'discord_inbox_queue_seconds',
    help: 'Age since receipt of each claimed Discord inbox item, including retries',
    buckets: [0.05, 0.25, 1, 2, 5, 15, 60, 300, 900],
    registers: [registry],
  });
  const commands = new Counter({
    name: 'discord_command_outcomes_total',
    help: 'Discord command and native account consent outcomes',
    labelNames: ['action', 'outcome'] as const,
    registers: [registry],
  });
  return safeDiscordObserver((event) => {
    if (event.type === 'submission')
      submissions.inc({
        kind: label(event.kind, ['interaction', 'dm']),
        result: label(event.result, ['accepted', 'duplicate', 'capacity', 'conflict']),
      });
    else if (event.type === 'message')
      messages.inc({
        kind: label(event.kind, ['guild', 'dm']),
        result: label(event.result, [
          'admitted',
          'duplicate',
          'ignored',
          'rejected',
          'unavailable',
        ]),
      });
    else if (event.type === 'inbox')
      inbox.inc({ event: label(event.event, ['expired', 'deferred']) });
    else if (event.type === 'queue') {
      if (Number.isFinite(event.seconds) && event.seconds >= 0) queue.observe(event.seconds);
    } else if (event.type === 'command')
      commands.inc({
        action: label(event.action, [
          'ask',
          'link',
          'confirm',
          'status',
          'cancel',
          'feedback',
          'review',
          'decide',
        ]),
        outcome: label(event.outcome, discordCommandOutcomes),
      });
  });
}
