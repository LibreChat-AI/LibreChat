import { memo } from 'react';
import { Part as ChatPart } from '@librechat/chat/components';
import {
  Tools,
  Constants,
  ContentTypes,
  ToolCallTypes,
  imageGenTools,
  isImageVisionTool,
  hasToolCallPreview,
  getToolCallPreviewRevision,
} from 'librechat-data-provider';
import type {
  ToolRenderer,
  AgentToolCall,
  PartRenderers,
  ToolRenderProps,
} from '@librechat/chat/components';
import type { TMessageContentParts, TAttachment, PartMetadata } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  ImageGen,
  ExecuteCode,
  AgentUpdate,
  EmptyText,
  Reasoning,
  ReasoningMarker,
  Summary,
  Text,
  SkillCall,
  MemoryCall,
  ReadFileCall,
  FileAuthoringCall,
  BashCall,
  SubagentCall,
  SteerPart,
} from './Parts';
import {
  getCachedPreview,
  getActivityLabelPart,
  getActivityLabelText,
  getPartKeyIndex,
} from '~/utils';
import BackgroundTaskCall from './Parts/BackgroundTaskCall';
import { getAskUserQuestionPart } from '~/utils/approval';
import AskUserQuestionCall from './AskUserQuestionCall';
import { isBashProgrammaticToolCall } from './routing';
import { isError } from './ToolOutput/OutputRenderer';
import { ToolPreparation } from './preparation';
import { ErrorMessage } from './MessageContent';
import AskUserQuestion from './AskUserQuestion';
import RetrievalCall from './RetrievalCall';
import ToolApproval from './ToolApproval';
import AgentHandoff from './AgentHandoff';
import CodeAnalyze from './CodeAnalyze';
import Container from './Container';
import WebSearch from './WebSearch';
import ToolCall from './ToolCall';
import Image from './Image';

const isFailedImageCall = (
  output: string | null | undefined,
  runStepStatus: PartMetadata['runStepStatus'],
): boolean =>
  runStepStatus !== 'cancelled' &&
  (runStepStatus === 'failed' || (typeof output === 'string' && isError(output)));

const renderExecuteCode: ToolRenderer = ({
  toolCall,
  toolCallId,
  attachments,
  isSubmitting,
  hideAttachments,
  onToolExpand,
}) => (
  <ExecuteCode
    attachments={attachments}
    isSubmitting={isSubmitting}
    runStepStatus={toolCall.runStepStatus}
    runStepDurationMs={toolCall.runStepDurationMs}
    backgrounded={toolCall.backgrounded}
    backgroundCancelled={toolCall.backgroundTask?.cancelled === true}
    output={toolCall.output ?? ''}
    initialProgress={toolCall.progress ?? 0.1}
    args={toolCall.args}
    hideAttachments={hideAttachments}
    onExpand={onToolExpand}
    toolCallId={toolCallId}
  />
);

const renderImageGen: ToolRenderer = ({
  toolCall,
  attachments,
  isSubmitting,
  isLast,
  hideAttachments,
  onToolExpand,
}) => {
  if (isFailedImageCall(toolCall.output, toolCall.runStepStatus)) {
    return (
      <ToolCall
        name={toolCall.name}
        args={toolCall.args ?? ''}
        output={toolCall.output}
        initialProgress={toolCall.progress ?? 0.1}
        isSubmitting={isSubmitting}
        isLast={isLast}
        runStepStatus={toolCall.runStepStatus}
        attachments={attachments}
        hideAttachments={hideAttachments}
        onExpand={onToolExpand}
      />
    );
  }
  return (
    <ImageGen
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      toolName={toolCall.name}
      args={toolCall.args ?? ''}
      output={toolCall.output ?? ''}
      attachments={attachments}
      hideAttachments={hideAttachments}
    />
  );
};

const renderMemory =
  (toolName: 'set_memory' | 'delete_memory'): ToolRenderer =>
  ({ toolCall, attachments, isSubmitting, hideAttachments, onToolExpand }) => (
    <MemoryCall
      toolName={toolName}
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      runStepDurationMs={toolCall.runStepDurationMs}
      attachments={attachments}
      hideAttachments={hideAttachments}
      onExpand={onToolExpand}
    />
  );

const renderFileAuthoring =
  (toolName: 'create_file' | 'edit_file'): ToolRenderer =>
  ({ toolCall, attachments, isSubmitting, hideAttachments, onToolExpand }) => (
    <FileAuthoringCall
      toolName={toolName}
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      runStepDurationMs={toolCall.runStepDurationMs}
      attachments={attachments}
      hideAttachments={hideAttachments}
      onExpand={onToolExpand}
    />
  );

