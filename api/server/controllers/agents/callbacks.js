const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const {
  Tools,
  StepTypes,
  StepEvents,
  ContentTypes,
  FileContext,
  ErrorTypes,
  UsageEvents,
  getRunStepDurationMs,
} = require('librechat-data-provider');
const {
  GraphEvents,
  GraphNodeKeys,
  createContentAggregator,
  summarizeEvent,
} = require('@librechat/agents');
const {
  sendEvent,
  computeUsageCostUSD,
  GenerationJobManager,
  waitForGenerationSettled,
  writeAttachmentEvent,
  createToolExecuteHandler,
  createOwnedToolEndHandler,
  createBackgroundCodeResultHandler: createCodeHarvestHandler,
  HOST_FILE_AUTHORING_ARTIFACT_KEY,
  isCodeSessionToolName,
  isCodeArtifactToolOutput,
  getModelRefusalInfo,
  shouldSignalSandboxStart,
  getToolInputValidationDetails,
  captureSubagentIdentity,
  collectToolCallIds,
} = require('@librechat/api');
const { processFileCitations } = require('~/server/services/Files/Citations');
const { processCodeOutput, runPreviewFinalize } = require('~/server/services/Files/Code/process');
const { preflightCodeOutputBatch } = require('~/server/services/Files/Code/preflight');
const { saveBase64Image } = require('~/server/services/Files/process');

function isHostFileAuthoringArtifact(artifact) {
  return artifact?.[HOST_FILE_AUTHORING_ARTIFACT_KEY] === true;
}

function getAttachmentOwnership(metadata) {
  const agentId = metadata?.executingAgentId ?? metadata?.agentId ?? metadata?.agent_id;
  const stepId = metadata?.stepId;
  return {
    ...(typeof agentId === 'string' && agentId.length > 0 ? { agentId } : {}),
    ...(typeof stepId === 'string' && stepId.length > 0 ? { stepId } : {}),
  };
}

function addStatefulWorkspaceChange(attachment, artifact, executionProfile) {
  if (!attachment || executionProfile !== 'stateful' || !isHostFileAuthoringArtifact(artifact)) {
    return attachment;
  }
  const path =
    typeof artifact.path === 'string' && artifact.path.length > 0
      ? artifact.path
      : attachment.filename;
  if (typeof path !== 'string' || path.length === 0) {
    return attachment;
  }
  attachment.workspaceChange = {
    profile: 'stateful',
    operation: artifact.created === true ? 'created' : 'updated',
    path,
  };
  return attachment;
}

async function enqueueCodeOutputBatch({
  req,
  artifact,
  artifactPromises,
  codeExecutionContext,
  processEntry,
}) {
  const entries = await preflightCodeOutputBatch({ req, artifact, codeExecutionContext });
  let persistenceChain = Promise.resolve();
  for (const entry of entries) {
    const current = persistenceChain
      .then(() => processEntry(entry))
      .catch(() => {
        logger.error('Error processing code output');
        return null;
      });
    persistenceChain = current.then(() => undefined);
    artifactPromises.push(current);
  }
}

class ModelEndHandler {
  /**
   * @param {Array<UsageMetadata>} collectedUsage
   * @param {Record<string, string> | null} [collectedThoughtSignatures] Map of
   *   `tool_call_id → thoughtSignature` accumulated across `chat_model_end`
   *   events. Used to persist Vertex Gemini 3 thought signatures across DB
   *   round-trips so resumed conversations don't 400 on the next API call.
   *   Each `model_end` may emit multiple tool calls (one per LLM cycle in a
   *   tool-using turn); per-id storage preserves the mapping so each tool
   *   call's signature can be restored onto the right reconstructed
   *   AIMessage rather than being concentrated on the last one.
   *   Optional; when `null`, the handler is a no-op for signatures. Non-Vertex
   *   providers don't emit `additional_kwargs.signatures`, so capture is also
   *   a no-op for them even when the map is provided.
   * @param {(data: Record<string, unknown>) => Promise<void> | void} [emitUsage] Optional
   *   callback to stream per-call token usage to the client.
   */
  constructor(collectedUsage, collectedThoughtSignatures = null, emitUsage = null) {
    if (!Array.isArray(collectedUsage)) {
      throw new Error('collectedUsage must be an array');
    }
    this.collectedUsage = collectedUsage;
    this.collectedThoughtSignatures = collectedThoughtSignatures;
    this.emitUsage = emitUsage;
  }

  finalize(errorMessage) {
    if (!errorMessage) {
      return;
    }
    throw new Error(errorMessage);
  }

  /**
   * @param {string} event
   * @param {ModelEndData | undefined} data
   * @param {Record<string, unknown> | undefined} metadata
   * @param {StandardGraph} graph
   * @returns {Promise<void>}
   */
  async handle(event, data, metadata, graph) {
    if (!graph || !metadata) {
      console.warn(`Graph or metadata not found in ${event} event`);
      return;
    }

    /** @type {string | undefined} */
    let errorMessage;
    try {
      const agentContext = graph.getAgentContext(metadata);
      const refusalInfo = getModelRefusalInfo(data?.output);
      if (refusalInfo) {
        errorMessage = JSON.stringify({
          type: ErrorTypes.REFUSAL,
          info: refusalInfo,
        });
        logger.debug(`[ModelEndHandler] Model refused to respond`, {
          ...refusalInfo,
          userId: metadata.user_id,
          messageId: metadata.run_id,
          conversationId: metadata.thread_id,
        });
      }

      const usage = data?.output?.usage_metadata;
      if (!usage) {
        return;
      }
      let taggedUsage = contextualizeModelUsage(usage, metadata, agentContext);
      /** Hidden intermediate sequential-agent calls are billed but never shown.
       *  Tag them non-primary on the COLLECTED usage too (not just the emit) so
       *  recordCollectedUsage excludes their output from the parent's tokenCount
       *  and the client folds them into cost/totals only — not the live gauge. */
      if (
        taggedUsage.usage_type == null &&
        !checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node) &&
        metadata?.hide_sequential_outputs === true
      ) {
        taggedUsage = { ...taggedUsage, usage_type: 'sequential' };
      }

      this.collectedUsage.push(taggedUsage);

      if (this.emitUsage) {
        /** Normalize Anthropic/Bedrock top-level and OpenAI GPT-5.6
         *  `cache_write_tokens` cache fields into details so the emitted/persisted
         *  usage cost matches what billing charges (getCacheCreationTokens). */
        const cache_creation =
          taggedUsage.input_token_details?.cache_creation ??
          taggedUsage.input_token_details?.cache_write_tokens ??
          taggedUsage.cache_creation_input_tokens ??
          taggedUsage.cache_write_tokens;
        const cache_read =
          taggedUsage.input_token_details?.cache_read ?? taggedUsage.cache_read_input_tokens;
        try {
          await this.emitUsage({
            input_tokens: taggedUsage.input_tokens,
            output_tokens: taggedUsage.output_tokens,
            total_tokens: taggedUsage.total_tokens,
            input_token_details:
              cache_creation != null || cache_read != null
                ? { cache_creation, cache_read }
                : undefined,
            model: taggedUsage.model,
            provider: taggedUsage.provider,
            usage_type: taggedUsage.usage_type,
            /** Producing agent for per-endpoint pricing; consumed by the emit
             *  cost resolver and not included in the emitted/persisted payload. */
            agentId: taggedUsage.agentId,
            runId: metadata?.run_id,
            /** Per-run sequence so identical payloads from distinct calls
             *  stay distinguishable during resume dedupe */
            seq: this.collectedUsage.length,
          });
        } catch (err) {
          /** Best-effort telemetry: a failed emit (closed SSE, Redis publish
           *  error) must not abort the handler before the thought-signature
           *  capture below, or resumed tool-call requests lose that metadata */
          logger.warn('[ModelEndHandler] Failed to emit token usage', err);
        }
      }

      /**
       * `additional_kwargs.signatures` is a flat array indexed by response
       * part position (text + functionCall interleaved). `tool_calls` is
       * just the function calls in their original order. Non-empty
       * signatures correspond 1:1 with `tool_calls` in order — see
       * `partsToSignatures` in `@langchain/google-common`. Walk both in a
       * single pass to map each signature onto the right `tool_call.id`.
       */
      const signatures = data?.output?.additional_kwargs?.signatures;
      const toolCalls = data?.output?.tool_calls;
      if (
        this.collectedThoughtSignatures &&
        Array.isArray(signatures) &&
        Array.isArray(toolCalls)
      ) {
        let toolIdx = 0;
        for (const sig of signatures) {
          if (typeof sig !== 'string' || sig.length === 0) continue;
          if (toolIdx >= toolCalls.length) break;
          const id = toolCalls[toolIdx++]?.id;
          if (id) this.collectedThoughtSignatures[id] = sig;
        }
      }
    } catch (error) {
      logger.error('Error handling model end event:', error);
    } finally {
      this.finalize(errorMessage);
    }
  }
}

