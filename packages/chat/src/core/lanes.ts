import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

/** Column key for a lane part that carries no agent id of its own. */
export const UNATTRIBUTED_LANE = 'unknown';

/**
 * Lanes an agent actually claims. `agentId` and `groupId` are independently
 * optional on a run step, so a group can hold a part with no agent of its
 * own; it shares the unattributed column, but it is NOT a second agent —
 * counting the sentinel would let one agent plus one metadata-less part
 * masquerade as a comparison.
 */
export function attributedLaneCount(agents: ReadonlySet<string>): number {
  return agents.has(UNATTRIBUTED_LANE) ? agents.size - 1 : agents.size;
}

/**
 * An agent update is a transition marker, not lane content: it names the agent
 * the run hands off TO. `useStepHandler` stamps it with the current group id
 * even when the destination's own steps carry none, so counting it would read
 * a sequential handoff as a second lane and split one run into columns.
 */
export function isLaneMarkerPart(part: TMessageContentParts | undefined): boolean {
  return part?.type === ContentTypes.AGENT_UPDATE;
}

/**
 * Columns a lane group needs before it renders as columns.
 *
 * `groupId` marks content the server ran as one wave, but a wave is only ever
 * shown as a side-by-side COMPARISON — the added-conversation feature seeds a
 * placeholder per agent so both columns exist from the first render. A group
 * that resolves to one agent has nothing to compare against, and rendering it
 * as a lane costs more than a redundant border: lanes draw their own author
 * header and branch control (restating the message's own sender) and they
 * render raw parts, which opts those parts out of tool grouping, activity
 * label headers and phase folds, while the message row widens for columns
 * that never arrive.
 *
 * A lone group is not exotic. A multi-agent graph assigns a group id to every
 * starting node, so an ordinary agent that merely has subagents available
 * carries one on its OWN output.
 */
export const MIN_PARALLEL_LANES = 2;

/**
 * Distinct lane agents per group id. Mirrors the column derivation in
 * `groupParallelContent`: a placeholder (empty `type`) establishes its agent's
 * column without contributing content, and a part with no agent id of its own
 * shares the single unattributed column.
 */
const laneAgentsCache = new WeakMap<object, ReadonlyMap<number, ReadonlySet<string>>>();

export function laneAgentsByGroup(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
): ReadonlyMap<number, ReadonlySet<string>> {
  if (content == null) {
    return new Map();
  }
  /** One message is scanned by `MultiMessage`, `useContentMetadata` and
   *  `ContentParts` in a single render pass. Keying on the array itself
   *  collapses those to one traversal and is exactly as fresh as the render:
   *  every streamed delta rebuilds `content` (`[...(message.content || [])]`
   *  in `useStepHandler`), and an update that kept the identity would not
   *  re-render either. Entries die with the array they key. */
  const cached = laneAgentsCache.get(content);
  if (cached != null) {
    return cached;
  }
  const lanes = new Map<number, Set<string>>();
  content.forEach((part) => {
    if (part?.groupId == null || isLaneMarkerPart(part)) {
      return;
    }
    const agents = lanes.get(part.groupId) ?? new Set<string>();
    agents.add(part.agentId ?? UNATTRIBUTED_LANE);
    lanes.set(part.groupId, agents);
  });
  laneAgentsCache.set(content, lanes);
  return lanes;
}

/**
 * The group ids that render as columns, resolved over WHOLE message content.
 *
 * Lane cardinality is a property of the message, not of the slice in front of
 * you: a phase marker can partition a real two-agent group so that one slice
 * holds a single agent's parts. Counting that slice on its own would demote it
 * and drop the per-agent attribution its sibling slice still shows, so every
 * slice asks this set instead of recounting.
 */
export function parallelLaneGroups(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
): Set<number> {
  const groups = new Set<number>();
  for (const [groupId, agents] of laneAgentsByGroup(content)) {
    if (attributedLaneCount(agents) >= MIN_PARALLEL_LANES) {
      groups.add(groupId);
    }
  }
  return groups;
}

/**
 * True when some group is backed by enough distinct agents to render as
 * columns. The predicate every consumer of "does this message have parallel
 * content" asks, so a lone group renders exactly like content with no group
 * id at all.
 *
 * `laneGroups` carries the message-level answer into a phase slice; without it
 * the content passed in is counted on its own.
 */
export function hasParallelLanes(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
  laneGroups?: ReadonlySet<number>,
): boolean {
  if (laneGroups != null) {
    return content?.some((part) => part?.groupId != null && laneGroups.has(part.groupId)) === true;
  }
  for (const agents of laneAgentsByGroup(content).values()) {
    if (attributedLaneCount(agents) >= MIN_PARALLEL_LANES) {
      return true;
    }
  }
  return false;
}
