import type { ResponseReviewView } from 'librechat-data-provider';
export type { ChannelServiceBundle as ChannelBundle } from 'librechat-data-provider';
export type {
  ChannelRunLease as Lease,
  ChannelRunLeaseRenewal as LeaseRenewal,
  ChannelResponseGrant as ResponseGrant,
  ChannelResponsePreparation as ResponsePreparation,
} from 'librechat-data-provider';
export interface Review {
  url: string;
  actionId: string;
  pendingAction?: ResponseReviewView['pendingAction'];
  pendingDecision?: ResponseReviewView['pendingDecision'];
}
export interface BackgroundResponse {
  id: string;
  object: 'response';
  model: string;
  background: true;
  store: true;
  status:
    | 'queued'
    | 'in_progress'
    | 'requires_action'
    | 'completed'
    | 'failed'
    | 'incomplete'
    | 'cancelled';
}
export interface Logger {
  info(event: string): void;
  warn(event: string): void;
  error(event: string): void;
}
export const logger: Logger = {
  info: (event) => console.info(JSON.stringify({ level: 'info', event })),
  warn: (event) => console.warn(JSON.stringify({ level: 'warn', event })),
  error: (event) => console.error(JSON.stringify({ level: 'error', event })),
};