/**
 * @deprecated Agent Chain helper
 * @param {string | undefined} [last_agent_id]
 * @param {string | undefined} [langgraph_node]
 * @returns {boolean}
 */
function checkIfLastAgent(last_agent_id, langgraph_node) {
  if (!last_agent_id || !langgraph_node) {
    return false;
  }
  return langgraph_node?.endsWith(last_agent_id);
}

/**
 * Helper to emit events either to res (standard mode) or to job emitter (resumable mode).
 * In Redis mode, awaits the emit to guarantee event ordering (critical for streaming deltas).
 * @param {ServerResponse} res - The server response object
 * @param {string | null} streamId - The stream ID for resumable mode, or null for standard mode
 * @param {Object} eventData - The event data to send
 * @param {number} [expectedCreatedAt] - The generation epoch that produced the event
 * @returns {Promise<void>}
 */
async function emitEvent(res, streamId, eventData, expectedCreatedAt) {
  if (streamId) {
    await GenerationJobManager.emitChunk(streamId, eventData, { expectedCreatedAt });
  } else {
    sendEvent(res, eventData);
  }
}

/**
 * Emits `on_sandbox_starting` for each code-execution tool call in the run
 * step when the conversation's stateful sandbox is still cold-booting, so the
 * UI can explain the first call's boot latency instead of showing a generic
 * running state. Only signals while a fired prewarm remains unresolved
 * ({@link shouldSignalSandboxStart}); stateless deployments never fire one
 * and completed boots clear the marker, so both stay on the generic label.
 * @param {(eventData: Object) => Promise<void>} emitForJob - Generation-fenced event emitter
 * @param {StreamEventData} data - The `on_run_step` event data
 * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata
 * @returns {Promise<void>}
 */
async function maybeEmitSandboxStarting(emitForJob, data, metadata) {
  const conversationId = metadata?.thread_id;
  if (!conversationId || !(await shouldSignalSandboxStart(conversationId))) {
    return;
  }
  const toolCalls = data?.stepDetails?.tool_calls ?? [];
  for (const toolCall of toolCalls) {
    const name = toolCall?.name ?? toolCall?.function?.name;
    if (!toolCall?.id || name == null || !isCodeSessionToolName(name)) {
      continue;
    }
    await emitForJob({
      event: StepEvents.ON_SANDBOX_STARTING,
      data: { tool_call_id: toolCall.id, runId: metadata?.run_id },
    });
  }
}

/**
 * Maps a {@link SubagentUpdateEvent} phase to the corresponding
 * {@link GraphEvents} name that the SDK's `createContentAggregator`
 * knows how to consume. Phases that don't carry content (`start`, `stop`,
 * `error`) or whose payload doesn't match a handled event (`run_step`
 * with an `ON_TOOL_EXECUTE`-shaped batch request rather than a RunStep)
 * return `null` so the caller skips them.
 * @param {SubagentUpdateEvent} event
 * @returns {string | null}
 */
function subagentPhaseToGraphEvent(event) {
  switch (event?.phase) {
    case 'run_step':
      /** `ON_RUN_STEP` and `ON_TOOL_EXECUTE` both forward with phase
       *  `run_step`; only the former matches the aggregator's RunStep
       *  schema. Detect by presence of `stepDetails`. */
      return event.data?.stepDetails ? GraphEvents.ON_RUN_STEP : null;
    case 'run_step_delta':
      return GraphEvents.ON_RUN_STEP_DELTA;
    case 'run_step_completed':
      return GraphEvents.ON_RUN_STEP_COMPLETED;
    case 'message_delta':
      return GraphEvents.ON_MESSAGE_DELTA;
    case 'reasoning_delta':
      return GraphEvents.ON_REASONING_DELTA;
    default:
      return null;
  }
}

/**
 * Folds a single {@link SubagentUpdateEvent} into the given content
 * aggregator. Silent no-op for phases outside the aggregator's domain.
 * @param {{ aggregateContent: Function, contentParts?: Array, stepMap?: Map }} aggregator
 * @param {SubagentUpdateEvent} event
 */
function feedSubagentAggregator(aggregator, event) {
  const graphEvent = subagentPhaseToGraphEvent(event);
  if (!graphEvent) return;
  aggregator.aggregateContent({ event: graphEvent, data: event.data });

  /** The SDK aggregator intentionally projects run-step tool calls onto its
   * public content shape, so host-only routing metadata is not copied. Restore
   * the server-owned identity by call id after that projection; otherwise the
   * persistence fallback has to parse an ambiguous delimiter-bearing name. */
  const toolCalls = event.data?.stepDetails?.tool_calls ?? [];
  const stepIndex = aggregator.stepMap?.get(event.data?.id)?.index;
  if (!Number.isInteger(stepIndex) || !Array.isArray(aggregator.contentParts)) {
    return;
  }
  for (let index = 0; index < toolCalls.length; index++) {
    const source = toolCalls[index];
    const target = aggregator.contentParts[stepIndex + index]?.tool_call;
    if (target?.id === source?.id && typeof source?.mcpServerName === 'string') {
      target.mcpServerName = source.mcpServerName;
    }
  }
}