const renderRetrieval: ToolRenderer = ({ toolCall, attachments, isSubmitting, onToolExpand }) => (
  <RetrievalCall
    initialProgress={toolCall.progress ?? 0.1}
    isSubmitting={isSubmitting}
    runStepStatus={toolCall.runStepStatus}
    runStepDurationMs={toolCall.runStepDurationMs}
    args={toolCall.args}
    output={toolCall.output ?? undefined}
    attachments={attachments}
    onExpand={onToolExpand}
  />
);

const renderBashProgrammatic: ToolRenderer = ({
  toolCall,
  toolCallId,
  attachments,
  isSubmitting,
  hideAttachments,
  onToolExpand,
}) => (
  <BashCall
    args={toolCall.args}
    output={toolCall.output ?? ''}
    initialProgress={toolCall.progress ?? 0.1}
    isSubmitting={isSubmitting}
    runStepStatus={toolCall.runStepStatus}
    runStepDurationMs={toolCall.runStepDurationMs}
    backgrounded={toolCall.backgrounded}
    backgroundCancelled={toolCall.backgroundTask?.cancelled === true}
    attachments={attachments}
    commandField="code"
    hideAttachments={hideAttachments}
    onExpand={onToolExpand}
    toolCallId={toolCallId}
  />
);

const renderHandoff: ToolRenderer = ({ toolCall }) => (
  <AgentHandoff args={toolCall.args ?? ''} name={toolCall.name || ''} />
);

/** Agent tool cards by tool name; any other name draws the generic card. */
const tools: Record<string, ToolRenderer> = {
  [Tools.execute_code]: renderExecuteCode,
  [Constants.PROGRAMMATIC_TOOL_CALLING]: renderExecuteCode,
  [Constants.BASH_PROGRAMMATIC_TOOL_CALLING]: renderExecuteCode,
  image_gen_oai: renderImageGen,
  image_edit_oai: renderImageGen,
  gemini_image_gen: renderImageGen,
  /** Dedicated Q&A record: the generic tool card would label the
   *  interrupt-resolved call "cancelled" and dump raw JSON args. */
  ask_user_question: ({ toolCall, isSubmitting, showCursor, onToolExpand }) => (
    <AskUserQuestionCall
      args={toolCall.args}
      output={typeof toolCall.output === 'string' ? toolCall.output : ''}
      toolCallId={toolCall.id}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      showCursor={showCursor}
      failed={'inputValidationError' in toolCall && toolCall.inputValidationError === true}
      onExpand={onToolExpand}
    />
  ),
  [Constants.CHECK_BACKGROUND_TASK]: ({
    toolCall,
    toolCallId,
    attachments,
    isSubmitting,
    hideAttachments,
    onToolExpand,
  }) => (
    <BackgroundTaskCall
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      runStepDurationMs={toolCall.runStepDurationMs}
      attachments={attachments}
      hideAttachments={hideAttachments}
      onExpand={onToolExpand}
      toolCallId={toolCallId}
    />
  ),
  skill: ({ toolCall, attachments, isSubmitting, hideAttachments, onToolExpand }) => (
    <SkillCall
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      runStepDurationMs={toolCall.runStepDurationMs}
      attachments={attachments}
      hideAttachments={hideAttachments}
      onExpand={onToolExpand}
    />
  ),
  [Constants.SUBAGENT]: ({ part, toolCall, attachments, isSubmitting, hideAttachments }) => {
    /** `subagent_content` is the aggregated content-parts array the
     *  backend writes onto the tool_call at message-save time so the
     *  child's activity survives a page refresh. Not present on older
     *  runs recorded before the persistence path existed; those fall
     *  back to the Recoil atom (live session) or the raw tool output
     *  inside `SubagentCall`. */
    const persistedContent = (
      toolCall as unknown as {
        subagent_content?: TMessageContentParts[];
      }
    ).subagent_content;
    return (
      <SubagentCall
        toolCallId={toolCall.id ?? ''}
        args={toolCall.args}
        output={toolCall.output ?? ''}
        initialProgress={toolCall.progress ?? 0.1}
        isSubmitting={isSubmitting}
        runStepStatus={toolCall.runStepStatus}
        attachments={attachments}
        persistedContent={persistedContent}
        contentPreview={
          hasToolCallPreview(toolCall)
            ? {
                revision: getToolCallPreviewRevision(toolCall),
                stepId: toolCall.stepId,
                agentId: part.agentId,
              }
            : undefined
        }
        subagentIdentity={toolCall.subagentIdentity}
        hideAttachments={hideAttachments}
      />
    );
  },
  set_memory: renderMemory('set_memory'),
  delete_memory: renderMemory('delete_memory'),
  read_file: ({ toolCall, attachments, isSubmitting, hideAttachments, onToolExpand }) => (
    <ReadFileCall
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      runStepDurationMs={toolCall.runStepDurationMs}
      attachments={attachments}
      hideAttachments={hideAttachments}
      onExpand={onToolExpand}
    />
  ),
  create_file: renderFileAuthoring('create_file'),
  edit_file: renderFileAuthoring('edit_file'),
  [Tools.bash_tool]: ({
    toolCall,
    toolCallId,
    attachments,
    isSubmitting,
    hideAttachments,
    onToolExpand,
  }) => (
    <BashCall
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      runStepDurationMs={toolCall.runStepDurationMs}
      backgrounded={toolCall.backgrounded}
      backgroundCancelled={toolCall.backgroundTask?.cancelled === true}
      executor={toolCall.executor}
      attachments={attachments}
      hideAttachments={hideAttachments}
      onExpand={onToolExpand}
      toolCallId={toolCallId}
    />
  ),
  [Tools.web_search]: ({
    toolCall,
    attachments,
    isSubmitting,
    isLast,
    hideAttachments,
    onToolExpand,
  }) => (
    <WebSearch
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
      attachments={attachments}
      hideAttachments={hideAttachments}
      isLast={isLast}
      onExpand={onToolExpand}
    />
  ),
  file_search: renderRetrieval,
  retrieval: renderRetrieval,
};

