import { isProxy } from 'node:util/types';
import type { TurnDeliveryRouting } from 'librechat-data-provider';
import type { AgentContentInput } from './adapters/submissions';
import {
  CONTENT_TRAVERSAL_MAX_NODES,
  ContentTraversalLimitError,
  getBoundedOwnEnumerableEntries,
} from './adapters/nested';

const runtimeRoutes = new WeakSet<TurnDeliveryRouting>();

/** Only the server's routing factory registers metadata, never request objects. */
export function registerRuntimeDeliveryRouting(routing: TurnDeliveryRouting): TurnDeliveryRouting {
  Object.freeze(routing);
  runtimeRoutes.add(routing);
  return routing;
}

export function projectAgentFileInspection(
  agent: AgentContentInput | null | undefined,
): AgentContentInput | null | undefined {
  if (agent == null || isProxy(agent)) {
    return agent;
  }
  const route = Object.getOwnPropertyDescriptor(agent, 'deliveryRouting');
  if (route == null || !('value' in route) || !runtimeRoutes.has(route.value)) {
    return agent;
  }
  const snapshot = getBoundedOwnEnumerableEntries(agent, CONTENT_TRAVERSAL_MAX_NODES);
  if (!snapshot.complete) {
    throw new ContentTraversalLimitError();
  }
  return Object.fromEntries(snapshot.entries.filter(([key]) => key !== 'deliveryRouting'));
}
