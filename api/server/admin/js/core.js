'use strict';

/**
 * BKL 어드민 공통 코어.
 * - BKL_ADMIN_TOKEN Bearer 인증 (localStorage, 401 시 재입력)
 * - 기간 필터 컴포넌트 (createRangeFilter — 탭마다 독립 인스턴스) / 탭 전환
 * - fetch / chart / 포맷 유틸
 * 각 탭 모듈은 window.BklAdmin.registerTab(name, { load }) 으로 등록한다.
 */
(function () {
  const TOKEN_KEY = 'bkl_admin_token';
  const API = '/admin-api';
  const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899'];

  const state = {
    currentTab: 'analytics',
    charts: {},
  };

  const tabs = {}; // name -> { load }

  /* ── 인증 ─────────────────────────────────────────────────── */
  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }
  function authHeaders() {
    return { Authorization: 'Bearer ' + getToken() };
  }
  function showAuthGate(message) {
    document.getElementById('app').style.display = 'none';
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('auth-error').textContent = message || '';
    setTimeout(() => document.getElementById('auth-token-input').focus(), 50);
  }
  async function verifyToken(token) {
    const r = await fetch(API + '/auth/check', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (r.status === 503) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || '서버에 BKL_ADMIN_TOKEN 이 설정되지 않았습니다');
    }
    return r.ok;
  }
  async function submitToken() {
    const input = document.getElementById('auth-token-input');
    const token = input.value.trim();
    if (!token) return;
    try {
      if (await verifyToken(token)) {
        localStorage.setItem(TOKEN_KEY, token);
        document.getElementById('auth-overlay').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        reloadAll();
      } else {
        document.getElementById('auth-error').textContent = '토큰이 올바르지 않습니다';
      }
    } catch (e) {
      document.getElementById('auth-error').textContent = e.message;
    }
  }

  /* ── fetch ────────────────────────────────────────────────── */
  async function getJSON(path) {
    const r = await fetch(API + path, { headers: authHeaders() });
    if (r.status === 401) {
      showAuthGate('세션이 만료되었습니다. 토큰을 다시 입력하세요.');
      throw new Error('unauthorized');
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || body.detail || path + ' → HTTP ' + r.status);
    }
    return r.json();
  }
  async function sendJSON(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      showAuthGate('세션이 만료되었습니다. 토큰을 다시 입력하세요.');
      throw new Error('unauthorized');
    }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || b.detail || path + ' → HTTP ' + r.status);
    }
    return r.json();
  }

  /* ── 날짜/포맷 유틸 ───────────────────────────────────────── */
  function toYMD(d) { return d.toISOString().slice(0, 10); }
  function fmtKST(iso) {
    if (!iso) return '—';
    const k = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
    return k.toISOString().replace('T', ' ').slice(0, 16);
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function fmtNum(n) { return (n ?? 0).toLocaleString(); }
  /**
   * 그룹 표시명 — BIMS 조직 API 의 groupName 이 원본이다.
   *
   * 예전에는 bkl_user_class 를 `class 62` 로 찍었는데, userClass("사용자 구분")는
   * 조직 체계가 아니라 groupSid(133~405)와 아예 다른 값이었다. 그래서 조직
   * 정보가 없으면 class 로 대체하지 않고 미표시로 둔다.
   */
  function groupLabel(name) {
    const text = typeof name === 'string' ? name.trim() : '';
    return text.length ? escHtml(text) : '—';
  }
  function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDelta(cur, prev) {
    if (prev == null || prev === 0) return '';
    const pct = ((cur - prev) / prev) * 100;
    const cls = pct >= 0 ? 'delta-up' : 'delta-down';
    const sign = pct >= 0 ? '▲' : '▼';
    return ` <span class="${cls}">${sign}${Math.abs(pct).toFixed(0)}%</span>`;
  }

  /**
   * 소형 마크다운 렌더러 — AI 통계 요약처럼 자체 LLM 산출물 표시용.
   * escHtml 을 먼저 통과시킨 뒤 헤딩/굵게/기울임/리스트/구분선/줄바꿈만
   * 변환한다 (외부 라이브러리·raw HTML 불허 → XSS 없음).
   */
  function renderMarkdown(md) {
    const lines = String(md ?? '').split(/\r?\n/);
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    const inline = (s) =>
      escHtml(s)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    // 표: `|`로 시작하는 연속 줄. 두 번째 줄이 `|---|` 구분선이면 첫 줄을 헤더로.
    const flushTable = (rows) => {
      if (!rows.length) return;
      const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim()));
      const isSep = (r) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(r);
      let head = null;
      let body = rows;
      if (rows.length >= 2 && isSep(rows[1])) {
        head = cells(rows[0]);
        body = rows.slice(2);
      }
      const html = ['<table class="md-table">'];
      if (head) html.push('<thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead>');
      html.push('<tbody>' + body.filter((r) => !isSep(r)).map((r) => '<tr>' + cells(r).map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>');
      html.push('</table>');
      out.push(html.join(''));
    };
    let tableRows = [];
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*\|.*\|\s*$/.test(line)) {
        closeList();
        tableRows.push(line);
        continue;
      }
      if (tableRows.length) { flushTable(tableRows); tableRows = []; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const li = line.match(/^\s*[-*•]\s+(.*)$/);
      if (h) {
        closeList();
        const lvl = Math.min(h[1].length + 2, 5); // #→h3 …
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      } else if (li) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${inline(li[1])}</li>`);
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        closeList();
        out.push('<hr/>');
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    if (tableRows.length) flushTable(tableRows);
    closeList();
    return out.join('');
  }

  /* ── 답변 렌더링: 인용 칩 + 『파일명』 링크 + 출처 모달 ───────── */
  /**
   * 채팅 우측 패널과 같은 출처 데이터(bkl_chat_sources.sources, 인용번호 순)를
   * 받아 답변 본문을 그린다.
   *  - `[N]` / `[[N]](url)` / `[1, 2]` → 번호 칩. 클릭하면 청크 모달.
   *  - 『파일명』 → 표시명(`_숫자`·`.md` 제거) + 출처에 iManage URL 이 있으면 링크.
   * 출처가 없는 답변(옛 로그·삭제된 대화)은 칩을 비활성으로 그린다.
   * 출처 배열은 answerSources 레지스트리에 키로 보관하고 칩은 data-key 로 가리킨다.
   */
  const answerSources = new Map(); // key -> sources[]
  let answerSeq = 0;

  function sourceMeta(src) {
    const m = src && Array.isArray(src.metadata) ? src.metadata[0] : null;
    return m && typeof m === 'object' ? m : {};
  }
  function sourceDisplayName(src) {
    const meta = sourceMeta(src);
    if (meta.display_name) return String(meta.display_name);
    const raw = String(meta.name ?? meta.file_name ?? src?.source?.name ?? '').normalize('NFC');
    const m = raw.match(/^『(.+?)』/);
    return displayFileName(m ? m[1] : raw, meta.imanage_document_number);
  }
  function sourceRawName(src) {
    const meta = sourceMeta(src);
    const raw = String(meta.name ?? meta.file_name ?? src?.source?.name ?? '').normalize('NFC');
    const m = raw.match(/^『(.+?)』/);
    return (m ? m[1] : raw).trim();
  }
  function sourceImanageUrl(src) {
    const meta = sourceMeta(src);
    const c = [src?.source?.imanage_url, src?.source?.imanage_preview_url, meta.imanage_url, meta.imanage_preview_url];
    return c.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
  }
  const nameKey = (s) => String(s || '').normalize('NFC').trim().replace(/\.(?:md|markdown)$/i, '').toLowerCase();

  function renderAnswer(text, sources) {
    const list = Array.isArray(sources) ? sources : [];
    const key = 'a' + (++answerSeq);
    if (list.length) answerSources.set(key, list);

    // 파일명 → (표시명, URL) 색인 — 같은 이름이면 상위 랭크(먼저 나온) 출처
    const byName = new Map();
    for (const src of list) {
      const raw = sourceRawName(src);
      if (!raw) continue;
      const k = nameKey(raw);
      const cur = byName.get(k);
      if (!cur) byName.set(k, { display: sourceDisplayName(src), url: sourceImanageUrl(src) });
      else if (!cur.url) cur.url = sourceImanageUrl(src); // 같은 파일의 다른 청크에만 링크가 있을 때
    }

    const chip = (n) => {
      const src = list[n - 1];
      if (!src) return `<span class="cite-chip disabled" title="출처 없음">${n}</span>`;
      const title = escHtml(sourceDisplayName(src));
      return `<button type="button" class="cite-chip" data-key="${key}" data-n="${n}" title="${title}">${n}</button>`;
    };

    let html = renderMarkdown(text);
    // [[N]](url) — 저장된 스트리밍 변환 포맷 (escHtml 은 괄호·대괄호를 건드리지 않는다)
    html = html.replace(/\[\[(\d+)\]\]\([^)]*\)/g, (_, n) => chip(Number(n)));
    // [1, 2, 3] 묶음 → 칩 나열
    html = html.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, g) => g.split(',').map((s) => chip(Number(s.trim()))).join(''));
    // 낱개 [N] (뒤에 '(' 가 오는 일반 링크는 제외)
    html = html.replace(/\[(\d{1,3})\](?!\()/g, (_, n) => chip(Number(n)));
    // 『파일명』 → 표시명 (+iManage 링크). 이미 escHtml 된 문자열이므로 내용은 그대로 다시 넣는다.
    const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    html = html.replace(/『([^『』\n<]+)』/g, (full, name) => {
      const plain = unesc(name);
      const hit = byName.get(nameKey(plain));
      const shown = hit ? escHtml(hit.display) : escHtml(displayFileName(plain));
      if (hit && hit.url) {
        return `<a class="file-link" href="${escHtml(hit.url)}" target="_blank" rel="noopener" title="iManage 원문 열기">『${shown}』</a>`;
      }
      return `『${shown}』`;
    });
    return `<div class="answer-body">${html}</div>`;
  }

  /** 청크 모달 — 채팅 우측 패널의 청크 뷰를 어드민용 모달로 옮긴 것. */
  function openSourceModal(src, n) {
    closeSourceModal();
    const meta = sourceMeta(src);
    const display = sourceDisplayName(src);
    const url = sourceImanageUrl(src);
    const text = Array.isArray(src.document) ? String(src.document[0] ?? '') : '';
    const metaLine = [
      meta.page_info ? String(meta.page_info) : null,
      meta.section ? String(meta.section) : null,
      typeof meta.relevance === 'number' ? '관련도 ' + Math.round(meta.relevance) : null,
      meta.matter_uid ? '사건 ' + String(meta.matter_uid) : null,
    ].filter(Boolean).join(' · ');
    const overlay = document.createElement('div');
    overlay.className = 'src-modal-overlay';
    overlay.innerHTML = `
      <div class="src-modal" role="dialog" aria-modal="true" aria-label="출처 ${n}">
        <div class="src-modal-head">
          <span class="cite-chip static">${n}</span>
          <div class="src-modal-title-wrap">
            <div class="src-modal-title" title="${escHtml(display)}">${escHtml(display)}</div>
            ${metaLine ? `<div class="src-modal-meta">${escHtml(metaLine)}</div>` : ''}
          </div>
          <button type="button" class="src-modal-close" aria-label="닫기">×</button>
        </div>
        <pre class="src-modal-text">${escHtml(text || '(본문 없음)')}</pre>
        <div class="src-modal-foot">
          ${url ? `<a class="btn-refresh" href="${escHtml(url)}" target="_blank" rel="noopener">iManage 원문 열기</a>` : '<span class="msg-loading">iManage 링크 없음</span>'}
          <button type="button" class="btn-refresh src-modal-close">닫기</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.src-modal-close')) closeSourceModal();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onModalKey);
  }
  function onModalKey(e) { if (e.key === 'Escape') closeSourceModal(); }
  function closeSourceModal() {
    document.querySelectorAll('.src-modal-overlay').forEach((el) => el.remove());
    document.removeEventListener('keydown', onModalKey);
  }
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.cite-chip[data-key]');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    const list = answerSources.get(chip.dataset.key);
    const n = Number(chip.dataset.n);
    if (list && list[n - 1]) openSourceModal(list[n - 1], n);
  });

  /**
   * 대화 출처 조회 → `lookup(message)` 를 가진 객체. assistant 메시지의 messageId 로
   * 찾고(bkl_chat_sources.message_id), 없으면 생성 시각이 5분 이내로 가장 가까운
   * 미사용 행으로 폴백한다. 출처가 없거나 실패하면 항상 [] (칩 비활성).
   * 대화 단위로 짧게 캐시한다.
   */
  const sourcesCache = new Map();
  const EMPTY_SOURCES = { lookup: () => [] };
  async function fetchConversationSources(conversationId) {
    if (!conversationId) return EMPTY_SOURCES;
    if (sourcesCache.has(conversationId)) return sourcesCache.get(conversationId);
    const p = getJSON('/sources/' + encodeURIComponent(conversationId))
      .then((j) => {
        const rows = (j?.messages || []).filter((m) => Array.isArray(m.sources) && m.sources.length);
        if (!rows.length) return EMPTY_SOURCES;
        const byId = new Map(rows.filter((m) => m.message_id).map((m) => [m.message_id, m.sources]));
        return {
          lookup(msg) {
            if (!msg || msg.role === 'user') return [];
            const id = msg.messageId || msg.message_id;
            if (id && byId.has(id)) return byId.get(id);
            const t = new Date(msg.createdAt || msg.created_at || 0).getTime();
            if (!t) return [];
            let best = null;
            for (const r of rows) {
              if (!r.created_at) continue;
              const d = Math.abs(new Date(r.created_at).getTime() - t);
              if (d < 300_000 && (!best || d < best.d)) best = { d, r };
            }
            return best ? best.r.sources : [];
          },
        };
      })
      .catch(() => EMPTY_SOURCES);
    sourcesCache.set(conversationId, p);
    setTimeout(() => sourcesCache.delete(conversationId), 60_000);
    return p;
  }
  /* ── 표시용 파일명 (FILENAME_DISPLAY_FIX_SPEC) ─────────────── */
  /**
   * `_{document_number}` 서픽스(수집기가 동명 충돌 시 붙임)와 OCR `.md` 를 표시에서만
   * 걷어낸다. document_number 와 정확히 일치하는 끝 숫자만 지운다.
   * 객체를 넘기면 `display_name` → `file_name`+`imanage_document_number` 순으로 본다.
   */
  function displayFileName(fileNameOrDoc, documentNumber) {
    let name = fileNameOrDoc;
    if (fileNameOrDoc && typeof fileNameOrDoc === 'object') {
      if (fileNameOrDoc.display_name) return String(fileNameOrDoc.display_name);
      name = fileNameOrDoc.file_name;
      documentNumber = fileNameOrDoc.imanage_document_number;
    }
    if (!name) return '';
    name = String(name);
    if (documentNumber != null && String(documentNumber).trim() !== '') {
      const num = String(documentNumber).trim();
      if (/^\d+$/.test(num)) {
        name = name.replace(new RegExp('_' + num + '(?=(?:\\.[^.\\s]+)*$)'), '');
      }
    }
    return name.replace(/\.(?:md|markdown)$/i, '');
  }

  /* ── 기간 필터 컴포넌트 ───────────────────────────────────── */
  const PRESET_DAYS = { today: 1, '7d': 7, '30d': 30, '365d': 365 };
  const PRESET_LABELS = { today: '오늘', '7d': '최근 7일', '30d': '최근 30일', '365d': '최근 1년' };

  /**
   * 탭마다 독립적인 기간 필터 드롭다운을 mount 요소에 렌더링한다.
   * 기간 상태는 인스턴스 안에만 있으므로 탭 간에 공유되지 않는다.
   * @param {string} mountId  드롭다운을 그릴 요소 id
   * @param {() => void} onChange  기간 변경 시 호출 (보통 A.reloadAll)
   * @returns {{ params: (extra?: string) => string, label: () => string, preset: () => string|null, setPreset: (preset: string) => void }}
   */
  function createRangeFilter(mountId, onChange) {
    const rf = { preset: '30d', from: null, to: null };
    const mount = document.getElementById(mountId);
    mount.classList.add('range-wrap');
    mount.innerHTML =
      '<button class="btn-range" type="button">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">' +
      '<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M5 1v3M11 1v3M2 7h12"/></svg>' +
      '<span class="range-label">최근 30일</span>' +
      '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6l4 4 4-4"/></svg>' +
      '</button>' +
      '<div class="range-dropdown">' +
      Object.keys(PRESET_DAYS)
        .map((k) => `<button class="range-option${k === '30d' ? ' active' : ''}" type="button" data-preset="${k}">${PRESET_LABELS[k]}</button>`)
        .join('') +
      '<div class="range-divider"></div>' +
      '<div class="custom-dropdown-title">기간 직접 지정</div>' +
      '<div class="date-row"><label>시작</label><input type="date" class="rf-from" /></div>' +
      '<div class="date-row"><label>종료</label><input type="date" class="rf-to" /></div>' +
      '<div class="dropdown-actions"><button class="btn-dd-apply" type="button">적용</button></div>' +
      '</div>';

    const toggle = mount.querySelector('.btn-range');
    const panel = mount.querySelector('.range-dropdown');
    const label = mount.querySelector('.range-label');
    const fromInput = mount.querySelector('.rf-from');
    const toInput = mount.querySelector('.rf-to');

    const closeDD = () => { panel.classList.remove('open'); toggle.classList.remove('active'); };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      toggle.classList.toggle('active', open);
    });
    document.addEventListener('click', (e) => { if (!mount.contains(e.target)) closeDD(); });

    /** 프리셋 적용 (UI 동기화 포함). onChange 는 호출자가 결정한다. */
    function applyPreset(preset) {
      if (!PRESET_DAYS[preset]) return;
      panel.querySelectorAll('.range-option').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
      rf.preset = preset;
      rf.from = null;
      rf.to = null;
      fromInput.value = '';
      toInput.value = '';
      label.textContent = PRESET_LABELS[preset];
    }

    panel.querySelectorAll('.range-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyPreset(btn.dataset.preset);
        closeDD();
        if (onChange) onChange();
      });
    });

    panel.querySelector('.btn-dd-apply').addEventListener('click', () => {
      const from = fromInput.value;
      if (!from) return;
      rf.from = from;
      rf.to = toInput.value || null;
      rf.preset = null;
      panel.querySelectorAll('.range-option').forEach((b) => b.classList.remove('active'));
      label.textContent = from + ' ~ ' + (rf.to || toYMD(new Date()));
      closeDD();
      if (onChange) onChange();
    });

    return {
      /** 현재 프리셋 키 (직접 지정 기간이면 null). */
      preset() { return rf.from ? null : rf.preset; },
      /**
       * 프리셋을 코드에서 바꾼다 — onChange 를 부르지 않으므로 호출자가 직접
       * 다시 로드해야 한다 (탭 진입 시 기간을 넓히고 한 번만 로드하기 위함).
       */
      setPreset(preset) { applyPreset(preset); },
      params(extra) {
        let q;
        if (rf.from) {
          q = '?from=' + rf.from + (rf.to ? '&to=' + rf.to : '');
        } else {
          q = '?days=' + (PRESET_DAYS[rf.preset] || 30);
        }
        return extra ? q + '&' + extra : q;
      },
      label() {
        const todayStr = toYMD(new Date());
        if (rf.from) return rf.from + '_' + (rf.to || todayStr);
        const days = PRESET_DAYS[rf.preset] || 30;
        return toYMD(new Date(Date.now() - days * 24 * 3600 * 1000)) + '_' + todayStr;
      },
    };
  }

  /* ── 차트 ─────────────────────────────────────────────────── */
  function makeChart(id, type, labels, datasets, extra = {}) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    const ctx = document.getElementById(id);
    if (!ctx) return;
    state.charts[id] = new Chart(ctx, {
      type,
      data: { labels, datasets },
      options: Object.assign({
        maintainAspectRatio: false, animation: { duration: 250 },
        plugins: { legend: { labels: { color: '#374151', boxWidth: 12, font: { size: 12 } } } },
        scales: type === 'doughnut' ? {} : {
          x: { ticks: { color: '#9ca3af', maxRotation: 45, font: { size: 11 } }, grid: { color: '#f3f4f6' } },
          y: { ticks: { color: '#9ca3af', font: { size: 11 } }, grid: { color: '#f3f4f6' }, beginAtZero: true },
        },
      }, extra),
    });
  }

  /* ── 탭 전환 ──────────────────────────────────────────────── */
  /**
   * 탭 전환. `opts` 는 대상 탭의 load(opts) 로 그대로 넘어간다 — 다른 탭에서
   * 특정 항목을 가리키며 넘어올 때(질의 이력 → 사용자 탭 자동 선택) 쓴다.
   * 이미 그 탭이면 기본적으로 아무것도 안 하지만 `opts.force` 로 다시 load 한다.
   */
  function switchTab(tab, opts = {}) {
    if (tab === state.currentTab && !opts.force) return;
    state.currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('panel-' + tab).classList.add('active');
    const mod = tabs[tab];
    if (mod && mod.load) mod.load(opts).catch(console.error);
  }

  /* ── 리로드 ───────────────────────────────────────────────── */
  async function reloadAll() {
    const t0 = Date.now();
    const el = document.getElementById('updated-text');
    el.textContent = '로딩 중...';
    try {
      const mod = tabs[state.currentTab];
      if (mod && mod.load) await mod.load();
      el.textContent = '업데이트 ' + new Date().toLocaleTimeString('ko-KR') + ' (' + (Date.now() - t0) + 'ms)';
    } catch (e) {
      if (e.message !== 'unauthorized') {
        el.innerHTML = '<span class="err-text">오류: ' + escHtml(e.message) + '</span>';
        console.error(e);
      }
    }
  }

  /* ── 부트 ─────────────────────────────────────────────────── */
  async function boot() {
    Chart.defaults.color = '#6b7280';
    Chart.defaults.borderColor = '#f3f4f6';
    Chart.defaults.font.family =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Apple SD Gothic Neo", sans-serif';

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.getElementById('btn-refresh').addEventListener('click', reloadAll);
    document.getElementById('btn-logout').addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      showAuthGate('');
    });
    document.getElementById('auth-submit').addEventListener('click', submitToken);
    document.getElementById('auth-token-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitToken();
    });
    const token = getToken();
    if (!token) {
      showAuthGate('');
      return;
    }
    try {
      if (await verifyToken(token)) {
        document.getElementById('auth-overlay').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        reloadAll();
      } else {
        showAuthGate('저장된 토큰이 유효하지 않습니다. 다시 입력하세요.');
      }
    } catch (e) {
      showAuthGate(e.message);
    }
  }

  window.BklAdmin = {
    state,
    COLORS,
    getJSON,
    sendJSON,
    toYMD,
    fmtKST,
    fmtDate,
    fmtNum,
    fmtDelta,
    escHtml,
    groupLabel,
    renderMarkdown,
    displayFileName,
    renderAnswer,
    fetchConversationSources,
    openSourceModal,
    createRangeFilter,
    makeChart,
    reloadAll,
    switchTab,
    registerTab: (name, mod) => { tabs[name] = mod; },
    boot,
  };
})();
