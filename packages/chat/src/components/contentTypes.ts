import type {
  SubagentAttachmentCallsResponse,
  SubagentAttachmentCallsParams,
  TMessageContentParts,
  SearchResultData,
  TAttachment,
} from 'librechat-data-provider';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { ToolCallGroupExpansionState } from './parts/ToolCallGroup';
import type { WorkspaceChangeAttachment } from '../core/attachments';
import type { ToolCallStepOwners } from '../core/parts/owners';
import type { MCPAppResourceOccurrence } from '../core/apps';
import type { ParallelColumnHeaderProps } from './Parallel';
import type { PartRenderers } from './partTypes';

/** What the content renderer hands a host's editor for a message in edit mode. */
export type ContentEditProps = {
  content: Array<TMessageContentParts | undefined>;
  contentIndexOffset?: number;
  messageId: string;
  isSubmitting: boolean;
  enterEdit: (cancel?: boolean) => void | null | undefined;
  siblingIdx: number | null;
  setSiblingIdx: (value: number) => void;
  /** Draws a part the editor does not edit, as the read-only renderer would. */
  renderReadOnlyPart: (part: TMessageContentParts, index: number, isLastPart: boolean) => ReactNode;
};

/** One batch of answers to which subagent transcripts hold the files asked about. */
export type SubagentAttachmentCallsResult = { data?: SubagentAttachmentCallsResponse };

/**
 * What a host adds to `ContentParts`. Every member is optional, and without one the renderer
 * leaves that piece out; nothing here is needed to draw a message. The object must stay the same
 * for the life of the tree it is passed to: two members are hooks, and a new object re-renders
 * every message.
 */
export type ContentPartsSlots = {
  /** The part renderer table, for a host that adds to the package's or replaces entries of it. */
  renderers?: PartRenderers;
  /** Draws the MCP Apps among the files of a tool group or a phase, under its header. */
  renderAppViews?: (attachments: TAttachment[]) => ReactNode;
  /**
   * Draws one MCP App as a row of the message, after the part whose tool call returned it;
   * `ordinal` numbers the message's Apps from 1. Without it an App is left to `renderAppViews`.
   */
  renderApp?: (resource: MCPAppResourceOccurrence, ordinal: number) => ReactNode;
  /** A hook: whether the reader may run MCP Apps at all. Absent, `renderApp` alone decides. */
  useAppsEnabled?: () => boolean;
  /**
   * Draws the files an agent changed in a stateful workspace, once for the message. With it those
   * files leave the rows beside the tool calls that wrote them; without it they stay there.
   */
  renderWorkspaceChanges?: (changes: WorkspaceChangeAttachment[]) => ReactNode;
  /** Draws a message in edit mode. Without it a message asked to edit draws read-only. */
  renderEdit?: (props: ContentEditProps) => ReactNode;
  /** Draws the sources of a web search above a reply that splits into columns. */
  renderSources?: (props: { messageId: string; conversationId?: string }) => ReactNode;
  /** Draws the header of one column where agents ran side by side. */
  renderColumnHeader?: (props: ParallelColumnHeaderProps) => ReactNode;
  /**
   * A hook that asks the server, in batches, which subagent transcripts hold the given files:
   * one a background task delivers after the message loaded names a child call the loaded
   * preview never mentioned. Called on every render with `enabled` false until there is something
   * to ask. Without it such a file stays with the top-level call that matched it by id.
   */
  useSubagentAttachmentCalls?: (
    params: SubagentAttachmentCallsParams,
    enabled: boolean,
  ) => ReadonlyArray<SubagentAttachmentCallsResult>;
};

export type ContentPartsProps = {
  content: Array<TMessageContentParts | undefined> | undefined;
  messageId: string;
  /** What the host adds to the renderer; see `ContentPartsSlots`. */
  slots?: ContentPartsSlots;
  /** Client-only parent anchor carried by one response while its server identities hydrate. */
  renderOwnerId?: string;
  /**
   * Skill names the user invoked manually on this turn. The host seeds them on the assistant
   * placeholder and the saved message drops them, so the field is present only for the lifetime
   * of the stream. A scalar string array, so `memo` compares it shallowly.
   */
  manualSkills?: string[];
  /** ISO timestamp of the parent message, surfaced in parallel column headers. */
  createdAt?: string | null;
  /**
   * Author icon + label node re-rendered before content that resumes after an
   * inline STEER part — the steer renders as a full user turn inside the
   * response, so what follows must be visibly re-attributed to the author.
   */
  authorHeader?: ReactNode;
  conversationId?: string | null;
  attachments?: TAttachment[];
  /** One mounted response, retained across optimistic and durable message ids. */
  mediaScope?: number;
  searchResults?: { [key: string]: SearchResultData };
  isCreatedByUser: boolean;
  showThinking: boolean;
  isLast: boolean;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  edit?: boolean;
  enterEdit?: (cancel?: boolean) => void | null | undefined;
  siblingIdx?: number;
  setSiblingIdx?: ((value: number) => void | Dispatch<SetStateAction<number>>) | null | undefined;
  /** Whether the span a run is still writing folds into one row. The host
   *  decides: false when the reader asked for tools expanded by default, and
   *  for a surface that IS the detail view of a run — a subagent's activity
   *  panel — where one row would hide what the panel was opened to watch. */
  foldLiveActivity?: boolean;
  /** Internal recursion guard for nested phase segments. */
  nestedActivityPhase?: boolean;
  /** Subsequent slices around stable App outputs must not repeat message decorations. */
  continuation?: boolean;
  /** Internal signal that the parent phase card lifted this segment's
   *  attachments into its own media row — the parts below must not render
   *  them a second time inside the fold. */
  hideAttachments?: boolean;
  /** Internal signal that this segment renders inside a completed phase card. */
  withinActivityPhase?: boolean;
  /** The parent phase owns the failure pill, including while it is live. */
  parentPhaseOwnsFailurePill?: boolean;
  /** Internal signal that a phase card already carries this message's
   *  streaming cursor. A solitary empty provider slot looks like the initial
   *  waiting state from inside its own segment, so without this it renders a
   *  second cursor beside the one already on screen. */
  cursorOwnedElsewhere?: boolean;
  /** Internal signal that the parent already removed message-level workspace attachments. */
  workspaceAttachmentsPartitioned?: boolean;
  /** Absolute transcript index represented by `content[0]` in a phase slice. */
  contentIndexOffset?: number;
  /** Absolute transcript index for each compacted sparse segment entry. */
  contentIndices?: ReadonlyArray<number>;
  /** Message-wide lane cardinality retained across nested phase segments, so a
   *  slice holding one agent of a real two-agent group keeps its columns. */
  laneGroups?: ReadonlySet<number>;
  /** Message-wide steer attribution retained across nested phase segments. */
  resumeAuthors?: ReadonlyMap<number, string | undefined>;
  /** Message-wide tool-group expansion overrides retained across phase slices. */
  toolGroupExpansionState?: Map<string, ToolCallGroupExpansionState>;
  /** Message-wide occurrence number for each grouped tool block's first tool. */
  toolGroupOccurrenceByIndex?: ReadonlyMap<number, number>;
  /** Completed step owners used to keep older attachments off a live repeated call. */
  toolCallStepOwnersById?: ToolCallStepOwners;
};
