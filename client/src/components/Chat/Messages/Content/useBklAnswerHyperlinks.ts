import { useEffect, useMemo, useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { BKL_SOURCES_EVENT } from '~/utils/bklSourcesEvent';
import { stripDisplayExtension } from '~/utils/fileTypeIcon';
import { HYPERLINK_DISPLAY_KEY, displayFileName, displayNameFromMeta } from '~/utils/displayName';
import { extractBklRidFromMessage } from '~/utils/bklFilter';
import type { BklSource } from './ChunkModal';

/**
 * 답변 끝 "검색 문서 리스트" 표의 『파일명』을 iManage 링크로 바꾸기 위한
 * 파일명 → URL 조회.
 *
 * 스트리밍 경로에서는 백엔드가 본문을 그대로 흘려보내고, 링크 매핑은
 * `GET /bkl/v1/hyperlinks/{rid}` 로 따로 준다 (LibreChat agents SSE 가
 * custom `hyperlinks` 이벤트를 버리므로 REST). 매핑에 빠진 파일은 우측
 * 패널이 쓰는 출처 캐시(window.__bklSources)의 imanage URL 로 보완한다 —
 * 두 경로 모두 PG `document_tags` 의 `imanage_preview_url` 이 원천이다.
 */

type HyperlinkMap = ReadonlyMap<string, string>;

/**
 * 한 답변의 링크 해석기. 파일명만으로는 동명 문서(사건마다 하나씩 있는
 * 「주식매매계약서.docx」)를 구분할 수 없어 doc_id 경로를 우선한다.
 *
 * 해석 순서 (applyBklAnswerHyperlinks):
 *  1. 『파일명』 바로 뒤의 인용번호 `[N]` → 이 답변의 출처 N → doc_id → URL
 *  2. 이 답변의 출처 중 같은 파일명을 가진 doc_id → URL (상위 랭크 우선)
 *  3. 파일명 → URL (서버 지도; 동명 문서가 있으면 상위 랭크 문서)
 *
 * 링크와 별개로 『파일명』의 **표시 텍스트**도 바꾼다 (FILENAME_DISPLAY_FIX_SPEC):
 * 서버 지도의 `__display_names__`(원본 → 표시명) 와 출처 메타의 `display_name`
 * 으로 `_{document_number}`·`.md` 를 걷어낸 이름을 보여준다. URL 해석 키는
 * 여전히 원본 파일명이다.
 */
export type BklHyperlinkResolver = {
  byName: HyperlinkMap;
  byDocId: HyperlinkMap;
  /** 인용번호(1-based) → doc_id */
  citationDocIds: ReadonlyMap<number, string>;
  /** 정규화 파일명 → 이 답변 출처의 doc_id 들 (출처 순서) */
  nameDocIds: ReadonlyMap<string, readonly string[]>;
  /** 정규화 원본 파일명 → 표시명 (원본과 다를 때만) */
  displayNames: ReadonlyMap<string, string>;
};

/** 서버 hyperlink_map 안의 doc_id → URL 부속 지도 키 (generate.py HYPERLINK_BY_DOC_KEY). */
const BY_DOC_KEY = '__by_doc_id__';

type HyperlinksResponse = { mapping?: Record<string, unknown> };

type BklWindow = Window & {
  __bklRids?: Record<string, string>;
  __bklSources?: Record<string, BklSource[]>;
};

const BKL_API = '/bkl';
const RID_RE = /<!--\s*bkl_rid:([A-Za-z0-9_-]+)\s*-->/;
const MD_LINK_RE = /^\[(?:『)?([^』\]]+)(?:』)?\]\((.+)\)$/;
/** 『파일명』 — 이미 링크 텍스트인 경우( `[『…』](` )는 치환하지 않는다. */
const FILE_MENTION_RE = /『([^『』\n]+)』/g;
/** 답변 저장 직후 매핑이 아직 PG 에 없을 수 있어 나눠 시도한다. */
const FETCH_RETRY_DELAYS_MS = [0, 1500, 4000];

/** 『파일명』 뒤에 붙는 인용번호: `- [32]`, `[32]`, `-[32]` (공백·대시 허용). */
const TRAILING_CITATION_RE = /^\s*[-–—]?\s*\[(\d{1,3})\]/;

type RidMaps = {
  byName: HyperlinkMap;
  byDocId: HyperlinkMap;
  displayNames: ReadonlyMap<string, string>;
};

