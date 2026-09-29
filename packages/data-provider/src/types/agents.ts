/* eslint-disable @typescript-eslint/no-namespace */
import { z } from 'zod';
import type { TAttachment, TPlugin, AgentProvider, MemoryScope, SkillsScope } from 'src/schemas';
import type { TTokenUsageEvent, TContextUsageEvent, TPendingSteer } from './runs';
import type { FunctionTool, ToolResources, AgentToolOptions } from './tools';
import type { StatefulCodeEnvironment } from '../stateful-code';
import type { SummaryContentPart } from './content';
import type { TFile } from './files';
import { StepTypes, ContentTypes, ToolCallTypes } from './runs';
import { ArtifactModes } from 'src/artifacts';
import { EToolResources } from './tools';
export {
  STATEFUL_CODE_ENVIRONMENTS,
  resolveStatefulCodeEnvironment,
  resolveAllowedStatefulCodeEnvironments,
} from '../stateful-code';
export type { StatefulCodeEnvironment } from '../stateful-code';

export namespace Agents {
  export type MessageType = 'human' | 'ai' | 'generic' | 'system' | 'function' | 'tool' | 'remove';

  export type ImageDetail = 'auto' | 'low' | 'high';

  export type ReasoningContentText = {
    type: ContentTypes.THINK;
    think: string;
  };

  export type MessageContentText = {
    type: ContentTypes.TEXT;
    text: string;
    tool_call_ids?: string[];
  };

  export type AgentUpdate = {
    type: ContentTypes.AGENT_UPDATE;
    agent_update: {
      index: number;
      runId: string;
      agentId: string;
    };
  };

  export type MessageContentImageUrl = {
    type: ContentTypes.IMAGE_URL;
    image_url: string | { url: string; detail?: ImageDetail };
  };

  export type MessageContentVideoUrl = {
    type: ContentTypes.VIDEO_URL;
    video_url: { url: string };
  };

  export type MessageContentInputAudio = {
    type: ContentTypes.INPUT_AUDIO;
    input_audio: {
      data: string;
      format: string;
    };
  };

  export type MessageContentComplex =
    | ReasoningContentText
    | AgentUpdate
    | MessageContentText
    | MessageContentImageUrl
    | MessageContentVideoUrl
    | MessageContentInputAudio
    | SummaryContentPart
    | ToolCallContent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | (Record<string, any> & { type?: ContentTypes | string })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | (Record<string, any> & { type?: never });

  export type MessageContent = string | MessageContentComplex[];

  /**
   * A call to a tool.
   */
  export type ToolCall = {
    /** Type ("tool_call") according to Assistants Tool Call Structure; optional literal
     *  form included to mirror langchain's ToolCall, whose `type` is optional. */
    type?: ToolCallTypes.TOOL_CALL | 'tool_call';
    /** The name of the tool to be called */
    name: string;
    /** Host-derived MCP server identity retained to disambiguate historical tool keys. */
    mcpServerName?: string;

    /** The arguments to the tool call */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args?: string | Record<string, any>;

    /** If provided, an identifier associated with the tool call */
    id?: string;
    /** Host run-step identity; unlike provider ids, this is unique across turns. */
    stepId?: string;
    /** If provided, the output of the tool call */
    output?: string;
    /** Host-owned durable receipt for a detached ordinary tool result.
     * It lives beside the original call so reload, manual collection, and
     * automatic continuation all arbitrate the same result identity. */
    backgroundTask?: {
      version: 1;
      taskId: string;
      toolName: string;
      status: 'completed' | 'error';
      /** Additive rolling-deploy-compatible cancellation discriminator. */
      cancelled?: true;
      settledAt: Date;
      resultClaim?: {
        kind: 'manual' | 'wakeup';
        claimId: string;
        claimedAt: Date;
        /** Response generation that owns a manual delivery claim. */
        generationId?: string;
      };
    };
    /** The tool call was rejected before execution because its input failed schema validation. */
    inputValidationError?: true;
    /** Auth URL */
    auth?: string;
    /** Expiration time */
    expires_at?: number;
    /**
     * When set, this tool call is paused for human review.
     * The presence of this field signals the UI to render approval controls
     * instead of the in-flight tool execution state.
     */
    approval?: {
      actionId: string;
      allowed_decisions: ToolApprovalDecisionType[];
      description?: string;
    };
  };

  export type ToolEndEvent = {
    /** The Step Id of the Tool Call */
    id: string;
    /** The Completed Tool Call */
    tool_call?: ToolCall;
    /** The content index of the tool call */
    index: number;
  };

