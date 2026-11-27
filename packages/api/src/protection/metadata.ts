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

/** Tool catalogs are envelopes: inspect every entry, with the same bound as the agent body. */
export function visitAgentFileInspectionUnits(
  agent: AgentContentInput | null | undefined,
  inspect: (unit: unknown) => void,
): void {
  if (agent == null || isProxy(agent)) {
    inspect(agent);
    return;
  }
  const snapshot = getBoundedOwnEnumerableEntries(agent, CONTENT_TRAVERSAL_MAX_NODES);
  if (!snapshot.complete) {
    throw new ContentTraversalLimitError();
  }
  const catalogs: [string, unknown[]][] = [];
  const body: [string, unknown][] = [];
  for (const [key, value] of snapshot.entries) {
    if ((key === 'tools' || key === 'toolDefinitions') && isProxy(value)) {
      throw new ContentTraversalLimitError();
    }
    if ((key === 'tools' || key === 'toolDefinitions') && Array.isArray(value)) {
      catalogs.push([key, value]);
    } else {
      body.push([key, value]);
    }
  }
  inspect(Object.fromEntries(body));

  let remainingEntries = CONTENT_TRAVERSAL_MAX_NODES;
  for (const [key, catalog] of catalogs) {
    const length: unknown = Object.getOwnPropertyDescriptor(catalog, 'length')?.value;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > remainingEntries
    ) {
      throw new ContentTraversalLimitError();
    }
    const entries = getBoundedOwnEnumerableEntries(catalog, remainingEntries);
    if (!entries.complete) {
      throw new ContentTraversalLimitError();
    }
    remainingEntries -= Math.max(length, entries.entries.length);
    for (const entry of entries.entries) {
      // Preserve even non-index properties: none of the catalog is exempt from file policy.
      inspect(Object.fromEntries([[key, Object.fromEntries([entry])]]));
    }
  }
}
