import { useCallback, useContext, useMemo, useState } from 'react';
import { Spinner } from '@librechat/client';
import {
  ContentTypes,
  hasToolCallPreview,
  getToolCallPreviewRevision,
} from 'librechat-data-provider';
import type { FullToolCall, TMessageContentParts } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  ToolContentRequestContext,
  ToolContentPendingContext,
  ToolContentQueryContext,
} from './disclosure';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { useToolCallPartQuery } from '~/data-provider';
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
 * The part with its stored content in place of the preview. Only the fields the server shortened
 * come from the fetched copy, and the preview markers go: everything else (progress, status,
 * fields the preview already carried in full, client-only state) stays as the conversation cache
 * has it, so a fetched copy can never roll back a newer cached value.
 */
export function withFullToolCall(part: ToolCallPart, full: FullToolCall): ToolCallPart {
  const {
    outputTruncated,
    outputLength: _outputLength,
    argsTruncated,
    argsLength: _argsLength,
    subagentContentOmitted,
    subagentContentParts: _subagentContentParts,
    previewRevision: _previewRevision,
    ...toolCall
  } = part.tool_call as FullToolCall;
  return {
    ...part,
    tool_call: {
      ...toolCall,
      ...(argsTruncated === true && full.args != null ? { args: full.args } : {}),
      ...(outputTruncated === true && full.output != null ? { output: full.output } : {}),
      ...(subagentContentOmitted === true && full.subagent_content != null
        ? { subagent_content: full.subagent_content }
        : {}),
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
  const { messageId, conversationId, partIndex } = useMessagePartsHost().useMessage();
  const [requested, setRequested] = useState(false);
  const request = useCallback(() => setRequested(true), []);
  const toolCall = part.tool_call as FullToolCall;
  const revision = useMemo(() => getToolCallPreviewRevision(toolCall), [toolCall]);
  const configuredQuery = useContext(ToolContentQueryContext);
  const queryHook = configuredQuery === undefined ? useToolCallPartQuery : configuredQuery;
  const usePartQuery = queryHook ?? useToolCallPartQuery;
  const canFetch = queryHook != null && !!conversationId && !!messageId && partIndex != null;
  const query = usePartQuery(
    {
      conversationId: conversationId ?? '',
      messageId: messageId ?? '',
      partIndex: partIndex ?? 0,
      toolCallId: toolCall.id,
      stepId: toolCall.stepId,
      agentId: part.agentId,
    },
    { enabled: requested && canFetch },
    revision,
  );
  const full = queryHook == null ? undefined : query.data?.tool_call;
  const effectivePart = useMemo(
    () => (full == null ? part : withFullToolCall(part, full)),
    [full, part],
  );
  const retry = useCallback(() => {
    query.refetch();
  }, [query]);

  return (
    <ToolContentRequestContext.Provider value={full == null ? request : null}>
      <ToolContentPendingContext.Provider value={full == null}>
        {children(effectivePart)}
      </ToolContentPendingContext.Provider>
      {requested && full == null && (queryHook == null || query.isError) && (
        <div role="alert" className="text-text-warning mb-2 flex items-center gap-2 ps-1 text-xs">
          <span>{localize('com_ui_tool_content_error')}</span>
          {queryHook != null && (
            <button
              type="button"
              onClick={retry}
              className="text-text-primary underline underline-offset-2"
            >
              {localize('com_ui_retry')}
            </button>
          )}
        </div>
      )}
      {requested && full == null && !query.isError && canFetch && (
        <div
          role="status"
          aria-live="polite"
          className="text-text-secondary mb-2 flex items-center gap-1.5 ps-1 text-xs"
        >
          <Spinner className="size-3" aria-hidden="true" />
          <span>{localize('com_ui_tool_content_loading')}</span>
        </div>
      )}
    </ToolContentRequestContext.Provider>
  );
}
