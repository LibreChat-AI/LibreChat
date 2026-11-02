import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecoilState } from 'recoil';
import { ChevronLeft, FolderPlus, X } from 'lucide-react';
import { Button } from '@librechat/client';
import store from '~/store';
import { cn, FileTypeIcon } from '~/utils';
import { stripDisplayExtension } from '~/utils/fileTypeIcon';
import { displayNameFromMeta } from '~/utils/displayName';
import AddToProjectPopover from '~/components/Projects/AddToProjectPopover';
import { SourceExternalLink, SourceDisabledLink, SourcePopupLink } from './SourceLinkButtons';
import MarkdownLite from './MarkdownLite';
import type { BklSource } from './ChunkModal';

// Keep in sync with the `duration-*` utilities on the root div below. The
// close animation keeps the component mounted for this long so users see the
// panel slide out before it unmounts.
const CLOSE_ANIM_MS = 300;

/**
 * Right-side panel that displays BKL document citations when the user clicks
 * a `[N]` marker in an assistant message.
 *
 * This component is rendered inside `SidePanelGroup`'s artifact `ResizablePanel`
 * slot (see `Presentation.tsx` — when `activeBklSource` is set, the citation
 * panel replaces any active artifact). That gives us:
 *   - the same resizable right-side surface as LibreChat artifacts,
 *   - the same transition / mobile behaviour (handled by `SidePanelGroup`),
 *   - no custom fixed-position overlay plumbing.
 *
 * The chrome (header, close button, body wrapper) mirrors `Artifacts.tsx`
 * exactly so the citation panel is visually indistinguishable from a native
 * LibreChat side panel.
 *
 * Data lives on `window.__bklSources[messageId]`, populated by the SSE
 * `sources_replace` event and/or a REST fallback in `BklCitation.tsx`. This
 * panel is a passive reader of that cache.
 */

function readSources(messageId: string): BklSource[] | null {
  if (!messageId) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  const mem = win.__bklSources?.[messageId];
  // An empty array is a definitive "server returned no sources" (e.g. all
  // ACL-filtered) — return it so the panel shows a message instead of
  // polling forever. Only `undefined`/missing means "not loaded yet".
  if (Array.isArray(mem)) return mem;
  try {
    const raw = localStorage.getItem('bkl_src_' + messageId);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.s) && parsed.s.length > 0) return parsed.s;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractFileName(metaName: string): string {
  const m = metaName.normalize('NFC').match(/^『(.+?)』/);
  // OCR 파생 `.md` 는 표시에서 제거 (계약서.pdf.md → 계약서.pdf)
  return stripDisplayExtension(m ? m[1] : metaName.normalize('NFC'));
}

function sourceDocId(source: BklSource | null): string | null {
  const meta = source?.metadata?.[0] as Record<string, unknown> | undefined;
  return typeof meta?.doc_id === 'string' && meta.doc_id ? meta.doc_id : null;
}

function sourceHasDisplayMetadata(source: BklSource | null): boolean {
  const meta = source?.metadata?.[0] as Record<string, unknown> | undefined;
  return Boolean(
    meta?.edit_date ||
      meta?.last_user ||
      meta?.custom4 ||
      meta?.custom1_description ||
      meta?.custom29_description,
  );
}

function sourceHasFolderLink(source: BklSource | null): boolean {
  const meta = source?.metadata?.[0] as Record<string, unknown> | undefined;
  return Boolean(
    source?.source?.imanage_folder_url ||
      (typeof meta?.imanage_folder_url === 'string' && meta.imanage_folder_url),
  );
}

function sourceHasBimsLink(source: BklSource | null): boolean {
  const meta = source?.metadata?.[0] as Record<string, unknown> | undefined;
  return Boolean(source?.source?.bims_url || (typeof meta?.bims_url === 'string' && meta.bims_url));
}

type ImanageDetails = Record<string, unknown>;

const IMANAGE_DISPLAY_FIELDS = [
  'edit_date',
  'last_user',
  'custom4',
  'custom1_description',
  'custom29_description',
] as const;

const IMANAGE_LINK_FIELDS = [
  'imanage_url',
  'imanage_preview_url',
  'imanage_folder_url',
  'bims_url',
] as const;

