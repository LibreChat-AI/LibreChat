import { useCallback, useMemo, useState } from 'react';
import { Spinner } from '@librechat/client';
import { ContentTypes, hasToolCallPreview } from 'librechat-data-provider';
import type { FullToolCall, TMessageContentParts } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { ToolContentRequestContext } from './disclosure';
import { useToolCallPartQuery } from '~/data-provider';
import { useMessageContext } from '~/Providers';
import { useLocalize } from '~/hooks';

type ToolCallPart = Extract<TMessageContentParts, { type: ContentTypes.TOOL_CALL }>;

/** A tool-call part whose content the server sent as a preview. */
export function isPreviewedToolCallPart(part: TMessageContentParts): part is ToolCallPart {
  return (
    part.type === ContentTypes.TOOL_CALL &&
    part.tool_call != null &&
    hasToolCallPreview(part.tool_call as FullToolCall)
  );
}

/**
 * The part with its stored content in place of the preview. Only the content fields come from
 * the server copy, and the preview markers go: everything else (progress, status, client-only
 * state) stays as the conversation cache has it.
 */
export function withFullToolCall(part: ToolCallPart, full: FullToolCall): ToolCallPart {
  const {
    outputTruncated: _outputTruncated,
    outputLength: _outputLength,
    argsTruncated: _argsTruncated,
    argsLength: _argsLength,
    subagentContentOmitted: _subagentContentOmitted,
    subagentContentParts: _subagentContentParts,
    ...toolCall
  } = part.tool_call as FullToolCall;
  return {
    ...part,
    tool_call: {
      ...toolCall,
      args: full.args ?? toolCall.args,
      output: full.output ?? toolCall.output,
      ...(full.subagent_content != null ? { subagent_content: full.subagent_content } : {}),
    },
  } as ToolCallPart;
}

/**
 * Renders a previewed tool-call part. Nothing loads until the reader opens the card (or its
 * subagent panel); then the stored part is fetched once, cached under its own key, and rendered
 * in place of the preview, with a status line while it loads or if it fails.
 */
export function PreviewedToolCallPart({
  part,
  children,
}: {
  part: ToolCallPart;
  children: (part: TMessageContentParts) => ReactNode;
}) {
  const localize = useLocalize();
  const { messageId, conversationId, partIndex } = useMessageContext();
  const [requested, setRequested] = useState(false);
  const request = useCallback(() => setRequested(true), []);
  const toolCallId = (part.tool_call as FullToolCall).id;
  const canFetch = !!conversationId && !!messageId && partIndex != null;
  const query = useToolCallPartQuery(
    {
      conversationId: conversationId ?? '',
      messageId: messageId ?? '',
      partIndex: partIndex ?? 0,
      toolCallId,
    },
    { enabled: requested && canFetch },
  );
  const full = query.data?.tool_call;
  const effectivePart = useMemo(
    () => (full == null ? part : withFullToolCall(part, full)),
    [full, part],
  );
  const retry = useCallback(() => {
    query.refetch();
  }, [query]);

  return (
    <ToolContentRequestContext.Provider value={full == null ? request : null}>
      {children(effectivePart)}
      {requested && full == null && query.isError && (
        <div role="alert" className="text-text-warning mb-2 flex items-center gap-2 pl-1 text-xs">
          <span>{localize('com_ui_tool_content_error')}</span>
          <button
            type="button"
            onClick={retry}
            className="text-text-primary underline underline-offset-2"
          >
            {localize('com_ui_retry')}
          </button>
        </div>
      )}
      {requested && full == null && !query.isError && canFetch && (
        <div
          role="status"
          aria-live="polite"
          className="text-text-secondary mb-2 flex items-center gap-1.5 pl-1 text-xs"
        >
          <Spinner className="size-3" aria-hidden="true" />
          <span>{localize('com_ui_tool_content_loading')}</span>
        </div>
      )}
    </ToolContentRequestContext.Provider>
  );
}
