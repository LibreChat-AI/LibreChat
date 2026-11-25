import type { AgentContinueTriggerEnvelope, AgentTriggerEvent } from './envelope';
import { AgentTriggerDispatchError } from './dispatch';
import { parseAgentTriggerEnvelope } from './envelope';

interface AgentTriggerBatchDelivery {
  deliveryKey: string;
  envelope: unknown;
}

interface StructuredBatchEvent {
  deliveryId: string;
  event: AgentTriggerEvent;
  input: string;
}

function requireCompatible(
  root: AgentContinueTriggerEnvelope,
  candidate: AgentContinueTriggerEnvelope,
): void {
  const compatible =
    candidate.principal.userId === root.principal.userId &&
    candidate.principal.tenantId === root.principal.tenantId &&
    candidate.target.agentId === root.target.agentId &&
    candidate.target.conversationId === root.target.conversationId &&
    candidate.target.bindingId === root.target.bindingId &&
    candidate.target.sourceKeyId === root.target.sourceKeyId &&
    candidate.event.source.id === root.event.source.id &&
    candidate.event.source.type === root.event.source.type;
  if (!compatible) {
    throw new AgentTriggerDispatchError('Coalesced agent events do not share one bound child');
  }
}

function compareEvents(
  left: { deliveryKey: string; envelope: AgentContinueTriggerEnvelope },
  right: { deliveryKey: string; envelope: AgentContinueTriggerEnvelope },
): number {
  return (
    left.envelope.event.occurredAt - right.envelope.event.occurredAt ||
    left.envelope.receivedAt - right.envelope.receivedAt ||
    left.envelope.event.id.localeCompare(right.envelope.event.id) ||
    left.deliveryKey.localeCompare(right.deliveryKey)
  );
}

/** Builds one deterministic, structured model turn while retaining every source event. */
export function createAgentTriggerBatchEnvelope(
  rootDelivery: AgentTriggerBatchDelivery,
  members: AgentTriggerBatchDelivery[],
): AgentContinueTriggerEnvelope {
  const parsedRoot = parseAgentTriggerEnvelope(rootDelivery.envelope);
  if (
    parsedRoot.mode !== 'continue' ||
    parsedRoot.target.bindingId == null ||
    parsedRoot.target.sourceKeyId == null
  ) {
    throw new AgentTriggerDispatchError('Only bound child continuations can be coalesced');
  }
  const deliveries = [{ deliveryKey: rootDelivery.deliveryKey, envelope: parsedRoot }];
  for (const member of members) {
    const envelope = parseAgentTriggerEnvelope(member.envelope);
    if (envelope.mode !== 'continue') {
      throw new AgentTriggerDispatchError('Only continue events can belong to a trigger batch');
    }
    requireCompatible(parsedRoot, envelope);
    deliveries.push({ deliveryKey: member.deliveryKey, envelope });
  }
  deliveries.sort(compareEvents);

  const eventTypeCounts = new Map<string, number>();
  const events: StructuredBatchEvent[] = deliveries.map(({ envelope }) => {
    eventTypeCounts.set(envelope.event.type, (eventTypeCounts.get(envelope.event.type) ?? 0) + 1);
    return {
      deliveryId: envelope.deliveryId,
      event: envelope.event,
      input: envelope.input,
    };
  });
  const structuredInput = {
    kind: 'librechat.agent_event_batch',
    version: 1,
    count: events.length,
    summary: {
      eventTypes: [...eventTypeCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, count]) => ({ type, count })),
    },
    events,
  };
  return {
    ...parsedRoot,
    input: JSON.stringify(structuredInput),
  };
}