/**
 * @typedef {Object} ToolExecuteOptions
 * @property {(toolNames: string[]) => Promise<{loadedTools: StructuredTool[]}>} loadTools - Function to load tools by name
 * @property {Object} configurable - Configurable context for tool invocation
 */

/**
 * Get default handlers for stream events.
 * @param {Object} options - The options object.
 * @param {ServerResponse} options.res - The server response object.
 * @param {ContentAggregator} options.aggregateContent - Content aggregator function.
 * @param {Array<Object>} [options.contentParts] - Aggregated message content parts.
 * @param {Map<string, Object>} [options.stepMap] - Run steps keyed by step ID.
 * @param {Map<string, import('@librechat/api').ToolInputValidationError>} [options.toolInputValidationErrors]
 *   Schema-validation errors keyed by tool-call ID at the execution error boundary.
 * @param {ToolEndCallback} options.toolEndCallback - Callback to use when tool ends.
 * @param {Array<UsageMetadata>} options.collectedUsage - The list of collected usage metadata.
 * @param {string | null} [options.streamId] - The stream ID for resumable mode, or null for standard mode.
 * @param {number} [options.jobCreatedAt] - The generation epoch that owns emitted events.
 * @param {ToolExecuteOptions} [options.toolExecuteOptions] - Options for event-driven tool execution.
 * @param {UsageCostDeps} [options.usageCost] - Pricing context for authoritative per-event cost.
 * @param {{ latest: TContextUsageEvent | null, count: number }} [options.contextUsageSink] - Mutable
 *   holder for the latest visible context snapshot + a count of visible snapshots (model calls),
 *   used to persist the breakdown only when the final call emitted usage. Also records that
 *   snapshot's position in the usage stream and in `contentParts`, so the save path can tell
 *   which usage events and which content parts came after it.
 * @param {Array<TTokenUsageEvent>} [options.usageEmitSink] - Array collecting each emitted
 *   `on_token_usage` payload (incl. cost) so the response's usage rollup can be persisted.
 * @param {(toolName: string, agentId?: string) => string | undefined} [options.resolveMcpServerName]
 * @returns {Record<string, t.EventHandler>} The default handlers.
 * @throws {Error} If the request is not found.
 */