  export type ToolCallContent = {
    type: ContentTypes.TOOL_CALL;
    tool_call?: ToolCall;
  };

  /**
   * A chunk of a tool call (e.g., as part of a stream).
   * When merging ToolCallChunks (e.g., via AIMessageChunk.__add__),
   * all string attributes are concatenated. Chunks are only merged if their
   * values of `index` are equal and not None.
   *
   * @example
   * ```ts
   * const leftChunks = [
   *   {
   *     name: "foo",
   *     args: '{"a":',
   *     index: 0
   *   }
   * ];
   *
   * const leftAIMessageChunk = new AIMessageChunk({
   *   content: "",
   *   tool_call_chunks: leftChunks
   * });
   *
   * const rightChunks = [
   *   {
   *     name: undefined,
   *     args: '1}',
   *     index: 0
   *   }
   * ];
   *
   * const rightAIMessageChunk = new AIMessageChunk({
   *   content: "",
   *   tool_call_chunks: rightChunks
   * });
   *
   * const result = leftAIMessageChunk.concat(rightAIMessageChunk);
   * // result.tool_call_chunks is equal to:
   * // [
   * //   {
   * //     name: "foo",
   * //     args: '{"a":1}'
   * //     index: 0
   * //   }
   * // ]
   * ```
   *
   * @property {string} [name] - If provided, a substring of the name of the tool to be called
   * @property {string} [args] - If provided, a JSON substring of the arguments to the tool call
   * @property {string} [id] - If provided, a substring of an identifier for the tool call
   * @property {number} [index] - If provided, the index of the tool call in a sequence
   */
  export type ToolCallChunk = {
    name?: string;

    args?: string;

    id?: string;

    index?: number;

    type?: 'tool_call_chunk';
  };

  /** Event names are of the format: on_[runnable_type]_(start|stream|end).

  Runnable types are one of:

  llm - used by non chat models
  chat_model - used by chat models
  prompt -- e.g., ChatPromptTemplate
  tool -- LangChain tools
  chain - most Runnables are of this type
  Further, the events are categorized as one of:

  start - when the runnable starts
  stream - when the runnable is streaming
  end - when the runnable ends
  start, stream and end are associated with slightly different data payload.

  Please see the documentation for EventData for more details. */
  export type EventName = string;
  export type RunStep = {
    type: StepTypes;
    id: string; // #new
    runId?: string; // #new
    agentId?: string; // #new
    index: number; // #new
    stepIndex?: number; // #new
    /** Group ID for parallel content - parts with same groupId are displayed in columns */
    groupId?: number; // #new
    stepDetails: StepDetails;
    summary?: SummaryContentPart;
    /** Optional to mirror the agents SDK, which omits usage until a step reports it. */
    usage?: null | object;
    /** Epoch ms the step was opened. Emitted by `@librechat/agents` >= 3.4.6. */
    created_at?: number;
    status?: RunStepStatus;
  };

  /** Lifecycle status of a run step. `in_progress` until a terminal close. */
  export type RunStepStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed';

  /** Terminal status a run step can close with. */
  export type RunStepClosedStatus = Exclude<RunStepStatus, 'in_progress'>;

  /**
   * Payload of {@link StepEvents.ON_RUN_STEP_CLOSED}. Emitted once per step
   * when it reaches a terminal state, including steps swept at end-of-run
   * because the caller aborted — which is the only signal that distinguishes
   * a stopped step from one still in flight.
   */
  export type RunStepClosedEvent = {
    id: string;
    index: number;
    type: StepTypes;
    status: RunStepClosedStatus;
    /** Epoch ms the step was opened, when the emitter knows it. */
    created_at?: number;
    /** Epoch ms the step reached its terminal state. */
    closed_at: number;
    runId?: string;
    agentId?: string;
    groupId?: number;
    stepIndex?: number;
  };

  /** Content part for aggregated message content */
  export interface ContentPart {
    type: string;
    text?: string;
    [key: string]: unknown;
  }

  /** User message metadata for rebuilding submission on reconnect */
  export interface UserMessageMeta {
    messageId: string;
    parentMessageId?: string;
    conversationId?: string;
    text?: string;
    /** Skill selections on the turn, carried so a HITL-resumed turn's reconstructed
     *  requestMessage keeps its skill pills (they aren't on the DB row the client refetches
     *  until reload). */
    manualSkills?: string[];
    alwaysAppliedSkills?: string[];
  }

  /** Client-safe state for one MCP authorization prompt that remains actionable. */
  export interface PendingMCPOAuthPrompt {
    stepId: string;
    runId?: string;
    index: number;
    toolCallId?: string;
    toolName: string;
    authURL: string;
    expiresAt?: number;
  }

