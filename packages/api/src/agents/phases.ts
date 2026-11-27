export const agentStartupMilestones = [
  'request_admitted',
  'job_created',
  'ack_sent',
  'conversation_resolved',
  'metadata_persisted',
  'client_initialized',
  'history_loaded',
  'messages_built',
  'run_input_prepared',
  'run_created',
  'stream_processing_started',
  'request_message_queued',
  'first_response_event_queued',
  'first_content_delta_queued',
] as const;

export const agentStartupResults = [
  'content_queued',
  'completed_without_delta',
  'deduplicated',
  'rejected',
  'paused',
  'replaced',
  'aborted',
  'error',
] as const;

export type AgentStartupMilestone = (typeof agentStartupMilestones)[number];
export type AgentStartupResult = (typeof agentStartupResults)[number];