function getDefaultHandlers({
  res,
  aggregateContent,
  contentParts = null,
  stepMap = null,
  toolInputValidationErrors = null,
  toolEndCallback,
  collectedUsage,
  collectedThoughtSignatures = null,
  streamId = null,
  jobCreatedAt,
  toolExecuteOptions = null,
  summarizationOptions = null,
  subagentAggregatorsByToolCallId = null,
  usageCost = null,
  contextUsageSink = null,
  usageEmitSink = null,
  eventChildActivity = null,
  resolveMcpServerName = null,
}) {
  if (!res || !aggregateContent) {
    throw new Error(
      `[getDefaultHandlers] Missing required options: res: ${!res}, aggregateContent: ${!aggregateContent}`,
    );
  }
  const eventActivityPhases = {
    [GraphEvents.ON_RUN_STEP]: 'run_step',
    [GraphEvents.ON_RUN_STEP_DELTA]: 'run_step_delta',
    [GraphEvents.ON_RUN_STEP_COMPLETED]: 'run_step_completed',
    [GraphEvents.ON_RUN_STEP_CLOSED]: 'run_step_closed',
    [GraphEvents.ON_MESSAGE_DELTA]: 'message_delta',
    [GraphEvents.ON_REASONING_DELTA]: 'reasoning_delta',
  };
  /** Event tasks retain one logical task id across HITL resume, while each
   * handler instance is a new generation invocation. Keep replay identity
   * unique per invocation; the existing stream transport preserves order.
   * Reusing a zero-based activitySequence here would make the client discard
   * resumed frames as duplicates of the pre-pause generation. */
  const eventActivityInvocationId = eventChildActivity == null ? null : nanoid();
  let eventActivitySequence = 0;
  let eventActivityPending = 0;
  let eventActivityCircuitOpen = false;
  let eventActivityTail = Promise.resolve();
  const publishEventChildActivity = (eventData) => {
    const phase = eventActivityPhases[eventData?.event];
    if (
      eventChildActivity == null ||
      phase == null ||
      eventActivityCircuitOpen ||
      eventActivityPending >= 128
    ) {
      return;
    }
    const sequence = eventActivitySequence++;
    eventActivityPending += 1;
    const update = {
      runId: eventChildActivity.runId,
      parentRunId: eventChildActivity.parentRunId,
      subagentRunId: eventChildActivity.subagentRunId,
      subagentType: eventChildActivity.subagentType,
      subagentKind: 'agent',
      subagentAgentId: eventChildActivity.subagentAgentId,
      parentAgentId: eventChildActivity.parentAgentId,
      depth: 1,
      ancestry: [],
      phase,
      data: eventData.data,
      label: summarizeEvent(eventData.event, eventData.data),
      timestamp: new Date().toISOString(),
      activityEventId: `${eventChildActivity.subagentRunId}:${eventActivityInvocationId}:${sequence}`,
    };
    eventActivityTail = eventActivityTail
      .then(() => eventChildActivity.publish(update))
      .catch((error) => {
        eventActivityCircuitOpen = true;
        logger.warn('[getDefaultHandlers] Failed to publish event child activity', error);
      })
      .finally(() => {
        eventActivityPending = Math.max(0, eventActivityPending - 1);
      });
  };
  const emitForJob = (eventData) => {
    publishEventChildActivity(eventData);
    return emitEvent(res, streamId, eventData, jobCreatedAt);
  };
  /**
   * Emit a token-usage event, attaching the authoritative per-event USD cost
   * when cost display is enabled. The backend is the single source of truth
   * for pricing (premium tiers, cache rates) — the client sums these instead
   * of re-deriving from base rates.
   * @param {Record<string, unknown>} data
   */
  const emitTokenUsage = ({ agentId, ...data }) => {
    let payload = data;
    if (usageCost?.enabled === true && usageCost.pricing) {
      try {
        /** Price with the producing agent's config (multi-endpoint graphs) so
         *  the streamed/persisted cost matches the per-agent balance transaction;
         *  `agentId` is resolved here, not forwarded to the client or rollup. */
        const endpointTokenConfig = usageCost.resolveEndpointTokenConfig
          ? usageCost.resolveEndpointTokenConfig({ agentId })
          : usageCost.endpointTokenConfig;
        payload = {
          ...data,
          cost: computeUsageCostUSD(data, usageCost.pricing, endpointTokenConfig),
        };
      } catch (err) {
        logger.warn('[getDefaultHandlers] Failed to compute usage cost', err);
      }
    }
    /** Collect the same payload the client folds so the response's usage rollup
     *  persisted on `metadata.usage` reproduces the live branch/total + cost. */
    if (usageEmitSink) {
      usageEmitSink.push(payload);
    }
    return emitForJob({ event: UsageEvents.ON_TOKEN_USAGE, data: payload });
  };
  const handlers = {
    [GraphEvents.CHAT_MODEL_END]: new ModelEndHandler(
      collectedUsage,
      collectedThoughtSignatures,
      emitTokenUsage,
    ),
    [GraphEvents.TOOL_END]: createOwnedToolEndHandler(toolEndCallback, logger),
    [GraphEvents.ON_RUN_STEP]: {
      /**
       * Handle ON_RUN_STEP event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        for (const toolCall of data?.stepDetails?.tool_calls ?? []) {
          const toolName = toolCall?.name ?? toolCall?.function?.name;
          if (toolCall?.name == null && typeof toolName === 'string') {
            toolCall.name = toolName;
          }
          const serverName = resolveMcpServerName?.(
            toolName,
            metadata?.agent_id ?? metadata?.agentId,
          );
          if (serverName) {
            toolCall.mcpServerName = serverName;
          }
        }
        aggregateContent({ event, data });
        if (data?.stepDetails.type === StepTypes.TOOL_CALLS) {
          await emitForJob({ event, data });
          await maybeEmitSandboxStarting(emitForJob, data, metadata);
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitForJob({ event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitForJob({ event, data });
        } else {
          const agentName = metadata?.name ?? 'Agent';
          const isToolCall = data?.stepDetails.type === StepTypes.TOOL_CALLS;
          const action = isToolCall ? 'performing a task...' : 'thinking...';
          await emitForJob({
            event: 'on_agent_update',
            data: {
              runId: metadata?.run_id,
              message: `${agentName} is ${action}`,
            },
          });
        }
      },
    },
    [GraphEvents.ON_RUN_STEP_CLOSED]: {
      /**
       * Handle ON_RUN_STEP_CLOSED event — the terminal signal for a run step.
       *
       * Stamped onto the aggregated part before it is forwarded. The SDK's
       * `aggregateContent` has no notion of this event, so without stamping
       * here the status would exist only on the live client message: a reload
       * or a resumable reconnect would drop it and fall back to inferring
       * "stopped" from `isSubmitting`, which is the behavior this fixes.
       *
       * Forwarded unconditionally, without the visibility gating the other
       * step events apply — a step whose `on_run_step` reached the client must
       * get its closure, or the client is left inferring again.
       *
       * @param {string} event - The event name.
       * @param {RunStepClosedEvent} data - The event data.
       */
      handle: async (event, data) => {
        const stepId = data?.id;
        if (typeof stepId === 'string' && contentParts) {
          /**
           * Resolved through `stepMap` only. The event's own `index` is the
           * SDK's, and the steer/HITL offset wrappers shift `ON_RUN_STEP` but
           * pass closures through untouched — so falling back to it would
           * stamp an unrelated part in any run containing an injection.
           * Skipping is the safe failure here; a missing status degrades to
           * the old heuristic, a misplaced one mislabels the wrong card.
           */
          const index = stepMap?.get(stepId)?.index;
          const part = typeof index === 'number' ? contentParts[index] : undefined;
          if (part?.type === ContentTypes.TOOL_CALL && part.tool_call) {
            part.tool_call.runStepStatus = data.status;
            /**
             * The raw derivable duration, left unset rather than zeroed when
             * the event cannot support a trustworthy one — no `created_at`,
             * or clocks that disagree. Whether it is *worth showing* is the
             * renderer's call; persisting the fact unfiltered keeps that
             * threshold adjustable without data loss.
             */
            const durationMs = getRunStepDurationMs(data);
            if (durationMs != null) {
              part.tool_call.runStepDurationMs = durationMs;
            }
          }
        }
        await emitForJob({ event, data });
      },
    },
    [GraphEvents.ON_RUN_STEP_DELTA]: {
      /**
       * Handle ON_RUN_STEP_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (data?.delta.type === StepTypes.TOOL_CALLS) {
          await emitForJob({ event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitForJob({ event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitForJob({ event, data });
        }
      },
    },
    [GraphEvents.ON_RUN_STEP_COMPLETED]: {
      /**
       * Handle ON_RUN_STEP_COMPLETED event.
       * @param {string} event - The event name.
       * @param {StreamEventData & { result: ToolEndData }} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        const toolCallId = data?.result?.tool_call?.id;
        const validationError =
          typeof toolCallId === 'string' ? toolInputValidationErrors?.get(toolCallId) : null;
        const validationDetails = getToolInputValidationDetails(data?.result, validationError);
        if (typeof toolCallId === 'string') {
          toolInputValidationErrors?.delete(toolCallId);
        }
        if (validationDetails != null) {
          if (data?.result?.tool_call != null) {
            data.result.tool_call.inputValidationError = true;
          }
          logger.debug('[AgentToolValidation] Tool input rejected', {
            ...validationDetails,
            runId: metadata?.run_id,
            conversationId: metadata?.thread_id,
            agentId: metadata?.agent_id,
          });
        }
        aggregateContent({ event, data });
        const stepId = data?.result?.id;
        const runStep = stepMap?.get(stepId);
        const toolCall = contentParts?.[runStep?.index]?.tool_call;
        if (toolCall != null) {
          if (typeof stepId === 'string') {
            toolCall.stepId = stepId;
          }
          if (validationDetails != null) {
            toolCall.inputValidationError = true;
          }
        }
        if (data?.result != null) {
          await emitForJob({ event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitForJob({ event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitForJob({ event, data });
        }
      },
    },
    [GraphEvents.ON_MESSAGE_DELTA]: {
      /**
       * Handle ON_MESSAGE_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitForJob({ event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitForJob({ event, data });
        }
      },
    },
    [GraphEvents.ON_REASONING_DELTA]: {
      /**
       * Handle ON_REASONING_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitForJob({ event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitForJob({ event, data });
        }
      },
    },
  };

  if (toolExecuteOptions) {
    handlers[GraphEvents.ON_TOOL_EXECUTE] = createToolExecuteHandler(toolExecuteOptions);
  }

  handlers[GraphEvents.ON_SUBAGENT_UPDATE] = {
    /**
     * Forwards subagent progress envelopes to the client stream, and
     * (when a caller-owned aggregator map is provided) also folds each
     * event into a per-tool-call `createContentAggregator`. The
     * resulting `contentParts` are attached to the parent's `subagent`
     * tool_call at message-save time so the child's reasoning / tool
     * calls / final text survive a page refresh — in-memory Recoil
     * atoms alone wouldn't persist that.
     *
     * Aggregation runs regardless of stream visibility (persistence +
     * dialog depend on it), but the SSE forward respects
     * `hide_sequential_outputs` the same way `ON_RUN_STEP`,
     * `ON_MESSAGE_DELTA`, etc. do — so intermediate agents in a
     * sequential chain don't leak their subagent activity when the
     * chain is configured to suppress intermediates.
     */
    handle: async (event, data, metadata) => {
      const isLastAgent = checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node);
      const visible = isLastAgent || !metadata?.hide_sequential_outputs;
      /**
       * Gate BOTH aggregation (persistence) AND streaming on the same
       * visibility rule. If we aggregated for a hidden intermediate
       * agent, `finalizeSubagentContent` would still attach its
       * child's reasoning / tool output to the saved message — so a
       * page refresh would reveal activity that was intentionally
       * suppressed live. Treat hide_sequential_outputs as a
       * consistent "don't record" rule for subagent traces.
       */
      if (!visible) return;
      const memberAgentId =
        typeof data?.memberAgentId === 'string' && data.memberAgentId.trim() !== ''
          ? data.memberAgentId
          : data?.subagentAgentId;
      for (const toolCall of data?.data?.stepDetails?.tool_calls ?? []) {
        const toolName = toolCall?.name ?? toolCall?.function?.name;
        if (toolCall?.name == null && typeof toolName === 'string') {
          toolCall.name = toolName;
        }
        const serverName = resolveMcpServerName?.(toolName, memberAgentId);
        if (serverName) {
          toolCall.mcpServerName = serverName;
        }
      }
      if (subagentAggregatorsByToolCallId && data?.parentToolCallId) {
        const key = data.parentToolCallId;
        let aggregator = subagentAggregatorsByToolCallId.get(key);
        if (!aggregator) {
          aggregator = createContentAggregator();
          subagentAggregatorsByToolCallId.set(key, aggregator);
        }
        try {
          captureSubagentIdentity(aggregator, data);
          feedSubagentAggregator(aggregator, data);
        } catch (err) {
          logger.warn(
            `[ON_SUBAGENT_UPDATE] Failed to aggregate phase "${data?.phase}" for tool_call ${key}: ${err?.message ?? err}`,
          );
        }
      }
      await emitForJob({ event, data });
    },
  };

  if (summarizationOptions?.enabled !== false) {
    handlers[GraphEvents.ON_SUMMARIZE_START] = {
      handle: async (_event, data) => {
        await emitForJob({
          event: GraphEvents.ON_SUMMARIZE_START,
          data,
        });
      },
    };
    handlers[GraphEvents.ON_SUMMARIZE_DELTA] = {
      handle: async (_event, data) => {
        aggregateContent({ event: GraphEvents.ON_SUMMARIZE_DELTA, data });
        await emitForJob({
          event: GraphEvents.ON_SUMMARIZE_DELTA,
          data,
        });
      },
    };
    handlers[GraphEvents.ON_SUMMARIZE_COMPLETE] = {
      handle: async (_event, data) => {
        aggregateContent({ event: GraphEvents.ON_SUMMARIZE_COMPLETE, data });
        /**
         * Stamped onto the aggregated part for the same reason as
         * `runStepStatus` above: an errored round keeps whatever deltas it
         * already streamed, and the SDK's aggregator ignores a complete event
         * that carries no `summary`, so nothing records the failure. Without
         * this the flag exists only on the live client message and a reload
         * re-renders the truncated text under "Conversation summarized".
         * Resolved through `stepMap` only, so a missing step degrades to the
         * old behavior rather than marking an unrelated part.
         */
        if (data?.error && contentParts) {
          const index = stepMap?.get(data?.id)?.index;
          const part = typeof index === 'number' ? contentParts[index] : undefined;
          if (part?.type === ContentTypes.SUMMARY) {
            part.failed = true;
          }
        }
        await emitForJob({
          event: GraphEvents.ON_SUMMARIZE_COMPLETE,
          data,
        });
      },
    };
  }

  handlers[GraphEvents.ON_AGENT_LOG] = { handle: agentLogHandler };

  /** Guarded: no-op when the installed @librechat/agents predates the event */
  if (GraphEvents.ON_CONTEXT_USAGE) {
    handlers[GraphEvents.ON_CONTEXT_USAGE] = {
      /**
       * Forward per-model-call context usage snapshots to the client,
       * honoring the same sequential-agent visibility gate as deltas.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        const visible =
          checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node) ||
          !metadata?.hide_sequential_outputs;
        /** Capture the latest visible snapshot (last-wins) and how many usage
         *  events preceded it BEFORE awaiting the emit. `emitEvent` can yield
         *  (resumable SSE / Redis publish); with parallel runs active this
         *  call's own primary usage could land in `usageEmitSink` during that
         *  yield, pushing `latestUsageIndex` past the very event that proves the
         *  snapshot completed — the save path would then slice it away and drop
         *  a valid breakdown. The recorded index lets the save path persist only
         *  when a PRIMARY usage follows this snapshot (the snapshot's call
         *  actually invoked the model); a summarization detour emits a snapshot
         *  whose only following usage is tagged `summarization`, which a plain
         *  snapshot-count would over-count and wrongly drop. */
        if (visible && contextUsageSink) {
          contextUsageSink.latest = data;
          contextUsageSink.count = (contextUsageSink.count ?? 0) + 1;
          contextUsageSink.latestUsageIndex = usageEmitSink?.length ?? 0;
          /** Which tool calls this snapshot already accounts for. A turn that
           *  stops at the tool-call limit counts the results of the calls missing
           *  from this set — the ones its own call produced, which no later
           *  snapshot describes. Ids, not a content index: completion reshapes the
           *  array (skill cards unshifted, hidden sequential output filtered), so
           *  an index recorded here would mean something else by save time. */
          contextUsageSink.latestToolCallIds = collectToolCallIds(contentParts);
        }
        /** Every agent's snapshot publishes the run's context meta, hidden
         *  sequential agents included: their model calls latch tiers too, and a
         *  Stop before the next visible snapshot must find them on the job. Awaited
         *  so the write lands before the model call it describes begins. */
        await contextUsageSink?.onSnapshot?.();
        if (visible) {
          await emitForJob({ event, data });
        }
      },
    };
  }

  return handlers;
}

