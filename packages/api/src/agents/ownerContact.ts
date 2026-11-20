import { ResourceType } from 'librechat-data-provider';
import { AGENT_OWNER_CONTACT_RESOLVED_FIELD } from '@librechat/data-schemas';
import type { AgentOwnerContact } from 'librechat-data-provider';
import type { AgentContactSource, AgentOwnerContactSource } from './contact';
import { hasSupportContact, resolveAgentOwnerContact } from './contact';

/** An id as the database hands it over: an ObjectId, or its stringified form. */
type IdLike = string | { toString(): string } | null | undefined;

type ResolvedMarker = { [K in typeof AGENT_OWNER_CONTACT_RESOLVED_FIELD]?: boolean };

/** One row of an agent list, as the response projects it. */
export type AgentOwnerContactRow = AgentContactSource &
  ResolvedMarker & {
    _id?: IdLike;
    author?: IdLike;
    owner_contact?: AgentOwnerContact;
  };

/**
 * The database reads this helper needs, supplied by the caller so it stays independent of
 * the app's connection and of Mongoose itself.
 */
export interface AgentOwnerContactDeps {
  /** Earliest owner principal per resource id, keyed by stringified resource id. */
  getFirstOwnerIdsByResource: (
    resourceType: string,
    resourceIds: string[],
  ) => Promise<Map<string, string>>;
  findOwnerContactUsers: (ownerIds: string[]) => Promise<AgentOwnerContactUser[]>;
  logger: Pick<Console, 'warn'>;
}

export type AgentOwnerContactUser = AgentOwnerContactSource & { _id?: IdLike };

const idOf = (value: IdLike): string | undefined => {
  const id = value?.toString();
  return id ? id : undefined;
};

/**
 * Fills in each row's display-only `owner_contact`.
 *
 * A list query that had to join the owner in order to sort by it hands the resolved
 * contact over on the row and marks it: re-resolving those rows would repeat the ACL
 * aggregation and the user lookup for a page the database already answered. The marker is
 * a handoff between the list query and this helper, never a response field, so it is
 * stripped either way. A configured support contact always wins — that is the owner's
 * explicit choice about how to be reached.
 *
 * Mutates and returns the rows it is given; list handlers pass the array they are about to
 * serialize.
 */
export async function attachAgentOwnerContacts<T extends AgentOwnerContactRow>(
  agents: T[],
  deps: AgentOwnerContactDeps,
): Promise<T[]> {
  if (!Array.isArray(agents) || agents.length === 0) {
    return agents;
  }

  const unresolved = agents.filter((agent) => agent?.[AGENT_OWNER_CONTACT_RESOLVED_FIELD] !== true);
  const pendingIds = unresolved
    .filter((agent) => !hasSupportContact(agent))
    .map((agent) => idOf(agent?._id))
    .filter((id): id is string => id != null);

  let ownerIdsByResource = new Map<string, string>();
  if (pendingIds.length > 0) {
    try {
      ownerIdsByResource = await deps.getFirstOwnerIdsByResource(ResourceType.AGENT, pendingIds);
    } catch (error) {
      deps.logger.warn('[/Agents] Failed to resolve agent owner ACL entries', error);
    }
  }

  const ownerIds = [
    ...new Set(
      unresolved
        .filter((agent) => !hasSupportContact(agent))
        .map((agent) => ownerIdsByResource.get(idOf(agent?._id) ?? '') ?? idOf(agent?.author) ?? '')
        .filter(Boolean),
    ),
  ];

  const ownersById = new Map<string, AgentOwnerContactUser>();
  if (ownerIds.length > 0) {
    try {
      const users = await deps.findOwnerContactUsers(ownerIds);
      for (const user of users) {
        const id = idOf(user?._id);
        if (id) {
          ownersById.set(id, user);
        }
      }
    } catch (error) {
      deps.logger.warn('[/Agents] Failed to resolve agent owner users', error);
    }
  }

  for (const agent of agents) {
    if (agent?.[AGENT_OWNER_CONTACT_RESOLVED_FIELD] === true) {
      delete agent[AGENT_OWNER_CONTACT_RESOLVED_FIELD];
      if (hasSupportContact(agent)) {
        delete agent.owner_contact;
      }
      continue;
    }
    if (hasSupportContact(agent)) {
      delete agent.owner_contact;
      continue;
    }
    const ownerId = ownerIdsByResource.get(idOf(agent?._id) ?? '') ?? idOf(agent?.author);
    const ownerContact = resolveAgentOwnerContact(
      agent,
      (ownerId != null ? ownersById.get(ownerId) : null) ?? null,
    );
    if (ownerContact) {
      agent.owner_contact = ownerContact;
    } else {
      delete agent.owner_contact;
    }
  }

  return agents;
}
