import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { ChevronDown, ChevronRight, ExternalLink, FileText, FolderPlus, X } from 'lucide-react';
import type { ProjectDocumentInput } from '~/data-provider/Projects';
import store from '~/store';
import { cn, FileTypeIcon } from '~/utils';
import BklSourcesPanel from '~/components/Chat/Messages/Content/BklSourcesPanel';
import AddToProjectPopover from '~/components/Projects/AddToProjectPopover';
import type { BklSource } from '~/components/Chat/Messages/Content/ChunkModal';
import {
  useConversationCitations,
  type CitedTurn,
  type MentionedFile,
} from './useConversationCitations';
import { useOpenBklSource } from './useActiveBklSource';

/**
 * 대화 단위 우측 패널 (mentat ThreadPanel 스타일) — 데스크톱에선 항상 열려
 * 있다 (Presentation.tsx 가 아티팩트 슬롯에 상시 라우팅).
 *
 * Overview(언급된 파일 / 인용된 청크 2개 접이식 섹션) ↔ 청크 텍스트 뷰의
 * 2상태로 동작한다. 청크 뷰는 기존 BklSourcesPanel 을 재사용하고, 뒤로가기
 * 또는 닫기로 Overview 에 복귀한다.
 */
export default function BklThreadPanel() {
  const active = useRecoilValue(store.activeBklSource);
  const setActive = useSetRecoilState(store.activeBklSource);

  // 청크 뷰 — 본문 [N] 클릭과 Overview 행 클릭 모두 이 경로.
  if (active != null) {
    return <BklSourcesPanel onBack={() => setActive(null)} />;
  }

  return <ThreadOverview />;
}

/**
 * 선택된 파일을 프로젝트 담기 입력으로 변환. doc_id 없는 파일(업로드 문서 등)은
 * 담을 수 없어 선택 대상에서 빠지므로 여기서도 걸러진다. collection 은 채팅
 * 입력의 컬렉션 선택과 같은 localStorage 키를 따른다 (BklSourcesPanel 과 동일).
 */
export function toProjectDocuments(
  files: MentionedFile[],
  selectedKeys: ReadonlySet<string>,
  collection: string | null,
): ProjectDocumentInput[] {
  const out: ProjectDocumentInput[] = [];
  for (const file of files) {
    if (!file.docId || !selectedKeys.has(file.key)) continue;
    out.push({
      doc_id: file.docId,
      collection,
      file_name: file.fileName,
      matter_uid: file.matterUid,
      origin: 'chat',
    });
  }
  return out;
}

function ThreadOverview() {
  // ChatView 와 동일하게 라우트 파라미터를 쓴다 — 메시지 쿼리 캐시 키가
  // 같아야 스트리밍 직후에도 같은 데이터를 본다.
  const { conversationId } = useParams();
  const { turns, files, isLoading } = useConversationCitations(conversationId);
  const openChunk = useOpenBklSource();

  // BKL: 언급된 파일 다중 선택 → 프로젝트에 한 번에 담기 (문서검색 화면과 동일 UX).
  // 대화가 바뀌면 선택을 비운다. 파일 목록이 줄어 사라진 키는 파생값에서 걸러진다.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [conversationId]);

  const selectableKeys = useMemo(() => files.filter((f) => f.docId).map((f) => f.key), [files]);
  const allSelected =
    selectableKeys.length > 0 && selectableKeys.every((key) => selectedKeys.has(key));
  const toggleSelection = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);
  const selectedDocs = useMemo(
    () => toProjectDocuments(files, selectedKeys, localStorage.getItem('bkl_selected_collection')),
    [files, selectedKeys],
  );

  const isEmpty = turns.length === 0 && files.length === 0;

  return (
    <div className="flex h-full w-full flex-col bg-surface-primary text-text-primary">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-light bg-surface-primary-alt px-4 py-3">
        <h2 className="truncate text-sm font-semibold text-text-primary">대화 자료</h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <FileText size={28} className="text-text-tertiary" aria-hidden="true" />
            {isLoading ? (
              <p className="text-sm text-text-secondary">출처를 불러오는 중…</p>
            ) : (
              <>
                <p className="text-sm font-medium text-text-primary">아직 인용된 출처가 없습니다</p>
                <p className="text-sm leading-relaxed text-text-secondary">
                  답변 본문에 인용된 문서와 청크가
                  <br />
                  여기에 정리됩니다.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <PanelSection
              label="언급된 파일"
              count={files.length}
              defaultOpen
              action={
                selectableKeys.length > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedKeys(allSelected ? new Set() : new Set(selectableKeys))
                    }
                    className="shrink-0 whitespace-nowrap text-[11px] normal-case tracking-normal text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
                  >
                    {allSelected ? '전체 해제' : '전체 선택'}
                  </button>
                ) : null
              }
            >
              {files.map((file) => (
                <FileRow
                  key={file.key}
                  file={file}
                  isSelected={selectedKeys.has(file.key)}
                  onToggleSelect={file.docId ? () => toggleSelection(file.key) : undefined}
                />
              ))}
            </PanelSection>
            <PanelSection
              label="인용된 청크"
              count={turns.reduce((acc, t) => acc + t.chunks.length, 0)}
              defaultOpen
            >
              {turns.map((turn) => (
                <TurnGroup key={turn.messageId} turn={turn} onOpenChunk={openChunk} />
              ))}
            </PanelSection>
          </>
        )}
      </div>

      {selectedDocs.length > 0 ? (
        <SelectionBar documents={selectedDocs} onClear={clearSelection} />
      ) : null}
    </div>
  );
}

