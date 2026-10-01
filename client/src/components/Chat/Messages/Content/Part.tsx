import { memo } from 'react';
import {
  Tools,
  Constants,
  ContentTypes,
  ToolCallTypes,
  imageGenTools,
  isImageVisionTool,
} from 'librechat-data-provider';
import type { TMessageContentParts, TAttachment, PartMetadata } from 'librechat-data-provider';
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
import { useMessageContext } from '~/Providers';
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

const Part = memo(function Part({
  part,
  isSubmitting,
  attachments,
  isLast,
  showCursor,
  isCreatedByUser,
  hideAttachments,
  onToolExpand,
}: PartProps) {
  const { partIndex } = useMessageContext();
  if (!part) {
    return null;
  }

  const askUserQuestion = getAskUserQuestionPart(part);
  if (askUserQuestion) {
    return (
      <AskUserQuestion
        key={askUserQuestion.ask_user_question.actionId}
        actionId={askUserQuestion.ask_user_question.actionId}
        question={askUserQuestion.ask_user_question.question}
        questions={askUserQuestion.ask_user_question.questions}
      />
    );
  }

  if (part.type === ContentTypes.STEER) {
    return (
      <SteerPart
        steer={part[ContentTypes.STEER]}
        files={part.files}
        quotes={part.quotes}
        steerId={part.steerId}
        createdAt={part.createdAt}
        isSubmitting={isSubmitting}
      />
    );
  }

  if (part.type === ContentTypes.ERROR) {
    return (
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
    );
  } else if (part.type === ContentTypes.AGENT_UPDATE) {
    return (
      <>
        <AgentUpdate currentAgentId={part[ContentTypes.AGENT_UPDATE]?.agentId} />
        {isLast && showCursor && (
          <Container>
            <EmptyText />
          </Container>
        )}
      </>
    );
  } else if (part.type === ContentTypes.TEXT) {
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
  } else if (part.type === ContentTypes.THINK) {
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
  } else if (part.type === ContentTypes.SUMMARY) {
    return (
      <Summary
        content={part.content}
        model={part.model}
        provider={part.provider}
        tokenCount={part.tokenCount}
        initiatedBy={part.initiatedBy}
        summarizing={part.summarizing}
        failed={part.failed}
      />
    );
  } else if (part.type === ContentTypes.ACTIVITY_LABEL) {
    /** Orphan label (its block's parts were filtered/hidden): renders as a
     *  standalone line. Labeled blocks normally render via ToolCallGroup,
     *  which consumes the label part as the group header instead. */
    const display = getActivityLabelText(getActivityLabelPart(part));
    if (!display) {
      return null;
    }
    const failed = part.status === 'failed' || part.status === 'partial';
    return (
      <div
        className={`my-1 break-words pl-1 text-sm italic ${failed ? 'text-text-warning' : 'text-text-secondary'}`}
      >
        {display}
      </div>
    );
  } else if (part.type === ContentTypes.TOOL_CALL) {
    const toolCall = part[ContentTypes.TOOL_CALL];

    if (!toolCall) {
      return null;
    }

    const isToolCall =
      'args' in toolCall && (!toolCall.type || toolCall.type === ToolCallTypes.TOOL_CALL);
    if (isToolCall) {
      const toolCallId =
        'id' in toolCall && typeof toolCall.id === 'string' ? toolCall.id : undefined;
      const card = (() => {
        if (isBashProgrammaticToolCall(toolCall.name, toolCall.args)) {
          return (
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
        } else if (
          toolCall.name === Tools.execute_code ||
          toolCall.name === Constants.PROGRAMMATIC_TOOL_CALLING ||
          toolCall.name === Constants.BASH_PROGRAMMATIC_TOOL_CALLING
        ) {
          return (
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
        } else if (
          toolCall.name === 'image_gen_oai' ||
          toolCall.name === 'image_edit_oai' ||
          toolCall.name === 'gemini_image_gen'
        ) {
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
        } else if (toolCall.name === 'ask_user_question') {
          /** Dedicated Q&A record — the generic tool card would label the
           *  interrupt-resolved call "cancelled" and dump raw JSON args. */
          return (
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
          );
        } else if (toolCall.name === Constants.CHECK_BACKGROUND_TASK) {
          return (
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
          );
        } else if (toolCall.name === 'skill') {
          return (
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
          );
        } else if (toolCall.name === Constants.SUBAGENT) {
          /** `subagent_content` is the aggregated content-parts array the
           *  backend writes onto the tool_call at message-save time so the
           *  child's activity survives a page refresh. Not present on older
           *  runs recorded before the persistence path existed — those fall
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
              subagentIdentity={toolCall.subagentIdentity}
              hideAttachments={hideAttachments}
            />
          );
        } else if (toolCall.name === 'set_memory' || toolCall.name === 'delete_memory') {
          return (
            <MemoryCall
              toolName={toolCall.name}
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
        } else if (toolCall.name === 'read_file') {
          return (
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
          );
        } else if (toolCall.name === 'create_file' || toolCall.name === 'edit_file') {
          return (
            <FileAuthoringCall
              toolName={toolCall.name}
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
        } else if (toolCall.name === Tools.bash_tool) {
          return (
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
              hideAttachments={hideAttachments}
              onExpand={onToolExpand}
              toolCallId={toolCallId}
            />
          );
        } else if (toolCall.name === Tools.web_search) {
          return (
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
          );
        } else if (toolCall.name === 'file_search' || toolCall.name === 'retrieval') {
          return (
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
        } else if (toolCall.name?.startsWith(Constants.LC_TRANSFER_TO_)) {
          return <AgentHandoff args={toolCall.args ?? ''} name={toolCall.name || ''} />;
        }
        return (
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
      })();

      /** Render approval controls for ANY paused agent tool — not just the generic
       *  card — so a HITL policy that gates a specialized tool (bash, code, file…)
       *  still surfaces approve/reject/edit/respond. Only while the call is unresolved
       *  (no output yet). */
      if (toolCall.approval != null && (toolCall.output?.length ?? 0) === 0) {
        return (
          <>
            {card}
            <ToolApproval
              approval={toolCall.approval}
              toolCallId={toolCall.id ?? ''}
              args={toolCall.args}
            />
          </>
        );
      }
      return card;
    } else if (toolCall.type === ToolCallTypes.CODE_INTERPRETER) {
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
        <ImageGen
          initialProgress={toolCall.progress ?? 0.1}
          args={toolCall.function.arguments as string}
          isSubmitting={isSubmitting}
          runStepStatus={toolCall.runStepStatus}
          toolName={toolCall.function.name}
          output={toolCall.function.output ?? ''}
        />
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
          isLast={isLast}
          hideAttachments={hideAttachments}
          onExpand={onToolExpand}
        />
      );
    }
  } else if (part.type === ContentTypes.IMAGE_FILE) {
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
  }

  return null;
});
Part.displayName = 'Part';

export default Part;