  /** State data sent to reconnecting clients */
  export interface ResumeState {
    runSteps: RunStep[];
    /** Aggregated content parts - can be MessageContentComplex[] or ContentPart[] */
    aggregatedContent?: MessageContentComplex[];
    userMessage?: UserMessageMeta;
    responseMessageId?: string;
    /** True when the live generation replaces an existing assistant branch. */
    isRegenerate?: boolean;
    conversationId?: string;
    sender?: string;
    iconURL?: string;
    model?: string;
    titleEvent?: {
      event: 'title';
      data?: {
        conversationId?: string;
        title?: string;
      };
    };
    replayEvents?: Array<{
      event: string;
      data?: unknown;
      [key: string]: unknown;
    }>;
    /** Pending MCP authorization prompts projected from durable stream state. */
    pendingOAuthPrompts?: PendingMCPOAuthPrompt[];
    /** Cumulative provider-reported usage for the run; backfills usage totals on resume */
    collectedUsage?: TTokenUsageEvent[];
    /** Latest context window snapshot; restores the usage gauge on resume */
    contextUsage?: TContextUsageEvent;
    /**
     * Live pending approval when the run is paused for human review. Carried in
     * the resume contract (not just /chat/status) so a reloading or
     * cross-replica client can rebuild and render the prompt from `resumeState`.
     */
    pendingAction?: PendingAction;
    /**
     * Steers queued server-side but not yet injected into the run. Injected
     * steers already live inside `aggregatedContent`; these are the remainder,
     * so a reconnecting client can rebuild its pending-steer chips.
     */
    pendingSteers?: TPendingSteer[];
  }
  /**
   * Represents a run step delta i.e. any changed fields on a run step during
   * streaming.
   */
  export interface RunStepDeltaEvent {
    /**
     * The identifier of the run step, which can be referenced in API endpoints.
     */
    id: string;
    /**
     * The delta containing the fields that have changed on the run step.
     */
    delta: ToolCallDelta;
  }
  export type StepDetails = MessageCreationDetails | ToolCallsDetails;
  export type MessageCreationDetails = {
    type: StepTypes.MESSAGE_CREATION;
    message_creation: {
      message_id: string;
      /** Provider content kind and Open Responses semantic text channel. */
      content_type?: 'text' | 'think';
      phase?: 'commentary' | 'final_answer';
    };
  };
  export type ToolCallsDetails = {
    type: StepTypes.TOOL_CALLS;
    tool_calls?: AgentToolCall[];
  };
  export type ToolCallDelta = {
    type: StepTypes.TOOL_CALLS | string;
    tool_calls?: ToolCallChunk[];
    auth?: string;
    expires_at?: number;
    /** Approval metadata, set when a tool call is paused for human review. */
    approval?: {
      actionId: string;
      allowed_decisions: ToolApprovalDecisionType[];
      description?: string;
    };
  };
  /**
   * Mirrors the agents SDK's function tool-call variant: `arguments` may arrive as a
   * parsed object, and `output` is attached by LibreChat aggregation only once available
   * (the legacy assistants `FunctionToolCall` requires both as string/present).
   */
  export type AgentFunctionToolCall = {
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string | object;
      output?: string | null;
    };
  };

  export type AgentToolCall = AgentFunctionToolCall | ToolCall;

  /**
   * Human-in-the-loop interrupt categories. The discriminator on
   * {@link HumanInterruptPayload}.
   *
   * - `tool_approval`: agent paused before executing one or more tools; user
   *   approves / rejects / edits each call.
   * - `ask_user_question`: agent invoked the `AskUserQuestion` tool to gather
   *   clarification; user replies with free-form text (or selects an option).
   *
   * `tool_approval` is a permission gate; `ask_user_question` is a clarification
   * channel — they share the {@link PendingAction} envelope but have different
   * UI affordances and resume payloads.
   */
  export type HumanInterruptType = 'tool_approval' | 'ask_user_question';

  /** String enum of decision kinds the user can make on a paused tool call. */
  export type ToolApprovalDecisionType = 'approve' | 'reject' | 'edit' | 'respond';

  /**
   * One pending tool execution awaiting user review.
   * Field naming mirrors LangChain HumanInterrupt's `ActionRequest`.
   */
  export interface ToolApprovalRequest {
    /** Tool name as registered with the agent */
    name: string;
    /** Sanitized arguments (no auth tokens / file blobs). May be string or parsed object. */
    arguments: string | Record<string, unknown>;
    /** Provider tool_call_id linking this request to the model's tool_use block */
    tool_call_id: string;
    /** Optional human-readable description shown alongside the prompt */
    description?: string;
    /** Server-authored provenance. Absent for user, MCP, action, and older tool calls. */
    source?: 'librechat_code';
  }

  /**
   * Per-call review configuration: which decisions the user is allowed to make.
   *
   * `tool_call_id` (NOT `action_name`) is the join key against
   * {@link ToolApprovalRequest.tool_call_id}. By-position mapping breaks the
   * moment a single batch contains the same tool called twice — e.g. a model
   * fanning out two `mcp:server:search` calls in parallel — so always join
   * by `tool_call_id`. `action_name` is retained for display only.
   */
  export interface ToolReviewConfig {
    action_name: string;
    tool_call_id: string;
    allowed_decisions: ToolApprovalDecisionType[];
  }

  /** Interrupt payload for a tool-approval pause. */
  export interface ToolApprovalInterruptPayload {
    type: 'tool_approval';
    action_requests: ToolApprovalRequest[];
    review_configs: ToolReviewConfig[];
  }

  /** A selectable answer for an ask-user-question prompt. */
  export interface AskUserQuestionOption {
    label: string;
    value: string;
  }

  /** The question itself: free-form prompt with optional curated answers. */
  export interface AskUserQuestionRequest {
    question: string;
    /** Optional descriptive context for the prompt; mirrors the SDK field. */
    description?: string;
    options?: AskUserQuestionOption[];
    /** When true the user may pick several options; the answer is their
     *  selected option values joined with ", ". */
    multiSelect?: boolean;
  }

  /** One independently answerable question in a batched clarification. */
  export interface AskUserQuestionBatchItem extends AskUserQuestionRequest {
    /** Batch-unique identifier used to map the submitted answer. */
    id: string;
    /** Optional short heading rendered above the question. */
    header?: string;
  }

  /** Input shape for one tool call that asks several related questions. */
  export interface AskUserQuestionsRequest {
    questions: AskUserQuestionBatchItem[];
  }

  /** Interrupt payload for an ask-user-question pause. */
  export interface AskUserQuestionInterruptPayload {
    type: 'ask_user_question';
    question: AskUserQuestionRequest;
    /** Present for a batched clarification; `question` remains the first-item fallback. */
    questions?: AskUserQuestionBatchItem[];
    /**
     * The ask tool call that raised this interrupt (mirrors the SDK field,
     * present from `@librechat/agents` > 3.3.8). Lets the question/answer
     * stamps target the exact tool-call part instead of guessing by
     * position when a model emits several ask calls in one turn.
     */
    tool_call_id?: string;
  }

  /**
   * Discriminated by `type`. Mirrors `@librechat/agents`'s `HumanInterruptPayload`
   * so the SDK's `Run.getInterrupt()` output can be embedded directly.
   */
  export type HumanInterruptPayload =
    | ToolApprovalInterruptPayload
    | AskUserQuestionInterruptPayload;

  /**
   * Server-side record of a job that is waiting for user input.
   * Persisted with the job; consumed by approval routes and the status endpoint.
   */
  export interface PendingAction {
    /** Stable identifier used in approval URLs */
    actionId: string;
    streamId: string;
    conversationId?: string;
    /** Stable per-turn identifier (LangGraph checkpoint_ns) when available */
    runId?: string;
    responseMessageId?: string;
    payload: HumanInterruptPayload;
    createdAt: number;
    /** Optional expiry; clients should treat past `expiresAt` as stale */
    expiresAt?: number;
    /**
     * SDK interrupt id (`RunInterruptResult.interruptId`). Persisted so a
     * cross-process resume can correlate the decision with the LangGraph
     * interrupt after the original `Run` object is gone.
     */
    interruptId?: string;
    /**
     * LangGraph `thread_id` the run was bound to (`RunInterruptResult.threadId`).
     * Required, with the checkpointer, to rebuild `Command({ resume })` on a
     * worker that didn't originate the run.
     */
    threadId?: string;
    /**
     * Fingerprint of the request fields that determine the agent/graph + tool set
     * (endpoint, agent_id, model, spec, ephemeralAgent), captured at pause time. The
     * resume route recomputes it from the resume request and rejects a mismatch — the
     * guard that catches an ephemeral-agent config swap, where `agent_id` is undefined
     * so the id check can't.
     */
    requestFingerprint?: string;
    /** Current-version fingerprint; server-only and omitted from client projections. */
    requestFingerprintV2?: string;
    /**
     * Graph-determining request fields (endpoint, agent_id, model, spec, promptPrefix,
     * ephemeralAgent) captured at pause. The resume route REPLAYS these onto the request
     * before rebuilding the run, so a reload/cross-replica resume — where the client can
     * no longer reconstruct the ephemeral config — still rebuilds the same agent/graph.
     */
    resumeContext?: Record<string, unknown>;
    /**
     * Opaque, server-only identity of the stateful code targets selected when a
     * tool approval paused. Resume rejects a changed target before provider or
     * tool execution so an approval cannot migrate to another VM or workspace.
     */
    codeExecutionBinding?: CodeExecutionApprovalBinding;
  }

  export interface CodeExecutionApprovalTargetBinding {
    /** Agent identity when available; anonymous ephemeral agents use null. */
    agentId: string | null;
    /** SHA-256 of the resolved route, worker and runtime-session identity. */
    targetHash: string;
  }

  export interface CodeExecutionApprovalBinding {
    version: 1;
    targets: CodeExecutionApprovalTargetBinding[];
  }

  /**
   * Scope of a tool-approval decision — drives the "remember this" persistence
   * envelope. Storage of session/always decisions is a Slice B+ concern; the
   * field is on the wire today so route signatures don't break later.
   */
  export type DecisionScope = 'once' | 'session' | 'always';

  /**
   * Per-tool decision returned from the approval UI.
   * Wire format. The host adapts each entry to the SDK's discriminated
   * `ToolApprovalDecision` (e.g. `{ type: 'edit', updatedInput }`) at the resume route.
   *
   * Constraints:
   * - `editedArguments` is required when `decision === 'edit'`.
   * - `responseText` is required when `decision === 'respond'`.
   * - `reason` is optional metadata; useful for reject/edit audit trails.
   * - `scope` defaults to `'once'`.
   */
  export interface ToolApprovalResolution {
    tool_call_id: string;
    decision: ToolApprovalDecisionType;
    editedArguments?: Record<string, unknown>;
    responseText?: string;
    reason?: string;
    scope?: DecisionScope;
  }

  /** Wire format for an ask-user-question response. */
  export interface AskUserQuestionResolution {
    answer: string;
  }

  /** Wire format for a batched ask-user-question response. */
  export interface AskUserQuestionsResolution {
    answers: Record<string, string>;
  }

  export interface ExtendedMessageContent {
    type?: string;
    text?: string;
    input?: string;
    index?: number;
    id?: string;
    name?: string;
  }
  /**
   * Represents a message delta i.e. any changed fields on a message during
   * streaming.
   */
  export interface MessageDeltaEvent {
    /**
     * The identifier of the message, which can be referenced in API endpoints.
     */
    id: string;
    /**
     * The delta containing the fields that have changed on the Message.
     */
    delta: MessageDelta;
  }
  /**
   * The delta containing the fields that have changed on the Message.
   */
  export interface MessageDelta {
    /**
     * The content of the message in array of text and/or images.
     */
    content?: Agents.MessageContentComplex[];
  }

  /**
   * Represents a reasoning delta i.e. any changed fields on a message during
   * streaming.
   */
  export interface ReasoningDeltaEvent {
    /**
     * The identifier of the message, which can be referenced in API endpoints.
     */
    id: string;

    /**
     * The delta containing the fields that have changed.
     */
    delta: ReasoningDelta;
  }

  /**
   * The reasoning delta containing the fields that have changed on the Message.
   */
  export interface ReasoningDelta {
    /**
     * The content of the message in array of text and/or images.
     */
    content?: MessageContentComplex[];
  }

  export type ReasoningDeltaUpdate = { type: ContentTypes.THINK; think: string };
  export type ContentType =
    | ContentTypes.THINK
    | ContentTypes.TEXT
    | ContentTypes.IMAGE_URL
    | ContentTypes.VIDEO_URL
    | ContentTypes.INPUT_AUDIO
    | string;

  export interface SummarizeStartEvent {
    agentId: string;
    provider: string;
    model?: string;
    messagesToRefineCount: number;
    summaryVersion: number;
  }

  export interface SummarizeDeltaEvent {
    id: string;
    delta: {
      summary: SummaryContentPart;
    };
  }

  export interface SummarizeCompleteEvent {
    id: string;
    agentId: string;
    summary?: SummaryContentPart;
    error?: string;
  }
}

