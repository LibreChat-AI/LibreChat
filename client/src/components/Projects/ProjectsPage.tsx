import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  Button,
  Spinner,
  TooltipAnchor,
  NewChatIcon,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import { BKL_APP_TITLE } from '~/components/Bkl/brand';
import {
  AlertTriangle,
  ExternalLink,
  Folder,
  FolderOpen,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ContextType } from '~/common';
import { useDocumentTitle, useLocalize } from '~/hooks';
import { useChatContext } from '~/Providers';
import { OpenSidebar } from '~/components/Chat/Menus';
import {
  useProjects,
  useProject,
  useCreateProject,
  useRenameProject,
  useDeleteProject,
  useRemoveProjectDocuments,
  ProjectsApiError,
} from '~/data-provider/Projects';
import type { ProjectDocument } from '~/data-provider/Projects';
import { clearMessagesCache, cn } from '~/utils';
import { displayNameOf } from '~/utils/displayName';
import HarveySyncPanel from './HarveySyncPanel';

/** 프로젝트(Vault류) 페이지 — 좌측 프로젝트 목록 + 우측 문서 테이블. */
const ProjectsPage: React.FC = () => {
  const localize = useLocalize();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { conversation, newConversation } = useChatContext();
  const { navVisible, setNavVisible } = useOutletContext<ContextType>();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  useDocumentTitle(`${localize('com_nav_projects')} | ${BKL_APP_TITLE}`);

  const { data: projects = [], isLoading, isError, error, refetch } = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  // 첫 로드/삭제 후 선택 보정
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !projects.some((p) => p.project_id === selectedId)) {
      setSelectedId(projects[0].project_id);
    }
  }, [projects, selectedId]);

  const createProject = useCreateProject();

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || createProject.isLoading) {
      return;
    }
    try {
      const project = await createProject.mutateAsync({ name });
      setNewName('');
      setCreating(false);
      setSelectedId(project.project_id);
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), status: 'error' });
    }
  }, [newName, createProject, showToast]);

  const handleNewChat = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
      window.open('/c/new', '_blank');
      return;
    }
    clearMessagesCache(queryClient, conversation?.conversationId);
    queryClient.invalidateQueries([QueryKeys.messages]);
    newConversation();
  };

  const showTopBar = !isSmallScreen && !navVisible;

  return (
    <div className="relative flex w-full grow overflow-hidden bg-presentation">
      <main className="flex h-full w-full flex-col overflow-hidden" role="main">
        {showTopBar && (
          <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border-light bg-presentation px-3">
            <OpenSidebar setNavVisible={setNavVisible} />
            <TooltipAnchor
              description={localize('com_ui_new_chat')}
              render={
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={localize('com_ui_new_chat')}
                  className="rounded-xl border border-border-light bg-surface-secondary p-2 hover:bg-surface-active-alt"
                  onClick={handleNewChat}
                >
                  <NewChatIcon />
                </Button>
              }
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl px-6 py-8 sm:px-10 sm:py-10">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-2 text-text-primary">
                <FolderOpen className="h-5 w-5 text-text-secondary" aria-hidden="true" />
                <h1 className="text-xl font-semibold tracking-tight">
                  {localize('com_nav_projects')}
                </h1>
              </div>
              {!creating && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 rounded-lg text-sm"
                  onClick={() => setCreating(true)}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />새 프로젝트
                </Button>
              )}
            </div>

            <div className="-mt-3 mb-6 text-xs leading-relaxed text-text-secondary">
              <p>
                프로젝트에 담은 문서는 Harvey(하비) Vault로 보내 Harvey에서 이어서 검토할 수
                있습니다.
              </p>
              <p className="mt-1 font-semibold text-blue-700 dark:text-blue-400">
                ※ iManage와 자동 연동된 Vault는 선택하지 마세요. (자동 동기화되어 파일이
                삭제됩니다.)
              </p>
            </div>

            {creating && (
              <div className="mb-5 flex items-center gap-2 rounded-xl border border-border-light bg-surface-primary p-3">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCreate();
                    }
                    if (e.key === 'Escape') {
                      setCreating(false);
                      setNewName('');
                    }
                  }}
                  placeholder="새 프로젝트 이름"
                  className="min-w-0 flex-1 rounded-md border border-border-medium bg-transparent px-3 py-2 text-sm text-text-primary outline-none focus:border-border-heavy"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreate}
                  disabled={!newName.trim() || createProject.isLoading}
                >
                  {createProject.isLoading ? <Spinner className="size-4" /> : '만들기'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="취소"
                  onClick={() => {
                    setCreating(false);
                    setNewName('');
                  }}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            )}

            {isLoading ? (
              <div className="flex justify-center py-16">
                <Spinner className="size-5" />
              </div>
            ) : isError ? (
              <ProjectsError error={error} onRetry={() => refetch()} />
            ) : projects.length === 0 ? (
              <EmptyProjects onCreate={() => setCreating(true)} />
            ) : (
              <div className="flex flex-col gap-5 md:flex-row">
                {/* 좌: 프로젝트 목록 */}
                <aside className="w-full shrink-0 md:w-60">
                  <ul className="flex flex-col gap-1">
                    {projects.map((project) => (
                      <li key={project.project_id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(project.project_id)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm',
                            selectedId === project.project_id
                              ? 'bg-surface-active-alt text-text-primary'
                              : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                          )}
                        >
                          <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          <span className="shrink-0 text-xs text-text-tertiary">
                            {project.document_count}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </aside>

                {/* 우: 선택 프로젝트 상세 */}
                <section className="min-w-0 flex-1">
                  {selectedId && (
                    <ProjectDetailPanel
                      projectId={selectedId}
                      onDeleted={() => setSelectedId(null)}
                      onSearchDocuments={(q) =>
                        navigate(`/documents?q=${encodeURIComponent(q)}`)
                      }
                    />
                  )}
                </section>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

/**
 * 목록 로드 실패를 빈 상태와 구분해 표시. 인스펙터 없이도 화면에서
 * 상태코드로 원인을 진단할 수 있게 안내 문구를 함께 그린다.
 * (404 = 구버전 bkl-api 배포, 403 = 프록시가 X-BKL-User-Sid 를 못 넣는 계정)
 */
const ProjectsError: React.FC<{ error: unknown; onRetry: () => void }> = ({ error, onRetry }) => {
  const status = error instanceof ProjectsApiError ? error.status : null;
  const message = error instanceof Error ? error.message : String(error);
  const hint =
    status === 404
      ? 'bkl-api 가 구버전입니다. 프로젝트 API 가 포함된 이미지(main-3d7fb57 이후)로 교체가 필요합니다.'
      : status === 403
        ? '이 계정에는 BIMS 사용자 식별자(sid)가 없어 프로젝트를 사용할 수 없습니다. BIMS 연동 계정으로 로그인해 주세요.'
        : status === 401
          ? // 만료 토큰은 보통 전역 인터셉터가 갱신·재시도해 여기까지 오지
            // 않는다. 이 문구는 갱신까지 실패한 경우(리프레시 토큰 만료)용.
            '세션이 만료되었습니다. 다시 로그인해 주세요.'
          : '네트워크 또는 서버 오류입니다. 잠시 후 다시 시도해 주세요.';

  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-red-300 bg-red-50 px-6 py-14 text-center dark:border-red-800 dark:bg-red-950/40">
      <p className="text-sm font-medium text-red-700 dark:text-red-300">
        프로젝트 목록을 불러오지 못했습니다{status != null ? ` (HTTP ${status})` : ''}
      </p>
      <p className="max-w-lg text-xs leading-relaxed text-red-700/90 dark:text-red-300/90">
        {hint}
      </p>
      {message && (
        <code className="max-w-lg truncate rounded bg-red-100 px-2 py-1 text-[11px] text-red-800 dark:bg-red-900/60 dark:text-red-200">
          {message}
        </code>
      )}
      <Button type="button" variant="outline" size="sm" className="mt-1" onClick={onRetry}>
        다시 시도
      </Button>
    </div>
  );
};

const EmptyProjects: React.FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-medium py-20 text-center">
    <FolderOpen className="h-10 w-10 text-text-secondary opacity-40" aria-hidden="true" />
    <p className="text-sm font-medium text-text-primary">아직 프로젝트가 없습니다</p>
    <p className="max-w-md text-xs leading-relaxed text-text-secondary">
      채팅 답변의 출처 패널이나 문서 검색 결과에서 문서를 담아 프로젝트로 관리할 수 있습니다.
      <br />
      담은 문서는 Harvey(하비) Vault로 보낼 수 있습니다.
    </p>
    <Button type="button" size="sm" className="mt-2 gap-1.5" onClick={onCreate}>
      <Plus className="h-4 w-4" aria-hidden="true" />새 프로젝트 만들기
    </Button>
  </div>
);

const ORIGIN_LABEL: Record<string, string> = {
  chat: '채팅',
  doc_search: '문서 검색',
};

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

const ProjectDetailPanel: React.FC<{
  projectId: string;
  onDeleted: () => void;
  onSearchDocuments: (query: string) => void;
}> = ({ projectId, onDeleted, onSearchDocuments }) => {
  const { showToast } = useToastContext();
  const { data: project, isLoading, isError: isDetailError, error: detailError } =
    useProject(projectId);
  const renameProject = useRenameProject();
  const deleteProject = useDeleteProject();
  const removeDocuments = useRemoveProjectDocuments();

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    setChecked(new Set());
    setEditingName(false);
    setFilter('');
  }, [projectId]);

  const documents = useMemo(() => {
    const docs = project?.documents ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) {
      return docs;
    }
    return docs.filter((d) => (displayNameOf(d) || d.file_name || d.doc_id).toLowerCase().includes(q));
  }, [project?.documents, filter]);

  const toggleDoc = (docId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  const allChecked = documents.length > 0 && documents.every((d) => checked.has(d.doc_id));

  const handleRename = async () => {
    const name = nameDraft.trim();
    if (!name || !project || name === project.name) {
      setEditingName(false);
      return;
    }
    try {
      await renameProject.mutateAsync({ projectId, name });
      setEditingName(false);
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), status: 'error' });
    }
  };

  const handleDelete = async () => {
    if (!project) {
      return;
    }
    if (!window.confirm(`'${project.name}' 프로젝트를 삭제할까요? 담긴 문서 목록도 사라집니다.`)) {
      return;
    }
    try {
      await deleteProject.mutateAsync({ projectId });
      showToast({ message: `'${project.name}' 프로젝트를 삭제했습니다`, status: 'success' });
      onDeleted();
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), status: 'error' });
    }
  };

  const handleRemove = async (docIds: string[]) => {
    if (docIds.length === 0) {
      return;
    }
    try {
      const result = await removeDocuments.mutateAsync({ projectId, docIds });
      showToast({ message: `${result.removed}건을 프로젝트에서 뺐습니다`, status: 'success' });
      setChecked(new Set());
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : String(e), status: 'error' });
    }
  };

  if (isDetailError) {
    return (
      <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-8 text-center text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
        프로젝트 상세를 불러오지 못했습니다:{' '}
        {detailError instanceof Error ? detailError.message : String(detailError)}
      </div>
    );
  }

  if (isLoading || !project) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border-light bg-surface-primary">
      {/* 상세 헤더 */}
      <div className="flex items-center gap-2 border-b border-border-light px-4 py-3">
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleRename();
              }
              if (e.key === 'Escape') {
                setEditingName(false);
              }
            }}
            onBlur={handleRename}
            className="min-w-0 flex-1 rounded-md border border-border-medium bg-transparent px-2 py-1 text-sm font-medium text-text-primary outline-none"
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
            {project.name}
            <span className="ml-2 text-xs font-normal text-text-tertiary">
              {project.document_count}건
            </span>
          </h2>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="이름 변경"
          onClick={() => {
            setNameDraft(project.name);
            setEditingName(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="프로젝트 삭제"
          onClick={handleDelete}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>

      <HarveySyncPanel project={project} />

      {project.documents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
          <MessageSquareText
            className="h-8 w-8 text-text-secondary opacity-40"
            aria-hidden="true"
          />
          <p className="text-sm text-text-primary">아직 담긴 문서가 없습니다</p>
          <p className="max-w-sm text-xs leading-relaxed text-text-secondary">
            채팅 출처 패널의 &lsquo;프로젝트에 담기&rsquo; 버튼이나 문서 검색에서 여러 건을
            선택해 담아 보세요.
          </p>
        </div>
      ) : (
        <>
          {/* 툴바: 필터 + 선택 제거 */}
          <div className="flex items-center gap-2 border-b border-border-light px-4 py-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-text-secondary">
              <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="담긴 문서 필터"
                className="min-w-0 flex-1 bg-transparent py-1 text-xs text-text-primary outline-none"
              />
            </label>
            {checked.size > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 rounded-md px-2 text-xs"
                disabled={removeDocuments.isLoading}
                onClick={() => handleRemove(Array.from(checked))}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                {checked.size}건 빼기
              </Button>
            )}
          </div>

          {/* 문서 목록 */}
          <ul className="divide-y divide-border-light">
            <li className="flex items-center gap-3 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
              <input
                type="checkbox"
                aria-label="전체 선택"
                checked={allChecked}
                onChange={() =>
                  setChecked(allChecked ? new Set() : new Set(documents.map((d) => d.doc_id)))
                }
                className="h-3.5 w-3.5 cursor-pointer accent-text-primary"
              />
              <span className="flex-1">문서</span>
              <span className="hidden w-20 sm:block">담은 출처</span>
              <span className="hidden w-20 sm:block">추가일</span>
              <span className="w-24 text-right">열기</span>
            </li>
            {documents.map((doc) => (
              <ProjectDocRow
                key={doc.doc_id}
                doc={doc}
                checked={checked.has(doc.doc_id)}
                onToggle={() => toggleDoc(doc.doc_id)}
                onRemove={() => handleRemove([doc.doc_id])}
                onSearch={() => onSearchDocuments(doc.file_name ?? doc.doc_id)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

// doc_id → iManage 링크 lazy 조회 캐시 (ResultCard 와 같은 엔드포인트)
// 상태코드를 같이 기억한다 — 403(권한) / 404(링크·메타데이터 없음) / 기타 실패를
// 사용자에게 구분해서 알려야 한다 (2026-10-19 KM팀: "링크를 찾지 못했습니다" 하나로
// 데이터 결손과 권한 문제가 섞여 보고됐다).
type ImanageLinkResult = { url: string | null; status: number | null };
const imanageLinksCache = new Map<string, ImanageLinkResult>();

async function fetchImanageFileUrl(docId: string): Promise<ImanageLinkResult> {
  const cached = imanageLinksCache.get(docId);
  if (cached) {
    return cached;
  }
  let result: ImanageLinkResult;
  try {
    const resp = await fetch(`/bkl/v1/imanage-links/${encodeURIComponent(docId)}`);
    if (!resp.ok) {
      result = { url: null, status: resp.status };
    } else {
      const data = await resp.json();
      result = { url: data.imanage_url ?? data.imanage_preview_url ?? null, status: resp.status };
    }
  } catch {
    result = { url: null, status: null };
  }
  imanageLinksCache.set(docId, result);
  return result;
}

function imanageLinkFailureMessage(status: number | null): string {
  if (status === 403) {
    return '이 문서에 대한 접근 권한이 없습니다.';
  }
  if (status === 404) {
    return 'iManage 링크 정보가 없습니다.';
  }
  return 'iManage 링크 조회에 실패했습니다.';
}

const ProjectDocRow: React.FC<{
  doc: ProjectDocument;
  checked: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onSearch: () => void;
}> = ({ doc, checked, onToggle, onRemove, onSearch }) => {
  const { showToast } = useToastContext();
  const [opening, setOpening] = useState(false);

  const openImanage = async () => {
    if (opening) {
      return;
    }
    setOpening(true);
    const { url, status } = await fetchImanageFileUrl(doc.doc_id);
    setOpening(false);
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      showToast({
        message: imanageLinkFailureMessage(status),
        status: status === 404 ? 'warning' : 'error',
      });
    }
  };

  return (
    <li className={cn('flex items-center gap-3 px-4 py-2.5', checked && 'bg-surface-active-alt')}>
      <input
        type="checkbox"
        aria-label={`${displayNameOf(doc) || doc.doc_id} 선택`}
        checked={checked}
        onChange={onToggle}
        className="h-3.5 w-3.5 cursor-pointer accent-text-primary"
      />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm text-text-primary"
          title={displayNameOf(doc) || doc.doc_id}
        >
          {displayNameOf(doc) || doc.doc_id}
        </p>
        {doc.matter_uid && <p className="truncate text-xs text-text-tertiary">{doc.matter_uid}</p>}
        {/* Harvey 전송에서 빠진 문서는 여기서 알려준다 — 상단 패널은 건수만 보여주므로
            어느 문서가 문제인지 알 수 없다. */}
        {doc.harvey_sync_error && !doc.harvey_file_id && (
          <p className="flex items-center gap-1 truncate text-xs text-amber-600 dark:text-amber-500">
            <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
            Harvey 전송 실패: {doc.harvey_sync_error}
          </p>
        )}
      </div>
      <span className="hidden w-20 text-xs text-text-secondary sm:block">
        {doc.origin ? ORIGIN_LABEL[doc.origin] ?? doc.origin : ''}
      </span>
      <span className="hidden w-20 text-xs text-text-secondary sm:block">
        {formatDate(doc.added_at)}
      </span>
      <div className="flex w-24 items-center justify-end gap-0.5">
        <button
          type="button"
          title="iM 파일"
          aria-label="iM 파일 열기"
          onClick={openImanage}
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          {opening ? (
            <Spinner className="size-3" />
          ) : (
            <ExternalLink size={13} aria-hidden="true" />
          )}
          iM
        </button>
        <button
          type="button"
          title="문서 검색에서 보기"
          aria-label="문서 검색에서 보기"
          onClick={onSearch}
          className="inline-flex h-7 items-center rounded-md px-1.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          <Search size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="프로젝트에서 빼기"
          aria-label="프로젝트에서 빼기"
          onClick={onRemove}
          className="inline-flex h-7 items-center rounded-md px-1.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
};

export default ProjectsPage;