/**
 * Helper to write attachment events either to res or to job emitter.
 * Note: Attachments are not order-sensitive like deltas, so fire-and-forget is acceptable.
 * @param {ServerResponse} res - The server response object
 * @param {string | null} streamId - The stream ID for resumable mode, or null for standard mode
 * @param {Object} attachment - The attachment data
 * @param {number} [expectedCreatedAt] - The generation epoch that produced the attachment
 */
function writeAttachment(res, streamId, attachment, expectedCreatedAt) {
  if (streamId) {
    GenerationJobManager.emitChunk(
      streamId,
      { event: 'attachment', data: attachment },
      { expectedCreatedAt },
    );
  } else {
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
}

/**
 * Predicate: is it safe to push an SSE write to the caller right now?
 *
 * In `streamId` (resumable) mode, writes go to the job emitter and the
 * `res` state is irrelevant — always writable.
 *
 * In standard mode, the caller's `res` must have headers sent (the
 * stream has been opened) and not yet be `writableEnded` (the response
 * hasn't closed). Writing to a closed stream raises
 * `ERR_STREAM_WRITE_AFTER_END`.
 *
 * Used by deferred preview emits in both `createToolEndCallback`
 * (chat-completions) and `createResponsesToolEndCallback` (Open
 * Responses) so the gate logic stays in one place. (Comprehensive
 * review #3 on PR #12957.)
 */
function isStreamWritable(res, streamId) {
  if (streamId) {
    return true;
  }
  return !!res && res.headersSent && !res.writableEnded;
}

/**
 * Emit an update for an attachment that was previously sent with
 * `status: 'pending'`. Fire-and-forget: if the response stream has
 * already closed (the agent finished generating before the deferred
 * preview resolved) the frontend's React Query polling on
 * `/api/files/:file_id/preview` picks up the resolved record on its
 * next tick. Skipping the write in that case avoids
 * `ERR_STREAM_WRITE_AFTER_END`.
 *
 * Reuses the `attachment` SSE event name with a discriminated payload:
 * the frontend's `useAttachmentHandler` upserts by `file_id`, so a
 * second event with the same id and `status: 'ready' | 'failed'`
 * overwrites the pending placeholder in place. No new event type, no
 * new client listener.
 *
 * @param {ServerResponse} res
 * @param {string | null} streamId
 * @param {Object} attachment - Updated attachment payload (must carry `file_id`).
 * @param {number} [expectedCreatedAt] - The generation epoch that produced the attachment
 */
function writeAttachmentUpdate(res, streamId, attachment, expectedCreatedAt) {
  if (!isStreamWritable(res, streamId)) {
    return;
  }
  writeAttachment(res, streamId, attachment, expectedCreatedAt);
}

/**
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} params.res
 * @param {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} params.artifactPromises
 * @param {string | null} [params.streamId] - The stream ID for resumable mode, or null for standard mode.
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted attachments.
 * @returns {ToolEndCallback} The tool end callback.
 */
function createToolEndCallback({ req, res, artifactPromises, streamId = null, jobCreatedAt }) {
  /**
   * @type {ToolEndCallback}
   */
  return async (data, metadata) => {
    const output = data?.output;
    if (!output) {
      return;
    }

    if (!output.artifact) {
      return;
    }

    if (output.artifact[Tools.file_search]) {
      artifactPromises.push(
        (async () => {
          const user = req.user;
          const attachment = await processFileCitations({
            user,
            metadata,
            appConfig: req.config,
            toolArtifact: output.artifact,
            toolCallId: output.tool_call_id,
          });
          if (!attachment) {
            return null;
          }
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment, jobCreatedAt);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing file citations:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.ui_resources]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.ui_resources,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.ui_resources]: output.artifact[Tools.ui_resources].data,
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment, jobCreatedAt);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.web_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.web_search,
            ...getAttachmentOwnership(metadata),
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.web_search]: { ...output.artifact[Tools.web_search] },
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment, jobCreatedAt);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.memory]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.memory,
            ...getAttachmentOwnership(metadata),
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.memory]: output.artifact[Tools.memory],
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment, jobCreatedAt);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing memory artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact.content) {
      /** @type {FormattedContent[]} */
      const content = output.artifact.content;
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part) {
          continue;
        }
        if (part.type !== 'image_url') {
          continue;
        }
        const { url } = part.image_url;
        artifactPromises.push(
          (async () => {
            const filename = `${output.name}_img_${nanoid()}`;
            const file_id = output.artifact.file_ids?.[i];
            const file = await saveBase64Image(url, {
              req,
              file_id,
              filename,
              endpoint: metadata.provider,
              context: FileContext.image_generation,
            });
            const fileMetadata = Object.assign(file, {
              messageId: metadata.run_id,
              toolCallId: output.tool_call_id,
              conversationId: metadata.thread_id,
            });
            if (!streamId && !res.headersSent) {
              return fileMetadata;
            }

            if (!fileMetadata) {
              return null;
            }

            writeAttachment(res, streamId, fileMetadata, jobCreatedAt);
            return fileMetadata;
          })().catch((error) => {
            logger.error('Error processing artifact content:', error);
            return null;
          }),
        );
      }
      return;
    }

    if (!isCodeArtifactToolOutput(output)) {
      return;
    }

    if (!output.artifact.files) {
      return;
    }

    const toolCallId = output.tool_call_id;
    await enqueueCodeOutputBatch({
      req,
      artifact: output.artifact,
      artifactPromises,
      codeExecutionContext: metadata.codeExecutionContext,
      processEntry: async ({ file, sessionId, preparedBuffer, downloadFallback }) => {
        const result = await processCodeOutput({
          req,
          id: file.id,
          name: file.name,
          messageId: metadata.run_id,
          toolCallId,
          conversationId: metadata.thread_id,
          session_id: sessionId,
          codeApiBaseUrl: metadata.codeExecutionContext?.baseUrl,
          executionProfile: metadata.codeExecutionContext?.executionProfile,
          executionRouteKey: metadata.codeExecutionContext?.executionRouteKey,
          bridgeWorkerId: metadata.codeExecutionContext?.bridgeWorkerId,
          preparedBuffer,
          downloadFallback,
        });
        const fileMetadata = addStatefulWorkspaceChange(
          result?.file ?? null,
          output.artifact,
          metadata.codeExecutionContext?.executionProfile,
        );
        const finalize = result?.finalize;
        if (!fileMetadata) {
          return null;
        }
        /* Initial emit: ship the attachment to the client immediately
         * (carries `status: 'pending'` for office buckets so the UI
         * shows "preparing preview…"). The agent's response stops
         * blocking on extraction here.
         *
         * Use the shared `isStreamWritable` predicate rather than the
         * narrower `streamId || res.headersSent` check that lived
         * here before — a client disconnect mid-stream
         * (`res.writableEnded`) would otherwise hit `res.write` and
         * raise `ERR_STREAM_WRITE_AFTER_END` (caught by the outer
         * IIFE catch but logged as noise). Same gate the Responses
         * path uses below. */
        if (isStreamWritable(res, streamId)) {
          writeAttachment(res, streamId, fileMetadata, jobCreatedAt);
        }
        /* Deferred preview rendering: extraction continues running
         * even after the HTTP response closes. If the stream is still
         * open when the preview resolves, push an `attachment`
         * update event so the UI patches in place; otherwise React
         * Query polling on `/api/files/:file_id/preview` picks it up.
         *
         * Spread the full updated record (mirroring the initial emit
         * shape) and overlay `messageId`/`toolCallId` from the
         * current run. The DB record preserves the original
         * `messageId` across cross-turn filename reuse so
         * `getCodeGeneratedFiles` can trace the file back to its
         * original assistant message; routing the update SSE by the
         * persisted id would land the patch on a stale message
         * slot — turn-N's pending placeholder would stay stuck while
         * turn-1's already-resolved attachment got re-merged.
         * (Codex P1 review on PR #12957.) */
        runPreviewFinalize({
          finalize,
          fileId: fileMetadata.file_id,
          previewRevision: result?.previewRevision,
          onResolved: (updated) => {
            writeAttachmentUpdate(
              res,
              streamId,
              {
                ...updated,
                messageId: metadata.run_id,
                toolCallId,
                ...(fileMetadata.workspaceChange
                  ? { workspaceChange: fileMetadata.workspaceChange }
                  : {}),
              },
              jobCreatedAt,
            );
          },
        });
        return fileMetadata;
      },
    });
  };
}

