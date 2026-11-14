import { createContext, useContext } from 'react';
import type { EModelEndpoint, EToolResources, TAttachment, TFile } from 'librechat-data-provider';
import type { Dispatch, MouseEvent, ReactNode, SetStateAction } from 'react';
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

/** A message attachment the row wants downloaded. */
export type AttachmentDownloadTarget = {
  href: string;
  filename: string;
  fileId?: string;
  user?: string;
  source?: string;
};

/** Deferred preview state for a code-execution file. */
export type AttachmentPreview = {
  status: 'pending' | 'ready' | 'failed';
  previewError?: string;
};

/** Which of the viewer's files a retrieval card may open. */
export type KnownFilesQuery = {
  enabled: boolean;
  fileIds: ReadonlySet<string>;
};

/** A tool-output file the host can open in a viewer the package does not own. */
export type AttachmentArtifact = { kind: 'mermaid' } | { kind: 'panel'; artifactType: string };

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
  /**
   * A hook a message-attachment row calls once per render. The function it returns downloads
   * that file. Omitted, the row still renders and a click does nothing.
   */
  useAttachmentDownload?: (
    target: AttachmentDownloadTarget,
  ) => (event: MouseEvent<HTMLElement>) => void;
  /** A hook a message-attachment row calls once per render. Omitted, pending and failed records still show. */
  useAttachmentPreview?: (attachment: TAttachment | undefined) => AttachmentPreview;
  /** A hook a retrieval card calls once per render. Omitted, parsed names are not matched to stored files. */
  useKnownFiles?: (query: KnownFilesQuery) => TFile[];
  /** The viewer for a tool-output file, or null when the row should fall through to text or a download. */
  classifyAttachment?: (attachment: TAttachment) => AttachmentArtifact | null;
  /** Draws the viewer `classifyAttachment` named. */
  renderAttachmentArtifact?: (props: {
    attachment: TAttachment;
    artifact: AttachmentArtifact;
  }) => ReactNode;
}

function attachmentPreview(attachment: TAttachment | undefined): AttachmentPreview {
  const record = attachment as { status?: string; previewError?: string } | undefined;
  if (record?.status === 'pending' || record?.status === 'failed') {
    return { status: record.status, previewError: record.previewError };
  }
  return { status: 'ready' };
}

type ReadyFilesHost = FilesHost & {
  useAttachmentDownload: NonNullable<FilesHost['useAttachmentDownload']>;
  useAttachmentPreview: NonNullable<FilesHost['useAttachmentPreview']>;
  useKnownFiles: NonNullable<FilesHost['useKnownFiles']>;
  classifyAttachment: NonNullable<FilesHost['classifyAttachment']>;
  renderAttachmentArtifact: NonNullable<FilesHost['renderAttachmentArtifact']>;
};

/** Without a host, attachments still render; a provider-stored file just carries no mark. */
const fallbackHost: ReadyFilesHost = {
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
  useAttachmentDownload: () => () => undefined,
  useAttachmentPreview: attachmentPreview,
  useKnownFiles: () => [],
  classifyAttachment: () => null,
  renderAttachmentArtifact: () => null,
};

function isReadyFilesHost(host: FilesHost): host is ReadyFilesHost {
  return (
    host.useAttachmentDownload != null &&
    host.useAttachmentPreview != null &&
    host.useKnownFiles != null &&
    host.classifyAttachment != null &&
    host.renderAttachmentArtifact != null
  );
}

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

/**
 * The host of the nearest provider, or one that draws no provider marks.
 * A provider that only supplies the composer members still downloads nothing and classifies
 * no artifact; the message rows read those from the fallback.
 */
export function useFilesHost(): ReadyFilesHost {
  const host = useContext(FilesHostContext);
  if (isReadyFilesHost(host)) {
    return host;
  }
  return {
    renderEndpointIcon: host.renderEndpointIcon,
    useDeleteFile: host.useDeleteFile,
    getPreviewUrl: host.getPreviewUrl,
    useAttachmentDownload: host.useAttachmentDownload ?? fallbackHost.useAttachmentDownload,
    useAttachmentPreview: host.useAttachmentPreview ?? fallbackHost.useAttachmentPreview,
    useKnownFiles: host.useKnownFiles ?? fallbackHost.useKnownFiles,
    classifyAttachment: host.classifyAttachment ?? fallbackHost.classifyAttachment,
    renderAttachmentArtifact:
      host.renderAttachmentArtifact ?? fallbackHost.renderAttachmentArtifact,
  };
}