// doc_id → `/v1/imanage-links` 응답. PG `document_tags` 는 세션 중 바뀌지
// 않으므로 문서당 한 번만 왕복하고, 동시 호출은 진행 중인 Promise 를
// 공유한다 (패널 본문과 iM/BIMS 버튼이 같은 doc 을 동시에 찾는다).
// 404(링크 없음)는 정상 응답이므로 null 로 캐시하고, 전송 실패만
// 캐시하지 않아 다음 마운트에서 다시 시도한다.
const imanageDetailsCache = new Map<string, ImanageDetails | null>();
const imanageDetailsInflight = new Map<string, Promise<ImanageDetails | null>>();

function fetchImanageDetails(docId: string): Promise<ImanageDetails | null> {
  if (imanageDetailsCache.has(docId)) {
    return Promise.resolve(imanageDetailsCache.get(docId) ?? null);
  }
  const pending = imanageDetailsInflight.get(docId);
  if (pending) return pending;

  const request = fetch(`/bkl/v1/imanage-links/${encodeURIComponent(docId)}`)
    .then((r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`imanage-links ${r.status}`);
      return r.json() as Promise<ImanageDetails>;
    })
    .then((details) => {
      imanageDetailsCache.set(docId, details);
      return details;
    })
    .catch(() => null)
    .finally(() => {
      imanageDetailsInflight.delete(docId);
    });

  imanageDetailsInflight.set(docId, request);
  return request;
}

/**
 * Merge a `/v1/imanage-links` response into a citation.
 *
 * Returns the ORIGINAL `source` object when the response adds nothing new.
 * That identity stability is load-bearing: the enrichment effect below depends
 * on `current`, which is memoised off `sources`, so handing back a fresh object
 * for a no-op merge re-arms the effect and it re-fetches forever — 2026-09-01
 * 서버 로그가 같은 doc_id 의 `GET /v1/imanage-links/... 200` 으로 도배됐다.
 * 응답에 표시 메타 / 폴더 URL / bims_url 중 하나라도 빠져 있으면
 * 이펙트의 skip 가드가 영영 참이 되지 않기 때문이다.
 */
function withImanageDetails(source: BklSource, details: ImanageDetails): BklSource {
  const meta0 = (source.metadata?.[0] ?? {}) as Record<string, unknown>;
  const src = (source.source ?? {}) as Record<string, unknown>;

  // 메타데이터에는 file/preview URL 을 서로 폴백해 채우고, `source.source`
  // 에는 응답에 실제로 실린 필드만 넣는다 (기존 병합 규칙 그대로).
  const metaUpdates: Record<string, unknown> = {};
  for (const field of IMANAGE_DISPLAY_FIELDS) {
    if (details[field]) metaUpdates[field] = details[field];
  }
  const fileUrl = details.imanage_url ?? details.imanage_preview_url;
  const previewUrl = details.imanage_preview_url ?? details.imanage_url;
  if (fileUrl) metaUpdates.imanage_url = fileUrl;
  if (previewUrl) metaUpdates.imanage_preview_url = previewUrl;
  if (details.imanage_folder_url) metaUpdates.imanage_folder_url = details.imanage_folder_url;
  if (details.bims_url) metaUpdates.bims_url = details.bims_url;

  const srcUpdates: NonNullable<BklSource['source']> = {};
  for (const field of IMANAGE_LINK_FIELDS) {
    const value = details[field];
    if (typeof value === 'string' && value) srcUpdates[field] = value;
  }

  const changed =
    Object.entries(metaUpdates).some(([key, value]) => meta0[key] !== value) ||
    Object.entries(srcUpdates).some(([key, value]) => src[key] !== value);
  if (!changed) return source;

  const metadata = source.metadata?.length ? [...source.metadata] : [{}];
  metadata[0] = { ...meta0, ...metaUpdates } as BklSource['metadata'][number];
  return {
    ...source,
    source: { ...source.source, ...srcUpdates },
    metadata,
  };
}

/**
 * Build the SectionBadge label from PR-B segment metadata. Returns null when
 * the chunk did not come from a segmented .msg.md (legacy index slices, raw
 * PDFs / DOCX, etc.) so the badge area stays empty rather than showing
 * misleading "본문" tags for non-email documents.
 *
 * Body chunks render as just "본문". Attachment chunks fold the index pair
 * + filename together — `첨부 1/3 · 계약서.docx` — so the user can tell at a
 * glance that the cited text came from an attachment of a forwarded thread
 * vs. the main email body.
 */