const renderDefaultTool: ToolRenderer = ({
  toolCall,
  toolCallId,
  attachments,
  isSubmitting,
  isLast,
  hideAttachments,
  onToolExpand,
}) => (
  <ToolCall
    args={toolCall.args ?? ''}
    name={toolCall.name || ''}
    toolCallId={toolCallId}
    output={toolCall.output ?? ''}
    initialProgress={toolCall.progress ?? 0.1}
    isSubmitting={isSubmitting}
    attachments={attachments}
    auth={toolCall.auth}
    isLast={isLast}
    hideAttachments={hideAttachments}
    onExpand={onToolExpand}
    runStepStatus={
      toolCall.backgroundTask?.cancelled === true ? 'cancelled' : toolCall.runStepStatus
    }
    runStepDurationMs={toolCall.runStepDurationMs}
    toolPreparationStartedAt={toolCall.toolPreparationStartedAt}
    toolDispatchedAt={toolCall.toolDispatchedAt}
    toolPreparationDurationMs={toolCall.toolPreparationDurationMs}
    toolExecutionDurationMs={toolCall.toolExecutionDurationMs}
  />
);

/** Calls a name alone cannot route: programmatic bash by its arguments, handoffs by prefix. */
const matchTool = ({ name, args }: AgentToolCall): ToolRenderer | undefined => {
  if (isBashProgrammaticToolCall(name, args)) {
    return renderBashProgrammatic;
  }
  if (name?.startsWith(Constants.LC_TRANSFER_TO_)) {
    return renderHandoff;
  }
  return undefined;
};

/**
 * Render approval controls for ANY paused agent tool, not just the generic
 * card, so a HITL policy that gates a specialized tool (bash, code, file…)
 * still surfaces approve/reject/edit/respond. Only while the call is unresolved
 * (no output yet).
 */
const wrapTool = (card: ReactNode, { toolCall, isSubmitting }: ToolRenderProps) => {
  const preparedCard = (
    <ToolPreparation call={toolCall} isSubmitting={isSubmitting}>
      {card}
    </ToolPreparation>
  );
  if (toolCall.approval != null && (toolCall.output?.length ?? 0) === 0) {
    return (
      <>
        {preparedCard}
        <ToolApproval
          approval={toolCall.approval}
          toolCallId={toolCall.id ?? ''}
          args={toolCall.args}
        />
      </>
    );
  }
  return preparedCard;
};