const ridMapCache = new Map<string, RidMaps | null>();
const ridMapInflight = new Map<string, Promise<RidMaps | null>>();

/** 표기 차이(NFC/NFD, 공백, OCR 파생 `.md`)를 접어 비교 키를 만든다. */
export function normalizeFileKey(name: string): string {
  return stripDisplayExtension(name.normalize('NFC').trim()).toLowerCase();
}

function stripBrackets(name: string): string {
  const m = name.normalize('NFC').match(/『(.+?)』/);
  return (m ? m[1] : name).trim();
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && !value.includes('|');
}

function urlFromMappingValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const link = value.match(MD_LINK_RE);
  const url = (link ? link[2] : value).trim();
  return isHttpUrl(url) ? url : null;
}

export function parseHyperlinksResponse(json: HyperlinksResponse | null): RidMaps | null {
  const mapping = json?.mapping;
  if (!mapping || typeof mapping !== 'object') return null;
  const byName = new Map<string, string>();
  const byDocId = new Map<string, string>();
  const displayNames = new Map<string, string>();
  for (const [key, value] of Object.entries(mapping)) {
    if (key === BY_DOC_KEY) {
      if (value && typeof value === 'object') {
        for (const [docId, url] of Object.entries(value as Record<string, unknown>)) {
          if (typeof url === 'string' && isHttpUrl(url)) byDocId.set(docId, url);
        }
      }
      continue;
    }
    if (key === HYPERLINK_DISPLAY_KEY) {
      if (value && typeof value === 'object') {
        for (const [raw, disp] of Object.entries(value as Record<string, unknown>)) {
          if (typeof disp === 'string' && disp) displayNames.set(normalizeFileKey(raw), disp);
        }
      }
      continue;
    }
    const url = urlFromMappingValue(value);
    if (!url) continue;
    byName.set(normalizeFileKey(stripBrackets(key)), url);
  }
  return byName.size > 0 || byDocId.size > 0 || displayNames.size > 0
    ? { byName, byDocId, displayNames }
    : null;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function fetchHyperlinkMap(rid: string): Promise<RidMaps | null> {
  for (let i = 0; i < FETCH_RETRY_DELAYS_MS.length; i++) {
    if (FETCH_RETRY_DELAYS_MS[i] > 0) await sleep(FETCH_RETRY_DELAYS_MS[i]);
    try {
      const resp = await fetch(`${BKL_API}/v1/hyperlinks/${encodeURIComponent(rid)}`);
      if (resp.ok) return parseHyperlinksResponse((await resp.json()) as HyperlinksResponse);
      if (resp.status !== 404) return null;
    } catch {
      /* 네트워크 오류 — 다음 시도 */
    }
  }
  return null;
}

function loadHyperlinkMap(rid: string): Promise<RidMaps | null> {
  if (ridMapCache.has(rid)) return Promise.resolve(ridMapCache.get(rid) ?? null);
  const pending = ridMapInflight.get(rid);
  if (pending) return pending;
  const request = fetchHyperlinkMap(rid)
    .then((map) => {
      ridMapCache.set(rid, map);
      return map;
    })
    .finally(() => ridMapInflight.delete(rid));
  ridMapInflight.set(rid, request);
  return request;
}

function sourceImanageUrl(source: BklSource): string | null {
  const meta = source.metadata?.[0] as Record<string, unknown> | undefined;
  const candidates = [
    source.source?.imanage_url,
    source.source?.imanage_preview_url,
    meta?.imanage_url,
    meta?.imanage_preview_url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && isHttpUrl(c)) return c;
  }
  return null;
}

function sourceFileName(source: BklSource): string | null {
  const meta = source.metadata?.[0];
  const raw = meta?.name ?? meta?.file_name;
  return typeof raw === 'string' && raw ? stripBrackets(raw) : null;
}

function sourceDocId(source: BklSource): string | null {
  const raw = source.metadata?.[0]?.doc_id;
  return typeof raw === 'string' && raw ? raw : null;
}

/** 출처 캐시에서 파일명 → iManage URL. 캐시가 없으면 null. */
export function hyperlinkMapFromSources(sources: BklSource[] | undefined): HyperlinkMap | null {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const out = new Map<string, string>();
  for (const source of sources) {
    const name = sourceFileName(source);
    if (!name) continue;
    const key = normalizeFileKey(name);
    if (out.has(key)) continue;
    const url = sourceImanageUrl(source);
    if (url) out.set(key, url);
  }
  return out.size > 0 ? out : null;
}

