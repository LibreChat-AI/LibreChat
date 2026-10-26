import { v4 } from 'uuid';
import { cloneDeep } from 'lodash';
import {
  Constants,
  ContentTypes,
  EModelEndpoint,
  getEndpointField,
  getDefaultParamsEndpoint,
  isAgentsEndpoint,
  parseCompactConvo,
  replaceSpecialVars,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import {
  createDualMessageContent,
  stripStreamedIndexStamps,
  getAppendParentMessageId,
  getRegenerateTargetResponseMessage,
  getRegenerateSubmissionMessages,
  getPreliminaryRegenerateResponseMessageId,
} from '@librechat/chat';
import type {
  TUser,
  TMessage,
  TModelSpec,
  TSubmission,
  TConversation,
  TEphemeralAgent,
  TEndpointOption,
  TEndpointsConfig,
  EndpointSchemaKey,
} from 'librechat-data-provider';
import type { TAskProps, TOptions, ExtendedFile } from '~/common';
import { getRouteChatProjectId, logger } from '~/utils';

/** What `ask` hands the turn builder once it has decided the send may go ahead. */
export type BuildTurnInput = {
  text: string;
  params: TAskProps;
  options: TOptions;
  /** Resolved by the caller: the explicit id, else the conversation's, else `null`. */
  conversationId: string | null;
  index: number;
  conversation: TConversation | null | undefined;
  latestMessage: TMessage | null;
  cachedMessages?: TMessage[];
  files?: Map<string, ExtendedFile>;
  /** Whether the host supplied a composer file setter, so consumed files can be cleared. */
  canClearFiles: boolean;
  endpointsConfig?: TEndpointsConfig;
  modelSpecs?: TModelSpec[];
  user?: TUser;
  isTemporary: boolean;
  ephemeralAgent: TEphemeralAgent | null;
  getSender: (endpointOption: TEndpointOption) => string;
  userKey: string | undefined;
  manualSkills: string[];
  quotes: string[];
  reasoningOverride: TMessage['reasoningOverride'];
  code: {
    approvalMode: TSubmission['codeApprovalMode'];
    latestApprovalMode?: TConversation['codeApprovalMode'];
    environmentMode: TSubmission['codeEnvironmentMode'];
    workspaces: TSubmission['codeWorkspaces'];
  };
};

/** Composer files the turn consumed, for the caller to mark as submitted and clear. */
export type TurnFileEffects = {
  submittedFileIds: (string | undefined)[];
  clearComposer: boolean;
};

export type BuiltTurn = {
  submission: TSubmission;
  currentMsg: TMessage;
  initialResponse: TMessage;
  submissionMessages: TMessage[];
  /** `null` for a new chat: the server assigns the id. */
  conversationId: string | null;
  regenerateShaped: boolean;
  isEditOrContinue: boolean;
  /** Set when the send starts from the new-chat route, which the caller navigates to. */
  newChatPath?: string;
  fileEffects?: TurnFileEffects;
  /** Whether the host should mark the chat as submitting now (Assistants flip it from the stream). */
  startsSubmitting: boolean;
};

const logChatRequest = (request: Record<string, unknown>) => {
  logger.log('=====================================\nAsk function called with:');
  logger.dir({
    conversationId: request.conversationId,
    messageId: request.messageId,
    parentMessageId: request.parentMessageId,
    isEdited: request.isEdited,
    isContinued: request.isContinued,
    isRegenerate: request.isRegenerate,
  });
  logger.log('=====================================');
};

/**
 * Builds the turn `ask` submits: the optimistic user message and response placeholder, the
 * message list to render, and the `TSubmission` the stream starts from. Reads nothing from the
 * app and writes nothing; the caller applies the navigation, composer-file and state effects the
 * result names.
 */
export function buildTurn({
  text,
  params,
  options,
  index,
  conversation,
  latestMessage,
  cachedMessages,
  files,
  canClearFiles,
  endpointsConfig,
  modelSpecs,
  user,
  isTemporary,
  ephemeralAgent,
  getSender,
  userKey,
  manualSkills,
  quotes,
  reasoningOverride,
  code,
  conversationId: resolvedConversationId,
}: BuildTurnInput): BuiltTurn {
  const { overrideConvoId, overrideUserMessageId, messageId = null } = params;
  let parentMessageId = params.parentMessageId ?? null;
  let conversationId = resolvedConversationId;
  const {
    editedContent = null,
    editedMessageId = null,
    isRegenerate = false,
    isContinued = false,
    isEdited = false,
    compact = false,
    overrideMessages,
    overrideFiles,
    targetResponseMessageId,
    addedConvo,
    overrideClientRequestId,
    overrideRecoverySteerId,
    overrideExpectedPredecessorCreatedAt,
    overrideQueuedMessageOrigin,
  } = options;
  const regenerateShaped = isRegenerate || compact;
  const isEditOrContinue = isEdited || isContinued;
  const endpoint = conversation?.endpoint;
  const endpointType = getEndpointField(endpointsConfig, endpoint, 'type');
  const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);
  const { latestApprovalMode: latestCodeApprovalMode } = code;
  const { approvalMode: codeApprovalMode, environmentMode: codeEnvironmentMode } = code;
  const codeWorkspaces = code.workspaces;

  let currentMessages: TMessage[] = overrideMessages ?? cachedMessages ?? [];

  if (conversation?.promptPrefix) {
    conversation.promptPrefix = replaceSpecialVars({
      text: conversation.promptPrefix,
      user,
    });
  }

  const chatProjectId =
    conversationId === Constants.NEW_CONVO
      ? getRouteChatProjectId()
      : (conversation?.chatProjectId ?? null);
  const conversationForPayload =
    chatProjectId != null ? { ...(conversation ?? {}), chatProjectId } : (conversation ?? {});

  // construct the query message
  // this is not a real messageId, it is used as placeholder before real messageId returned
  const intermediateId = overrideUserMessageId ?? v4();
  /** Stable idempotency key for this submission: fresh per `ask()` (so regenerate differs)
   *  but reused across the client's start-generation network retries, letting the server
   *  dedup a retried request instead of starting a second billed generation. */
  const clientRequestId = overrideClientRequestId ?? v4();
  if (parentMessageId == null) {
    parentMessageId = getAppendParentMessageId({ latestMessage, currentMessages });
  }

  logChatRequest({
    index,
    conversation,
    latestMessage,
    conversationId,
    intermediateId,
    parentMessageId,
    currentMessages,
  });

  let newChatPath: string | undefined;
  if (conversationId == Constants.NEW_CONVO) {
    parentMessageId = Constants.NO_PARENT;
    currentMessages = [];
    conversationId = null;
    const projectSearch = chatProjectId ? `?projectId=${encodeURIComponent(chatProjectId)}` : '';
    newChatPath = `/c/new${projectSearch}`;
  }

  const targetParentMessageId = regenerateShaped ? messageId : latestMessage?.parentMessageId;
  /**
   * If the user regenerated or resubmitted the message, the current parent is technically
   * the latest user message, which is passed into `ask`; otherwise, we can rely on the
   * latestMessage to find the parent.
   */
  const targetParentMessage = currentMessages.find(
    (msg) => msg.messageId === targetParentMessageId,
  );
  const targetResponseMessage = isRegenerate
    ? getRegenerateTargetResponseMessage({
        messages: currentMessages,
        parentMessageId: messageId,
        targetResponseMessageId,
        latestMessage,
      })
    : null;

  let thread_id = targetParentMessage?.thread_id ?? latestMessage?.thread_id;
  if (thread_id == null) {
    thread_id = currentMessages.find((message) => message.thread_id)?.thread_id;
  }

  const iconURL = conversation?.iconURL;

  /** This becomes part of the `endpointOption` */
  const convo = parseCompactConvo({
    endpoint: endpoint as EndpointSchemaKey,
    endpointType: endpointType as EndpointSchemaKey,
    conversation: conversationForPayload,
    defaultParamsEndpoint,
  });

  const { modelDisplayLabel } = endpointsConfig?.[endpoint ?? ''] ?? {};
  const endpointOption = Object.assign(
    {
      endpoint,
      endpointType,
      overrideConvoId,
      overrideUserMessageId:
        overrideUserMessageId ??
        (endpoint === EModelEndpoint.agents && !regenerateShaped && !isContinued
          ? `${intermediateId}${Constants.COMMON_DIVIDER}0`
          : undefined),
    },
    convo,
    chatProjectId ? { chatProjectId } : {},
  ) as TEndpointOption;
  if (endpoint !== EModelEndpoint.agents) {
    endpointOption.key = userKey;
    endpointOption.thread_id = thread_id;
    endpointOption.modelDisplayLabel = modelDisplayLabel;
  } else {
    endpointOption.key = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  }
  const responseSender = getSender({ model: conversation?.model, ...endpointOption });

  const currentMsg: TMessage = {
    text,
    sender: 'User',
    clientTimestamp: new Date().toLocaleString('sv').replace(' ', 'T'),
    isCreatedByUser: true,
    parentMessageId,
    conversationId,
    /** A compaction's "user message" is the leaf itself, so an error lands under it. */
    messageId:
      (isContinued || compact) && messageId != null && messageId ? messageId : intermediateId,
    thread_id,
    error: false,
    /**
     * UI-only metadata. Survives reload because the backend persists the
     * field on the message schema, and `SkillPills` reads straight
     * off the message so there's no Recoil state to clean up. Runtime
     * skill resolution reads the top-level `manualSkills` payload field.
     */
    manualSkills: manualSkills.length > 0 ? manualSkills : undefined,
    /**
     * Quoted excerpts the user referenced this turn. Persisted on the
     * message (backend echoes it back on `req.body.quotes`) so `MessageQuotes`
     * renders the references on the user bubble after reload. The backend
     * also merges these into the model-facing user text at request time.
     */
    quotes: quotes.length > 0 ? quotes : undefined,
    reasoningOverride,
  };

  /** The leaf's files already sit in history; a compaction re-attaches nothing. */
  const submissionFiles = compact ? undefined : (overrideFiles ?? targetParentMessage?.files);
  const reuseFiles =
    (isRegenerate || (overrideFiles != null && overrideFiles.length)) &&
    submissionFiles &&
    submissionFiles.length > 0;

  let fileEffects: TurnFileEffects | undefined;
  if (canClearFiles && reuseFiles === true) {
    currentMsg.files = [...submissionFiles];
    /** Queued override files were consumed just like composer files, so mark their identities
     * as submitted before later draft cleanup can classify the restored paste as unsent. */
    const submittedFileIds: (string | undefined)[] = [];
    for (const file of submissionFiles) {
      submittedFileIds.push(file.file_id, file.temp_file_id);
    }
    // Caller-supplied overrideFiles were consumed elsewhere (queued
    // during-run messages take theirs out of the composer at queue time);
    // clearing here would eat attachments staged for the user's NEXT send.
    fileEffects = { submittedFileIds, clearComposer: isRegenerate };
  } else if (!compact && canClearFiles && files && files.size > 0 && overrideFiles == null) {
    /** A compaction attaches nothing and must not consume files the user
     *  staged in the composer for their next message. */
    // `overrideFiles` (even empty) is authoritative for the submission:
    // auto-drained queued messages must never vacuum up attachments the
    // user has staged in the composer for their NEXT message.
    const submittedFileIds: (string | undefined)[] = [];
    currentMsg.files = [];
    for (const [key, file] of files) {
      currentMsg.files.push({
        file_id: file.file_id,
        filepath: file.filepath,
        filename: file.filename,
        type: file.type ?? '',
        llmDeliveryPath: file.llmDeliveryPath,
        height: file.height,
        width: file.width,
      });
      submittedFileIds.push(key, file.file_id, file.temp_file_id);
    }
    fileEffects = { submittedFileIds, clearComposer: true };
  }

  const responseMessageId =
    editedMessageId ??
    (isRegenerate
      ? getPreliminaryRegenerateResponseMessageId(
          targetResponseMessage?.messageId ?? targetResponseMessageId,
        )
      : null) ??
    null;
  /** Set only for edited resubmissions; see `TSubmission.editPrefixLength`. */
  let editPrefixLength: number | undefined;
  const initialResponseId =
    responseMessageId ??
    getPreliminaryRegenerateResponseMessageId(`${regenerateShaped ? messageId : intermediateId}`) ??
    `${v4()}_`;

  const initialResponse: TMessage = {
    sender: responseSender,
    text: '',
    endpoint: endpoint ?? '',
    parentMessageId: regenerateShaped ? messageId : intermediateId,
    messageId: initialResponseId,
    thread_id,
    conversationId,
    unfinished: false,
    isCreatedByUser: false,
    model: convo?.model,
    error: false,
    iconURL,
    clientQueueParentMessageId: regenerateShaped ? (messageId ?? undefined) : intermediateId,
    /**
     * Seed the assistant placeholder with the turn's manually-invoked
     * skill names so `ContentParts` can render interim `SkillCall` cards
     * from the very first render: no round-trip through the `created`
     * SSE event required. Rides along with every subsequent spread
     * (`useStepHandler` response construction, `updateContent` result
     * spreads) and drops out naturally at `finalHandler` when the
     * server-backed `responseMessage` replacement takes over.
     */
    manualSkills: manualSkills.length > 0 ? manualSkills : undefined,
  };

  if (isAssistantsEndpoint(endpoint)) {
    initialResponse.model = conversation?.assistant_id ?? '';
    initialResponse.text = '';
    initialResponse.content = [
      {
        type: ContentTypes.TEXT,
        [ContentTypes.TEXT]: {
          value: '',
        },
      },
    ];
  } else if (endpoint != null) {
    initialResponse.model = isAgentsEndpoint(endpoint)
      ? (conversation?.agent_id ?? '')
      : (conversation?.model ?? '');
    initialResponse.text = '';

    if (editedContent && latestMessage?.content) {
      /** Stamps off: the rerun appends provider parts at the prefix LENGTH,
       *  and a retained `streamedIndex` at or above it would collide with an
       *  appended part's render key (see `stripStreamedIndexStamps`). */
      initialResponse.content = stripStreamedIndexStamps(cloneDeep(latestMessage.content));
      /** Captured now, while it is still the retained prefix: a later resume
       *  sync replaces this array with the server's completion-local
       *  snapshot, after which its length no longer describes the offset. */
      editPrefixLength = initialResponse.content.length;
      const { index, type, ...part } = editedContent;
      if (initialResponse.content && index >= 0 && index < initialResponse.content.length) {
        const contentPart = initialResponse.content[index];
        if (type === ContentTypes.THINK && contentPart.type === ContentTypes.THINK) {
          contentPart[ContentTypes.THINK] = part[ContentTypes.THINK];
          delete contentPart.reasoning_label;
          delete contentPart.reasoning_label_step_id;
          delete contentPart.reasoning_label_attempts;
          delete contentPart.reasoning_label_submitted_chars;
          delete contentPart.reasoning_label_revision;
          delete contentPart.reasoning_label_status;
        } else if (type === ContentTypes.TEXT && contentPart.type === ContentTypes.TEXT) {
          contentPart[ContentTypes.TEXT] = part[ContentTypes.TEXT];
        }
      }
    } else if (addedConvo && conversation) {
      // Pre-populate placeholders for smooth UI - these will be overridden/extended
      // as SSE events arrive with actual content, preserving the agent-based agentId
      initialResponse.content = createDualMessageContent(
        conversation,
        addedConvo,
        endpointsConfig,
        modelSpecs,
      );
    } else {
      initialResponse.content = [];
    }
  }

  if (isContinued) {
    currentMessages = currentMessages.filter((msg) => msg.messageId !== responseMessageId);
  }

  const submissionMessages = regenerateShaped
    ? getRegenerateSubmissionMessages({
        messages: currentMessages,
        targetResponseMessage,
        initialResponseId: initialResponse.messageId,
      })
    : currentMessages;
  const regenerateMessages = regenerateShaped ? [...currentMessages] : undefined;

  logger.log('message_state', initialResponse);
  const submission: TSubmission = {
    conversation: {
      ...conversation,
      ...(chatProjectId ? { chatProjectId } : {}),
      ...(latestCodeApprovalMode != null ? { codeApprovalMode: latestCodeApprovalMode } : {}),
      conversationId,
    },
    endpointOption,
    userMessage: {
      ...currentMsg,
      responseMessageId,
      overrideParentMessageId: isRegenerate ? messageId : null,
    },
    messages: submissionMessages,
    regenerateMessages,
    isEdited: isEditOrContinue,
    isContinued,
    isRegenerate: regenerateShaped,
    ...(compact && { compact: true }),
    initialResponse,
    isTemporary,
    ephemeralAgent,
    editedContent,
    editPrefixLength,
    addedConvo,
    manualSkills: manualSkills.length > 0 ? manualSkills : undefined,
    codeApprovalMode,
    codeEnvironmentMode,
    codeWorkspaces,
    clientRequestId,
    recoverySteerId: overrideRecoverySteerId,
    expectedPredecessorCreatedAt: overrideExpectedPredecessorCreatedAt,
    queuedMessageOrigin: overrideQueuedMessageOrigin,
  };

  return {
    submission,
    currentMsg,
    initialResponse,
    submissionMessages,
    conversationId,
    regenerateShaped,
    isEditOrContinue,
    newChatPath,
    fileEffects,
    startsSubmitting: endpoint != null && !isAssistantsEndpoint(endpoint),
  };
}
