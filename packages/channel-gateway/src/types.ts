import type {
  AgentChannel,
  ChannelRunView,
  ChannelRunFence,
  ResponseReviewView,
} from 'librechat-data-provider';

export interface ChannelBundle {
  channel: AgentChannel & {
    revision: string;
    slack: { teamId: string; appId: string; botUserId: string };
  };
  credentials: { botToken: string; signingSecret?: string };
  agent: { id: string; name?: string };
}
export interface Lease {
  run: ChannelRunView;
  fence: ChannelRunFence;
  leaseExpiresAt: number;
}
export interface ResponseGrant {
  settled?: ChannelRunView;
  apiKey: string;
  requestKey: string;
  responseId?: string;
  request: {
    model: string;
    input: string;
    background: true;
    store: true;
    previous_response_id?: string;
  };
}
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
