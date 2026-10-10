import { memo, useRef, useMemo, useState, useEffect } from 'react';
import { Eye, Search } from 'lucide-react';
import { apiBaseUrl } from 'librechat-data-provider';
import { Button, IconButton, Spinner, useToastContext } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import FilePreviewDialog, {
  formatBytes,
  getDisplayType,
} from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { getPreviewKind } from '~/components/Chat/Messages/Content/preview';
import { getFileType, toAbsoluteFilePath, triggerDownload } from '~/utils';
import DialogImage from '~/components/Chat/Messages/Content/DialogImage';
import FilePreview from '~/components/Chat/Input/Files/FilePreview';
import { useGetFiles, useFilePreviewBlob } from '~/data-provider';
import { useLocalize, useAuthContext } from '~/hooks';

export type FileView = 'all' | 'images' | 'documents';

export const FILE_VIEWS: Array<{ value: FileView; labelKey: TranslationKeys }> = [
  { value: 'all', labelKey: 'com_ui_all_proper' },
  { value: 'images', labelKey: 'com_ui_composer_files_images' },
  { value: 'documents', labelKey: 'com_ui_composer_files_documents' },
];

const NO_FILES: TFile[] = [];

const isImage = (file: TFile) => file.type?.startsWith('image/') === true;

/** Images, audio and video are media; everything else is a document. */
const isDocument = (file: TFile) =>
  !isImage(file) &&
  file.type?.startsWith('audio/') !== true &&
  file.type?.startsWith('video/') !== true;

/** What a card's preview button opens, if anything: images in the message
 *  image viewer, PDFs in the message file preview. */
function previewOf(file: TFile): 'image' | 'pdf' | null {
  if (isImage(file)) {
    return 'image';
  }
  return getPreviewKind(file.filename ?? '', file.type ?? undefined, file.source) === 'pdf'
    ? 'pdf'
    : null;
}

