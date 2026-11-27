import type { TMessageContentParts } from 'librechat-data-provider';
import type { PartWithIndex } from './content';
import { MIN_PARALLEL_LANES, UNATTRIBUTED_LANE, isLaneMarkerPart } from './lanes';
import { lastCursorContentIdx } from './parts/activityLabels';

export type ParallelColumn = {
  agentId: string;
  parts: PartWithIndex[];
};

export type ParallelSection = {
  groupId: number;
  columns: ParallelColumn[];
  /** The transcript index of the section's first part; `Infinity` while it holds only
   *  placeholder columns, which sorts it after every section with content. */
  start: number;
};

/**
 * Groups content parts by groupId for parallel rendering.
 * Parts with same groupId are displayed in columns, grouped by agentId.
 *
 * @param content - Array of content parts
 * @returns Object containing parallel sections and sequential parts
 */
export function groupParallelContent(
  content: Array<TMessageContentParts | undefined> | undefined,
  contentIndexOffset = 0,
  contentIndices?: ReadonlyArray<number>,
  laneGroups?: ReadonlySet<number>,
): { parallelSections: ParallelSection[]; sequentialParts: PartWithIndex[] } {
  if (!content) {
    return { parallelSections: [], sequentialParts: [] };
  }

  const groupMap = new Map<number, PartWithIndex[]>();
  // Track placeholder agentIds per groupId (parts with empty type that establish columns)
  const placeholderAgents = new Map<number, Set<string>>();
  const noGroup: PartWithIndex[] = [];

  content.forEach((part, localIdx) => {
    if (!part) {
      return;
    }
    const idx = contentIndices?.[localIdx] ?? localIdx + contentIndexOffset;

    // Read metadata directly from content part (TMessageContentParts includes ContentMetadata)
    const { groupId } = part;

    // Check for placeholder (empty type) before narrowing - access agentId via casting
    const partAgentId = (part as { agentId?: string }).agentId;

    if (groupId != null) {
      // Track placeholder parts (empty type) to establish columns for pending agents
      if (!part.type && partAgentId) {
        if (!placeholderAgents.has(groupId)) {
          placeholderAgents.set(groupId, new Set());
        }
        placeholderAgents.get(groupId)!.add(partAgentId);
        return; // Don't add to groupMap - we'll handle these separately
      }

      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, []);
      }
      groupMap.get(groupId)!.push({ part, idx });
    } else {
      noGroup.push({ part, idx });
    }
  });

  // Collect all groupIds (from both real content and placeholders)
  const allGroupIds = new Set([...groupMap.keys(), ...placeholderAgents.keys()]);

  // Build parallel sections with columns grouped by agentId
  const sections: ParallelSection[] = [];
  for (const groupId of allGroupIds) {
    const columnMap = new Map<string, PartWithIndex[]>();
    const parts = groupMap.get(groupId) ?? [];

    for (const { part, idx } of parts) {
      // Read agentId directly from content part (TMessageContentParts includes ContentMetadata)
      const agentId = part.agentId ?? UNATTRIBUTED_LANE;

      if (!columnMap.has(agentId)) {
        columnMap.set(agentId, []);
      }
      columnMap.get(agentId)!.push({ part, idx });
    }

    // Add empty columns for placeholder agents that don't have real content yet
    const groupPlaceholders = placeholderAgents.get(groupId);
    if (groupPlaceholders) {
      for (const placeholderAgentId of groupPlaceholders) {
        if (!columnMap.has(placeholderAgentId)) {
          // Empty array signals this column should show loading state
          columnMap.set(placeholderAgentId, []);
        }
      }
    }

    // Sort columns: primary agent (no ____N suffix) first, added agents (with suffix) second
    // This ensures consistent column ordering regardless of which agent responds first
    const sortedAgentIds = Array.from(columnMap.keys()).sort((a, b) => {
      const aHasSuffix = a.includes('____');
      const bHasSuffix = b.includes('____');
      if (aHasSuffix && !bHasSuffix) {
        return 1;
      }
      if (!aHasSuffix && bHasSuffix) {
        return -1;
      }
      return 0;
    });

    const columns = sortedAgentIds.map((agentId) => ({
      agentId,
      parts: columnMap.get(agentId)!,
    }));

    /** Which columns are an agent's own output, mirroring `laneAgentsByGroup`:
     *  the sentinel column belongs to no agent, and a column holding only a
     *  handoff marker is nothing to compare against. A placeholder column has
     *  no parts at all and still claims its lane — that is how a dual run
     *  shows both agents from the first render. */
    const claimedColumns = columns.filter(
      ({ agentId, parts }) =>
        agentId !== UNATTRIBUTED_LANE &&
        (parts.length === 0 || parts.some(({ part }) => !isLaneMarkerPart(part))),
    ).length;

    /** One column is not a comparison. Its parts rejoin the sequential flow,
     *  where tool grouping, activity-label headers and phase folds apply and
     *  the message's own author header is the only attribution shown.
     *
     *  `laneGroups` is the message-level verdict: a phase slice holding one
     *  agent of a real two-agent group keeps its columns, because the group
     *  is a comparison even where this slice cannot show it. */
    if (claimedColumns < MIN_PARALLEL_LANES && laneGroups?.has(groupId) !== true) {
      for (const column of columns) {
        noGroup.push(...column.parts);
      }
      continue;
    }

    /** Found once here: the sort below and the renderer's layout both read it, where each used to
     *  flatten every column's indices again, the sort on every comparison. */
    let start = Infinity;
    for (const { idx } of parts) {
      if (idx < start) {
        start = idx;
      }
    }
    sections.push({ groupId, columns, start });
  }

  sections.sort((a, b) => (a.start === b.start ? 0 : a.start - b.start));

  /** Demoted lane parts are appended after the parts that preceded them, so
   *  restore transcript order before the before/after split reads indexes. */
  noGroup.sort((a, b) => a.idx - b.idx);

  return { parallelSections: sections, sequentialParts: noGroup };
}

export function lastParallelColumnCursorIdx(
  parts: ReadonlyArray<{ part: TMessageContentParts; idx: number }>,
): number {
  const relativeIdx = lastCursorContentIdx(parts.map(({ part }) => part));
  return relativeIdx < 0 ? -1 : (parts[relativeIdx]?.idx ?? -1);
}
