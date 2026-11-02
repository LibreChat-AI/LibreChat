import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useMessageContext } from '~/Providers';
import { useOpenBklSource } from '~/components/Chat/BklPanel/useActiveBklSource';
import { FileTypeIcon } from '~/utils';
import { getFileExtension, stripDisplayExtension } from '~/utils/fileTypeIcon';
import { displayNameFromMeta } from '~/utils/displayName';
import { BKL_SOURCES_EVENT, notifyBklSourcesChanged } from '~/utils/bklSourcesEvent';
import { type BklSource } from './ChunkModal';

type BklCitationProps = {
  n: number;
};

const BKL_API = '/bkl';

/** 같은 메시지에 대해 여러 칩이 동시에 조회를 걸지 않게 막는다. */
const _fetchInflight = new Set<string>();

/**
 * messageId 별 서버 조회 횟수.
 *
 * 예전에는 `_fetchInflight` 에 넣기만 하고 절대 지우지 않아, 스트리밍 중
 * 첫 조회가 실패하면(메시지가 아직 저장 전이라 404) 그 메시지는 두 번 다시
 * 조회되지 않았다. 그래서 이벤트를 놓치면 새로고침 말고는 방법이 없었다.
 * 이제 조회가 끝나면 풀어주되, 영영 없는 출처를 무한히 두드리지 않도록
 * 횟수로 막는다.
 */
const _fetchAttempts = new Map<string, number>();
const _MAX_FETCH_ATTEMPTS = 10;

function requestSources(messageId: string, { force = false } = {}): void {
  if (_fetchInflight.has(messageId)) return;
  const attempts = _fetchAttempts.get(messageId) ?? 0;
  if (attempts >= _MAX_FETCH_ATTEMPTS) return;
  _fetchInflight.add(messageId);
  _fetchAttempts.set(messageId, attempts + 1);
  void fetchSourcesForMessage(messageId, { forceRefresh: force })
    .catch(() => {})
    .finally(() => _fetchInflight.delete(messageId));
}

function extractFileName(metaName: string): string {
  const m = metaName.normalize('NFC').match(/^『(.+?)』/);
  // OCR 파생 `.md` 는 표시에서 제거 (계약서.pdf.md → 계약서.pdf)
  return stripDisplayExtension(m ? m[1] : metaName.normalize('NFC'));
}

function truncateMiddle(str: string, maxLen = 22): string {
  const s = str.normalize('NFC');
  if (s.length <= maxLen) return s;
  const keepStart = Math.ceil((maxLen - 3) * 0.55);
  const keepEnd = maxLen - 3 - keepStart;
  return s.substring(0, keepStart) + '...' + s.substring(s.length - keepEnd);
}

async function fetchWithRetry(url: string, retries = 2, delayMs = 500): Promise<Response | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp;
      if (resp.status === 404 && i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return null;
    } catch {
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  return null;
}

const _LS_PREFIX = 'bkl_src_';
const _LS_MAX_ENTRIES = 200;

function _lsKey(messageId: string): string {
  return _LS_PREFIX + messageId;
}

function getCachedRequestId(messageId: string): string | null {
  try {
    const raw = localStorage.getItem(_lsKey(messageId));
    if (!raw) return null;
    const { r } = JSON.parse(raw);
    return typeof r === 'string' && r ? r : null;
  } catch {
    return null;
  }
}

function _pruneLocalStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(_LS_PREFIX)) keys.push(k);
    }
    if (keys.length > _LS_MAX_ENTRIES) {
      keys.slice(0, keys.length - _LS_MAX_ENTRIES).forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    /* quota or security error — ignore */
  }
}

