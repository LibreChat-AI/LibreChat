import type { SubagentIdentity, ContentTypes } from './runs';
import type { Agents } from './agents';
import type { TFile } from './files';

/**
 * Details of the Code Interpreter tool call the run step was involved in.
 * Includes the tool call ID, the code interpreter definition, and the type of tool call.
 */
export type CodeToolCall = {
  id: string; // The ID of the tool call.
  code_interpreter: {
    input: string; // The input to the Code Interpreter tool call.
    outputs: Array<Record<string, unknown>>; // The outputs from the Code Interpreter tool call.
  };
  type: 'code_interpreter'; // The type of tool call, always 'code_interpreter'.
};

/**
 * Details of a Function tool call the run step was involved in.
 * Includes the tool call ID, the function definition, and the type of tool call.
 */
export type FunctionToolCall = {
  id: string; // The ID of the tool call object.
  function: {
    arguments: string; // The arguments passed to the function.
    name: string; // The name of the function.
    output: string | null; // The output of the function, null if not submitted.
  };
  type: 'function'; // The type of tool call, always 'function'.
};

/**
 * Details of a Retrieval tool call the run step was involved in.
 * Includes the tool call ID and the type of tool call.
 */
export type RetrievalToolCall = {
  id: string; // The ID of the tool call object.
  retrieval: unknown; // An empty object for now.
  type: 'retrieval'; // The type of tool call, always 'retrieval'.
};

/**
 * Details of a Retrieval tool call the run step was involved in.
 * Includes the tool call ID and the type of tool call.
 */
export type FileSearchToolCall = {
  id: string; // The ID of the tool call object.
  file_search: unknown; // An empty object for now.
  type: 'file_search'; // The type of tool call, always 'retrieval'.
};

/**
 * Details of the tool calls involved in a run step.
 * Can be associated with one of three types of tools: `code_interpreter`, `retrieval`, or `function`.
 */
export type ToolCallsStepDetails = {
  tool_calls: Array<CodeToolCall | RetrievalToolCall | FileSearchToolCall | FunctionToolCall>; // An array of tool calls the run step was involved in.
  type: 'tool_calls'; // Always 'tool_calls'.
};

export type ImageFile = TFile & {
  /**
   * The [File](https://platform.openai.com/docs/api-reference/files) ID of the image
   * in the message content.
   */
  file_id: string;
  filename: string;
  filepath: string;
  height: number;
  width: number;
  /**
   * Prompt used to generate the image if applicable.
   */
  prompt?: string;
  /**
   * Additional metadata used to generate or about the image/tool_call.
   */
  metadata?: Record<string, unknown>;
};

// FileCitation.ts
export type FileCitation = {
  end_index: number;
  file_citation: FileCitationDetails;
  start_index: number;
  text: string;
  type: 'file_citation';
};

export type FileCitationDetails = {
  file_id: string;
  quote: string;
};

export type FilePath = {
  end_index: number;
  file_path: FilePathDetails;
  start_index: number;
  text: string;
  type: 'file_path';
};

export type FilePathDetails = {
  file_id: string;
};

export type Text = {
  annotations?: Array<FileCitation | FilePath>;
  value: string;
};

export enum AnnotationTypes {
  FILE_CITATION = 'file_citation',
  FILE_PATH = 'file_path',
}

