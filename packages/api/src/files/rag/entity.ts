import { FileContext } from 'librechat-data-provider';
import type { IAgent } from '@librechat/data-schemas';
import type { TFile } from 'librechat-data-provider';

export type EntityFile = Pick<TFile, 'file_id' | 'filename' | 'context' | 'metadata'>;

type FileSearchAgent = Pick<IAgent, 'id' | 'tool_resources'>;

export type TGetFileSearchAgents = (
  filter: { 'tool_resources.file_search.file_ids': { $in: string[] } },
  select: { id: 1; 'tool_resources.file_search.file_ids': 1 },
) => Promise<FileSearchAgent[] | null>;

const isAgentId = (id: string): boolean => id.startsWith('agent_');

/**
 * Finds the agents whose File Search lists each file. Lookups requested in the same tick
 * share one query, so a turn with several agent files costs a single round trip. A failed
 * query is reported once and lists nothing for every file in it.
 */
function createListingLookup(
  getAgents?: TGetFileSearchAgents,
  onLookupError?: (error: unknown) => void,
) {
  let pending: { fileIds: Set<string>; listings: Promise<Map<string, string[]>> } | undefined;

  const fetchAgents = async (fileIds: Set<string>): Promise<FileSearchAgent[]> => {
    try {
      return (
        (await getAgents?.(
          { 'tool_resources.file_search.file_ids': { $in: [...fileIds] } },
          { id: 1, 'tool_resources.file_search.file_ids': 1 },
        )) ?? []
      );
    } catch (error) {
      onLookupError?.(error);
      return [];
    }
  };

  const load = async (fileIds: Set<string>): Promise<Map<string, string[]>> => {
    pending = undefined;
    const agents = await fetchAgents(fileIds);
    const listings = new Map<string, string[]>();
    for (const agent of agents) {
      for (const fileId of agent.tool_resources?.file_search?.file_ids ?? []) {
        if (fileIds.has(fileId)) {
          listings.set(fileId, [...(listings.get(fileId) ?? []), agent.id]);
        }
      }
    }
    return listings;
  };

  return async (fileId: string): Promise<string[]> => {
    if (!getAgents) {
      return [];
    }
    if (!pending) {
      const fileIds = new Set<string>();
      pending = { fileIds, listings: Promise.resolve(fileIds).then(load) };
    }
    pending.fileIds.add(fileId);
    const listings = await pending.listings;
    return [...(listings.get(fileId) ?? [])].sort();
  };
}

/**
 * Lists the agent namespaces that may hold a file's vectors, for files first embedded into
 * an agent's File Search and later attached outside that agent's chat: the agents recorded
 * on the file, then, for agent files, the agents whose File Search lists it. The recorded
 * list can be incomplete, since re-provisioning records only the new namespace, so agent
 * files always consult the listing too. A failed listing keeps the recorded agents.
 * Resolves an empty list for any other file.
 */
export function createEntityResolver({
  getAgents,
  onLookupError,
}: {
  getAgents?: TGetFileSearchAgents;
  onLookupError?: (error: unknown) => void;
}): (file: EntityFile) => Promise<string[]> {
  const listedBy = createListingLookup(getAgents, onLookupError);

  return async (file) => {
    const recorded = (file.metadata?.embeddedEntities ?? []).filter(isAgentId).sort();
    if (file.context !== FileContext.agents) {
      return recorded;
    }
    return [...new Set([...recorded, ...(await listedBy(file.file_id))])];
  };
}