const _LEADING_SECTION_MARKER_RE =
  /^\s*\[(본문|첨부(?:\s+(\d+)\s*\/\s*(\d+))?(?:\s*[·•]\s*([^\]\n]+))?)\]/u;

function badgeFromChunkMarker(text: string | undefined): {
  kind: 'body' | 'attachment';
  label: string;
  filename?: string;
} | null {
  if (!text) return null;
  const m = text.match(_LEADING_SECTION_MARKER_RE);
  if (!m) return null;
  if (m[1] === '본문') return { kind: 'body', label: '본문' };
  return {
    kind: 'attachment',
    label: m[2] && m[3] ? `첨부 ${m[2]}/${m[3]}` : '첨부',
    filename: m[4]?.trim() || undefined,
  };
}

function getSectionBadge(
  meta: Record<string, unknown> | undefined,
  documentText?: string,
): {
  kind: 'body' | 'attachment';
  label: string;
  filename?: string;
} | null {
  if (!meta) return badgeFromChunkMarker(documentText);
  const kind = (meta.section_kind as string | undefined) ?? null;
  if (!kind) return badgeFromChunkMarker(documentText);
  if (kind === 'attachment') {
    const fallback = badgeFromChunkMarker(documentText);
    const idx = meta.attachment_idx as number | undefined;
    const total = meta.attachment_total as number | undefined;
    const filename = stripDisplayExtension(
      (meta.attachment_filename as string | undefined) ?? fallback?.filename ?? '',
    );
    const counter = idx && total ? `첨부 ${idx}/${total}` : (fallback?.label ?? '첨부');
    return { kind: 'attachment', label: counter, filename };
  }
  if (kind === 'body') {
    return { kind: 'body', label: '본문' };
  }
  return null;
}

function formatRelevance(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    if (raw <= 1) return `${(raw * 100).toFixed(1)}%`;
    return `${Math.min(100, Math.round(raw)).toFixed(0)}%`;
  }
  return String(raw);
}

type BklSourcesPanelProps = {
  /**
   * 대화 패널(BklThreadPanel)에서 렌더될 때 — 헤더 왼쪽에 뒤로가기 버튼을
   * 노출한다. 클릭 시 청크 선택만 해제해 Overview 목록으로 복귀한다.
   */
  onBack?: () => void;
};

