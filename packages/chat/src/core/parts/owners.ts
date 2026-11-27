import { Tools, ContentTypes } from 'librechat-data-provider';
import type {
  SubagentAttachmentFile,
  TMessageContentParts,
  TAttachment,
  Agents,
} from 'librechat-data-provider';
import { filterAttachmentsForPart } from '../files';
import { attachmentRenderKey } from '../media';
import { hasAppResource } from '../apps';

type Content = ReadonlyArray<TMessageContentParts | undefined> | undefined;

/** A message's attachments by the tool call they were saved under; see `mapAttachments`. */
export type AttachmentsByToolCall = Record<string, TAttachment[] | undefined>;

/** A finished step that ran a tool call, and the agent it ran for. */
export type ToolCallStepOwner = { agentId?: string; stepId: string };

/** The finished steps of a message by provider tool call id, which providers reuse. */
export type ToolCallStepOwners = ReadonlyMap<string, readonly ToolCallStepOwner[]>;

type ToolCallHolder = { agentId?: string; tool_call?: Agents.ToolCall & { agentId?: string } };

/** Read without narrowing on `type`: a part is trusted to hold a call wherever it carries one. */
const holder = (part: TMessageContentParts): ToolCallHolder | undefined =>
  part as ToolCallHolder | undefined;

/** Provider id of the tool call a part holds, or `''`. */
export const partToolCallId = (part: TMessageContentParts): string =>
  holder(part)?.tool_call?.id ?? '';

/** The agent a part ran for, read from the part or the tool call it holds. */
export const partAgentId = (part: TMessageContentParts): string | undefined =>
  holder(part)?.agentId ?? holder(part)?.tool_call?.agentId;

/** The run step of the tool call a part holds; stamped only once the call finishes. */
export const partStepId = (part: TMessageContentParts): string | undefined =>
  holder(part)?.tool_call?.stepId;

/** Every finished step in `content`, by the provider id of the tool call it ran. */
export function toolCallStepOwners(content: Content): ToolCallStepOwners {
  const owners = new Map<string, ToolCallStepOwner[]>();
  for (const part of content ?? []) {
    if (part == null) {
      continue;
    }
    const toolCallId = partToolCallId(part);
    const stepId = partStepId(part);
    if (toolCallId === '' || stepId == null) {
      continue;
    }
    const entries = owners.get(toolCallId) ?? [];
    entries.push({ stepId, agentId: partAgentId(part) });
    owners.set(toolCallId, entries);
  }
  return owners;
}

/**
 * The steps other parts already finished under the tool call id a live part reuses, so the live
 * part leaves their files alone. Nothing for a part that has its own step.
 */
export function siblingStepIds(
  part: TMessageContentParts,
  owners: ToolCallStepOwners,
): ReadonlySet<string> | undefined {
  if (partStepId(part) != null) {
    return;
  }
  const toolCallId = partToolCallId(part);
  const entries = owners.get(toolCallId);
  if (toolCallId === '' || entries == null) {
    return;
  }
  const agentId = partAgentId(part);
  const stepIds = new Set<string>();
  for (const owner of entries) {
    if (agentId == null || owner.agentId == null || owner.agentId === agentId) {
      stepIds.add(owner.stepId);
    }
  }
  return stepIds.size === 0 ? undefined : stepIds;
}

/** The attachments saved under a part's tool call that the part's agent and step scope accepts. */
export function acceptedAttachments(
  part: TMessageContentParts,
  byToolCall: AttachmentsByToolCall,
  owners: ToolCallStepOwners,
): TAttachment[] | undefined {
  return filterAttachmentsForPart(
    byToolCall[partToolCallId(part)],
    partAgentId(part),
    partStepId(part),
    siblingStepIds(part, owners),
  );
}

/** Whether the part carries every agent and step scope the attachment does. */
export function carriesScopeOf(part: TMessageContentParts, attachment: TAttachment): boolean {
  const { agentId, stepId } = attachment as { agentId?: string; stepId?: string };
  return (
    (agentId == null || partAgentId(part) === agentId) &&
    (stepId == null || partStepId(part) === stepId)
  );
}

/**
 * Attachments a top-level part accepts under the ownership rules its own row
 * applies. A file a subagent child call owns under its full scope (`reserved`)
 * goes to a top-level part only when that part carries the same scope, so an
 * unscoped call reusing the child's id cannot take it first.
 */
export function collectClaimedAttachments(
  content: Content,
  byToolCall: AttachmentsByToolCall,
  owners: ToolCallStepOwners,
  reserved: ReadonlySet<TAttachment>,
): { claimed: ReadonlySet<TAttachment>; exact: ReadonlySet<TAttachment> } {
  const claimed = new Set<TAttachment>();
  /** Claimed by a part carrying the file's full scope, not only by a part missing some of it. */
  const exact = new Set<TAttachment>();
  for (const part of content ?? []) {
    if (part == null) {
      continue;
    }
    for (const attachment of acceptedAttachments(part, byToolCall, owners) ?? []) {
      const scoped = carriesScopeOf(part, attachment);
      if (reserved.has(attachment) && !scoped) {
        continue;
      }
      claimed.add(attachment);
      if (scoped) {
        exact.add(attachment);
      }
    }
  }
  return { claimed, exact };
}

