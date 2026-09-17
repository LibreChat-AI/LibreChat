import { memo, useMemo, useState, useEffect, useCallback } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import type { TFile, TMessage } from 'librechat-data-provider';
import SteerReceipt, { type SteerReceiptState } from '~/components/Chat/Steering/Receipt';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import MessageTimestamp from '~/components/Chat/Messages/ui/MessageTimestamp';
import MessageQuotes from '~/components/Chat/Messages/Content/MessageQuotes';
import { cn, hydrateFileDeliveryMetadata, usesImagePreview } from '~/utils';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { useFileMapContext, useShareContext } from '~/Providers';
import Image from '~/components/Chat/Messages/Content/Image';
import CollapsibleText from './CollapsibleText';
import { useLocalize } from '~/hooks';
import store from '~/store';

/**
 * A mid-run steering message rendered as a standard user message inside the
 * assistant response, with the same compact surface and text presentation as any
 * user turn, placed where the words enter the run so the visible order equals
 * what the next turn replays (`ContentTypes.STEER` splits back into a
 * HumanMessage server-side). Only the server-applied part renders here, at its
 * authoritative index; a steer still in flight lives in the composer's chip
 * stack. Renders identically live, on reload, and in shared/search views.
 */
const SteerPart = memo(function SteerPart({
  steer,
  files,
  quotes,
  steerId,
  createdAt,
  isSubmitting = false,
  receiptState = 'applied',
}: {
  steer: string;
  files?: TMessage['files'];
  /** Quoted excerpts steered with the message; rendered as the same reference
   *  blocks a user bubble shows for `message.quotes`. */
  quotes?: string[];
  /** Anchors the part for the message-nav rail (`#steer-<id>` rib target). */
  steerId?: string;
  createdAt?: number;
  /** The owning response is still generating: the receipt keeps its amber
   *  steering identity while it is the live thing at the end, then settles
   *  to timestamp gray (always settled on reload, share, and search). */
  isSubmitting?: boolean;
  /** Pending renderer state must never claim server application early. */
  receiptState?: SteerReceiptState;
}) {
  const localize = useLocalize();
  /** Read the atom rather than the auth context: AuthContextProvider mirrors the
   *  user into it, and the public share route mounts outside that provider. */
  const user = useRecoilValue(store.user);
  const { isSharedConvo } = useShareContext();
  const fileMap = useFileMapContext();
  const usernameDisplay = useRecoilValue<boolean>(store.UsernameDisplay);
  const enableUserMsgMarkdown = useRecoilValue<boolean>(store.enableUserMsgMarkdown);
  const collapseLongUserMessages = useRecoilValue<boolean>(store.collapseLongUserMessages);

  /** The share surface must never label the SHARER's steers with the
   *  viewer's identity; always the generic user label there. */
  const label = useMemo(() => {
    if (isSharedConvo === true || !usernameDisplay) {
      return localize('com_user_message');
    }
    return (user?.name ?? '') || user?.username || localize('com_user_message');
  }, [isSharedConvo, usernameDisplay, user?.name, user?.username, localize]);
  const timestamp = useMemo(
    () => (createdAt != null ? new Date(createdAt).toISOString() : null),
    [createdAt],
  );
  const hydratedFiles = useMemo(
    () => hydrateFileDeliveryMetadata(files, undefined, fileMap),
    [files, fileMap],
  );
  const imageFiles = useMemo(() => hydratedFiles?.filter(usesImagePreview) ?? [], [hydratedFiles]);
  const otherFiles = useMemo(
    () => hydratedFiles?.filter((file) => !usesImagePreview(file)) ?? [],
    [hydratedFiles],
  );
  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);
  const handlePreviewClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  /** The receipt draw-in plays exactly once, at the live chip→inline hand-off:
   *  the applied handler stamps the id as it commits the part, the render that
   *  first sees each identity captures it, and the effect consumes it so a
   *  remount (conversation revisit, reload, share view) renders the settled
   *  checks without motion. Captured per IDENTITY, not per mount — a content
   *  slot can be overwritten with a different steer (`applySteerPart` permits
   *  replacement at an index) while React reuses this component — and every
   *  identity consumes its id whether it animated or not, so nothing lingers.
   *  The membership selector scopes the subscription to THIS id — stamping or
   *  consuming one steer never re-renders the other mounted parts. */
  const isLiveApplied = useRecoilValue(store.liveAppliedSteerFamily(steerId ?? ''));
  const setLiveAppliedIds = useSetRecoilState(store.liveAppliedSteerIds);
  const [captured, setCaptured] = useState<{ id: string | undefined; animate: boolean }>({
    id: steerId,
    animate: isLiveApplied,
  });
  if (captured.id !== steerId) {
    setCaptured({ id: steerId, animate: isLiveApplied });
  }
  const animateIn = captured.id === steerId && captured.animate;
  useEffect(() => {
    if (steerId == null || steerId.length === 0) {
      return;
    }
    setLiveAppliedIds((prev) =>
      prev.includes(steerId) ? prev.filter((id) => id !== steerId) : prev,
    );
  }, [steerId, setLiveAppliedIds]);

  if (typeof steer !== 'string' || steer.length === 0) {
    return null;
  }

  return (
    <div
      id={steerId ? `steer-${steerId}` : undefined}
      className="steer-render group relative my-5 flex w-full justify-end"
      data-testid="steer-part"
    >
      <div className="user-turn relative flex w-fit max-w-[90%] flex-col items-end sm:max-w-[85%]">
        <h2 className="sr-only">{label}</h2>
        <div className="flex max-w-full flex-col items-start gap-2 rounded-theme-surface rounded-br-theme-control bg-surface-tertiary px-theme-normal py-2.5">
          <MessageQuotes quotes={quotes} />
          {(imageFiles.length > 0 || otherFiles.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {otherFiles.map((file) => (
                <FileContainer
                  key={file.file_id}
                  file={file as TFile}
                  onClick={() => setSelectedFile(file)}
                />
              ))}
              {imageFiles.map((file) => (
                <Image
                  key={file.file_id}
                  imagePath={file.preview ?? file.filepath ?? ''}
                  height={file.height ?? 1920}
                  width={file.width ?? 1080}
                  altText={file.filename ?? localize('com_ui_attached_image')}
                />
              ))}
            </div>
          )}
          <CollapsibleText enabled={collapseLongUserMessages}>
            <div
              className={cn(
                'markdown prose message-content dark:prose-invert light w-full break-words',
                !enableUserMsgMarkdown && 'whitespace-pre-wrap',
                'text-text-primary',
              )}
            >
              {enableUserMsgMarkdown ? <MarkdownLite content={steer} /> : steer}
            </div>
          </CollapsibleText>
        </div>
        {/* The receipt trails the timestamp so the always-visible checks sit
         *  flush under the bubble's bottom-right corner. Leading them would
         *  park them wherever the hover-revealed time happens to end, and that
         *  width changes as the relative string ticks. */}
        <div className="mt-1 flex min-h-8 items-center justify-end gap-2 text-text-secondary">
          <MessageTimestamp value={timestamp} className="ml-0" />
          <SteerReceipt state={receiptState} live={isSubmitting} animateIn={animateIn} />
        </div>
      </div>
      {otherFiles.length > 0 && (
        <FilePreviewDialog
          open={selectedFile !== null}
          onOpenChange={handlePreviewClose}
          fileName={selectedFile?.filename ?? ''}
          fileId={selectedFile?.file_id}
          filePath={selectedFile?.filepath}
          fileType={selectedFile?.type ?? undefined}
          fileSource={selectedFile?.source}
          fileSize={(selectedFile as TFile | null)?.bytes}
          deliveryPath={selectedFile?.llmDeliveryPath}
        />
      )}
    </div>
  );
});

export default SteerPart;