/** The Assistants tool call shapes: code interpreter, retrieval, and function calls. */
const renderAssistantsToolCall: PartRenderers['parts'][ContentTypes.TOOL_CALL] = ({
  part,
  attachments,
  isSubmitting,
  isLast,
  showCursor,
  isCreatedByUser,
  hideAttachments,
  onToolExpand,
}) => {
  const toolCall = part[ContentTypes.TOOL_CALL];
  if (toolCall.type === ToolCallTypes.CODE_INTERPRETER) {
    const code_interpreter = toolCall[ToolCallTypes.CODE_INTERPRETER];
    return (
      <CodeAnalyze
        initialProgress={toolCall.progress ?? 0.1}
        code={code_interpreter.input}
        outputs={code_interpreter.outputs ?? []}
        onExpand={onToolExpand}
      />
    );
  } else if (
    toolCall.type === ToolCallTypes.RETRIEVAL ||
    toolCall.type === ToolCallTypes.FILE_SEARCH
  ) {
    return (
      <RetrievalCall
        initialProgress={toolCall.progress ?? 0.1}
        isSubmitting={isSubmitting}
        runStepStatus={toolCall.runStepStatus}
        runStepDurationMs={toolCall.runStepDurationMs}
        output={(toolCall as { output?: string }).output}
        attachments={attachments}
        onExpand={onToolExpand}
      />
    );
  } else if (
    toolCall.type === ToolCallTypes.FUNCTION &&
    ToolCallTypes.FUNCTION in toolCall &&
    imageGenTools.has(toolCall.function.name)
  ) {
    if (isFailedImageCall(toolCall.function.output, toolCall.runStepStatus)) {
      return (
        <ToolCall
          name={toolCall.function.name}
          args={toolCall.function.arguments as string}
          output={toolCall.function.output}
          initialProgress={toolCall.progress ?? 0.1}
          isSubmitting={isSubmitting}
          isLast={isLast}
          runStepStatus={toolCall.runStepStatus}
          attachments={attachments}
          hideAttachments={hideAttachments}
          onExpand={onToolExpand}
        />
      );
    }
    return (
      <ToolPreparation
        call={{
          args: toolCall.function.arguments as string,
          name: toolCall.function.name,
          output: toolCall.function.output,
          progress: toolCall.progress,
          runStepStatus: toolCall.runStepStatus,
          toolPreparationStartedAt: toolCall.toolPreparationStartedAt,
          toolDispatchedAt: toolCall.toolDispatchedAt,
        }}
        isSubmitting={isSubmitting}
      >
        <ImageGen
          initialProgress={toolCall.progress ?? 0.1}
          args={toolCall.function.arguments as string}
          isSubmitting={isSubmitting}
          runStepStatus={toolCall.runStepStatus}
          toolName={toolCall.function.name}
          output={toolCall.function.output ?? ''}
        />
      </ToolPreparation>
    );
  } else if (toolCall.type === ToolCallTypes.FUNCTION && ToolCallTypes.FUNCTION in toolCall) {
    if (isImageVisionTool(toolCall)) {
      if (isSubmitting && showCursor) {
        return (
          <Container>
            <Text text={''} isCreatedByUser={isCreatedByUser} showCursor={showCursor} />
          </Container>
        );
      }
      return null;
    }

    return (
      <ToolCall
        initialProgress={toolCall.progress ?? 0.1}
        isSubmitting={isSubmitting}
        args={toolCall.function.arguments as string}
        name={toolCall.function.name}
        output={toolCall.function.output}
        runStepStatus={toolCall.runStepStatus}
        runStepDurationMs={toolCall.runStepDurationMs}
        toolPreparationStartedAt={toolCall.toolPreparationStartedAt}
        toolDispatchedAt={toolCall.toolDispatchedAt}
        toolPreparationDurationMs={toolCall.toolPreparationDurationMs}
        toolExecutionDurationMs={toolCall.toolExecutionDurationMs}
        isLast={isLast}
        hideAttachments={hideAttachments}
        onExpand={onToolExpand}
      />
    );
  }
  return null;
};