type SourceIndex = {
  byDocId: Map<string, string>;
  citationDocIds: Map<number, string>;
  nameDocIds: Map<string, string[]>;
  /** 정규화 원본 파일명 → 표시명 (출처 메타 display_name / document_number 규칙) */
  displayNames: Map<string, string>;
};

/**
 * 출처 캐시에서 doc_id 기반 색인을 만든다. 출처 배열의 순서가 곧 인용번호
 * (`[N]` → sources[N-1]) 이고, 같은 doc_id 의 청크가 여러 번 나와도 doc 단위로
 * 접는다. 출처 payload 에 URL 이 있으면 byDocId 에도 넣는다.
 */
export function sourceIndexFromSources(sources: BklSource[] | undefined): SourceIndex | null {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const idx: SourceIndex = {
    byDocId: new Map(),
    citationDocIds: new Map(),
    nameDocIds: new Map(),
    displayNames: new Map(),
  };
  sources.forEach((source, i) => {
    const name = sourceFileName(source);
    if (name) {
      const key = normalizeFileKey(name);
      const disp = displayNameFromMeta(source.metadata?.[0]);
      if (disp && disp !== name && !idx.displayNames.has(key)) idx.displayNames.set(key, disp);
    }
    const docId = sourceDocId(source);
    if (!docId) return;
    idx.citationDocIds.set(i + 1, docId);
    const url = sourceImanageUrl(source);
    if (url && !idx.byDocId.has(docId)) idx.byDocId.set(docId, url);
    if (name) {
      const key = normalizeFileKey(name);
      const list = idx.nameDocIds.get(key) ?? [];
      if (!list.includes(docId)) idx.nameDocIds.set(key, [...list, docId]);
    }
  });
  return idx.citationDocIds.size > 0 || idx.displayNames.size > 0 ? idx : null;
}

function resolveRid(messageId: string, text: string, message?: TMessage): string | null {
  const fromText = text.match(RID_RE)?.[1];
  if (fromText) return fromText;
  const fromMessage = extractBklRidFromMessage(message);
  if (fromMessage) return fromMessage;
  const win = window as BklWindow;
  return win.__bklRids?.[messageId] ?? null;
}

function mergeMaps(
  primary: HyperlinkMap | null,
  secondary: HyperlinkMap | null,
): HyperlinkMap | null {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const out = new Map(secondary);
  for (const [k, v] of primary) out.set(k, v);
  return out;
}

/** 파일명 맵만 있는 경우(테스트·구버전 서버)를 위한 해석기 생성. */
export function resolverFromMaps(
  byName: HyperlinkMap | null,
  byDocId: HyperlinkMap | null = null,
  sourceIndex: SourceIndex | null = null,
  displayNames: ReadonlyMap<string, string> | null = null,
): BklHyperlinkResolver | null {
  const name: HyperlinkMap = byName ?? new Map<string, string>();
  const doc: HyperlinkMap =
    mergeMaps(byDocId, sourceIndex?.byDocId ?? null) ?? new Map<string, string>();
  // 서버 지도가 권위, 출처 메타는 보완
  const disp: ReadonlyMap<string, string> =
    mergeMaps(displayNames, sourceIndex?.displayNames ?? null) ?? new Map<string, string>();
  if (name.size === 0 && doc.size === 0 && disp.size === 0) return null;
  return {
    byName: name,
    byDocId: doc,
    citationDocIds: sourceIndex?.citationDocIds ?? new Map<number, string>(),
    nameDocIds: sourceIndex?.nameDocIds ?? new Map<string, string[]>(),
    displayNames: disp,
  };
}

function resolveUrl(r: BklHyperlinkResolver, name: string, trailing: string): string | null {
  const key = normalizeFileKey(name);
  // 1) 인용번호 → doc_id
  const cite = trailing.match(TRAILING_CITATION_RE);
  if (cite) {
    const docId = r.citationDocIds.get(Number(cite[1]));
    const url = docId ? r.byDocId.get(docId) : undefined;
    if (url) return url;
  }
  // 2) 이 답변 출처 중 같은 파일명의 doc_id (상위 랭크 우선)
  for (const docId of r.nameDocIds.get(key) ?? []) {
    const url = r.byDocId.get(docId);
    if (url) return url;
  }
  // 3) 파일명 지도
  return r.byName.get(key) ?? null;
}

