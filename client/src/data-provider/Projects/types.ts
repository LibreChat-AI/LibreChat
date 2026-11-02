/** 프로젝트(Harvey Vault류) API 타입 — bkl-api /api/projects/* 응답과 1:1. */

export type ProjectDocumentOrigin = 'chat' | 'doc_search';

/**
 * Harvey 전송 상태.
 *
 * `null` 은 아직 보낸 적 없음. `partial` 은 일부 문서가 원본을 못 찾았거나
 * 회차 상한을 넘어 남은 상태로, 다시 보내면 남은 것만 올린다. `error` 는
 * 대개 403 — 선택한 Harvey 프로젝트에 대한 업로드 권한이 없는 경우다.
 */
export type HarveySyncStatus = 'syncing' | 'synced' | 'partial' | 'error';

/**
 * 로그인 사용자가 Harvey 에서 접근 가능한 프로젝트 (전송 대상 후보).
 *
 * 우리가 만드는 게 아니라 Harvey 에 이미 있는 것이다. `can_upload` 가 false 면
 * 목록에는 보이지만 대상으로 고를 수 없다.
 */
export interface HarveyProject {
  project_id: string;
  project_name: string;
  created_at: string | null;
  access_level: string | null;
  can_upload: boolean;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  description: string | null;
  /** 사용자가 고른 Harvey 프로젝트 id. 다시 보내기는 여기로 간다. */
  harvey_vault_id?: string | null;
  harvey_vault_name?: string | null;
  harvey_sync_status?: HarveySyncStatus | null;
  harvey_synced_at?: string | null;
  harvey_sync_error?: string | null;
  created_at: string;
  updated_at: string;
  document_count: number;
  /** Harvey 에 올라간 문서 수. document_count 와 함께 진행률로 쓴다. */
  harvey_synced_count?: number;
}

export interface ProjectDocument {
  doc_id: string;
  collection: string | null;
  file_name: string | null;
  /** 표시용 파일명 (서버 계산, 구버전 응답엔 없음) */
  display_name?: string | null;
  matter_uid: string | null;
  origin: ProjectDocumentOrigin | null;
  added_at: string;
  harvey_file_id?: string | null;
  harvey_synced_at?: string | null;
  harvey_sync_error?: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  documents: ProjectDocument[];
}

export interface HarveySyncStarted {
  started: boolean;
  project_id: string;
  status: 'syncing';
}

export interface HarveyRefreshResult {
  refreshed: boolean;
  projects_processed: number | null;
  snapshot_id: string | null;
}

export interface ProjectDocumentInput {
  doc_id: string;
  collection?: string | null;
  file_name?: string | null;
  matter_uid?: string | null;
  origin?: ProjectDocumentOrigin;
}

export interface AddDocumentsResult {
  added: number;
  skipped: number;
}
