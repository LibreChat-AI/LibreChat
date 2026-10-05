import { useCallback, useMemo, useState, lazy, Suspense } from 'react';
import { useStore } from 'jotai';
import { getEndpointFileConfig, isAgentsEndpoint, mergeFileConfig } from 'librechat-data-provider';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogDescription,
} from '@librechat/client';
import type { MediaAsset, TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { getViableUploadOptions, validateFileLimit, validateFileSizes } from '~/utils/files';
import useAgentUploadTarget from '~/hooks/Agents/useAgentUploadTarget';
import { openMediaEditDraft } from '~/components/Media/seeding';
import { useMediaAccess } from '~/hooks/Media/useMediaAccess';
import { MediaHostProvider } from '~/components/Media/host';
import { useMediaShellHost } from '~/hooks/Media/host';
import { useGetFileConfig } from '~/data-provider';
import { useMediaChatHandoff } from './handoff';
import { useLocalize } from '~/hooks';

const MediaWorkspace = lazy(() => import('~/components/Media/Workspace'));

type ChatMediaProps = {
  conversation: TConversation | null;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  disabled: boolean;
  temporary: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** The host adapter binds permissions, composer shortcuts and identity; none of that is worth
 * paying for on a deployment that has not turned Studio on in chat. */
export default function ChatMedia(props: ChatMediaProps) {
  const { chat, studio } = useMediaAccess();
  if (!chat && !studio) return null;
  return <ChatMediaEnabled {...props} />;
}

function ChatMediaEnabled({
  conversation,
  files,
  setFiles,
  disabled,
  temporary,
  open,
  onOpenChange: setOpen,
}: ChatMediaProps) {
  const localize = useLocalize();
  const [threadId, setThreadId] = useState<string>();
  const [error, setError] = useState(false);
  const { agentProvider, endpointType, useResponsesApi } = useAgentUploadTarget(conversation);
  const config = useGetFileConfig({ select: (data) => mergeFileConfig(data) });
  const attach = useCallback(
    async (asset: MediaAsset) => {
      const endpoint = isAgentsEndpoint(conversation?.endpoint)
        ? agentProvider
        : conversation?.endpoint;
      if (!config.isSuccess || !endpoint) throw new Error('Destination policy unavailable');
      const policy = getEndpointFileConfig({ fileConfig: config.data, endpoint, endpointType });
      const viable = getViableUploadOptions([new File([], asset.filename, { type: asset.type })], {
        provider: agentProvider,
        endpoint: conversation?.endpoint,
        endpointType,
        useResponsesApi,
        fileSearchEnabled: false,
        codeEnabled: false,
        contextEnabled: false,
        fileSearchAllowedByAgent: false,
        codeAllowedByAgent: false,
        fileConfig: config.data,
        endpointSupportedMimeTypes: policy.supportedMimeTypes,
      });
      const otherFiles = new Map(files);
      otherFiles.delete(asset.file_id);
      const validation = {
        files: otherFiles,
        fileList: [{ size: asset.bytes }],
        endpointFileConfig: policy,
        setError: () => {},
      };
      if (
        disabled ||
        policy.disabled ||
        !viable.includes(undefined) ||
        !validateFileLimit(validation) ||
        !validateFileSizes(validation)
      ) {
        throw new Error('Destination cannot accept this file');
      }
      setFiles((previous) =>
        new Map(previous).set(asset.file_id, {
          ...asset,
          size: asset.bytes,
          progress: 1,
          attached: true,
        }),
      );
      setOpen(false);
      setError(false);
    },
    [
      agentProvider,
      conversation?.endpoint,
      config.isSuccess,
      config.data,
      endpointType,
      useResponsesApi,
      files,
      disabled,
      setFiles,
      setOpen,
    ],
  );
  const actions = useMemo(
    () => ({ openThread: (id: string) => setThreadId(id || undefined), useInChat: attach }),
    [attach],
  );
  const { host } = useMediaShellHost(actions);
  const store = useStore();
  const destination = conversation?.conversationId ?? 'new';
  const { dismiss } = useMediaChatHandoff({
    scope: host?.scope,
    conversationId: destination,
    ready: config.isSuccess,
    isCurrentSession: host?.isCurrentSession,
    attach,
    onError: () => setError(true),
  });
  const references = [...files.values()].filter(
    (file) =>
      file.progress === 1 && file.type?.startsWith('image/') && file.filepath && file.filename,
  );
  if (!host) return null;
  return (
    <>
      {error && (
        <div role="alert" className="text-sm">
          <p>{localize('com_media_chat_unsupported')}</p>
          <Button
            variant="ghost"
            onClick={() => {
              dismiss();
              setError(false);
            }}
          >
            {localize('com_ui_dismiss')}
          </Button>
        </div>
      )}
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogContent className="flex h-[90dvh] max-w-6xl flex-col overflow-hidden">
          <OGDialogTitle>{localize('com_media_create')}</OGDialogTitle>
          <OGDialogDescription>{localize('com_media_chat_description')}</OGDialogDescription>
          {temporary ? (
            <p role="status">{localize('com_media_temporary')}</p>
          ) : (
            <>
              {references.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const assets: MediaAsset[] = references.map((file) => ({
                      file_id: file.file_id,
                      filename: file.filename!,
                      filepath: file.filepath!,
                      type: file.type!,
                      bytes: file.size,
                      width: file.width,
                      height: file.height,
                    }));
                    openMediaEditDraft(store, host.scope, assets);
                    setThreadId(undefined);
                  }}
                >
                  {localize('com_media_edit_attachments')}
                </Button>
              )}
              <MediaHostProvider value={host}>
                <Suspense fallback={<p role="status">{localize('com_media_loading')}</p>}>
                  <MediaWorkspace threadId={threadId} />
                </Suspense>
              </MediaHostProvider>
            </>
          )}
        </OGDialogContent>
      </OGDialog>
    </>
  );
}
