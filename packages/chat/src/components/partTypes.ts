import type { ContentTypes, TMessageContentParts, TAttachment } from 'librechat-data-provider';
import type { ReactNode } from 'react';

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
 * How each kind of part is drawn. `Part` only routes: every visual comes from here, so a host
 * adds a tool card by adding an entry to `tools`, the way an AI SDK app switches on
 * `tool-<name>` parts. The package's own table is `partRenderers()`.
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
  /** How to draw each kind of part. Without it, the package's own cards: `partRenderers()`. */
  renderers?: PartRenderers;
};
