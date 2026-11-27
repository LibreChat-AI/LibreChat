import { createContext, useContext } from 'react';
import useAgentsMap from '~/hooks/Agents/useAgentsMap';
type AgentsMapContextType = ReturnType<typeof useAgentsMap>;

/** Defaults to undefined (map unknown): an `{}` default outside the provider would
 * read as a loaded-but-empty catalog and misclassify stored agent picks as deleted. */
export const AgentsMapContext = createContext<AgentsMapContextType>(undefined);
export const useAgentsMapContext = () => useContext(AgentsMapContext);