/**
 * Emitter for `attachment` SSE events on the current request's live stream,
 * for re-emitting background-harvested attachments on a poll turn. Safe to
 * call after the stream closes (silently dropped).
 *
 * @param {Object} params
 * @param {ServerResponse} params.res
 * @param {string | null} [params.streamId]
 * @param {number} [params.jobCreatedAt]
 * @returns {(attachment: Object) => void}
 */
function createAttachmentEmitter({ res, streamId = null, jobCreatedAt }) {
  return (attachment) => {
    if (!attachment || !isStreamWritable(res, streamId)) {
      return;
    }
    writeAttachment(res, streamId, attachment, jobCreatedAt);
  };
}

/**
 * Streams `on_ptc_tool_call` lifecycle events for the tool calls a
 * programmatic tool-calling program makes from inside the sandbox. Those
 * inner calls open no run step of their own, so without this the card shows
 * a running spinner for the whole program with no sign of what it is doing.
 *
 * Fire-and-forget like the attachment emitter: a closed stream drops the
 * event rather than failing the tool call that produced it.
 *
 * @param {Object} params
 * @param {ServerResponse} params.res
 * @param {string | null} [params.streamId]
 * @param {number} [params.jobCreatedAt]
 * @returns {(event: import('librechat-data-provider').PtcToolCallEvent) => void}
 */
