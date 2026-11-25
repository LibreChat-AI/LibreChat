import type { FunctionTool, ToolResources } from './tools';
import type { AssistantsEndpoint } from 'src/schemas';

export type Metadata = {
  avatar?: string;
  author?: string;
} & {
  [key: string]: unknown;
};

/* Assistant types */

export type Assistant = {
  id: string;
  created_at: number;
  description: string | null;
  file_ids?: string[];
  instructions: string | null;
  conversation_starters?: string[];
  metadata: Metadata | null;
  model: string;
  name: string | null;
  object: string;
  tools?: FunctionTool[];
  tool_resources?: ToolResources;
};

export type TAssistantsMap = Record<AssistantsEndpoint, Record<string, Assistant>>;

export type AssistantCreateParams = {
  model: string;
  description?: string | null;
  file_ids?: string[];
  instructions?: string | null;
  conversation_starters?: string[];
  metadata?: Metadata | null;
  name?: string | null;
  tools?: Array<FunctionTool | string>;
  endpoint: AssistantsEndpoint;
  version: number | string;
  append_current_datetime?: boolean;
};

export type AssistantUpdateParams = {
  model?: string;
  description?: string | null;
  file_ids?: string[];
  instructions?: string | null;
  conversation_starters?: string[] | null;
  metadata?: Metadata | null;
  name?: string | null;
  tools?: Array<FunctionTool | string>;
  tool_resources?: ToolResources;
  endpoint: AssistantsEndpoint;
  append_current_datetime?: boolean;
};

export type AssistantListParams = {
  limit?: number;
  before?: string | null;
  after?: string | null;
  order?: 'asc' | 'desc';
  endpoint: AssistantsEndpoint;
};

export type AssistantListResponse = {
  object: string;
  data: Assistant[];
  first_id: string;
  last_id: string;
  has_more: boolean;
};

export type File = {
  file_id: string;
  id?: string;
  temp_file_id?: string;
  bytes: number;
  created_at: number;
  filename: string;
  object: string;
  purpose: 'fine-tune' | 'fine-tune-results' | 'assistants' | 'assistants_output';
};

//enum for RunStatus
// The status of the run: queued, in_progress, requires_action, cancelling, cancelled, failed, completed, or expired.
export enum RunStatus {
  QUEUED = 'queued',
  IN_PROGRESS = 'in_progress',
  REQUIRES_ACTION = 'requires_action',
  CANCELLING = 'cancelling',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

export type AssistantAvatar = {
  filepath: string;
  source: string;
};

export type AssistantDocument = {
  user: string;
  assistant_id: string;
  conversation_starters?: string[];
  avatar?: AssistantAvatar;
  access_level?: number;
  file_ids?: string[];
  actions?: string[];
  createdAt?: Date;
  updatedAt?: Date;
  append_current_datetime?: boolean;
};

export enum FilePurpose {
  Vision = 'vision',
  FineTune = 'fine-tune',
  FineTuneResults = 'fine-tune-results',
  Assistants = 'assistants',
  AssistantsOutput = 'assistants_output',
}

export const defaultOrderQuery: {
  order: 'desc';
  limit: 100;
} = {
  order: 'desc',
  limit: 100,
};

export enum AssistantStreamEvents {
  ThreadCreated = 'thread.created',
  ThreadRunCreated = 'thread.run.created',
  ThreadRunQueued = 'thread.run.queued',
  ThreadRunInProgress = 'thread.run.in_progress',
  ThreadRunRequiresAction = 'thread.run.requires_action',
  ThreadRunCompleted = 'thread.run.completed',
  ThreadRunFailed = 'thread.run.failed',
  ThreadRunCancelling = 'thread.run.cancelling',
  ThreadRunCancelled = 'thread.run.cancelled',
  ThreadRunExpired = 'thread.run.expired',
  ThreadRunStepCreated = 'thread.run.step.created',
  ThreadRunStepInProgress = 'thread.run.step.in_progress',
  ThreadRunStepCompleted = 'thread.run.step.completed',
  ThreadRunStepFailed = 'thread.run.step.failed',
  ThreadRunStepCancelled = 'thread.run.step.cancelled',
  ThreadRunStepExpired = 'thread.run.step.expired',
  ThreadRunStepDelta = 'thread.run.step.delta',
  ThreadMessageCreated = 'thread.message.created',
  ThreadMessageInProgress = 'thread.message.in_progress',
  ThreadMessageCompleted = 'thread.message.completed',
  ThreadMessageIncomplete = 'thread.message.incomplete',
  ThreadMessageDelta = 'thread.message.delta',
  ErrorEvent = 'error',
}