export type ToolCallResult = {
  user: string;
  toolId: string;
  result?: unknown;
  messageId: string;
  partIndex?: number;
  blockIndex?: number;
  conversationId: string;
  attachments?: TAttachment[];
};

export enum AuthTypeEnum {
  ServiceHttp = 'service_http',
  OAuth = 'oauth',
  None = 'none',
}

export enum AuthorizationTypeEnum {
  Bearer = 'bearer',
  Basic = 'basic',
  Custom = 'custom',
}

export enum TokenExchangeMethodEnum {
  DefaultPost = 'default_post',
  BasicAuthHeader = 'basic_auth_header',
}

export type Action = {
  action_id: string;
  type?: string;
  settings?: Record<string, unknown>;
  metadata: ActionMetadata;
  version: number | string;
} & ({ assistant_id: string; agent_id?: never } | { assistant_id?: never; agent_id: string });

export type ActionMetadata = {
  api_key?: string;
  auth?: ActionAuth;
  domain?: string;
  privacy_policy_url?: string;
  raw_spec?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
};

export type ActionAuth = {
  authorization_type?: AuthorizationTypeEnum;
  custom_auth_header?: string;
  type?: AuthTypeEnum;
  authorization_content_type?: string;
  authorization_url?: string;
  client_url?: string;
  scope?: string;
  token_exchange_method?: TokenExchangeMethodEnum;
};