export enum StepStatus {
  IN_PROGRESS = 'in_progress',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

export enum MessageContentTypes {
  TEXT = 'text',
  IMAGE_FILE = 'image_file',
}

export type PartMetadata = {
  /** Host-resolved execution identity for a saved subagent invocation. */
  subagentIdentity?: SubagentIdentity;
  progress?: number;
  asset_pointer?: string;
  status?: string;
  action?: boolean;
  auth?: string;
  expires_at?: number;
  /** Index indicating parallel sibling content (same stepIndex in multi-agent runs) */
  siblingIndex?: number;
  /** Agent ID for parallel agent rendering - identifies which agent produced this content */
  agentId?: string;
  /** Group ID for parallel content - parts with same groupId are displayed in columns */
  groupId?: number;
  /**
   * Terminal lifecycle status of the run step that produced this part, from
   * `on_run_step_closed`. Distinct from `status`, which is already claimed by
   * activity-label and question-form parts. Absent on parts predating the
   * event or from endpoints that do not emit it, in which case renderers fall
   * back to inferring "stopped" from `progress` and `isSubmitting`.
   */
  runStepStatus?: Agents.RunStepClosedStatus;
  /**
   * Wall-clock milliseconds the run step took, derived from the same
   * `on_run_step_closed` event as {@link runStepStatus} via
   * `getRunStepDurationMs`. Only written when the event carried both
   * timestamps and they agree in order — so its absence means "not
   * derivable", never "instant". The raw value is persisted unfiltered;
   * whether it is worth showing (`isReportableRunStepDuration`) is decided
   * at render time.
   */
  runStepDurationMs?: number;
  /**
   * Stamped by the background harvester when a detached task's final output
   * replaces the dispatch handle in `tool_call.output`. The handle JSON and
   * the live status-marker attachment are both transient, so after the patch
   * (or a reload) this is the only signal that the call ran in the
   * background — renderers use it to keep treating {@link runStepDurationMs}
   * as dispatch time rather than the task's runtime.
   */
  backgrounded?: boolean;
  /**
   * Content index this part occupied while its run streamed. The aggregator
   * writes parts at provider-source indexes, so the streamed array is sparse;
   * persistence compacts it and every part after a hole shifts down. The
   * client's final handler stamps the streamed position onto the compacted
   * parts it adopts, so index-derived render identity survives the swap
   * instead of remounting the settled message. Client-only and absent
   * everywhere else — persisted content never carries it.
   */
  streamedIndex?: number;
};

/** Metadata for parallel content rendering - subset of PartMetadata */
export type ContentMetadata = Pick<PartMetadata, 'agentId' | 'groupId' | 'streamedIndex'>;

export type ContentPart = (
  | CodeToolCall
  | RetrievalToolCall
  | FileSearchToolCall
  | FunctionToolCall
  | Agents.AgentToolCall
  | ImageFile
  | Text
) &
  PartMetadata;

export type TextData = (Text & PartMetadata) | undefined;

export type SummaryContentPart = {
  type: ContentTypes.SUMMARY;
  content?: Array<{ type: ContentTypes.TEXT; text: string }>;
  tokenCount?: number;
  summarizing?: boolean;
  /** A summarize round that ended in error. Partial deltas already streamed
   *  into this slot are kept, so the renderer needs this to avoid presenting
   *  truncated text under the "Conversation summarized" label. */
  failed?: boolean;
  /** Set when the user compacted the context manually rather than the
   *  automatic detour firing on context pressure. */
  initiatedBy?: 'user';
  summaryVersion?: number;
  model?: string;
  provider?: string;
  createdAt?: string;
  boundary?: {
    messageId: string;
    contentIndex: number;
  };
};

/**
 * A user steering message injected mid-run at a tool-batch boundary.
 * Persisted inline in the response message's content array (keyed by the
 * type name like `text`/`think` so token counting reads it for free);
 * replayed as a user message on subsequent turns by `formatAgentMessages`.
 */
export type SteerContentPart = {
  type: ContentTypes.STEER;
  steer: string;
  steerId?: string;
  /** Stable optimistic-client id used to settle a POST whose response was lost. */
  clientSteerId?: string;
  createdAt?: number;
  /** Attachments steered with the message; re-encoded per turn on replay
   *  like any other user-message media (refs only, never encoded data). */
  files?: Partial<TFile>[];
  /** Quoted excerpts steered with the message, persisted separately from the
   *  typed text (mirroring `TMessage.quotes`) so the UI renders them as
   *  reference blocks; merged into the model-bound user turn on every replay. */
  quotes?: string[];
};

export type TMessageContentParts =
  | ({
      type: ContentTypes.ERROR;
      text?: string | TextData;
      error?: string;
      /** Set when this failure is what a manual compaction produced instead of a
       *  summary. The turn has no other record of having been one, so the rerun
       *  controls read it the same way they read a summary's marker. */
      initiatedBy?: 'user';
    } & ContentMetadata)
  | ({
      type: ContentTypes.THINK;
      think?: string | TextData;
      /** Generated orientation for this user-visible reasoning step. */
      reasoning_label?: string;
      /** Stable SDK run-step identity used to correlate live revisions. */
      reasoning_label_step_id?: string;
      /** Durable provider-call count used to enforce the per-run cost cap across resumes. */
      reasoning_label_attempts?: number;
      /** Visible reasoning length included in this step's latest provider call. */
      reasoning_label_submitted_chars?: number;
      /** Monotonic provider-call revision; gaps are allowed after unsuccessful attempts. */
      reasoning_label_revision?: number;
      /** Whether the reasoning step can still produce a newer label. */
      reasoning_label_status?: 'streaming' | 'complete';
      /** The reasoning happened but its text is not available to this view
       *  (e.g. detached subagent projections retain only a marker). */
      reasoning_unavailable?: boolean;
    } & ContentMetadata)
  | (SteerContentPart & ContentMetadata)
  | ({
      type: ContentTypes.TEXT;
      text?: string | TextData;
      tool_call_ids?: string[];
      /** Open Responses semantic channel for assistant text. */
      phase?: 'commentary' | 'final_answer';
    } & ContentMetadata)
  | ({
      type: ContentTypes.TOOL_CALL;
      tool_call: (
        | CodeToolCall
        | RetrievalToolCall
        | FileSearchToolCall
        | FunctionToolCall
        | Agents.AgentToolCall
      ) &
        PartMetadata;
    } & ContentMetadata)
  | ({ type: ContentTypes.IMAGE_FILE; image_file: ImageFile & PartMetadata } & ContentMetadata)
  | (SummaryContentPart & ContentMetadata)
  | ({
      /** One-line LLM-generated note describing a completed tool batch. UI-only:
       *  never sent to the model (stripped before payload formatting). */
      type: ContentTypes.ACTIVITY_LABEL;
      activity_label?: string;
      /** Missing means the legacy/per-batch activity label. */
      activity_label_type?: 'phase';
      tool_call_ids?: string[];
      /** Parent phase bounds and telemetry. */
      activity_start_index?: number;
      /** Exclusive end of the grouped content; may precede the marker itself. */
      activity_end_index?: number;
      activity_count?: number;
      agent_ids?: string[];
      /** ok = all tools succeeded, failed = all failed, partial = mixed. */
      status?: 'ok' | 'partial' | 'failed';
      pending?: boolean;
    } & ContentMetadata)
  | (Agents.AgentUpdate & ContentMetadata)
  | (Agents.MessageContentImageUrl & ContentMetadata)
  | (Agents.MessageContentVideoUrl & ContentMetadata)
  | (Agents.MessageContentInputAudio & ContentMetadata);

export type StreamContentData = TMessageContentParts & {
  /** The index of the current content part */
  index: number;
  /** The current text content was already served but edited to replace elements therein */
  edited?: boolean;
};

export type TContentData = StreamContentData & {
  messageId: string;
  conversationId: string;
  userMessageId: string;
  thread_id: string;
  stream?: boolean;
};

export const hostImageIdSuffix = '_host_copy';
export const hostImageNamePrefix = 'host_copy_';