function formatDate(file: TFile): string {
  const raw = file.updatedAt ?? file.createdAt;
  if (raw == null) {
    return '';
  }
  return new Date(raw).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** The image itself for images, so the card is recognisable at a glance; the
 *  file-type tile otherwise, or when the image cannot be loaded. */
function Thumbnail({ file }: { file: TFile }) {
  const [failed, setFailed] = useState(false);
  if (isImage(file) && !failed && file.filepath) {
    return (
      <span
        aria-hidden="true"
        className="bg-surface-tertiary size-10 shrink-0 overflow-hidden rounded-xl"
      >
        <img
          src={toAbsoluteFilePath(file.filepath, apiBaseUrl())}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="shrink-0">
      <FilePreview file={file} fileType={getFileType(file.type)} className="size-10 rounded-xl" />
    </span>
  );
}

interface FileCardProps {
  file: TFile;
  onAttach: (file: TFile) => void;
  onPreview: (file: TFile, trigger: HTMLButtonElement) => void;
  disabled?: boolean;
}

/** Laid out like the skill and MCP cards: the card is the attach action, and
 *  the corner holds the one secondary action, previewing, where they keep the
 *  favourite star. */
const FileCard = memo(function FileCard({ file, onAttach, onPreview, disabled }: FileCardProps) {
  const localize = useLocalize();
  const name = file.filename ?? '';
  const details = [
    getDisplayType(localize, file.type ?? undefined, name),
    formatBytes(file.bytes ?? 0),
  ];
  const canPreview = previewOf(file) != null;

  return (
    <div className="group border-border-light hover:border-border-medium hover:bg-surface-tertiary relative flex h-28 w-full flex-col overflow-hidden rounded-2xl border bg-transparent hover:shadow-xs">
      <button
        type="button"
        onClick={() => onAttach(file)}
        disabled={disabled}
        className="focus-visible:ring-ring-primary flex h-full w-full cursor-pointer flex-col gap-2 rounded-2xl p-4 text-left focus:outline-hidden focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex w-full min-w-0 items-start gap-3">
          <Thumbnail file={file} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-text-primary truncate text-sm font-semibold">{name}</span>
            <span className="text-text-secondary truncate text-xs">{details.join(' · ')}</span>
          </span>
        </span>
        <span className="text-text-secondary mt-auto text-xs">{formatDate(file)}</span>
      </button>
      {canPreview && (
        <span className="absolute right-2 bottom-2">
          <IconButton
            size="xs"
            shape="square"
            label={localize('com_ui_composer_preview_file', { 0: name })}
            onClick={(event) => onPreview(file, event.currentTarget)}
          >
            <Eye className="text-text-secondary h-4 w-4" aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </div>
  );
});

/** What the grid shows in place of cards: still loading, the list failed to
 *  load, or nothing matches the search and view. */
function EmptyState({
  loading,
  failed,
  onRetry,
  text,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  text?: string;
}) {
  const localize = useLocalize();
  if (loading) {
    return (
      <div role="status" className="text-text-secondary flex items-center justify-center py-16">
        <Spinner size={24} />
        <span className="sr-only">{localize('com_ui_loading')}</span>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <p role="alert" className="text-text-secondary text-sm">
          {localize('com_ui_error_connection')}
        </p>
        {/* The files query does not refetch on mount, focus or reconnect, so
            reopening the dialog would not recover without this. */}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  }
  return (
    <div role="status" className="flex flex-col items-center justify-center py-16 text-center">
      <Search className="text-text-tertiary size-8 opacity-40" aria-hidden="true" />
      <p className="text-text-secondary mt-3 text-sm">
        {text ?? localize('com_ui_composer_no_results')}
      </p>
    </div>
  );
}

/** Files from somewhere other than the user's whole library, such as a
 *  server-filtered list of the files a project can take. */
export interface FileGridSource {
  files: TFile[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

interface FileGridProps {
  query: string;
  view: FileView;
  onAttach: (file: TFile) => void;
  source?: FileGridSource;
  disabled?: boolean;
  emptyText?: string;
}

/** The user's files as cards, filtered by name and kind, with a preview for
 *  anything the message viewers can show. */
export default function FileGrid({
  query,
  view,
  onAttach,
  source,
  disabled,
  emptyText,
}: FileGridProps) {
  const localize = useLocalize();
  const library = useGetFiles<TFile[]>({ enabled: source == null });
  const files = source?.files ?? library.data ?? NO_FILES;
  const isLoading = source?.isLoading ?? library.isLoading;
  const isError = source?.isError ?? library.isError;
  const refetch = source?.refetch ?? library.refetch;
  const [previewing, setPreviewing] = useState<TFile | null>(null);
  /** The Preview button that opened the viewer, where focus returns on close. */
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openPreview = (file: TFile, trigger: HTMLButtonElement) => {
    previewTriggerRef.current = trigger;
    setPreviewing(file);
  };

  const visible = useMemo(
    () =>
      files.filter((file) => {
        if (query !== '' && file.filename?.toLowerCase().includes(query) !== true) {
          return false;
        }
        if (view === 'images') {
          return isImage(file);
        }
        if (view === 'documents') {
          return isDocument(file);
        }
        return true;
      }),
    [files, query, view],
  );

  const previewKind = previewing != null ? previewOf(previewing) : null;

  /* The image is fetched through the backend by id, as the PDF preview is,
     rather than from its stored link: a signed storage link can expire between
     the list refreshing it and the preview opening. The link is the fallback. */
  const { user } = useAuthContext();
  const { refetch: fetchPreview } = useFilePreviewBlob(user?.id, previewing?.file_id);
  const { showToast } = useToastContext();
  /* Read through a ref: `showToast` is a new function each render, and the
     preview effect must not refetch because of it. */
  const previewFailedRef = useRef<(file: TFile) => void>(() => undefined);
  previewFailedRef.current = (file: TFile) => {
    showToast({
      message: localize('com_ui_composer_preview_failed', { 0: file.filename ?? '' }),
      status: 'error',
    });
    setPreviewing(null);
  };
  const [imageUrl, setImageUrl] = useState<string>();
  useEffect(() => {
    if (previewKind !== 'image' || previewing == null) {
      return;
    }
    let objectUrl: string | undefined;
    let cancelled = false;
    void fetchPreview().then(({ data }) => {
      if (cancelled) {
        return;
      }
      if (data != null) {
        objectUrl = URL.createObjectURL(data);
        setImageUrl(objectUrl);
        return;
      }
      /* Nothing to show: stay on the grid and say so, rather than open an
         empty viewer or let the click appear to do nothing. */
      const fail = () => previewFailedRef.current(previewing);
      if (!previewing.filepath) {
        fail();
        return;
      }
      /* A stored link can be expired: open only once it actually loads. */
      const fallback = toAbsoluteFilePath(previewing.filepath, apiBaseUrl());
      const probe = new Image();
      probe.onload = () => !cancelled && setImageUrl(fallback);
      probe.onerror = () => !cancelled && fail();
      probe.src = fallback;
    });
    return () => {
      cancelled = true;
      if (objectUrl != null) {
        URL.revokeObjectURL(objectUrl);
      }
      setImageUrl(undefined);
    };
  }, [previewKind, previewing, fetchPreview]);

  const closePreview = (open: boolean) => {
    if (!open) {
      setPreviewing(null);
    }
  };

  return (
    <>
      {visible.length === 0 ? (
        <EmptyState
          loading={isLoading}
          failed={isError && files.length === 0}
          onRetry={() => void refetch()}
          text={emptyText}
        />
      ) : (
        <>
          {/* Announces how many files the search and view leave, without making the
              interactive cards themselves a live region. */}
          <p className="sr-only" role="status" aria-live="polite">
            {localize('com_ui_search_results_count', { count: visible.length })}
          </p>
          <ul
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
            aria-label={localize('com_ui_composer_files')}
          >
            {visible.map((file) => (
              <li key={file.file_id}>
                <FileCard
                  file={file}
                  onAttach={onAttach}
                  onPreview={openPreview}
                  disabled={disabled}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <DialogImage
        isOpen={previewKind === 'image' && imageUrl != null}
        onOpenChange={closePreview}
        src={imageUrl}
        triggerRef={previewTriggerRef}
        showDetails={false}
        title={previewing?.filename ?? undefined}
        downloadImage={() => {
          if (imageUrl != null) {
            triggerDownload(imageUrl, previewing?.filename ?? 'image');
          }
        }}
      />
      <FilePreviewDialog
        open={previewKind === 'pdf'}
        onOpenChange={closePreview}
        fileName={previewing?.filename ?? ''}
        fileId={previewing?.file_id}
        filePath={previewing?.filepath}
        fileType={previewing?.type ?? undefined}
        fileSource={previewing?.source}
        fileSize={previewing?.bytes}
        deliveryPath={previewing?.llmDeliveryPath}
        triggerRef={previewTriggerRef}
      />
    </>
  );
}