export type ActionMetadataRuntime = ActionMetadata & {
  oauth_access_token?: string;
  oauth_refresh_token?: string;
  oauth_token_expires_at?: Date;
};

export type MCP = {
  serverName: string;
  metadata: MCPMetadata;
} & ({ assistant_id: string; agent_id?: never } | { assistant_id?: never; agent_id?: string });

export type MCPMetadata = Omit<ActionMetadata, 'auth'> & {
  name?: string;
  description?: string;
  url?: string;
  tools?: string[];
  auth?: MCPAuth;
  icon?: string;
  trust?: boolean;
};

export type MCPAuth = ActionAuth;

export type AgentToolType = {
  tool_id: string;
  metadata: ToolMetadata;
} & ({ assistant_id: string; agent_id?: never } | { assistant_id?: never; agent_id?: string });

export type ToolMetadata = TPlugin;

export interface BaseMessage {
  content: string;
  role?: string;
  [key: string]: unknown;
}

export interface BaseGraphState {
  [key: string]: unknown;
}

export type GraphEdge = {
  /** Agent ID, use a list for multiple sources */
  from: string | string[];
  /** Agent ID, use a list for multiple destinations */
  to: string | string[];
  description?: string;
  /** Can return boolean or specific destination(s) */
  condition?: (state: BaseGraphState) => boolean | string | string[];
  /** 'handoff' creates tools for dynamic routing, 'direct' creates direct edges, which also allow parallel execution */
  edgeType?: 'handoff' | 'direct';
  /**
   * For direct edges: Optional prompt to add when transitioning through this edge.
   * String prompts can include variables like {results} which will be replaced with
   * messages from startIndex onwards. When {results} is used, excludeResults defaults to true.
   *
   * For handoff edges: Description for the input parameter that the handoff tool accepts,
   * allowing the supervisor to pass specific instructions/context to the transferred agent.
   *
   * The callback receives a minimal structural view of the run's messages (data-provider
   * cannot depend on langchain's BaseMessage): every langchain message satisfies
   * `{ content: unknown }`, and callbacks typed against richer structural message shapes
   * remain assignable. The promise branch mirrors the agents SDK signature exactly —
   * widening it (e.g. to `Promise<string | undefined>`) would break assignability of
   * stored edges into the SDK's `GraphEdge`.
   */
  prompt?:
    | string
    | ((
        messages: { content: unknown }[],
        runStartIndex: number,
      ) => string | Promise<string> | undefined);
  /**
   * When true, excludes messages from startIndex when adding prompt.
   * Automatically set to true when {results} variable is used in prompt.
   */
  excludeResults?: boolean;
  /**
   * For handoff edges: Customizes the parameter name for the handoff input.
   * Defaults to "instructions" if not specified.
   * Only applies when prompt is provided for handoff edges.
   */
  promptKey?: string;
};

