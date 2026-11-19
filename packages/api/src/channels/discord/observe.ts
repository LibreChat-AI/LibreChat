import type { DiscordMessageResult } from 'librechat-data-provider';

export const discordCommandOutcomes = [
  'queued',
  'link_required',
  'confirm_required',
  'linked',
  'already_linked',
  'cancelled',
  'no_active_run',
  'no_retained_run',
  'reported',
  'feedback_reply',
  'conflict',
  'unavailable',
] as const;

export type DiscordCommandOutcome = (typeof discordCommandOutcomes)[number];
export type DiscordObservation =
  | {
      type: 'submission';
      kind: 'interaction' | 'dm';
      result: 'accepted' | 'duplicate' | 'capacity' | 'conflict';
    }
  | {
      type: 'message';
      kind: 'guild' | 'dm';
      result: 'admitted' | 'duplicate' | 'ignored' | 'rejected' | 'unavailable';
    }
  | { type: 'inbox'; event: 'expired' | 'deferred' }
  | { type: 'queue'; seconds: number }
  | {
      type: 'command';
      action: 'ask' | 'link' | 'confirm' | 'status' | 'cancel' | 'feedback' | 'other';
      outcome: DiscordCommandOutcome;
    };
export type DiscordObserver = (observation: DiscordObservation) => void;

/** Telemetry must not change authorization, persistence, or the response contract. */
export function safeDiscordObserver(observer?: DiscordObserver): DiscordObserver {
  return (observation) => {
    try {
      observer?.(observation);
    } catch {
      // An optional metrics sink cannot turn a completed command into a retried side effect.
    }
  };
}

export function observeDiscordMessage(
  observer: DiscordObserver,
  kind: 'guild' | 'dm',
  result: { ok: false } | { ok: true; value: Pick<DiscordMessageResult, 'outcome'> },
): void {
  observer({ type: 'message', kind, result: result.ok ? result.value.outcome : 'rejected' });
}