/** What one pass over a message's content finds for the rows drawn around its parts. */
export type MessageContentScan = {
  /** Every attachment carrying an MCP App, once each, in content order. */
  attachments: TAttachment[];
  /** Those attachments by the position in `content` of the part that owns them. */
  atIndex: Map<number, TAttachment[]>;
  /** The agent writing at each transcript index where a response resumes after a steer. */
  resumeAuthors: ReadonlyMap<number, string | undefined>;
};

/**
 * Finds the MCP App attachments each part of a message owns, and who is writing wherever the
 * response resumes after an inline steer. `nested` holds the files a part owns through its
 * subagent run; `contentIndices`, or else `contentIndexOffset`, gives each position's transcript
 * index when `content` is a slice.
 */
export function collectMessageContent(
  content: Content,
  byToolCall: AttachmentsByToolCall,
  owners: ToolCallStepOwners,
  nested: Pick<ReadonlyMap<TMessageContentParts, TAttachment[]>, 'get'>,
  contentIndexOffset = 0,
  contentIndices?: ReadonlyArray<number>,
): MessageContentScan {
  const resumeAuthors = new Map<number, string | undefined>();
  let prevType: string | undefined;
  let activeAgentId: string | undefined;
  const atIndex = new Map<number, TAttachment[]>();
  const collected = new Set<TAttachment>();
  (content ?? []).forEach((part, index) => {
    if (part == null) return;
    // Attribute the resume point before applying a handoff on that same part.
    if (prevType === ContentTypes.STEER && part.type !== ContentTypes.STEER) {
      resumeAuthors.set(contentIndices?.[index] ?? index + contentIndexOffset, activeAgentId);
    }
    if (part.type === ContentTypes.AGENT_UPDATE) {
      activeAgentId = part[ContentTypes.AGENT_UPDATE]?.agentId || undefined;
    }
    prevType = part.type;
    const routed = acceptedAttachments(part, byToolCall, owners);
    /** A subagent's child-call Apps render beside the subagent row, like its
     *  own, so regrouping the row while it streams never remounts them. */
    const owned = nested.get(part);
    for (const attachment of owned == null ? (routed ?? []) : [...(routed ?? []), ...owned]) {
      if (!collected.has(attachment) && hasAppResource(attachment)) {
        collected.add(attachment);
        const entries = atIndex.get(index) ?? [];
        entries.push(attachment);
        atIndex.set(index, entries);
      }
    }
  });
  return { attachments: Array.from(collected), atIndex, resumeAuthors };
}

/**
 * Every file the given parts produced, in transcript order, deduplicated across parts that share
 * a tool call. A repeat REPLACES the earlier record in place: a tool that writes the same file
 * twice emits two records and the later one carries the fresher lifecycle fields (status, preview
 * text, generated contents). A file with no identity has nothing to compare against, so it is
 * kept rather than collapsed onto whichever arrived first.
 */
export function collectPartAttachments(
  parts: ReadonlyArray<TMessageContentParts | undefined>,
  attachmentsFor: (part: TMessageContentParts) => TAttachment[] | undefined,
): TAttachment[] | undefined {
  const collected: TAttachment[] = [];
  const positionOf = new Map<string, number>();
  for (const part of parts) {
    if (part == null) {
      continue;
    }
    for (const attachment of attachmentsFor(part) ?? []) {
      const identity = attachmentRenderKey(attachment);
      if (identity == null) {
        collected.push(attachment);
        continue;
      }
      const at = positionOf.get(identity);
      if (at != null) {
        collected[at] = attachment;
        continue;
      }
      positionOf.set(identity, collected.length);
      collected.push(attachment);
    }
  }
  return collected.length > 0 ? collected : undefined;
}

/** Whether an attachment is a file a tool wrote, as opposed to an MCP App or search results. */
export function isFileOutput(file: TAttachment): boolean {
  return (
    Boolean(file.filepath) && file.type !== Tools.ui_resources && file.type !== Tools.web_search
  );
}

/** The distinct tool call scopes of the given files, in a stable order. */
export function attachmentScopes(files: ReadonlyArray<TAttachment>): SubagentAttachmentFile[] {
  const scopes = new Map<string, SubagentAttachmentFile>();
  for (const file of files) {
    const { toolCallId, agentId, stepId } = file as SubagentAttachmentFile;
    const scope = {
      toolCallId,
      ...(agentId != null ? { agentId } : {}),
      ...(stepId != null ? { stepId } : {}),
    };
    scopes.set(JSON.stringify(scope), scope);
  }
  return [...scopes.keys()].sort().map((key) => scopes.get(key) as SubagentAttachmentFile);
}
