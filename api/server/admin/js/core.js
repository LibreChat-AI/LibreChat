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
    for (const raw of lines) {
      const line = raw.trimEnd();
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
    closeList();
    return out.join('');
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
    createRangeFilter,
    makeChart,
    reloadAll,
    switchTab,
    registerTab: (name, mod) => { tabs[name] = mod; },
    boot,
  };
})();
