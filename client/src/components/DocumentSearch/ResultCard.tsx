import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ChunkPreview, DocumentHit } from '~/data-provider/DocumentSearch';
import {
  SourceExternalLink,
  SourceDisabledLink,
  SourcePopupLink,
} from '~/components/Chat/Messages/Content/SourceLinkButtons';
import { useLocalize } from '~/hooks';
import { cn, FileTypeIcon, fileExtensionLabel } from '~/utils';
import { displayNameOf } from '~/utils/displayName';

interface ResultCardProps {
  hit: DocumentHit;
  query: string;
  isSelected?: boolean;
  onClick?: () => void;
  /** BKL: 다중 선택(프로젝트에 담기)용 체크박스 토글. 넘기면 카드 좌측에 체크박스 표시. */
  onToggleSelect?: () => void;
}

const CHUNKS_PER_PAGE = 8;
const imanageLinksCache = new Map<string, { fileUrl: string | null; folderUrl: string | null }>();

async function fetchImanageLinks(
  docId: string,
): Promise<{ fileUrl: string | null; folderUrl: string | null } | null> {
  if (imanageLinksCache.has(docId)) {
    return imanageLinksCache.get(docId) ?? null;
  }
  const resp = await fetch(`/bkl/v1/imanage-links/${encodeURIComponent(docId)}`);
  if (!resp.ok) return null;
  const data = await resp.json();
  const links = {
    fileUrl: data.imanage_url ?? data.imanage_preview_url ?? null,
    folderUrl: data.imanage_folder_url ?? null,
  };
  imanageLinksCache.set(docId, links);
  return links;
}

/**
 * 검색어를 하이라이트할 단어들로 쪼갠다.
 *
 * 구분자를 공백만으로 잡으면 `세종텔레콤, 아이즈비전` 이 `["세종텔레콤,",
 * "아이즈비전"]` 이 되어, 쉼표가 붙은 앞 단어는 본문과 영영 매칭되지 않는다.
 * 맨 뒤 단어만 칠해지는 것처럼 보이던 원인이다. 검색 팁이 쉼표 표기를
 * 안내하고 있으므로 흔한 입력이다.
 */
