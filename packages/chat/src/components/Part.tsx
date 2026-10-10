import { memo } from 'react';
import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessageContentParts, TAttachment } from 'librechat-data-provider';
import type { MemoExoticComponent, ReactNode } from 'react';
import { useMessageContext } from '../react/message';

/** A content part of one type. */
export type ContentPart<T extends ContentTypes = ContentTypes> = Extract<
  TMessageContentParts,
  { type: T }
>;

type ToolCallPart = ContentPart<ContentTypes.TOOL_CALL>;
type ToolCallValue = ToolCallPart[ContentTypes.TOOL_CALL];

/** A tool call an agent made, as opposed to the Assistants code, retrieval and function shapes. */
export type AgentToolCall = Extract<ToolCallValue, { args?: unknown }>;

/** What a part renderer receives. */
export type PartRenderProps<P extends TMessageContentParts = TMessageContentParts> = {
  part: P;
  /** The part's position in its message, from the message context. */
  partIndex: number | undefined;
  isLast?: boolean;
  isSubmitting: boolean;
  showCursor: boolean;
  isCreatedByUser: boolean;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  onToolExpand?: () => void;
};

/** Draws one part; `null` draws nothing. */
export type PartRenderer<P extends TMessageContentParts = TMessageContentParts> = (
  props: PartRenderProps<P>,
) => ReactNode;

/** What a tool renderer receives: the part, plus its agent tool call. */
export type ToolRenderProps = PartRenderProps<ToolCallPart> & {
  toolCall: AgentToolCall;
  /** The provider's id for the call, when it has one. */
  toolCallId: string | undefined;
};

/** Draws one agent tool call. */
export type ToolRenderer = (props: ToolRenderProps) => ReactNode;

/**
 * How a host draws each kind of part. `Part` only routes: every visual comes from here, so a host
 * adds a tool card by adding an entry to `tools`, the way an AI SDK app switches on
 * `tool-<name>` parts.
 */
export type PartRenderers = {
  /** Claims a part before it is routed by type, or returns `undefined` to let it through. */
  claim?: PartRenderer;
  /** Parts by content type. A tool call reaches its entry only in the Assistants shapes. */
  parts: { [T in ContentTypes]?: PartRenderer<ContentPart<T>> };
  /** Agent tool calls by tool name. */
  tools: Record<string, ToolRenderer>;
  /** Routes the calls a name alone cannot (by arguments, by name prefix); checked first. */
  matchTool?: (toolCall: AgentToolCall) => ToolRenderer | undefined;
  /** Agent tool calls no other entry claims. */
  defaultTool: ToolRenderer;
  /** Wraps every agent tool call's card, for state shared by all of them. */
  wrapTool?: (card: ReactNode, props: ToolRenderProps) => ReactNode;
};

export type PartProps = Omit<PartRenderProps, 'part' | 'partIndex'> & {
  part?: TMessageContentParts;
  renderers: PartRenderers;
};

const isAgentToolCall = (toolCall: ToolCallValue): toolCall is AgentToolCall =>
  'args' in toolCall && (!toolCall.type || toolCall.type === ToolCallTypes.TOOL_CALL);

const renderToolCall = (
  renderers: PartRenderers,
  props: PartRenderProps<ToolCallPart>,
): ReactNode => {
  const toolCall = props.part[ContentTypes.TOOL_CALL];
  if (!toolCall) {
    return null;
  }
  if (!isAgentToolCall(toolCall)) {
    return renderers.parts[ContentTypes.TOOL_CALL]?.(props) ?? null;
  }
  const toolProps: ToolRenderProps = {
    ...props,
    toolCall,
    toolCallId: 'id' in toolCall && typeof toolCall.id === 'string' ? toolCall.id : undefined,
  };
  const render =
    renderers.matchTool?.(toolCall) ??
    (toolCall.name ? renderers.tools[toolCall.name] : undefined) ??
    renderers.defaultTool;
  const card = render(toolProps);
  return renderers.wrapTool ? renderers.wrapTool(card, toolProps) : card;
};

/** Routes one content part to the host's renderer for it. */
export const Part: MemoExoticComponent<(props: PartProps) => ReactNode> = memo(function Part({
  part,
  renderers,
  ...rest
}: PartProps) {
  const { partIndex } = useMessageContext();
  if (!part) {
    return null;
  }
  const props: PartRenderProps = { ...rest, part, partIndex };
  const claimed = renderers.claim?.(props);
  if (claimed !== undefined) {
    return claimed;
  }
  if (part.type === ContentTypes.TOOL_CALL) {
    return renderToolCall(renderers, { ...props, part });
  }
  const render = renderers.parts[part.type] as PartRenderer | undefined;
  return render?.(props) ?? null;
});
Part.displayName = 'Part';
