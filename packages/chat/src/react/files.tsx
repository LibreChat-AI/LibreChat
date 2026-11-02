import { createContext, useContext } from 'react';
import type { EModelEndpoint } from 'librechat-data-provider';
import type { ReactNode } from 'react';

/** App capabilities the attachment components read. */
export interface FilesHost {
  /** The provider mark drawn on a file a provider stores (OpenAI, Azure OpenAI). */
  renderEndpointIcon: (endpoint: EModelEndpoint) => ReactNode;
}

/** Without a host, attachments still render; a provider-stored file just carries no mark. */
const fallbackHost: FilesHost = {
  renderEndpointIcon: () => null,
};

const FilesHostContext = createContext<FilesHost>(fallbackHost);

/** Supplies the host the attachment components read from. */
export function FilesHostProvider({
  host,
  children,
}: {
  host: FilesHost;
  children: ReactNode;
}): ReactNode {
  return <FilesHostContext.Provider value={host}>{children}</FilesHostContext.Provider>;
}

/** The host of the nearest provider, or one that draws no provider marks. */
export function useFilesHost(): FilesHost {
  return useContext(FilesHostContext);
}
