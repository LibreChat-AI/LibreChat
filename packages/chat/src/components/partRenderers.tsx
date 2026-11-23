import {
  Tools,
  Constants,
  ContentTypes,
  ToolCallTypes,
  imageGenTools,
  isOpaqueReasoning,
  isImageVisionTool,
} from 'librechat-data-provider';
import type { PartMetadata } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ToolRenderer, AgentToolCall, PartRenderers, ToolRenderProps } from './partTypes';
import { getActivityLabelPart, getActivityLabelText } from '../core/parts/activityLabels';
import { isBashProgrammaticToolCall } from '../core/parts/routing';
import Reasoning, { ReasoningMarker } from './parts/Reasoning';
import BackgroundTaskCall from './parts/BackgroundTaskCall';
import FileAuthoringCall from './parts/FileAuthoringCall';
import { getCachedPreview } from '../core/previewCache';
import { ToolPreparation } from './parts/preparation';
import AskUserQuestionCall from './parts/ask/Call';
import { getPartKeyIndex } from '../core/content';
import ReadFileCall from './parts/ReadFileCall';
import AgentHandoff from './parts/AgentHandoff';
import { isError } from '../core/parts/output';
import RetrievalCall from './parts/Retrieval';
import ExecuteCode from './parts/ExecuteCode';
import CodeAnalyze from './parts/CodeAnalyze';
import MemoryCall from './parts/MemoryCall';
import SkillCall from './parts/SkillCall';
import SteerPart from './parts/SteerPart';
import Container from './parts/Container';
import ImageGen from './parts/ImageGen';
import ToolCall from './parts/ToolCall';
import BashCall from './parts/BashCall';
import AgentUpdate from './AgentUpdate';
import EmptyText from './EmptyText';
import Image from './parts/Image';
import Summary from './Summary';
import Text from './Text';

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
    stepId={toolCall.stepId}
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
        stepId={toolCall.stepId}
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
    stepId={toolCall.stepId}
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
const buildTools = (): Record<string, ToolRenderer> => ({
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
  set_memory: renderMemory('set_memory'),
  delete_memory: renderMemory('delete_memory'),
  read_file: ({
    toolCall,
    toolCallId,
    attachments,
    isSubmitting,
    hideAttachments,
    onToolExpand,
  }) => (
    <ReadFileCall
      toolCallId={toolCallId}
      stepId={toolCall.stepId}
      args={toolCall.args}
      output={toolCall.output ?? ''}
      initialProgress={toolCall.progress ?? 0.1}
      isSubmitting={isSubmitting}
      runStepStatus={toolCall.runStepStatus}
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
      stepId={toolCall.stepId}
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
  file_search: renderRetrieval,
  retrieval: renderRetrieval,
});

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
    stepId={toolCall.stepId}
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

/** Every agent tool call's card sits in its preparation frame, which shows what the tool is doing
 *  before it has anything to report. */
const wrapTool = (card: ReactNode, { toolCall, isSubmitting }: ToolRenderProps): ReactNode => (
  <ToolPreparation call={toolCall} isSubmitting={isSubmitting}>
    {card}
  </ToolPreparation>
);

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

const build = (): PartRenderers => ({
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
      if (isOpaqueReasoning(reasoning)) {
        return <ReasoningMarker encrypted />;
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
          className={`my-1 ps-1 text-sm break-words italic ${failed ? 'text-text-warning' : 'text-text-secondary'}`}
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
  tools: buildTools(),
  matchTool,
  defaultTool: renderDefaultTool,
  wrapTool,
});

let built: PartRenderers | null = null;

/**
 * How the package draws each kind of part with its own cards. `Part` uses these unless it is
 * given others, and a host extends them with `extendPartRenderers` for what only it can draw:
 * its error card, a tool of its own, approval controls around every tool call.
 *
 * Built on first use and kept. The table is keyed by `librechat-data-provider`'s tool and part
 * names, which a spec that replaces that package leaves undefined while this module loads.
 */
export function partRenderers(): PartRenderers {
  built ??= build();
  return built;
}

/**
 * `base` with a host's own renderers laid over it: `parts` and `tools` are merged entry by
 * entry, and every other member replaces the base's. A `wrapTool` that only adds to the base's
 * calls it: `(card, props) => <>{partRenderers().wrapTool?.(card, props)}<Approval /></>`.
 */
export function extendPartRenderers(
  overrides: Partial<PartRenderers>,
  base: PartRenderers = partRenderers(),
): PartRenderers {
  return {
    ...base,
    ...overrides,
    parts: { ...base.parts, ...overrides.parts },
    tools: { ...base.tools, ...overrides.tools },
  };
}