/* Agent types */

export type AgentAvatar = {
  filepath: string;
  source: string;
};

export type AgentParameterValue = number | string | null;

export type AgentModelParameters = {
  model?: string;
  temperature: AgentParameterValue;
  maxContextTokens: AgentParameterValue;
  max_context_tokens: AgentParameterValue;
  max_output_tokens: AgentParameterValue;
  top_p: AgentParameterValue;
  frequency_penalty: AgentParameterValue;
  presence_penalty: AgentParameterValue;
  useResponsesApi?: boolean;
  web_search?: boolean;
};

export interface AgentBaseResource {
  /**
   * A list of file IDs made available to the tool.
   */
  file_ids?: Array<string>;
  /**
   * A list of files already fetched.
   */
  files?: Array<TFile>;
}

export interface AgentToolResources {
  [EToolResources.image_edit]?: AgentBaseResource;
  [EToolResources.execute_code]?: ExecuteCodeResource;
  [EToolResources.file_search]?: AgentFileResource;
  [EToolResources.context]?: AgentBaseResource;
  /** @deprecated Use context instead */
  [EToolResources.ocr]?: AgentBaseResource;
}
/**
 * A resource for the execute_code tool.
 * Contains file IDs made available to the tool (max 20 files) and already fetched files.
 */