/** 『파일명』의 표시 텍스트 — 표시명이 있으면 그걸로, 없으면 원본 그대로. */
function displayMention(r: BklHyperlinkResolver, name: string): string {
  const disp = r.displayNames.get(normalizeFileKey(name));
  // 지도에 없으면 최소한 OCR `.md` 만 걷어낸다 (document_number 는 모르므로 보존).
  return `『${disp ?? displayFileName(name, null)}』`;
}

/**
 * 본문의 『파일명』을 `[『파일명』](<url>)` 마크다운 링크로 바꾼다.
 *
 * 이미 링크 텍스트인 자리(딥씽킹 경로는 서버가 미리 링크를 박는다)는 URL 을
 * 건드리지 않고 표시 텍스트만 정제한다.
 * URL 은 `<…>` 로 감싸 공백·괄호가 있어도 링크가 깨지지 않게 한다.
 * `lookup` 에는 해석기 또는 (하위 호환) 파일명 → URL 맵을 넘길 수 있다.
 */
export function applyBklAnswerHyperlinks(
  text: string,
  lookup: BklHyperlinkResolver | HyperlinkMap | null,
): string {
  if (!text || !lookup || text.indexOf('『') === -1) return text;
  const resolver =
    lookup instanceof Map ? resolverFromMaps(lookup) : (lookup as BklHyperlinkResolver);
  if (!resolver) return text;
  return text.replace(FILE_MENTION_RE, (full: string, name: string, offset: number) => {
    const before = text[offset - 1];
    const end = offset + full.length;
    const after = text.slice(end, end + 2);
    const shown = displayMention(resolver, name);
    if (before === '[' && after === '](') return shown;
    const url = resolveUrl(resolver, name, text.slice(end, end + 12));
    return url ? `[${shown}](<${url}>)` : shown;
  });
}

function useSourcesTick(messageId: string, enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const bump = () => setTick((t) => t + 1);
    window.addEventListener(BKL_SOURCES_EVENT, bump);
    return () => window.removeEventListener(BKL_SOURCES_EVENT, bump);
  }, [messageId, enabled]);
  return tick;
}

/**
 * 어시스턴트 답변 하나에 대한 파일명 → iManage URL 조회 맵. 아직 못 받았거나
 * 링크 걸 파일이 없으면 null.
 */
export function useBklAnswerHyperlinks(
  messageId: string,
  text: string,
  message: TMessage | undefined,
  enabled: boolean,
): BklHyperlinkResolver | null {
  const hasMention = enabled && text.indexOf('『') !== -1;
  const sourcesTick = useSourcesTick(messageId, hasMention);
  const rid = useMemo(
    () => (hasMention ? resolveRid(messageId, text, message) : null),
    // text 가 바뀔 때마다 rid 를 다시 찾는다 — 스트리밍 끝에 rid 주석이 붙는다.
    // sourcesTick: 본문 주석이 없는 경로는 window.__bklRids 가 출처 캐시와
    // 함께 채워지므로 그 이벤트에도 다시 찾는다 (값 자체는 쓰지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasMention, messageId, text, message, sourcesTick],
  );
  const [ridMap, setRidMap] = useState<RidMaps | null>(null);

  useEffect(() => {
    if (!rid) return;
    const cached = ridMapCache.get(rid);
    if (cached) {
      setRidMap(cached);
      return;
    }
    let cancelled = false;
    loadHyperlinkMap(rid).then((map) => {
      if (!cancelled && map) setRidMap(map);
    });
    return () => {
      cancelled = true;
    };
  }, [rid]);

  const sources = useMemo(() => {
    if (!hasMention) return { byName: null, index: null };
    const win = window as BklWindow;
    const list = win.__bklSources?.[messageId];
    return { byName: hyperlinkMapFromSources(list), index: sourceIndexFromSources(list) };
    // sourcesTick: window.__bklSources 변화 감지용 — 값 자체는 쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMention, messageId, sourcesTick]);

  return useMemo(
    () =>
      resolverFromMaps(
        mergeMaps(ridMap?.byName ?? null, sources.byName),
        ridMap?.byDocId ?? null,
        sources.index,
        ridMap?.displayNames ?? null,
      ),
    [ridMap, sources],
  );
}