function cacheSources(messageId: string, sources: BklSource[], rid?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  win.__bklSources = win.__bklSources ?? {};
  win.__bklSources[messageId] = sources;
  if (rid) {
    win.__bklSourcesByRid = win.__bklSourcesByRid ?? {};
    win.__bklSourcesByRid[rid] = sources;
  }
  notifyBklSourcesChanged();

  // Known-empty (e.g. every source was ACL-filtered out) is cached in session
  // memory only: persisting `[]` to localStorage would keep the panel empty
  // forever, even after the user later gains access to the matter.
  if (sources.length === 0) return;

  try {
    _pruneLocalStorage();
    const payload = JSON.stringify({ s: sources, r: rid ?? null });
    localStorage.setItem(_lsKey(messageId), payload);
  } catch {
    /* quota exceeded — in-memory still works */
  }
}

function loadSourcesFromStorage(messageId: string): BklSource[] | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  const mem = win.__bklSources?.[messageId];
  // An empty array is a *definitive* answer ("server said no sources"), not
  // "still loading" — return it so callers stop refetching / spinning.
  if (Array.isArray(mem)) return mem;

  try {
    const raw = localStorage.getItem(_lsKey(messageId));
    if (raw) {
      const { s, r } = JSON.parse(raw);
      if (Array.isArray(s) && s.length > 0) {
        win.__bklSources = win.__bklSources ?? {};
        win.__bklSources[messageId] = s;
        if (r) {
          win.__bklSourcesByRid = win.__bklSourcesByRid ?? {};
          win.__bklSourcesByRid[r] = s;
        }
        return s;
      }
    }
  } catch {
    /* parse error — ignore */
  }

  return null;
}

