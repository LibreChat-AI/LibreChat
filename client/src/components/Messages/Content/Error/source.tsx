import { createContext, useContext, useMemo } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useMessageContext } from '~/Providers/MessageContext';

/** The fields of a message that say who produced a failure and when. */
export type ErrorSource = Pick<TMessage, 'endpoint' | 'model' | 'createdAt'> & {
  /**
   * The agent that ran the failing part: the agent of its own lane in a parallel run, otherwise
   * the agent a handoff earlier in the row made active.
   */
  partAgentId?: string;
};

/** Where a row's content changes agents, and which error parts name their own. */
type AgentPositions = {
  /** Positions of `AGENT_UPDATE` parts, in content order. */
  handoffs: Array<{ index: number; agentId: string }>;
  /** Error parts a parallel run stamped with the agent of their lane, by position. */
  owners: Record<number, string>;
};

type RowSource = { source: ErrorSource; positions: AgentPositions };

const ErrorSourceContext = createContext<RowSource | undefined>(undefined);

function findAgentPositions(content: TMessage['content']): AgentPositions {
  const positions: AgentPositions = { handoffs: [], owners: {} };
  for (let index = 0; index < (content?.length ?? 0); index++) {
    const part = content?.[index];
    if (part?.type === ContentTypes.ERROR && part.agentId) {
      positions.owners[index] = part.agentId;
      continue;
    }
    if (part?.type !== ContentTypes.AGENT_UPDATE) {
      continue;
    }
    const agentId = part[ContentTypes.AGENT_UPDATE]?.agentId;
    if (agentId) {
      positions.handoffs.push({ index, agentId });
    }
  }
  return positions;
}

/** The agent that ran the part at `partIndex`: its own lane's, else the last handoff before it. */
function findPartAgent(
  { handoffs, owners }: AgentPositions,
  partIndex: number,
): string | undefined {
  const owner = owners[partIndex];
  if (owner != null) {
    return owner;
  }
  let agentId: string | undefined;
  for (const handoff of handoffs) {
    if (handoff.index >= partIndex) {
      break;
    }
    agentId = handoff.agentId;
  }
  return agentId;
}

/**
 * Supplies a message row's identity to the errors rendered inside it.
 *
 * A failure during a run is persisted as an error content part, and `Part` renders it without the
 * message it belongs to. Without this, its copy could only name the conversation's current
 * endpoint and model, which stop being the ones that failed as soon as the reader switches models.
 *
 * One row can hold several agents' work: a sequential run hands off through `AGENT_UPDATE` parts,
 * and a parallel run stamps each part with the agent of its lane. The row therefore also records
 * where those agents sit, and an error part resolves its own agent from its position (the
 * absolute `partIndex` its `MessageContext` carries). The positions are keyed by value: a
 * streaming row, whose content changes on every token, keeps one context value until an agent
 * position actually changes, so its error parts do not re-render in between.
 */
export function ErrorSourceProvider({
  message,
  children,
}: {
  message: Pick<TMessage, 'endpoint' | 'model' | 'createdAt' | 'content'>;
  children: ReactNode;
}) {
  const { endpoint, model, createdAt, content } = message;
  const positionsKey = useMemo(() => JSON.stringify(findAgentPositions(content)), [content]);
  const row = useMemo<RowSource>(
    () => ({
      source: { endpoint, model, createdAt },
      positions: JSON.parse(positionsKey) as AgentPositions,
    }),
    [endpoint, model, createdAt, positionsKey],
  );
  return <ErrorSourceContext.Provider value={row}>{children}</ErrorSourceContext.Provider>;
}

/** The identity of the row rendering this error, resolved to the agent that ran its part. */
export function useErrorSource(): ErrorSource | undefined {
  const row = useContext(ErrorSourceContext);
  const { partIndex } = useMessageContext();
  return useMemo(() => {
    if (row == null) {
      return undefined;
    }
    const partAgentId = partIndex == null ? undefined : findPartAgent(row.positions, partIndex);
    return partAgentId == null ? row.source : { ...row.source, partAgentId };
  }, [row, partIndex]);
}
