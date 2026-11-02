/**
 * 사용자 표시용 파일명 (FILENAME_DISPLAY_FIX_SPEC).
 *
 * 수집기는 같은 폴더에 동명 파일이 있을 때만 `_{document_number}` 를 파일명 끝에
 * 붙인다 (이메일 RE: 체인에서 흔함). 이 서픽스와 OCR 산출물 확장자 `.md` 는
 * 사용자에게 의미가 없어 **표시에서만** 걷어낸다.
 *
 * 서버가 `display_name` 을 주면 그걸 쓰고(권위), 없으면(구버전 응답·로컬 캐시)
 * `imanage_document_number` 로 같은 규칙을 클라이언트에서 적용한다.
 *
 * 식별자(doc_id·URL·React key·검색어·프로젝트 저장값)에는 절대 쓰지 말 것.
 */
import { stripDisplayExtension } from './fileTypeIcon';

/** 서버 hyperlink_map 안의 원본 파일명 → 표시명 부속 지도 키 (generate.py HYPERLINK_DISPLAY_KEY). */
export const HYPERLINK_DISPLAY_KEY = '__display_names__';

export function displayFileName(
  fileName: string | null | undefined,
  documentNumber?: string | number | null,
  { stripMd = true }: { stripMd?: boolean } = {},
): string {
  if (!fileName) return '';
  let name = String(fileName);
  if (documentNumber != null && String(documentNumber).trim() !== '') {
    const num = String(documentNumber).trim();
    if (/^\d+$/.test(num)) {
      // 뒤에 확장자(들)만 남는 위치의 _{num} 하나만 — 중간의 같은 숫자·다른 숫자는 보존
      name = name.replace(new RegExp(`_${num}(?=(?:\\.[^.\\s]+)*$)`), '');
    }
  }
  if (stripMd) name = stripDisplayExtension(name).replace(/\.(?:md|markdown)$/i, '');
  return name;
}

type MetaLike = {
  display_name?: unknown;
  imanage_document_number?: unknown;
  name?: unknown;
  file_name?: unknown;
} & Record<string, unknown>;

/** `『파일명』- [n]` 헤더에서 파일명만. */
export function stripCitationHeader(raw: string): string {
  const m = raw.normalize('NFC').match(/^『(.+?)』/);
  return (m ? m[1] : raw.normalize('NFC')).trim();
}

/**
 * 출처 metadata[0] 에서 표시용 파일명. `display_name` 우선, 없으면
 * `name`/`file_name` 에서 헤더를 벗기고 `imanage_document_number` 규칙 적용.
 */
export function displayNameFromMeta(meta: MetaLike | null | undefined, fallback = ''): string {
  if (!meta) return fallback;
  if (typeof meta.display_name === 'string' && meta.display_name) {
    return meta.display_name.normalize('NFC');
  }
  const raw = meta.name ?? meta.file_name;
  if (typeof raw !== 'string' || !raw) return fallback;
  const docNum =
    typeof meta.imanage_document_number === 'string' ||
    typeof meta.imanage_document_number === 'number'
      ? meta.imanage_document_number
      : null;
  return displayFileName(stripCitationHeader(raw), docNum) || fallback;
}

/** 문서검색 hit / 프로젝트 문서 / 필터 문서처럼 평면 객체용. */
export function displayNameOf(doc: {
  display_name?: string | null;
  file_name?: string | null;
  imanage_document_number?: string | number | null;
}): string {
  if (doc.display_name) return doc.display_name;
  return displayFileName(doc.file_name, doc.imanage_document_number ?? null);
}