export default function BklSourcesPanel({ onBack }: BklSourcesPanelProps = {}) {
  const [active, setActive] = useRecoilState(store.activeBklSource);
  const [sources, setSources] = useState<BklSource[] | null>(null);
  // Flips true when the 20s cache-poll below gives up without sources —
  // the panel then shows a "can't display" message instead of spinning
  // forever (user report 2026-08-07: ACL 로 전부 걸러진 답변에서 "출처를
  // 불러오는 중…" 이 영영 표시됨).
  const [timedOut, setTimedOut] = useState(false);

  // Slide-in / slide-out animation, mirroring `Artifacts.tsx` so the citation
  // panel feels like a first-class LibreChat surface. `isVisible` drives the
  // enter transition (delayed one tick after mount). `isClosing` keeps the
  // panel mounted for CLOSE_ANIM_MS after `onClose`, so the slide-out has
  // time to play before we actually null out the Recoil atom and unmount.
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Re-read cached sources whenever the active messageId changes, and poll
   * briefly if sources haven't arrived yet (the SSE `sources_replace` event
   * may land slightly after the user clicks the very first `[N]`).
   */
  useEffect(() => {
    setTimedOut(false);
    if (!active) {
      setSources(null);
      return;
    }
    const initial = readSources(active.messageId);
    setSources(initial);
    if (initial) return;

    let cancelled = false;
    const iv = setInterval(() => {
      if (cancelled) return;
      const s = readSources(active.messageId);
      if (s) {
        setSources(s);
        clearInterval(iv);
      }
    }, 400);
    const to = setTimeout(() => {
      clearInterval(iv);
      if (!cancelled) setTimedOut(true);
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
      clearTimeout(to);
    };
  }, [active?.messageId]);

  /**
   * Drive the enter animation. Whenever a citation becomes active (either
   * from null → set, or from one `[N]` to another while we're still open),
   * cancel any pending close timer and fire a next-tick `isVisible=true` so
   * the root div transitions from `translate-x-5 opacity-0` → `translate-x-0
   * opacity-100`.
   */
  useEffect(() => {
    if (!active) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsClosing(false);
    const t = setTimeout(() => setIsVisible(true), 30);
    return () => clearTimeout(t);
  }, [active]);

  const onClose = useCallback(() => {
    // Play the slide-out first, then clear the Recoil atom (which unmounts
    // this component via the `!active` guard below).
    setIsClosing(true);
    setIsVisible(false);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setActive(null);
      setIsClosing(false);
      closeTimerRef.current = null;
    }, CLOSE_ANIM_MS);
  }, [setActive]);

  // Cleanup any pending close timer on unmount so we don't late-write to an
  // unmounted tree if the user navigates away mid-animation.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, onClose]);

  const current = useMemo(() => {
    if (!active || !sources) return null;
    return sources[active.n - 1] ?? null;
  }, [active, sources]);

  useEffect(() => {
    if (
      !active ||
      !current ||
      (sourceHasDisplayMetadata(current) &&
        sourceHasFolderLink(current) &&
        sourceHasBimsLink(current))
    )
      return;
    const docId = sourceDocId(current);
    if (!docId) return;
    let cancelled = false;
    fetchImanageDetails(docId).then((details) => {
      if (cancelled || !details) return;
      setSources((prev) => {
        if (!prev) return prev;
        const idx = active.n - 1;
        const entry = prev[idx];
        if (!entry) return prev;
        const merged = withImanageDetails(entry, details);
        // 병합이 아무것도 바꾸지 않으면 배열 identity 를 그대로 둔다 —
        // 새 배열을 만들면 `current` 메모가 재계산되어 이 이펙트가 다시
        // 켜지고, 그대로 무한 재요청이 된다.
        if (merged === entry) return prev;
        const next = [...prev];
        next[idx] = merged;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, current]);

  if (!active) return null;

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col bg-surface-primary text-text-primary shadow-2xl',
        // Desktop slide: same translate-x / opacity values as the native
        // Artifacts panel (`Artifacts.tsx`). Mobile path isn't handled here —
        // `SidePanelGroup` wraps us in `fixed inset-0 z-[100]` on small screens,
        // so the panel covers the viewport without needing a separate
        // translate-y animation.
        isVisible && !isClosing
          ? 'translate-x-0 opacity-100 transition-all duration-300'
          : 'translate-x-5 opacity-0 transition-all duration-300',
      )}
    >
      {/* Header — mirrors Artifacts.tsx chrome: surface-primary-alt bar with
          a subtle bottom border. We intentionally do NOT surface prev/next or
          a "3 / 10" counter: only a subset of the retrieved chunks are
          actually cited in the answer, so exposing navigation across all
          retrieved sources would mislead the user into treating unused
          chunks as evidence.

          좁은 패널 대응(2026-08-25): 한 행에 제목과 액션 버튼을 나란히 두면
          300~400px 폭에서 제목이 0px 로 짜부라져 세로로 깨진다. 세 단으로
          나눠 각각 독립적으로 줄바꿈/말줄임되게 한다.
            1행 — [뒤로] 출처 [N] + 메타 뱃지(wrap) + [닫기]
            2행 — 파일 아이콘 + 파일명(truncate)
            3행 — iM / BIMS / 담기 (wrap) */}
      <div className="flex flex-shrink-0 flex-col gap-1 border-b border-border-light bg-surface-primary-alt px-3 py-2">
        <div className="flex items-start gap-1">
          {onBack ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={onBack}
              aria-label="목록으로"
              title="목록으로"
              className="-ml-1 h-7 w-7 shrink-0"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 pt-0.5 text-xs font-medium uppercase tracking-wider text-text-secondary">
            <span className="whitespace-nowrap">출처 [{active.n}]</span>
            <PanelTopMeta source={current} />
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            aria-label="닫기"
            className="-mr-1 h-7 w-7 shrink-0"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <PanelTitleIcon source={current} />
          <div className="min-w-0 flex-1">
            <PanelTitle source={current} />
          </div>
        </div>
        <div className="-ml-1 flex flex-wrap items-center gap-x-0.5 gap-y-1">
          <ExternalSystemButtons source={current} />
          <AddToProjectButton source={current} />
        </div>
      </div>

      {/* Body — matches Artifacts inner panel: flex-1 column, overflow-hidden,
          with the scroll area inside so the header stays pinned. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-primary">
        <div className="flex-1 overflow-y-auto px-5 py-4 text-base">
          {current ? (
            <PanelBody source={current} />
          ) : sources == null && !timedOut ? (
            <p className="text-sm text-text-secondary">출처를 불러오는 중…</p>
          ) : (
            <p className="text-sm text-text-secondary">
              출처 정보를 표시할 수 없습니다. 접근 권한이 없거나 출처가 만료되었을 수 있습니다.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * BKL: 현재 열린 출처 문서를 프로젝트에 담는 버튼. doc_id 가 없는 소스
 * (업로드 파일 등 인덱스 밖 문서)는 담을 수 없으므로 비활성 처리한다.
 * collection 은 채팅 입력의 컬렉션 선택과 같은 localStorage 키를 따른다.
 */
function AddToProjectButton({ source }: { source: BklSource | null }) {
  const docId = sourceDocId(source);
  const meta = source?.metadata?.[0] as Record<string, unknown> | undefined;

  if (!docId) {
    return (
      <button
        type="button"
        disabled
        title="이 출처는 프로젝트에 담을 수 없습니다"
        aria-label="프로젝트에 담기"
        className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-md px-2 text-xs text-text-tertiary opacity-70"
      >
        <FolderPlus size={14} aria-hidden="true" />
        <span>담기</span>
      </button>
    );
  }

  const rawName = typeof meta?.name === 'string' ? extractFileName(meta.name) : null;
  const fileName =
    rawName ?? (typeof meta?.file_name === 'string' ? (meta.file_name as string) : null);
  const matterUid = typeof meta?.matter_uid === 'string' ? (meta.matter_uid as string) : null;
  const collection = localStorage.getItem('bkl_selected_collection');

  return (
    <AddToProjectPopover
      documents={[
        {
          doc_id: docId,
          collection,
          file_name: fileName,
          matter_uid: matterUid,
          origin: 'chat',
        },
      ]}
    >
      <button
        type="button"
        title="프로젝트에 담기"
        aria-label="프로젝트에 담기"
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
      >
        <FolderPlus size={14} aria-hidden="true" />
        <span>담기</span>
      </button>
    </AddToProjectPopover>
  );
}

function ExternalSystemButtons({ source }: { source: BklSource | null }) {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [bimsUrl, setBimsUrl] = useState<string | null>(null);

  useEffect(() => {
    setFileUrl(null);
    setBimsUrl(null);
    if (!source) return;
    const meta = source.metadata?.[0] as Record<string, unknown> | undefined;
    const directFile =
      source.source?.imanage_url ??
      source.source?.imanage_preview_url ??
      (typeof meta?.imanage_url === 'string' ? (meta.imanage_url as string) : null) ??
      (typeof meta?.imanage_preview_url === 'string' ? (meta.imanage_preview_url as string) : null);
    const directBims =
      source.source?.bims_url ??
      (typeof meta?.bims_url === 'string' ? (meta.bims_url as string) : null);
    setFileUrl(directFile);
    setBimsUrl(directBims);

    // PG document_tags 에 iManage 검색 링크(imanage_preview_url)가 전건
    // 채워져 있으므로, Qdrant payload 값은 임시 표시용이고 API 응답(PG)이
    // 항상 최종 값으로 덮어쓴다 — 조건부 skip 없이 항상 호출 (2026-08-26).
    // 왕복은 `fetchImanageDetails` 의 doc_id 캐시가 문서당 1회로 묶는다.
    const docId = typeof meta?.doc_id === 'string' && meta.doc_id ? (meta.doc_id as string) : null;
    if (!docId) return;
    let cancelled = false;
    fetchImanageDetails(docId).then((data) => {
      if (cancelled || !data) return;
      const nextFile = (data.imanage_url ?? data.imanage_preview_url ?? null) as string | null;
      if (nextFile) setFileUrl(nextFile);
      if (typeof data.bims_url === 'string' && data.bims_url) setBimsUrl(data.bims_url);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (!fileUrl && !bimsUrl) return null;
  return (
    <>
      {fileUrl ? (
        <SourceExternalLink href={fileUrl} label="iM" />
      ) : (
        <SourceDisabledLink label="iM" />
      )}
      {bimsUrl && <SourcePopupLink href={bimsUrl} label="BIMS" popupName="bims_popup" />}
    </>
  );
}

function PanelTitleIcon({ source }: { source: BklSource | null }) {
  if (!source) return null;
  const meta = source.metadata?.[0];
  // Prefer the explicit `file_type` field if the backend surfaces one (PR-C),
  // and fall back to parsing the extension from the citation header. Either
  // way the same icon set lives in `FileTypeIcon`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ext = (meta as any)?.file_type ?? null;
  const rawName = meta?.name ?? meta?.file_name ?? '';
  return <FileTypeIcon ext={ext} name={rawName} className="mt-0.5 h-5 w-5 shrink-0" />;
}

function formatMetadataValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return value;
}

function getDocumentMetadataValues(source: BklSource | null): string[] {
  const meta = source?.metadata?.[0] as Record<string, unknown> | undefined;
  if (!meta) return [];
  return [
    meta.edit_date,
    meta.last_user,
    meta.custom4,
    meta.custom1_description,
    meta.custom29_description,
  ]
    .map(formatMetadataValue)
    .filter(Boolean) as string[];
}

function DocumentMetadataLine({ source }: { source: BklSource | null }) {
  const line = getDocumentMetadataValues(source).join(' | ');
  if (!line) return null;
  return (
    <div className="mt-1 truncate text-xs font-normal text-text-tertiary" title={line}>
      {line}
    </div>
  );
}

function PanelTopMeta({ source }: { source: BklSource | null }) {
  if (!source) return null;
  const meta = source.metadata?.[0];
  const pageInfo = meta?.page_info;
  const relevance = formatRelevance(meta?.relevance);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const badge = getSectionBadge(meta as any, source.document?.[0]);
  return (
    <>
      {badge ? (
        <SectionBadge kind={badge.kind} label={badge.label} filename={badge.filename} />
      ) : null}
      {pageInfo ? <span className="normal-case tracking-normal">{pageInfo}</span> : null}
      {relevance ? (
        <span className="rounded bg-surface-secondary px-1.5 py-0.5 normal-case tracking-normal">
          관련도 {relevance}
        </span>
      ) : null}
    </>
  );
}

function PanelTitle({ source }: { source: BklSource | null }) {
  if (!source)
    return <h2 className="mt-0.5 truncate text-sm font-semibold text-text-primary">—</h2>;
  const meta = source.metadata?.[0];
  const fileName = displayNameFromMeta(meta, '출처 문서');
  return (
    <>
      <h2 className="mt-0.5 truncate text-sm font-semibold text-text-primary" title={fileName}>
        {fileName}
      </h2>
      <DocumentMetadataLine source={source} />
    </>
  );
}

/**
 * Visual distinction between email-body and attachment chunks (PR-B).
 *
 * Body chunks get a neutral pill so they read as "this came from the email
 * itself." Attachment chunks get a tinted pill that surfaces both the
 * `첨부 N/M` counter and the original filename, mirroring what we removed
 * from the chunk markdown (the `## 첨부 N/M — fname` heading and the
 * `[📎 원본 파일]` link line both moved into segment metadata so the chunk
 * body is clean, and we render that metadata explicitly here instead).
 */
function SectionBadge({
  kind,
  label,
  filename,
}: {
  kind: 'body' | 'attachment';
  label: string;
  filename?: string;
}) {
  const tone =
    kind === 'attachment'
      ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'
      : 'bg-blue-100 text-blue-900 dark:bg-blue-500/20 dark:text-blue-200';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        tone,
      )}
      title={filename || label}
    >
      <span>{label}</span>
      {filename ? (
        <span className="max-w-[200px] truncate font-normal opacity-90">· {filename}</span>
      ) : null}
    </span>
  );
}

/**
 * Strip the leading `[본문]` / `[첨부 N/M · file]` marker line that the
 * indexer prepends to chunk content for body/attachment provenance.
 *
 * The marker is *embedded inside the chunk text* on purpose (so retrieval
 * embeddings and the LLM context both see it), but the citation panel
 * already surfaces the same information as a `SectionBadge` in the title
 * area. Rendering the marker a second time as the first line of the body
 * just looks like noise — see user report 2026-04-26 ("첨부파일인데
 * [본문] 이라고 나오는 경우가 꽤 많이 있는 것 같은데").
 *
 * The indexer fix (`emit_markers = any(s.kind === 'attachment')` in
 * index_documents.py) prevents [본문] from being prepended to standalone
 * non-MSG documents going forward, but legacy index slices written before
 * that fix still carry the marker — this strip handles both.
 */
const _CHUNK_MARKER_RE =
  /^\s*\[(?:본문|첨부(?:\s+\d+\s*\/\s*\d+)?(?:\s*[·•]\s*[^\]\n]+)?)\]\s*\n+/u;
function stripLeadingSegmentMarker(text: string): string {
  if (!text) return text;
  return text.replace(_CHUNK_MARKER_RE, '');
}

/**
 * Defensively unescape mammoth's over-eager backslash-escaping of
 * punctuation that is virtually never markdown-significant in mid-
 * paragraph Korean prose.
 *
 * `mammoth.convert_to_markdown` defensively writes `\(`, `\)`, `\[`,
 * `\]`, `\.`, `\-`, `\+`, `\=`, `\|` for ASCII punctuation embedded in
 * paragraph runs. Three things go wrong when that lands in this panel:
 *
 *  1. `\(...\)` is the LaTeX inline-math delimiter that
 *     `MarkdownLite`'s `remark-math`/`rehype-katex` chain happily
 *     consumes — KaTeX strips intra-math whitespace and re-renders
 *     Latin runs in math-italic glyphs. That's why "Mobile Virtual
 *     Network Operator" / "KT" / "SKT" / "LGU\+" come out as the
 *     mathematical italic block (`𝑀𝑜𝑏𝑖𝑙𝑒𝑉𝑖𝑟𝑡𝑢𝑎𝑙…`) with no spaces in
 *     the legal-doc panel screenshot (2026-04-26 user report
 *     "워드 파일 청크가 이상하게 보여").
 *  2. `\.`, `\-`, `\+` etc. occasionally leak through React-Markdown
 *     verbatim ("정리하였습니다\." instead of "정리하였습니다.").
 *  3. The escapes pollute embeddings and chunk-snippet readability.
 *
 * Backend (`mammoth_docx_processor.py`) now strips these escapes
 * before chunking, but legacy index slices written before that fix
 * still carry them. Apply the same normalisation client-side as a
 * belt-and-braces measure so panels never render math-italicised
 * legal text again.
 *
 * Why these specific characters: they have *no* CommonMark meaning
 * inside a paragraph (parens are only special as link tails, brackets
 * as link openers, periods only after a digit at the start of a line).
 * We intentionally do not unescape `\*`, `\_`, `` \` ``, `\\`, `\#`,
 * `\!`, `\{`, `\}`, `\~` — those genuinely need escaping.
 */
const _MAMMOTH_UNESCAPE_RE = /\\([()\[\].\-+=|<>])/g;
function normaliseMammothEscapes(text: string): string {
  if (!text || text.indexOf('\\') === -1) return text;
  return text.replace(_MAMMOTH_UNESCAPE_RE, '$1');
}

/**
 * Defuse Korean YYYY. M. D. style date headings that CommonMark/remark-gfm
 * misparses as a *nested* ordered list.
 *
 * Concrete example from the OCR'd PDF panel (2026-04-26 user report
 * "2024. k. 11.(월) 이거 왜 이렇게 깨지냐고"): the source line is
 *
 *     2024. 11. 11.(월)
 *
 * which CommonMark folds into
 *
 *     <ol start="2024">
 *       <li>
 *         <ol start="11">
 *           <li>11.(월)</li>
 *         </ol>
 *       </li>
 *     </ol>
 *
 * because every `digit{1,9}.` token is treated as a list marker and the
 * trailing-text indentation hits the nested-item threshold. LibreChat's
 * `style.css` defaults the *nested* `<ol ol>` to `list-style-type:
 * lower-alpha`, so position 11 in the inner list renders as the marker
 * "k." — hence the user's "2024. k. 11.(월)".
 *
 * Escaping just the FIRST period after a 4-digit year at the start of a
 * line is enough to prevent the entire chain (verified locally with
 * `unified` + `remark-gfm`@4 / `remark-math`@6, the exact LibreChat
 * MarkdownLite plugin set). Markdown then renders the line as a single
 * paragraph, identical text shape, no list at all.
 *
 * The pattern is intentionally conservative: it ONLY fires when the line
 * starts with optional whitespace, a 4-digit number, a period, and a
 * space, AND is followed by another `digit.` token before any
 * non-numeric word — the canonical YYYY. M. D. shape. A bare `2024.`
 * paragraph (no further dotted segment) is left untouched so we don't
 * suppress legitimate ordered-list usage of large start numbers.
 */
const _DATE_LIST_GUARD_RE = /^([ \t]*)(\d{4})\.([ \t]+)(?=\d{1,2}\.[ \t]+(?:\d{1,2}\.|[\d(]))/gm;
function neutraliseDateListMarker(text: string): string {
  if (!text) return text;
  return text.replace(_DATE_LIST_GUARD_RE, '$1$2\\.$3');
}

/**
 * Promote / repair docx headings that landed in the index as bold runs.
 *
 * mammoth emits docx headings like `__제6조 [이행사항]__`, often with a
 * trailing space inside the delimiter (the original Word run was the
 * Korean section name plus a space before the paragraph mark). After
 * the previous `normaliseMammothEscapes` strip, `\[` / `\]` get
 * unescaped and the line becomes
 *
 *     __제6조 [이행사항] __
 *
 * — and CommonMark refuses to parse `__strong__` whose closing
 * delimiter has whitespace immediately before it. The result is the
 * panel rendering both `__` delimiters literally (user report
 * 2026-04-26: "원기호 저거 크게 보이는 거" + "청크가 왜 이러지").
 *
 * The backend mammoth processor now promotes these to ATX `## ...`
 * headings at OCR time, but legacy index slices written before that
 * fix still carry the bold-run shape. Promote them client-side too:
 * any standalone-line bold run carrying `제\d+\s*[장절조항]` becomes
 * a real ATX heading. Trailing whitespace inside the delimiters is
 * dropped as part of the rewrite. Inline bold elsewhere on a line
 * is left untouched.
 */
const _LEGAL_HEADING_BOLD_RE =
  /^([ \t]*)(?:__|\*\*)[ \t]*(제\s*\d+\s*[장절조항][^\n_*]*?)[ \t]*(?:__|\*\*)[ \t]*$/gmu;
function promoteLegalBoldHeading(text: string): string {
  if (!text) return text;
  return text.replace(_LEGAL_HEADING_BOLD_RE, '$1## $2');
}

function PanelBody({ source }: { source: BklSource }) {
  const rawText = source.document?.[0] ?? '';
  const text = promoteLegalBoldHeading(
    neutraliseDateListMarker(normaliseMammothEscapes(stripLeadingSegmentMarker(rawText))),
  );
  if (!text) return <p className="text-sm text-text-secondary">내용을 불러올 수 없습니다.</p>;
  // MarkdownLite (GFM + math + code highlighting) renders the chunk body.
  // PR-B moves the `## 첨부 N/M — fname` heading + `[📎 원본 파일]` link
  // into segment metadata (rendered as `SectionBadge` above), so chunk
  // bodies should usually contain no level-2 / level-3 headings at all.
  //
  // The prose-h{2,3} overrides are still in place as a defense-in-depth:
  // legacy index slices (pre-PR-B re-index) and OCR'd attachments that
  // happen to start with a real H2 in the source document still benefit
  // from the down-sized typography so a single heading at the top of a
  // chunk no longer dominates the panel.
  //
  // `prose-sm` + `dark:prose-invert` matches the typography used in the
  // assistant message surface; `max-w-none` lets paragraphs fill the panel
  // width instead of the default `prose` narrow measure.
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none break-words text-text-primary',
        'prose-h1:text-base prose-h1:font-semibold prose-h1:my-2',
        'prose-h2:text-sm prose-h2:font-semibold prose-h2:my-2',
        'prose-h3:text-sm prose-h3:font-semibold prose-h3:my-1.5',
        'prose-h4:text-sm prose-h4:font-medium prose-h4:my-1.5',
      )}
    >
      <MarkdownLite content={text} codeExecution={false} />
    </div>
  );
}
