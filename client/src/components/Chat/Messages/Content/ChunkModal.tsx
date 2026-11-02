import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ExternalLink, X } from 'lucide-react';
import { notifyBklSourcesChanged } from '~/utils/bklSourcesEvent';
import { displayNameFromMeta } from '~/utils/displayName';

export type BklSource = {
  source?: {
    url?: string;
    embed_url?: string;
    imanage_url?: string;
    imanage_preview_url?: string;
    imanage_folder_url?: string;
    bims_url?: string;
  };
  document: string[];
  metadata: Array<{
    name?: string;
    file_name?: string;
    page_info?: string;
    relevance?: number | string;
    [key: string]: unknown;
  }>;
};

type ChunkModalProps = {
  isOpen: boolean;
  onClose: () => void;
  source: BklSource | null;
  citationNumber: number;
  messageId?: string;
};

const _LS_PREFIX = 'bkl_src_';

function hasImanageUrl(source: BklSource | null): boolean {
  const meta = source?.metadata?.[0];
  return Boolean(
    source?.source?.imanage_url ||
      source?.source?.imanage_preview_url ||
      (typeof meta?.imanage_url === 'string' && meta.imanage_url) ||
      (typeof meta?.imanage_preview_url === 'string' && meta.imanage_preview_url),
  );
}

function hasImanageFolderUrl(source: BklSource | null): boolean {
  const meta = source?.metadata?.[0];
  return Boolean(
    source?.source?.imanage_folder_url ||
      (typeof meta?.imanage_folder_url === 'string' && meta.imanage_folder_url),
  );
}

function hasBimsUrl(source: BklSource | null): boolean {
  const meta = source?.metadata?.[0];
  return Boolean(
    source?.source?.bims_url ||
      (typeof meta?.bims_url === 'string' && meta.bims_url),
  );
}

