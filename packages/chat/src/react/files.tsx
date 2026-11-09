import { createContext, useContext } from 'react';
import type { EModelEndpoint, EToolResources } from 'librechat-data-provider';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { ExtendedFile } from '../core/files';

/** The surface a row's files are removed from. */
export type FileDeleteScope = {
  agent_id?: string;
  assistant_id?: string;
  tool_resource?: EToolResources;
  index?: number;
};

/** The setter for the composer's map of attached files. */
export type FileMapSetter = Dispatch<SetStateAction<Map<string, ExtendedFile>>>;

/** App capabilities the attachment components read. */
export interface FilesHost {
  /** The provider mark drawn on a file a provider stores (OpenAI, Azure OpenAI). */
  renderEndpointIcon: (endpoint: EModelEndpoint) => ReactNode;
  /** A hook the row calls once per render; the function it returns deletes one file from the scope. */
  useDeleteFile: (
    scope: FileDeleteScope,
  ) => (args: { file: ExtendedFile; setFiles: FileMapSetter }) => void;
  /** The cached local preview for an upload, when one exists. */
  getPreviewUrl: (fileId: string) => string | undefined;
}

/** Without a host, attachments still render; a provider-stored file just carries no mark. */
const fallbackHost: FilesHost = {
  renderEndpointIcon: () => null,
  useDeleteFile:
    () =>
    ({ file, setFiles }) =>
      setFiles((current) => {
        const next = new Map(current);
        next.delete(file.file_id);
        return next;
      }),
  getPreviewUrl: () => undefined,
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