export type ExecuteCodeResource = AgentBaseResource;

export interface AgentFileResource extends AgentBaseResource {
  /**
   * The ID of the vector store attached to this agent. There
   * can be a maximum of 1 vector store attached to the agent.
   */
  vector_store_ids?: Array<string>;
}
export type SupportContact = {
  name?: string;
  email?: string;
};

export type AgentOwnerContact = {
  name?: string;
};

/**
 * Configuration for spawning subagents (isolated-context child agents) from an agent.
 * When `enabled` is true, the agent gets a subagent-spawn tool that can delegate work
 * to itself, listed single-agent targets, and/or explicit saved-agent teams.
 */
export type AgentSubagentGraphEdge = Omit<
  GraphEdge,
  'edgeType' | 'condition' | 'prompt' | 'promptKey'
> & {
  edgeType: 'direct';
  condition?: never;
  prompt?: string;
  promptKey?: never;
};

/** A bounded saved-agent team that can be spawned as one isolated child graph. */
export type AgentSubagentGraph = {
  /** Stable spawn-tool enum value for the team. */
  type: string;
  name: string;
  description: string;
  /** Member IDs. In create/update payloads, an empty ID refers to the current agent. */
  agent_ids: string[];
  edges: AgentSubagentGraphEdge[];
  /** Entry member ID. In create/update payloads, an empty ID refers to the current agent. */
  entry_agent_id: string;
  /** Result member ID. In create/update payloads, an empty ID refers to the current agent. */
  result_agent_id: string;
};

export type AgentSubagentsConfig = {
  enabled?: boolean;
  /** When true (default), the agent may spawn itself in an isolated context. */
  allowSelf?: boolean;
  /** Share current-turn files with authorized descendants. Off unless explicitly enabled. */
  shareFiles?: boolean;
  /** Specific agents that may be spawned as subagents. */
  agent_ids?: string[];
  /** Explicit saved-agent teams that may be spawned as bounded child graphs. */
  graphs?: AgentSubagentGraph[];
};

export type AgentGitIdentity = {
  /** Commit author and committer display name. */
  name: string;
  /** Commit author and committer email address. */
  email: string;
};

// GitHub App bot noreply addresses contain `[bot]`, which Zod's email validator rejects.
const githubAppBotEmail =
  /^\d+\+[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?\[bot\]@users\.noreply\.github\.com$/i;
const standardGitEmail = z.string().email();

export const agentGitIdentitySchema: z.ZodType<AgentGitIdentity | undefined> = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => !/[\0\r\n]/.test(value)),
    email: z
      .string()
      .trim()
      .max(254)
      .refine(
        (value) =>
          !/[\0\r\n]/.test(value) &&
          (standardGitEmail.safeParse(value).success || githubAppBotEmail.test(value)),
      ),
  })
  .optional();