/**
 * 다중 선택 액션 바 — 1건 이상 선택 시 패널 하단에 고정. 문서검색 화면의
 * 플로팅 바와 같은 구성이지만, 패널은 폭이 좁아 본문을 가리지 않도록
 * 스크롤 영역 아래 footer 로 둔다.
 */
function SelectionBar({
  documents,
  onClear,
}: {
  documents: ProjectDocumentInput[];
  onClear: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-t border-border-light bg-surface-primary-alt px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
        {documents.length}건 선택
      </span>
      <AddToProjectPopover documents={documents} align="end" onAdded={onClear}>
        <button
          type="button"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface-submit px-3 text-sm text-white hover:bg-surface-submit-hover"
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" />
          프로젝트에 담기
        </button>
      </AddToProjectPopover>
      <button
        type="button"
        aria-label="선택 해제"
        onClick={onClear}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * mentat PanelSection 의 이식판 — 접이식 섹션 헤더 + 카운트 뱃지.
 * `action` 은 헤더 오른쪽에 두는 보조 컨트롤(전체 선택 등). 헤더 토글이
 * button 이라 그 안에 넣을 수 없어 형제로 나란히 둔다.
 */
function PanelSection({
  label,
  count,
  defaultOpen = false,
  action,
  children,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border-light">
      <div className="flex items-center text-xs font-semibold uppercase tracking-wider text-text-secondary">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left hover:bg-surface-hover"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="flex-1 truncate">{label}</span>
          <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal">
            {count}
          </span>
        </button>
        {open && action ? <div className="px-3">{action}</div> : null}
      </div>
      {open ? <div className="pb-1">{children}</div> : null}
    </div>
  );
}

function fileTypeExt(source: BklSource): string | null {
  const meta = source.metadata?.[0] as Record<string, unknown> | undefined;
  return typeof meta?.file_type === 'string' ? (meta.file_type as string) : null;
}

/**
 * 파일 한 줄 — 체크박스(프로젝트 담기 선택) + 파일명 버튼(iManage 원문 열기).
 * doc_id 가 없어 담을 수 없는 파일은 체크박스 자리를 비워 정렬만 맞춘다.
 */
function FileRow({
  file,
  isSelected,
  onToggleSelect,
}: {
  file: MentionedFile;
  isSelected: boolean;
  onToggleSelect?: () => void;
}) {
  const rawName = String(
    file.sample.metadata?.[0]?.name ?? file.sample.metadata?.[0]?.file_name ?? file.fileName,
  );
  const clickable = Boolean(file.imanageUrl);
  const open = () => {
    if (file.imanageUrl) window.open(file.imanageUrl, '_blank', 'noopener');
  };
  return (
    <div
      className={cn(
        'flex w-full items-center gap-2 pl-3 pr-1 text-sm',
        isSelected && 'bg-surface-active-alt',
      )}
    >
      {onToggleSelect ? (
        <input
          type="checkbox"
          aria-label={`${file.fileName} 선택`}
          checked={isSelected}
          onChange={onToggleSelect}
          className="h-4 w-4 shrink-0 cursor-pointer accent-text-primary"
        />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={open}
        disabled={!clickable}
        title={clickable ? `${file.fileName} — iManage 원문 열기` : file.fileName}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-1 pr-2 text-left',
          clickable ? 'hover:bg-surface-hover' : 'cursor-default',
        )}
      >
        <FileTypeIcon ext={fileTypeExt(file.sample)} name={rawName} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-text-primary">{file.fileName}</span>
        <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-[11px] text-text-secondary">
          {file.count}
        </span>
        {clickable ? (
          <ExternalLink size={13} className="shrink-0 text-text-tertiary" aria-hidden="true" />
        ) : null}
      </button>
    </div>
  );
}

function TurnGroup({
  turn,
  onOpenChunk,
}: {
  turn: CitedTurn;
  onOpenChunk: (messageId: string, n: number) => void;
}) {
  return (
    <div>
      <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium text-text-tertiary">
        답변 {turn.index}
      </div>
      {turn.chunks.map((chunk) => {
        const pageInfo = chunk.source.metadata?.[0]?.page_info;
        return (
          <div
            key={`${chunk.messageId}-${chunk.n}`}
            className="group/chunk flex w-full items-center pl-3 pr-1 text-sm hover:bg-surface-hover"
          >
            <button
              type="button"
              onClick={() => onOpenChunk(chunk.messageId, chunk.n)}
              title={chunk.fileName}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            >
              <span className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 text-[11px] font-semibold text-text-secondary">
                {chunk.n}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-primary">{chunk.fileName}</span>
              {pageInfo ? (
                <span className="shrink-0 text-[11px] text-text-tertiary">{String(pageInfo)}</span>
              ) : null}
            </button>
            {/* 파일 행과 같은 iManage 원문 열기 — 행 클릭(청크 뷰)과 분리된 별도 버튼 */}
            {chunk.imanageUrl ? (
              <button
                type="button"
                aria-label={`${chunk.fileName} iManage 원문 열기`}
                title="iManage 원문 열기"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(chunk.imanageUrl as string, '_blank', 'noopener');
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-tertiary hover:text-text-primary"
              >
                <ExternalLink size={13} aria-hidden="true" />
              </button>
            ) : (
              <span className="h-7 w-7 shrink-0" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}