function getDocId(source: BklSource | null): string | null {
  const meta = source?.metadata?.[0];
  if (typeof meta?.doc_id === 'string' && meta.doc_id) return meta.doc_id;

  const sourceUrl = source?.source?.url ?? source?.source?.embed_url;
  if (!sourceUrl?.includes('/v1/source-files/')) return null;
  return (
    decodeURIComponent(sourceUrl.split('/v1/source-files/')[1]?.split(/[?#]/)[0] ?? '') || null
  );
}

function withImanageLinks(
  source: BklSource,
  links: { imanageUrl?: string | null; imanageFolderUrl?: string | null; bimsUrl?: string | null },
): BklSource {
  const metadata = source.metadata?.length
    ? [
        {
          ...source.metadata[0],
          ...(links.imanageUrl
            ? { imanage_url: links.imanageUrl, imanage_preview_url: links.imanageUrl }
            : {}),
          ...(links.imanageFolderUrl ? { imanage_folder_url: links.imanageFolderUrl } : {}),
          ...(links.bimsUrl ? { bims_url: links.bimsUrl } : {}),
        },
      ]
    : source.metadata;
  return {
    ...source,
    source: {
      ...source.source,
      ...(links.imanageUrl
        ? { imanage_url: links.imanageUrl, imanage_preview_url: links.imanageUrl }
        : {}),
      ...(links.imanageFolderUrl ? { imanage_folder_url: links.imanageFolderUrl } : {}),
      ...(links.bimsUrl ? { bims_url: links.bimsUrl } : {}),
    },
    metadata,
  };
}

function getRequestId(messageId?: string): string | null {
  if (!messageId) return null;
  const win = window as any;
  const fromMemory = win.__bklRids?.[messageId];
  if (typeof fromMemory === 'string' && fromMemory) return fromMemory;

  try {
    const raw = localStorage.getItem(`${_LS_PREFIX}${messageId}`);
    if (!raw) return null;
    const { r } = JSON.parse(raw);
    return typeof r === 'string' && r ? r : null;
  } catch {
    return null;
  }
}

function cacheSources(
  messageId: string | undefined,
  requestId: string | null,
  sources: BklSource[],
) {
  if (!messageId || !sources.length) return;
  const win = window as any;
  win.__bklSources = win.__bklSources ?? {};
  win.__bklSources[messageId] = sources;
  if (requestId) {
    win.__bklSourcesByRid = win.__bklSourcesByRid ?? {};
    win.__bklSourcesByRid[requestId] = sources;
  }
  notifyBklSourcesChanged();
  try {
    localStorage.setItem(`${_LS_PREFIX}${messageId}`, JSON.stringify({ s: sources, r: requestId }));
  } catch {
    /* in-memory cache is enough if localStorage is unavailable */
  }
}

async function fetchSources(
  requestId: string | null,
  messageId?: string,
): Promise<{ sources: BklSource[]; requestId: string | null } | null> {
  const url = requestId
    ? `/bkl/v1/sources/${requestId}`
    : messageId
      ? `/bkl/v1/sources/by-message/${encodeURIComponent(messageId)}`
      : null;
  if (!url) return null;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = await resp.json();
  const sources = data.sources ?? data;
  if (!Array.isArray(sources)) return null;
  return { sources, requestId: requestId ?? data.request_id ?? null };
}

async function fetchImanageLinksByDocId(
  docId: string,
): Promise<{ imanageUrl: string | null; imanageFolderUrl: string | null; bimsUrl: string | null } | null> {
  const resp = await fetch(`/bkl/v1/imanage-links/${encodeURIComponent(docId)}`);
  if (!resp.ok) return null;
  const data = await resp.json();
  return {
    imanageUrl: data.imanage_url ?? data.imanage_preview_url ?? null,
    imanageFolderUrl: data.imanage_folder_url ?? null,
    bimsUrl: data.bims_url ?? null,
  };
}

export default function ChunkModal({
  isOpen,
  onClose,
  source,
  citationNumber,
  messageId,
}: ChunkModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const attemptedEnrichmentRef = useRef<string | null>(null);
  const [resolvedSource, setResolvedSource] = useState<BklSource | null>(source);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    setResolvedSource(source);
  }, [source]);

  useEffect(() => {
    if (
      !isOpen ||
      !citationNumber ||
      (hasImanageUrl(resolvedSource) && hasImanageFolderUrl(resolvedSource) && hasBimsUrl(resolvedSource))
    ) {
      return;
    }

    let cancelled = false;
    const docId = getDocId(resolvedSource);
    const requestId = getRequestId(messageId);
    const attemptKey = `${messageId ?? 'unknown'}:${citationNumber}:${docId ?? requestId ?? 'latest'}`;
    if (attemptedEnrichmentRef.current === attemptKey) {
      return;
    }
    attemptedEnrichmentRef.current = attemptKey;

    (async () => {
      if (docId && resolvedSource) {
        const links = await fetchImanageLinksByDocId(docId);
        if (cancelled) return;
        if (links?.imanageUrl || links?.imanageFolderUrl || links?.bimsUrl) {
          setResolvedSource(withImanageLinks(resolvedSource, links));
          return;
        }
      }

      const result = await fetchSources(requestId, messageId);
      if (cancelled || !result) return;
      cacheSources(messageId, result.requestId, result.sources);
      const nextSource = result.sources[citationNumber - 1] ?? null;
      if (nextSource) setResolvedSource(nextSource);
    })().catch(() => {
      /* Leave the existing source visible if enrichment fails. */
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, citationNumber, messageId, resolvedSource]);

  const activeSource = useMemo(() => resolvedSource ?? source, [resolvedSource, source]);
  const meta = activeSource?.metadata?.[0];
  // 표시명: `_{document_number}`·OCR `.md` 제거 (FILENAME_DISPLAY_FIX_SPEC)
  const fileName = displayNameFromMeta(meta, '출처 문서');
  const pageInfo = meta?.page_info;
  const relevanceRaw = meta?.relevance;
  const chunkText = activeSource?.document?.[0] ?? '';
  const imanageUrl =
    activeSource?.source?.imanage_url ??
    activeSource?.source?.imanage_preview_url ??
    (typeof meta?.imanage_url === 'string' ? meta.imanage_url : undefined) ??
    (typeof meta?.imanage_preview_url === 'string' ? meta.imanage_preview_url : undefined);
  const imanageFolderUrl =
    activeSource?.source?.imanage_folder_url ??
    (typeof meta?.imanage_folder_url === 'string' ? meta.imanage_folder_url : undefined);
  const bimsUrl =
    activeSource?.source?.bims_url ??
    (typeof meta?.bims_url === 'string' ? meta.bims_url : undefined);

  // relevance: 0–1이면 *100, 이미 0–100이면 그대로 (100 초과 시 100으로 캡)
  const relevanceDisplay =
    relevanceRaw == null
      ? null
      : typeof relevanceRaw === 'number'
        ? relevanceRaw <= 1
          ? `${(relevanceRaw * 100).toFixed(1)}%`
          : `${Math.min(100, Math.round(relevanceRaw)).toFixed(0)}%`
        : String(relevanceRaw);

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[201] max-h-[80vh] w-[min(90vw,680px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border-medium bg-surface-primary shadow-2xl outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            closeButtonRef.current?.focus();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex items-start justify-between border-b border-border-medium px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-text-primary">{fileName}</h2>
              <div className="mt-1 flex items-center gap-3 text-xs text-text-secondary">
                {pageInfo && <span>{pageInfo}</span>}
                {relevanceDisplay && (
                  <span className="rounded bg-surface-secondary px-1.5 py-0.5">
                    관련도 {relevanceDisplay}
                  </span>
                )}
              </div>
            </div>
            <div className="ml-3 flex flex-shrink-0 items-center gap-1">
              {imanageUrl ? (
                <a
                  href={imanageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
                  aria-label="iManage 파일 보기"
                  title="iManage 파일 보기"
                >
                  <ExternalLink className="size-3.5" />
                  iM 파일
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  className="inline-flex h-7 cursor-not-allowed items-center gap-1 rounded-md px-2 text-xs text-text-tertiary opacity-70"
                  aria-label="iManage 링크 확인 중"
                  title="iManage 링크 확인 중"
                >
                  <ExternalLink className="size-3.5" />
                  iM 파일
                </button>
              )}
              {imanageFolderUrl ? (
                <a
                  href={imanageFolderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
                  aria-label="iManage 폴더 보기"
                  title="iManage 폴더 보기"
                >
                  <ExternalLink className="size-3.5" />
                  iM 폴더
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  className="inline-flex h-7 cursor-not-allowed items-center gap-1 rounded-md px-2 text-xs text-text-tertiary opacity-70"
                  aria-label="iManage 폴더 없음"
                  title="iManage 폴더 없음"
                >
                  <ExternalLink className="size-3.5" />
                  iM 폴더
                </button>
              )}
              {bimsUrl && (
                <button
                  type="button"
                  onClick={() => {
                    window.open(
                      bimsUrl,
                      'bims_popup',
                      'width=1000,height=800,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes',
                    );
                  }}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
                  aria-label="BIMS 보기"
                  title="BIMS 보기"
                >
                  <ExternalLink className="size-3.5" />
                  BIMS
                </button>
              )}
              <button
                ref={closeButtonRef}
                onClick={onClose}
                className="rounded-md p-1 text-text-secondary hover:bg-surface-secondary hover:text-text-primary"
                aria-label="닫기"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="overflow-y-auto px-5 py-4" style={{ maxHeight: 'calc(80vh - 80px)' }}>
            {chunkText ? (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-text-primary">
                {chunkText}
              </pre>
            ) : (
              <p className="text-sm text-text-secondary">내용을 불러올 수 없습니다.</p>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