/** The app's part renderers: every visual the package `Part` routes to. */
const renderers: PartRenderers = {
  claim: ({ part }) => {
    const askUserQuestion = getAskUserQuestionPart(part);
    if (!askUserQuestion) {
      return undefined;
    }
    return (
      <AskUserQuestion
        key={askUserQuestion.ask_user_question.actionId}
        actionId={askUserQuestion.ask_user_question.actionId}
        question={askUserQuestion.ask_user_question.question}
        questions={askUserQuestion.ask_user_question.questions}
      />
    );
  },
  parts: {
    [ContentTypes.STEER]: ({ part, isSubmitting }) => (
      <SteerPart
        steer={part[ContentTypes.STEER]}
        files={part.files}
        quotes={part.quotes}
        steerId={part.steerId}
        createdAt={part.createdAt}
        isSubmitting={isSubmitting}
      />
    ),
    [ContentTypes.ERROR]: ({ part }) => (
      <ErrorMessage
        text={
          part[ContentTypes.ERROR] ??
          (typeof part[ContentTypes.TEXT] === 'string'
            ? part[ContentTypes.TEXT]
            : part.text?.value) ??
          ''
        }
        className="my-2"
      />
    ),
    [ContentTypes.AGENT_UPDATE]: ({ part, isLast, showCursor }) => (
      <>
        <AgentUpdate currentAgentId={part[ContentTypes.AGENT_UPDATE]?.agentId} />
        {isLast && showCursor && (
          <Container>
            <EmptyText />
          </Container>
        )}
      </>
    ),
    [ContentTypes.TEXT]: ({ part, isLast, showCursor, isCreatedByUser }) => {
      const text = typeof part.text === 'string' ? part.text : part.text?.value;

      if (typeof text !== 'string') {
        return null;
      }
      if (part.tool_call_ids != null && !text) {
        return null;
      }
      /** Handle whitespace-only text to avoid layout shift */
      if (text.length > 0 && /^\s*$/.test(text)) {
        /** Show placeholder for whitespace-only last part during streaming */
        if (isLast && showCursor) {
          return (
            <Container>
              <EmptyText />
            </Container>
          );
        }
        /** Skip rendering non-last whitespace-only parts to avoid empty Container */
        if (!isLast) {
          return null;
        }
      }
      return (
        <Container>
          <Text text={text} isCreatedByUser={isCreatedByUser} showCursor={showCursor} />
        </Container>
      );
    },
    [ContentTypes.THINK]: ({ part, partIndex, isLast }) => {
      const reasoning = typeof part.think === 'string' ? part.think : part.think?.value;
      if (typeof reasoning !== 'string') {
        return null;
      }
      if (reasoning.trim() === '' && part.reasoning_unavailable === true) {
        return <ReasoningMarker label={part.reasoning_label} />;
      }
      return (
        <Reasoning
          partKeyIndex={getPartKeyIndex(part, partIndex ?? 0)}
          reasoning={reasoning}
          isLast={isLast ?? false}
          reasoningLabel={part.reasoning_label}
        />
      );
    },
    [ContentTypes.SUMMARY]: ({ part }) => (
      <Summary
        content={part.content}
        model={part.model}
        provider={part.provider}
        tokenCount={part.tokenCount}
        initiatedBy={part.initiatedBy}
        summarizing={part.summarizing}
        failed={part.failed}
      />
    ),
    /** Orphan label (its block's parts were filtered/hidden): renders as a
     *  standalone line. Labeled blocks normally render via ToolCallGroup,
     *  which consumes the label part as the group header instead. */
    [ContentTypes.ACTIVITY_LABEL]: ({ part }) => {
      const display = getActivityLabelText(getActivityLabelPart(part));
      if (!display) {
        return null;
      }
      const failed = part.status === 'failed' || part.status === 'partial';
      return (
        <div
          className={`my-1 pl-1 text-sm break-words italic ${failed ? 'text-text-warning' : 'text-text-secondary'}`}
        >
          {display}
        </div>
      );
    },
    [ContentTypes.TOOL_CALL]: renderAssistantsToolCall,
    [ContentTypes.IMAGE_FILE]: ({ part, isCreatedByUser }) => {
      const imageFile = part[ContentTypes.IMAGE_FILE];
      const cached = imageFile.file_id ? getCachedPreview(imageFile.file_id) : undefined;
      return (
        <Image
          imagePath={cached ?? imageFile.filepath}
          altText={imageFile.filename ?? 'Uploaded Image'}
          alignRight={isCreatedByUser}
          width={imageFile.width}
          height={imageFile.height}
        />
      );
    },
  },
  tools,
  matchTool,
  defaultTool: renderDefaultTool,
  wrapTool,
};

type PartProps = {
  part?: TMessageContentParts;
  isLast?: boolean;
  isSubmitting: boolean;
  showCursor: boolean;
  isCreatedByUser: boolean;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onToolExpand?: () => void;
};

/** One content part, drawn with the app's renderers. */
const Part = memo(function Part(props: PartProps) {
  return <ChatPart {...props} renderers={renderers} />;
});
Part.displayName = 'Part';

export default Part;