function createPtcProgressEmitter({ res, streamId = null, jobCreatedAt }) {
  return (event) => {
    if (!event || !isStreamWritable(res, streamId)) {
      return;
    }
    const payload = { event: StepEvents.ON_PTC_TOOL_CALL, data: event };
    if (streamId) {
      /* Absorb a rejected transport here. The emitter is called from a
       * synchronous try/catch inside `instrumentPtcToolMap`, which cannot
       * observe a rejected promise — without this catch a failed emit would
       * surface as an unhandled rejection on every affected inner call
       * instead of being dropped as the telemetry it is. */
      Promise.resolve(
        GenerationJobManager.emitChunk(streamId, payload, { expectedCreatedAt: jobCreatedAt }),
      ).catch(() => {
        /* dropped: the trace is best-effort */
      });
      return;
    }
    sendEvent(res, payload);
  };
}

/**
 * Leading sub-second retries cover the common case of a fast background task
 * settling moments before the dispatch turn finalizes its message row — an
 * immediate follow-up turn should find the attachments already anchored.
 * The long tail covers dispatch turns that keep running for minutes.
 */
/**
 * Thin wrapper binding the host file services into the TS harvest
 * implementation (`@librechat/api` `createBackgroundCodeResultHandler`).
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {(params: {
 *   userId: string;
 *   messageId: string;
 *   conversationId: string;
 *   toolCallId: string;
 *   output?: string;
 *   attachments?: Object[];
 * }) => Promise<boolean>} params.updateToolCallResult
 * @param {number} [params.jobCreatedAt] - Immutable dispatch generation epoch.
 * @param {string} [params.streamId] - The stream owning that epoch.
 */
function createBackgroundCodeResultHandler({ req, updateToolCallResult, jobCreatedAt, streamId }) {
  return createCodeHarvestHandler({
    req,
    updateToolCallResult,
    preflightCodeOutputBatch,
    processCodeOutput,
    runPreviewFinalize,
    generationCreatedAt: jobCreatedAt,
    generationStreamId: streamId,
    waitForGenerationSettled: (conversationId, options) =>
      waitForGenerationSettled(GenerationJobManager, conversationId, options),
  });
}

/**
 * Helper to write attachment events in Open Responses format (librechat:attachment)
 * @param {ServerResponse} res - The server response object
 * @param {Object} tracker - The response tracker with sequence number
 * @param {Object} attachment - The attachment data
 * @param {Object} metadata - Additional metadata (messageId, conversationId)
 */
function writeResponsesAttachment(res, tracker, attachment, metadata) {
  const sequenceNumber = tracker.nextSequence();
  writeAttachmentEvent(res, sequenceNumber, attachment, {
    messageId: metadata.run_id,
    conversationId: metadata.thread_id,
  });
}

/**
 * Creates a tool end callback specifically for the Responses API.
 * Emits attachments as `librechat:attachment` events per the Open Responses extension spec.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} params.res
 * @param {Object} params.tracker - Response tracker with sequence number
 * @param {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} params.artifactPromises
 * @returns {ToolEndCallback} The tool end callback.
 */