function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  return (
    query
      // 인용부호·그룹 기호는 구분자 역할만 한다.
      .replace(/["()]/g, ' ')
      // `"구문"~5` 의 근접 지정자. 남겨두면 본문의 숫자를 전부 칠한다.
      .replace(/~\d+/g, ' ')
      .split(/[\s,;|]+/)
      // `-단어` 는 제외 조건이라 애초에 본문에 없어야 정상이다.
      .filter((t) => !t.startsWith('-'))
      .map((t) =>
        t
          .replace(/^\++/, '')
          .replace(/[*~]+$/, '')
          .trim(),
      )
      .filter((t) => {
        const key = t.toLowerCase();
        if (t.length < 1 || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      // 긴 단어를 먼저 두어야 `삼성|삼성전자` 에서 짧은 쪽이 먼저 먹고
      // 나머지가 안 칠해지는 일이 없다.
      .sort((a, b) => b.length - a.length)
  );
}

function highlight(text: string, query: string): React.ReactNode {
  if (!text) return null;
  const tokens = queryTokens(query);
  if (tokens.length === 0) return text;

  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(re);
  const tokenSet = new Set(tokens.map((t) => t.toLowerCase()));
  return parts.map((part, i) =>
    tokenSet.has(part.toLowerCase()) ? (
      <mark
        key={i}
        className="rounded bg-yellow-200 px-0.5 font-medium text-text-primary dark:bg-yellow-700/60"
      >
        {part}
      </mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

function cleanPreviewText(content: string): string {
  return content
    .replace(/<!--\s*BKL_SEG\b[^>]*-->/gi, '')
    .replace(/\n-{3,}\s*\n📄\s*문서:[\s\S]*$/m, '')
    .replace(/^📄\s*문서:[\s\S]*$/m, '')
    .replace(/^\s*\[(본문|첨부[^\]\n]*)\]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildSnippet(content: string, query: string, maxLen = 260): string {
  const cleaned = cleanPreviewText(content);
  if (!cleaned) return '';
  const tokens = queryTokens(query);
  const lower = cleaned.toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const hit = lower.indexOf(t.toLowerCase());
    if (hit !== -1) {
      idx = hit;
      break;
    }
  }
  if (idx === -1) {
    return cleaned.slice(0, maxLen) + (cleaned.length > maxLen ? '…' : '');
  }
  const start = Math.max(0, idx - 80);
  const end = Math.min(cleaned.length, start + maxLen);
  return (start > 0 ? '…' : '') + cleaned.slice(start, end) + (end < cleaned.length ? '…' : '');
}

function previewForChunk(chunk: ChunkPreview, query: string): string {
  const snippet = cleanPreviewText(chunk.snippet || '');
  if (snippet && snippet !== '...') return snippet;
  return buildSnippet(chunk.content, query);
}

function formatMetadataValue(value?: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return value;
}

function documentMetadataLine(hit: DocumentHit): string | null {
  const values = [
    hit.edit_date,
    hit.last_user,
    hit.custom4,
    hit.custom1_description,
    hit.custom29_description,
  ]
    .map(formatMetadataValue)
    .filter(Boolean);
  return values.length ? values.join(' | ') : null;
}

// `fileExtension` / `extensionLabel` / `ExtensionIcon` were inlined here
// originally; they now live in `~/utils/fileTypeIcon.tsx` so the citation
// chip and the BKL sources panel render the same icon set.

interface ChunkRowProps {
  chunk: ChunkPreview;
  index: number;
  total: number;
  query: string;
  /**
   * Document-level iManage preview URL. Used to suppress a redundant per-chunk
   * link when the chunk carries the same (non page-anchored) URL the card
   * header already exposes.
   */
  docImanageUrl?: string | null;
}

const ChunkRow: React.FC<ChunkRowProps> = ({ chunk, index, total, query, docImanageUrl }) => {
  const [expanded, setExpanded] = useState(false);
  const pageInfo =
    chunk.page_start != null
      ? chunk.page_end != null && chunk.page_end !== chunk.page_start
        ? `p.${chunk.page_start}-${chunk.page_end}`
        : `p.${chunk.page_start}`
      : null;
  const preview = previewForChunk(chunk, query);
  const expandedText = cleanPreviewText(chunk.content) || chunk.content;
  const chunkImanageUrl =
    chunk.imanage_preview_url && chunk.imanage_preview_url !== docImanageUrl
      ? chunk.imanage_preview_url
      : null;

  return (
    <div className="group/chunk rounded-md border border-transparent px-2 py-2 hover:border-border-light hover:bg-surface-hover">
      <div className="flex w-full items-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-border-heavy"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-text-tertiary transition-transform',
              expanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
          <span className="inline-flex h-5 shrink-0 items-center rounded bg-surface-secondary px-1.5 text-[10px] font-semibold tabular-nums text-text-secondary">
            {index + 1}/{total}
          </span>
          {pageInfo && (
            <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{pageInfo}</span>
          )}
        </button>
        {chunkImanageUrl && (
          <SourceExternalLink
            href={chunkImanageUrl}
            label="iM 파일"
            size="sm"
            shrink
            stopPropagation
          />
        )}
      </div>
      <div className="mt-1 pl-5">
        {expanded ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-text-primary">
            {highlight(expandedText, query)}
          </pre>
        ) : (
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-secondary">
            {highlight(preview, query)}
          </p>
        )}
      </div>
    </div>
  );
};

const ResultCard: React.FC<ResultCardProps> = ({
  hit,
  query,
  isSelected,
  onClick,
  onToggleSelect,
}) => {
  const localize = useLocalize();
  const [page, setPage] = useState(0);
  const displayedChunkCount = hit.top_chunks.length;
  const matchedChunkCount = hit.chunk_count || displayedChunkCount;
  const totalPages = Math.max(1, Math.ceil(displayedChunkCount / CHUNKS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * CHUNKS_PER_PAGE;
  const visibleChunks = hit.top_chunks.slice(pageStart, pageStart + CHUNKS_PER_PAGE);
  const chunkCountLabel =
    matchedChunkCount > displayedChunkCount
      ? `표시 ${displayedChunkCount}개 / 매칭 ${matchedChunkCount}개`
      : `${localize('com_document_search_matched_chunks')}: ${matchedChunkCount}`;
  const metadataLine = documentMetadataLine(hit);
  const [imanageFileUrl, setImanageFileUrl] = useState<string | null>(
    hit.imanage_preview_url ?? null,
  );
  const [imanageFolderUrl, setImanageFolderUrl] = useState<string | null>(
    hit.imanage_folder_url ?? null,
  );

  useEffect(() => {
    setImanageFileUrl(hit.imanage_preview_url ?? null);
    setImanageFolderUrl(hit.imanage_folder_url ?? null);
    if (!hit.doc_id || hit.imanage_folder_url) return;

    let cancelled = false;
    fetchImanageLinks(hit.doc_id)
      .then((links) => {
        if (cancelled || !links) return;
        if (links.fileUrl) setImanageFileUrl(links.fileUrl);
        if (links.folderUrl) setImanageFolderUrl(links.folderUrl);
      })
      .catch(() => {
        /* Optional enrichment only. */
      });
    return () => {
      cancelled = true;
    };
  }, [hit.doc_id, hit.imanage_folder_url, hit.imanage_preview_url]);

  const metaBadges = [hit.work_type, hit.document_type, hit.practice_area_primary].filter(
    Boolean,
  ) as string[];

  return (
    <article
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group border-b border-border-light py-4 transition-colors',
        onClick && 'cursor-pointer hover:bg-surface-hover',
        isSelected && 'bg-surface-active-alt',
      )}
    >
      <div className="flex items-center gap-2 px-4">
        {onToggleSelect && (
          <input
            type="checkbox"
            aria-label={`${displayNameOf(hit) || hit.doc_id} 선택`}
            checked={Boolean(isSelected)}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 shrink-0 cursor-pointer accent-text-primary"
          />
        )}
        <span className="inline-flex h-5 shrink-0 items-center rounded-sm border border-border-medium bg-surface-secondary px-1.5 text-[10px] font-semibold tabular-nums leading-none tracking-wide text-text-secondary">
          {fileExtensionLabel(hit.file_name)}
        </span>
        <FileTypeIcon name={hit.file_name} className="h-4 w-4 shrink-0" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
          {highlight(displayNameOf(hit) || hit.doc_id, query)}
        </h3>
        {hit.source_library === 'DB' && (
          <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            DB 라이브러리
          </span>
        )}
        {hit.title_match && (
          <span className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
            파일명
          </span>
        )}
        {hit.match_tier && hit.match_tier !== 'exact' && (
          <span
            title="검색어 일부만 일치하는 유사 결과입니다"
            className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
          >
            유사
          </span>
        )}
        {imanageFileUrl && (
          <SourceExternalLink
            href={imanageFileUrl}
            label="iM 파일"
            size="sm"
            shrink
            stopPropagation
          />
        )}
        {imanageFolderUrl ? (
          <SourceExternalLink
            href={imanageFolderUrl}
            label="iM 폴더"
            size="sm"
            shrink
            stopPropagation
          />
        ) : imanageFileUrl ? (
          <SourceDisabledLink label="iM 폴더" size="sm" shrink />
        ) : null}
        {hit.bims_url && (
          <SourcePopupLink
            href={hit.bims_url}
            label="BIMS"
            popupName="bims_popup"
            size="sm"
            shrink
            stopPropagation
          />
        )}
      </div>

      {metadataLine && (
        <div
          className="mt-1 truncate px-4 pl-16 text-[11px] text-text-tertiary"
          title={metadataLine}
        >
          {metadataLine}
        </div>
      )}

      {visibleChunks.length > 0 && (
        <div
          className={cn(
            'mt-2 flex flex-col gap-1 px-3',
            visibleChunks.length > 3 && 'max-h-72 overflow-y-auto pr-2',
          )}
        >
          {visibleChunks.map((c, i) => (
            <ChunkRow
              key={c.chunk_id || `${hit.doc_id}-${i}`}
              chunk={c}
              index={pageStart + i}
              total={displayedChunkCount}
              query={query}
              docImanageUrl={hit.imanage_preview_url}
            />
          ))}
        </div>
      )}

      {displayedChunkCount > CHUNKS_PER_PAGE && (
        <div className="mt-2 flex items-center justify-end gap-2 px-4 text-[11px] text-text-secondary">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPage((p) => Math.max(0, p - 1));
            }}
            disabled={safePage === 0}
            className="inline-flex h-6 items-center gap-1 rounded px-2 hover:bg-surface-hover disabled:cursor-default disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            이전
          </button>
          <span className="tabular-nums">
            {safePage + 1}/{totalPages}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPage((p) => Math.min(totalPages - 1, p + 1));
            }}
            disabled={safePage >= totalPages - 1}
            className="inline-flex h-6 items-center gap-1 rounded px-2 hover:bg-surface-hover disabled:cursor-default disabled:opacity-40"
          >
            다음
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-[11px] text-text-secondary">
        {(hit.imanage_create_date || hit.document_date) && (
          <span className="tabular-nums">
            {(hit.imanage_create_date || hit.document_date)!.slice(0, 10)}
          </span>
        )}
        {metaBadges.map((b) => (
          <span key={b} className="text-text-secondary">
            · {b}
          </span>
        ))}
        <span className="ml-auto tabular-nums">{chunkCountLabel}</span>
      </div>
    </article>
  );
};

export { highlight, buildSnippet, queryTokens };
export default ResultCard;