export type Agent = {
  _id?: string;
  id: string;
  name: string | null;
  author?: string | null;
  /** The original custom endpoint name, lowercased */
  endpoint?: string | null;
  authorName?: string | null;
  description: string | null;
  created_at: number;
  avatar: AgentAvatar | null;
  instructions?: string | null;
  additional_instructions?: string | null;
  tools?: string[];
  tool_kwargs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  provider: AgentProvider;
  model: string | null;
  model_parameters: AgentModelParameters;
  conversation_starters?: string[];
  tool_resources?: AgentToolResources;
  /** @deprecated Use edges instead */
  agent_ids?: string[];
  edges?: GraphEdge[];
  end_after_tools?: boolean;
  hide_sequential_outputs?: boolean;
  /** Per-agent opt-in for stateful code sessions (requires the app-level capability). */
  stateful_code_sessions?: boolean;
  /** Stateful workspace sharing scope. Defaults to one workspace per user. */
  stateful_code_environment?: StatefulCodeEnvironment;
  /** Operator-configured managed or attached stateful execution environment. */
  code_environment_id?: string | null;
  /** Default attached workspace for new chats; empty means no agent default. */
  code_workspace_id?: string;
  repositoryInstructions?: 'prefer' | 'defer' | 'off';
  /** Non-secret Git authorship injected into this agent's sandboxed commands. */
  git_identity?: AgentGitIdentity | null;
  artifacts?: ArtifactModes;
  recursion_limit?: number;
  isPublic?: boolean;
  /**
   * Whether the requesting user holds EDIT on this agent, so a single VIEW-scoped fetch can
   * serve consumers that only need the editable subset instead of issuing a second full
   * paginated walk under an EDIT-scoped cache key.
   *
   * Set by the list endpoint only; single-agent responses omit it. Treat absence as unknown
   * and fail open (`isEditable !== false`), never as `false`, since a client on an older
   * server would otherwise see an empty list rather than too many rows.
   *
   * Reflects the caller's ACL grant. The `MANAGE_AGENTS` capability bypasses ACL on write,
   * so a capability holder can edit agents this flag reports as not editable.
   */
  isEditable?: boolean;
  version?: number;
  category?: string;
  support_contact?: SupportContact;
  owner_contact?: AgentOwnerContact;
  /** Per-tool configuration options (deferred loading, allowed callers, etc.) */
  tool_options?: AgentToolOptions;
  /** Attached action registrations, each `${encodedDomain}${actionDelimiter}${action_id}` */
  actions?: string[];
  /** Optional allowlist of skill ObjectIds. Only applies when `skills_enabled`. */
  skills?: string[];
  /** Master toggle for skill use on this agent. `true` = active (full catalog unless
   *  `skills` narrows it). `false`/undefined = inactive (no skills available). */
  skills_enabled?: boolean;
  /** Enables runtime skill creation without exposing an existing skill catalog. */
  skill_authoring_enabled?: boolean;
  /** Explicit catalog exposure while skills are enabled. Missing preserves legacy semantics. */
  skills_scope?: SkillsScope;
  /** Subagent spawning configuration — isolated-context child agents. */
  subagents?: AgentSubagentsConfig;
  /** Memory partition: `agent` isolates memories per (user, agent); default shared pool */
  memory_scope?: MemoryScope;
};

export type TAgentsMap = Record<string, Agent | undefined>;

export type AgentCreateParams = {
  git_identity?: AgentGitIdentity;
  name?: string | null;
  description?: string | null;
  avatar?: AgentAvatar | null;
  file_ids?: string[];
  instructions?: string | null;
  tools?: Array<FunctionTool | string>;
  provider: AgentProvider;
  model: string | null;
  model_parameters: AgentModelParameters;
} & Pick<
  Agent,
  | 'agent_ids'
  | 'edges'
  | 'end_after_tools'
  | 'hide_sequential_outputs'
  | 'stateful_code_sessions'
  | 'stateful_code_environment'
  | 'code_environment_id'
  | 'code_workspace_id'
  | 'repositoryInstructions'
  | 'artifacts'
  | 'recursion_limit'
  | 'category'
  | 'support_contact'
  | 'tool_options'
  | 'skills'
  | 'skills_enabled'
  | 'skill_authoring_enabled'
  | 'skills_scope'
  | 'subagents'
  | 'memory_scope'
>;

export type AgentUpdateParams = {
  name?: string | null;
  description?: string | null;
  avatar?: AgentAvatar | null;
  file_ids?: string[];
  instructions?: string | null;
  tools?: Array<FunctionTool | string>;
  tool_resources?: ToolResources;
  provider?: AgentProvider;
  model?: string | null;
  model_parameters?: AgentModelParameters;
} & Pick<
  Agent,
  | 'agent_ids'
  | 'edges'
  | 'end_after_tools'
  | 'hide_sequential_outputs'
  | 'stateful_code_sessions'
  | 'stateful_code_environment'
  | 'code_environment_id'
  | 'git_identity'
  | 'code_workspace_id'
  | 'repositoryInstructions'
  | 'artifacts'
  | 'recursion_limit'
  | 'category'
  | 'support_contact'
  | 'tool_options'
  | 'skills'
  | 'skills_enabled'
  | 'skill_authoring_enabled'
  | 'skills_scope'
  | 'subagents'
  | 'memory_scope'
>;

export type AgentListParams = {
  limit?: number;
  requiredPermission: number;
  category?: string;
  search?: string;
  cursor?: string;
  promoted?: 0 | 1;
};

export type AgentListResponse = {
  object: string;
  data: Agent[];
  first_id: string;
  last_id: string;
  has_more: boolean;
  after?: string;
};

export type AgentFile = {
  file_id: string;
  id?: string;
  temp_file_id?: string;
  bytes: number;
  created_at: number;
  filename: string;
  object: string;
  purpose: 'fine-tune' | 'fine-tune-results' | 'agents' | 'agents_output';
};
