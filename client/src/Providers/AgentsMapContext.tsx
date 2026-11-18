import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import useAgentsMap, { useAgentsCatalog } from '~/hooks/Agents/useAgentsMap';
type AgentsMapContextType = ReturnType<typeof useAgentsMap>;

/** Defaults to undefined (map unknown): an `{}` default outside the provider would
 * read as a loaded-but-empty catalog and misclassify stored agent picks as deleted. */
export const AgentsMapContext = createContext<AgentsMapContextType>(undefined);
export const useAgentsMapContext = () => useContext(AgentsMapContext);

/** Separate lifecycle keeps the incremental map and its existing consumers compatible. */
export const AgentsCatalogPendingContext = createContext<boolean | undefined>(undefined);
export const useAgentsCatalogPending = () => useContext(AgentsCatalogPendingContext);

/** One Root-owned catalog observer; existing readers still receive the incremental map. */
export function AgentCatalogProvider({
  isAuthenticated,
  children,
}: {
  isAuthenticated: boolean;
  children: ReactNode;
}) {
  const { agentsMap, pending } = useAgentsCatalog({ isAuthenticated });
  return (
    <AgentsCatalogPendingContext.Provider value={pending}>
      <AgentsMapContext.Provider value={agentsMap}>{children}</AgentsMapContext.Provider>
    </AgentsCatalogPendingContext.Provider>
  );
}