async function fetchSourcesForMessage(
  messageId: string,
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<BklSource[] | null> {
  const existing = forceRefresh ? null : loadSourcesFromStorage(messageId);
  if (existing) return existing;

  const msgEl = document.getElementById(messageId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  let rid: string | null = msgEl?.getAttribute('data-bkl-rid') ?? null;
  if (!rid) rid = win.__bklRids?.[messageId] ?? null;
  if (!rid) rid = getCachedRequestId(messageId);

  // Tracks a 200 OK response whose sources array was empty (typically every
  // source got ACL-filtered out server-side). That's a definitive "no
  // sources for you" — cache `[]` so the UI shows a message instead of an
  // infinite "출처를 불러오는 중…" spinner. `null` stays reserved for "could
  // not reach the API / not persisted yet" so retries remain possible.
  let sawEmpty = false;

  if (rid) {
    const resp = await fetchWithRetry(`${BKL_API}/v1/sources/${rid}`);
    if (resp) {
      try {
        const data = await resp.json();
        const sources = data.sources ?? data;
        if (Array.isArray(sources)) {
          if (sources.length > 0) {
            cacheSources(messageId, sources, rid);
            return sources;
          }
          sawEmpty = true;
        }
      } catch {
        /* fall through */
      }
    }
  }

  if (messageId) {
    const byMsgResp = await fetchWithRetry(
      `${BKL_API}/v1/sources/by-message/${encodeURIComponent(messageId)}`,
    );
    if (byMsgResp) {
      try {
        const data = await byMsgResp.json();
        const sources: BklSource[] = data.sources ?? data;
        if (Array.isArray(sources)) {
          if (sources.length > 0) {
            cacheSources(messageId, sources, data.request_id);
            if (data.request_id) {
              win.__bklRids = win.__bklRids ?? {};
              win.__bklRids[messageId] = data.request_id;
            }
            return sources;
          }
          sawEmpty = true;
        }
      } catch {
        /* fall through */
      }
    }
  }

  if (sawEmpty) {
    cacheSources(messageId, []);
    return [];
  }

  return null;
}

/**
 * 캐시에 배열은 있는데 요청한 번호 자리만 비어 있는 상태 — 낡은 캐시다.
 *
 * 서버는 스트리밍 *전에* 검색 청크만으로 출처를 한 번 캐시한다. 그 시점에
 * 프론트가 조회하면 DocRead virtual source 가 빠진 짧은 배열을 받아
 * localStorage 에까지 저장한다. 이후 서버가 전문 읽기 결과를 뒤에 덧붙여도
 * 클라이언트 캐시는 낡은 채로 남아 `[56]` 같은 뒤쪽 번호가 영영 안 풀린다.
 * 새로고침하면 localStorage 의 낡은 배열이 다시 살아나 더 끈질기다.
 *
 * 길이가 0 인 배열은 "서버가 출처 없음이라고 답했다" 는 확정 상태라 제외한다
 * (ACL 로 전부 걸러진 경우) — 재조회해봐야 같은 답이다.
 */
function isIndexMissingFromCache(messageId: string, n: number): boolean {
  const sources = loadSourcesFromStorage(messageId);
  return Array.isArray(sources) && sources.length > 0 && !sources[n - 1];
}

/** 낡은 캐시 재조회는 (messageId, n) 당 한 번만 — 실제로 없는 번호를 계속 두드리지 않는다. */
const _staleRefreshed = new Set<string>();

/**
 * 낡은 캐시로 판정되면 강제 재조회를 시작한다. 시작했으면 true.
 *
 * 평소 경로(`fetchSourcesForMessage`)는 캐시가 있으면 그대로 돌려주므로,
 * 이 경우엔 `forceRefresh` 없이는 영원히 같은 배열을 받는다.
 */
function refreshStaleCache(messageId: string, n: number): boolean {
  if (!isIndexMissingFromCache(messageId, n)) return false;
  const key = `${messageId}#${n}`;
  if (_staleRefreshed.has(key)) return false;
  _staleRefreshed.add(key);
  void fetchSourcesForMessage(messageId, { forceRefresh: true }).catch(() => {});
  return true;
}

/**
 * 탭에 돌아왔을 때처럼 "지금 상태가 어떻든 다시 확인" 이 필요한 순간에 쓴다.
 *
 * 캐시가 아예 없으면 평범하게 조회하고, 배열은 있는데 이 번호가 비었거나
 * 빈 배열이면 캐시를 무시하고 다시 받는다. 평소 조회 경로는 캐시가 있으면
 * 그대로 돌려주므로 `forceRefresh` 없이는 낫지 않는다.
 *
 * 새로고침이 이 문제를 고쳐주던 이유가 바로 서버 재조회다 — 돌아왔을 때도
 * 같은 일을 해준다.
 */
function refetchSources(messageId: string, n: number): void {
  const cached = loadSourcesFromStorage(messageId);
  const unusable = Array.isArray(cached) && (cached.length === 0 || !cached[n - 1]);
  requestSources(messageId, { force: unusable });
}

function getSourceLabel(messageId: string, n: number): string | null {
  const sources = loadSourcesFromStorage(messageId);
  if (!Array.isArray(sources) || !sources[n - 1]) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = sources[n - 1] as any;
  // 표시명: 서버 display_name → document_number 규칙 → 헤더 파싱 순 (FILENAME_DISPLAY_FIX_SPEC)
  const fileName =
    displayNameFromMeta(src.metadata?.[0]) ||
    (src.source?.name ? extractFileName(String(src.source.name)) : '');
  if (!fileName) return null;
  return truncateMiddle(fileName);
}

/**
 * Pull the file type (`pdf`, `msg`, `eml`, …) for citation [n], if known.
 *
 * The backend surfaces `metadata[0].file_type` in PR-C; if that field is
 * missing we fall back to parsing the extension out of the citation header
 * `『...』`. Returns null when sources aren't loaded yet.
 */
function getSourceFileType(messageId: string, n: number): string | null {
  const sources = loadSourcesFromStorage(messageId);
  if (!Array.isArray(sources) || !sources[n - 1]) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = sources[n - 1] as any;
  const explicit = src?.metadata?.[0]?.file_type;
  if (explicit && typeof explicit === 'string') return explicit.toLowerCase().replace(/^\./, '');
  const name: string = src?.metadata?.[0]?.name || src?.source?.name || '';
  if (!name) return null;
  // getFileExtension 은 `*.pdf.md` 이중 확장자에서 원본 타입(pdf)을 꺼낸다 —
  // 마지막 토큰만 자르면 전부 `md` 로 오인되던 문제 수정.
  return getFileExtension(extractFileName(name)) || null;
}

/**
 * 답변이 끝난 직후 서버가 출처를 저장하기까지 약간 걸릴 수 있어 나눠 시도한다.
 * 캐시가 그 사이 채워지면 남은 시도는 건너뛴다.
 */
const COMPLETION_RETRY_DELAYS_MS = [0, 1500, 4000];

export default function BklCitation({ n }: BklCitationProps) {
  const { messageId, isSubmitting } = useMessageContext();
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState<string | null>(() => getSourceLabel(messageId, n));
  const [fileType, setFileType] = useState<string | null>(() => getSourceFileType(messageId, n));
  const openSource = useOpenBklSource();

  /**
   * 답변이 끝나는 순간 출처를 다시 받는다.
   *
   * 스트리밍 중에 조회하면 서버가 **아직 검색 청크만** 캐시해둔 상태라 짧은
   * 배열이 온다. 그 배열이 클라이언트 캐시에 앉으면 검색 인용 [1..K] 는 바로
   * 풀리지만, 전문 읽기로 뒤에 붙는 [K+1..] 은 자리가 비어 있다. 그런데 폴링도
   * 이벤트도 캐시를 "다시 읽기"만 할 뿐 "다시 요청"하지는 않아서, 눌러서
   * 강제 조회가 돌기 전까지 영영 안 풀렸다. 사용자가 본 "flow 검색 인용은
   * 빠른데 이것만 눌러야 뜬다" 가 정확히 이 차이다 (2026-08-31).
   *
   * 답변 완료가 "서버에 완전한 배열이 올라왔다" 는 유일하게 확실한 신호다.
   * SSE 의 sources_replace 재매핑 경로에 기대지 않으므로, 그 경로가 어긋나도
   * (탭 전환 등으로 이벤트를 놓쳐도) 여기서 낫는다.
   */
  const wasSubmitting = useRef(isSubmitting === true);
  useEffect(() => {
    const justFinished = wasSubmitting.current && isSubmitting !== true;
    wasSubmitting.current = isSubmitting === true;
    if (!justFinished || label) return;

    let cancelled = false;
    const timers = COMPLETION_RETRY_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        if (cancelled || getSourceLabel(messageId, n)) return;
        refetchSources(messageId, n);
      }, delay),
    );
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [isSubmitting, label, messageId, n]);

  useEffect(() => {
    if (label) return;
    let cancelled = false;
    let iv: ReturnType<typeof setInterval> | null = null;

    const check = () => {
      const l = getSourceLabel(messageId, n);
      if (l && !cancelled) {
        setLabel(l);
        const ft = getSourceFileType(messageId, n);
        if (ft) setFileType(ft);
        return true;
      }
      return false;
    };

    if (check()) return;

    const stopPolling = () => {
      if (iv !== null) {
        clearInterval(iv);
        iv = null;
      }
    };
    /** 풀렸으면 대기 장치를 걷고 true. */
    const settle = () => {
      if (!check()) return false;
      stopPolling();
      window.removeEventListener(BKL_SOURCES_EVENT, settle);
      return true;
    };

    // 낡은 캐시면 강제 재조회가 필요하다 — 평소 경로는 캐시를 그대로 돌려준다.
    if (!refreshStaleCache(messageId, n)) {
      requestSources(messageId);
    }

    // 캐시에 쓰는 모든 지점이 이 이벤트를 발행한다. 예전에는 20초 폴링만
    // 있었는데, 스트리밍 중 출처는 `_pending_*` 키에 있어 messageId 로는
    // 안 보이고 실제 배열은 스트림이 끝나야 옮겨진다. 전문 읽기가 붙은 답변은
    // 60초를 넘기므로 그 전에 창이 닫혀, 인용이 파일명 없이 맨숫자로 남고
    // 클릭해야 비로소 이름이 뜨는 문제가 있었다 (2026-08-31 사용자 보고).
    window.addEventListener(BKL_SOURCES_EVENT, settle);

    // 답변을 기다리다 다른 탭에 갔다 오면 파일명이 안 박혀 있고 새로고침해야만
    // 보이는 문제가 있었다 (2026-08-31 사용자 보고). 배경 탭에서는 타이머가
    // 크게 제한되고, 그 사이 스트림이 끝나면서 발행된 이벤트를 놓치면 다시
    // 확인할 계기가 없었다. 돌아온 시점에 새로고침과 같은 일(서버 재조회)을
    // 해준다.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled) return;
      if (!settle()) {
        refetchSources(messageId, n);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    // 이벤트를 발행하지 않고 캐시를 채우는 경로가 남아 있을 때를 위한 안전망.
    // 이벤트가 본줄이므로 느슨하게 돌리고, 오래된 메시지에서 타이머가 영원히
    // 남지 않도록 끊는다 (리스너는 언마운트까지 유지된다).
    iv = setInterval(settle, 1000);
    const to = setTimeout(stopPolling, 120_000);

    return () => {
      cancelled = true;
      stopPolling();
      clearTimeout(to);
      window.removeEventListener(BKL_SOURCES_EVENT, settle);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [messageId, n, label]);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const cachedSources = loadSourcesFromStorage(messageId);
      let source: BklSource | null =
        Array.isArray(cachedSources) && cachedSources[n - 1] ? cachedSources[n - 1] : null;

      if (!source) {
        setLoading(true);
        // 캐시에 배열은 있는데 이 번호만 비었다면 낡은 캐시다 — 그냥 조회하면
        // 같은 배열을 돌려받으므로 강제로 다시 받아야 한다.
        const stale = Array.isArray(cachedSources) && cachedSources.length > 0;
        const sources = await fetchSourcesForMessage(messageId, { forceRefresh: stale });
        setLoading(false);
        source = sources?.[n - 1] ?? source ?? null;
        if (!label) {
          const l = getSourceLabel(messageId, n);
          if (l) setLabel(l);
        }
      }

      // Web-search style citations: source has a URL but no document body.
      // The user explicitly wanted these to open as plain links rather than
      // showing the drawer, since there is nothing substantive to preview.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const src = source as any;
      const url: string | undefined = src?.source?.url || src?.source?.embed_url;
      const hasBody =
        Array.isArray(src?.document) &&
        typeof src.document[0] === 'string' &&
        src.document[0].trim().length > 0;
      if (url && !hasBody) {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }

      openSource(messageId, n);
    },
    [messageId, n, label, openSource],
  );

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      /* Keep the chip on the text baseline, then lower the compact badge
         slightly so it sits inside Korean body text instead of floating above it. */
      style={{ verticalAlign: 'baseline', position: 'relative', top: '0.12em' }}
      className={
        label
          ? 'mx-0.5 inline-flex items-center gap-0.5 rounded bg-black/[0.04] px-1.5 py-px text-[11px] leading-none text-gray-900 transition-colors hover:bg-black/[0.08] disabled:opacity-50 dark:bg-white/[0.08] dark:text-gray-100 dark:hover:bg-white/[0.12]'
          : 'mx-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded bg-black/[0.04] px-1 text-[11px] leading-none text-gray-900 transition-colors hover:bg-black/[0.08] disabled:opacity-50 dark:bg-white/[0.08] dark:text-gray-100 dark:hover:bg-white/[0.12]'
      }
      title={label ? `${label} [${n}]` : `출처 [${n}] 보기`}
      aria-label={`출처 ${n} 보기`}
    >
      {loading ? (
        '…'
      ) : label ? (
        <>
          {fileType ? <FileTypeIcon ext={fileType} className="-ml-0.5 h-3 w-3 shrink-0" /> : null}
          <span>『{label}』</span>
          <span>- [{n}]</span>
        </>
      ) : (
        n
      )}
    </button>
  );
}