function createResponsesToolEndCallback({ req, res, tracker, artifactPromises }) {
  /**
   * @type {ToolEndCallback}
   */
  return async (data, metadata) => {
    const output = data?.output;
    if (!output) {
      return;
    }

    if (!output.artifact) {
      return;
    }

    if (output.artifact[Tools.file_search]) {
      artifactPromises.push(
        (async () => {
          const user = req.user;
          const attachment = await processFileCitations({
            user,
            metadata,
            appConfig: req.config,
            toolArtifact: output.artifact,
            toolCallId: output.tool_call_id,
          });
          if (!attachment) {
            return null;
          }
          // For Responses API, emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing file citations:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.ui_resources]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.ui_resources,
            toolCallId: output.tool_call_id,
            [Tools.ui_resources]: output.artifact[Tools.ui_resources].data,
          };
          // For Responses API, always emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.web_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.web_search,
            toolCallId: output.tool_call_id,
            ...getAttachmentOwnership(metadata),
            [Tools.web_search]: { ...output.artifact[Tools.web_search] },
          };
          // For Responses API, always emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.memory]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.memory,
            toolCallId: output.tool_call_id,
            ...getAttachmentOwnership(metadata),
            [Tools.memory]: output.artifact[Tools.memory],
          };
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing memory artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact.content) {
      /** @type {FormattedContent[]} */
      const content = output.artifact.content;
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part) {
          continue;
        }
        if (part.type !== 'image_url') {
          continue;
        }
        const { url } = part.image_url;
        artifactPromises.push(
          (async () => {
            const filename = `${output.name}_img_${nanoid()}`;
            const file_id = output.artifact.file_ids?.[i];
            const file = await saveBase64Image(url, {
              req,
              file_id,
              filename,
              endpoint: metadata.provider,
              context: FileContext.image_generation,
            });
            const fileMetadata = Object.assign(file, {
              toolCallId: output.tool_call_id,
            });

            if (!fileMetadata) {
              return null;
            }

            // For Responses API, emit attachment during streaming
            if (res.headersSent && !res.writableEnded) {
              const attachment = {
                file_id: fileMetadata.file_id,
                filename: fileMetadata.filename,
                type: fileMetadata.type,
                url: fileMetadata.filepath,
                width: fileMetadata.width,
                height: fileMetadata.height,
                tool_call_id: output.tool_call_id,
              };
              writeResponsesAttachment(res, tracker, attachment, metadata);
            }

            return fileMetadata;
          })().catch((error) => {
            logger.error('Error processing artifact content:', error);
            return null;
          }),
        );
      }
      return;
    }

    if (!isCodeArtifactToolOutput(output)) {
      return;
    }

    if (!output.artifact.files) {
      return;
    }

    const toolCallId = output.tool_call_id;
    await enqueueCodeOutputBatch({
      req,
      artifact: output.artifact,
      artifactPromises,
      codeExecutionContext: metadata.codeExecutionContext,
      processEntry: async ({ file, sessionId, preparedBuffer, downloadFallback }) => {
        const result = await processCodeOutput({
          req,
          id: file.id,
          name: file.name,
          messageId: metadata.run_id,
          toolCallId,
          conversationId: metadata.thread_id,
          session_id: sessionId,
          codeApiBaseUrl: metadata.codeExecutionContext?.baseUrl,
          executionProfile: metadata.codeExecutionContext?.executionProfile,
          executionRouteKey: metadata.codeExecutionContext?.executionRouteKey,
          bridgeWorkerId: metadata.codeExecutionContext?.bridgeWorkerId,
          preparedBuffer,
          downloadFallback,
        });
        const fileMetadata = addStatefulWorkspaceChange(
          result?.file ?? null,
          output.artifact,
          metadata.codeExecutionContext?.executionProfile,
        );
        const finalize = result?.finalize;
        if (!fileMetadata) {
          return null;
        }

        /* Initial emit (Open Responses extension format). The agent's
         * response no longer blocks on extraction. */
        if (isStreamWritable(res, null)) {
          writeResponsesAttachment(
            res,
            tracker,
            buildResponsesAttachment(fileMetadata, toolCallId),
            metadata,
          );
        }

        /* Deferred preview rendering: extract HTML in the background
         * and emit a follow-up `librechat:attachment` with the same
         * `file_id` so the client merges the resolved record over the
         * pending placeholder. Fire-and-forget — survives response
         * close; polling covers the post-close gap. */
        runPreviewFinalize({
          finalize,
          fileId: fileMetadata.file_id,
          previewRevision: result?.previewRevision,
          onResolved: (updated) => {
            if (!isStreamWritable(res, null)) {
              return;
            }
            writeResponsesAttachment(
              res,
              tracker,
              buildResponsesAttachment(
                fileMetadata.workspaceChange
                  ? { ...updated, workspaceChange: fileMetadata.workspaceChange }
                  : updated,
                toolCallId,
              ),
              metadata,
            );
          },
        });

        return fileMetadata;
      },
    });
  };
}

/**
 * Project a file metadata record into the Open Responses attachment
 * shape. Mirrors the legacy inline projection but adds `status` and
 * `previewError` so deferred preview updates carry the lifecycle
 * signal the client uses to upsert by `file_id`.
 */
function buildResponsesAttachment(fileMetadata, toolCallId) {
  return {
    file_id: fileMetadata.file_id,
    filename: fileMetadata.filename,
    type: fileMetadata.type,
    url: fileMetadata.filepath,
    width: fileMetadata.width,
    height: fileMetadata.height,
    tool_call_id: toolCallId,
    text: fileMetadata.text ?? null,
    textFormat: fileMetadata.textFormat ?? null,
    status: fileMetadata.status,
    previewError: fileMetadata.previewError,
    workspaceChange: fileMetadata.workspaceChange,
  };
}

const ALLOWED_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function agentLogHandler(_event, data) {
  if (!data) {
    return;
  }
  const logFn = ALLOWED_LOG_LEVELS.has(data.level) ? logger[data.level] : logger.debug;
  const meta = typeof data.data === 'object' && data.data != null ? data.data : {};
  logFn(`[agents:${data.scope ?? 'unknown'}] ${data.message ?? ''}`, {
    ...meta,
    runId: data.runId,
    agentId: data.agentId,
  });
}

function markSummarizationUsage(usage, metadata) {
  const node = metadata?.langgraph_node;
  if (typeof node === 'string' && node.startsWith(GraphNodeKeys.SUMMARIZE)) {
    return { ...usage, usage_type: 'summarization' };
  }
  return usage;
}

/**
 * Stamps provider/model/agent identity onto one model call before billing or
 * API response aggregation. The graph owns this context; provider payloads do
 * not consistently include it, and cache normalization depends on it.
 */
function contextualizeModelUsage(usage, metadata, agentContext = {}) {
  const taggedUsage = { ...usage };
  const context = agentContext ?? {};
  const invokedProvider = metadata?.__invoked_provider;
  const invokedModel = metadata?.__invoked_model;
  const modelName =
    metadata?.ls_model_name ||
    (typeof invokedModel === 'string' && invokedModel !== '' ? invokedModel : undefined) ||
    context.clientOptions?.model;
  const provider =
    (typeof invokedProvider === 'string' && invokedProvider !== '' ? invokedProvider : undefined) ||
    context.provider;
  if (modelName) {
    taggedUsage.model = modelName;
  }
  if (provider) {
    taggedUsage.provider = provider;
  }
  if (context.agentId) {
    taggedUsage.agentId = context.agentId;
  }
  return markSummarizationUsage(taggedUsage, metadata);
}

const agentLogHandlerObj = { handle: agentLogHandler };

/**
 * Builds the three summarization SSE event handlers.
 * In streaming mode, each event is forwarded to the client via `res.write`.
 * In non-streaming mode, the handlers are no-ops.
 * @param {{ isStreaming: boolean, res: import('express').Response }} opts
 */
function buildSummarizationHandlers({ isStreaming, res }) {
  if (!isStreaming) {
    const noop = { handle: () => {} };
    return { on_summarize_start: noop, on_summarize_delta: noop, on_summarize_complete: noop };
  }
  const writeEvent = (name) => ({
    handle: async (_event, data) => {
      if (!res.writableEnded) {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
  });
  return {
    on_summarize_start: writeEvent('on_summarize_start'),
    on_summarize_delta: writeEvent('on_summarize_delta'),
    on_summarize_complete: writeEvent('on_summarize_complete'),
  };
}

module.exports = {
  ModelEndHandler,
  agentLogHandler,
  agentLogHandlerObj,
  getDefaultHandlers,
  createToolEndCallback,
  createAttachmentEmitter,
  createPtcProgressEmitter,
  createBackgroundCodeResultHandler,
  isStreamWritable,
  markSummarizationUsage,
  contextualizeModelUsage,
  buildSummarizationHandlers,
  createResponsesToolEndCallback,
};
