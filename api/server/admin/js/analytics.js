'use strict';

/**
 * 통계 탭 (항목 2·4·6·8):
 * - bkl_query_logs 기반 요약/일별/시간대/모델/그룹 + compare=prev 증감률
 * - 질문 유형 도넛, Top 문서/케이스 (FastAPI analytics 프록시)
 * - 상위 사용자 모델별 드릴다운, 강화 턴 별도 표기
 * - AI 통계 요약 카드, 엑셀 내보내기 (시트: 요약/일별/모델별/그룹별/유형별/Top문서/기간비교)
 */
(function () {
  const A = window.BklAdmin;
  const data = {}; // 최근 로드 데이터 (엑셀용)
  const range = A.createRangeFilter('range-analytics', () => A.reloadAll());

  async function loadSummary() {
    const s = await A.getJSON('/summary' + range.params('compare=prev'));
    data.summary = s;
    const cards = document.querySelectorAll('#summary-cards .card-value');
    const cur = s.range || {};
    const prev = s.prev_range || null;
    const vals = [s.dau, s.wau, s.mau, cur.queries, cur.enhances, s.users_total];
    cards.forEach((el, i) => { el.textContent = A.fmtNum(vals[i]); });
    document.getElementById('range-q-sub').innerHTML =
      '전기간 ' + A.fmtNum(prev?.queries) + '건' + (prev ? A.fmtDelta(cur.queries, prev.queries) : '');
    document.getElementById('range-e-sub').innerHTML =
      '전기간 ' + A.fmtNum(prev?.enhances) + '건' + (prev ? A.fmtDelta(cur.enhances, prev.enhances) : '');
    document.getElementById('convo-sub').textContent = '대화 ' + A.fmtNum(s.conversations_total) + '건';
    // fmtKST 가 UTC ISO → KST 문자열 변환을 전담한다. (기존 +9h 후
    // toLocaleString 은 브라우저 로컬(KST)로 또 변환해 9시간이 중복됐다.)
    document.getElementById('analytics-sub').textContent =
      '마지막 업데이트: ' + A.fmtKST(s.now) + ' KST';
  }

  async function loadDaily() {
    const j = await A.getJSON('/usage/daily' + range.params('compare=prev'));
    data.daily = j.data;
    data.dailyPrev = j.prev;
    A.makeChart('daily-chart', 'bar', j.data.map((d) => d.date), [
      { label: '질의 수', data: j.data.map((d) => d.queries), backgroundColor: 'rgba(99,102,241,.7)', borderColor: '#6366f1', borderWidth: 1, yAxisID: 'y', order: 3 },
      { label: '강화', data: j.data.map((d) => d.enhances), backgroundColor: 'rgba(139,92,246,.5)', borderColor: '#8b5cf6', borderWidth: 1, yAxisID: 'y', order: 2 },
      { label: '활성 사용자', data: j.data.map((d) => d.active_users), type: 'line', borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.12)', fill: false, tension: 0.3, pointRadius: 2, yAxisID: 'y2', order: 1 },
    ], {
      scales: {
        x: { stacked: true, ticks: { color: '#9ca3af', maxRotation: 45, font: { size: 11 } }, grid: { color: '#f3f4f6' } },
        y: { stacked: true, position: 'left', ticks: { color: '#6366f1', font: { size: 11 } }, grid: { color: '#f3f4f6' }, beginAtZero: true },
        y2: { position: 'right', ticks: { color: '#10b981', font: { size: 11 } }, grid: { display: false }, beginAtZero: true },
      },
    });
  }

  async function loadHourly() {
    const j = await A.getJSON('/usage/hourly' + range.params());
    const map = new Map(j.data.map((d) => [d.hour, d.queries]));
    const labels = Array.from({ length: 24 }, (_, i) => i + '시');
    A.makeChart('hourly-chart', 'bar', labels, [{
      label: '질의 수', data: labels.map((_, i) => map.get(i) || 0),
      backgroundColor: 'rgba(99,102,241,.6)', borderColor: '#6366f1', borderWidth: 1,
    }]);
  }

  async function loadModel() {
    const j = await A.getJSON('/usage/by-model' + range.params('compare=prev'));
    data.byModel = j.data;
    data.byModelPrev = j.prev;
    A.makeChart('model-chart', 'doughnut', j.data.map((d) => d.model || '(미분류)'),
      [{ data: j.data.map((d) => d.queries), backgroundColor: A.COLORS, borderWidth: 2, borderColor: '#fff' }],
      { plugins: { legend: { position: 'bottom', labels: { color: '#374151', boxWidth: 10, font: { size: 11 } } } } });
  }

  async function loadCategories() {
    try {
      const j = await A.getJSON('/analytics/query-categories' + range.params('compare=prev'));
      data.categories = j.data;
      data.categoriesPrev = j.prev;
      A.makeChart('category-chart', 'doughnut', j.data.map((d) => d.category),
        [{ data: j.data.map((d) => d.queries), backgroundColor: A.COLORS, borderWidth: 2, borderColor: '#fff' }],
        { plugins: { legend: { position: 'bottom', labels: { color: '#374151', boxWidth: 10, font: { size: 11 } } } } });
    } catch (e) {
      console.warn('query-categories unavailable:', e.message);
    }
  }

  async function loadGroup() {
    const j = await A.getJSON('/usage/by-group' + range.params());
    data.byGroup = j.data;
    A.makeChart('group-chart', 'bar', j.data.map((d) => d.group_name || '(미확인)'), [
      { label: '질의 수', data: j.data.map((d) => d.queries), backgroundColor: 'rgba(99,102,241,.7)', borderColor: '#6366f1', borderWidth: 1 },
      { label: '활성 사용자', data: j.data.map((d) => d.active_users), backgroundColor: 'rgba(16,185,129,.7)', borderColor: '#10b981', borderWidth: 1 },
    ]);
  }

  async function loadTopDocs() {
    try {
      const j = await A.getJSON('/analytics/top-documents' + range.params('limit=20'));
      data.topDocs = j.data;
      const tbody = document.getElementById('topdocs-tbody');
      if (!j.data?.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="4">데이터 없음</td></tr>'; return; }
      tbody.innerHTML = j.data.map((d, i) => `<tr>
        <td>${i + 1}</td>
        <td class="text-clip" title="${A.escHtml(d.file_name || d.name || d.doc_id)}">${A.escHtml((A.displayFileName(d) || d.name || d.doc_id || '').slice(0, 80))}</td>
        <td>${A.fmtNum(d.queries)}</td>
        <td>${A.fmtNum(d.citations)}</td>
      </tr>`).join('');
    } catch (e) {
      document.getElementById('topdocs-tbody').innerHTML =
        '<tr class="empty-row"><td colspan="4">분석 API 연결 불가 (' + A.escHtml(e.message) + ')</td></tr>';
    }
  }

  async function loadTopCases() {
    try {
      const j = await A.getJSON('/analytics/top-cases' + range.params('limit=20'));
      data.topCases = j.data;
      const tbody = document.getElementById('topcases-tbody');
      if (!j.data?.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="4">데이터 없음</td></tr>'; return; }
      tbody.innerHTML = j.data.map((c, i) => `<tr>
        <td>${i + 1}</td>
        <td class="text-clip" title="${A.escHtml(c.case_name || c.matter_uid)}">${A.escHtml(c.case_name || c.matter_uid || '')}</td>
        <td>${A.fmtNum(c.queries)}</td>
        <td>${A.fmtNum(c.documents)}</td>
      </tr>`).join('');
    } catch (e) {
      document.getElementById('topcases-tbody').innerHTML =
        '<tr class="empty-row"><td colspan="4">분석 API 연결 불가</td></tr>';
    }
  }

  async function loadTopUsers() {
    const j = await A.getJSON('/usage/by-user' + range.params('limit=50'));
    data.byUser = j.data;
    const tbody = document.getElementById('topusers-tbody');
    if (!j.data?.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">데이터 없음</td></tr>'; return; }
    tbody.innerHTML = j.data.slice(0, 30).map((u) => {
      const name = u.name || u.username || (u.email ? u.email.split('@')[0] : 'ID:' + u.user_id.slice(-6));
      const breakdown = (u.by_model || []).map((m) => `${A.escHtml(m.model)} ${A.fmtNum(m.queries)}건`).join(' · ');
      return `<tr>
        <td><div class="user-cell"><span class="user-name">${A.escHtml(name)}</span><span class="user-email">${A.escHtml(u.email || '')}</span></div></td>
        <td>${A.groupLabel(u.group_name)}</td>
        <td>${A.escHtml(u.department || '—')}</td>
        <td>${A.fmtNum(u.queries)}</td>
        <td>${A.fmtNum(u.enhances)}</td>
        <td>${A.fmtNum(u.active_days)}</td>
        <td class="model-breakdown">${breakdown || '—'}</td>
      </tr>`;
    }).join('');
  }

  async function loadRecent() {
    const j = await A.getJSON('/messages/recent?limit=50');
    const tbody = document.getElementById('recent-tbody');
    if (!j.data?.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">데이터 없음</td></tr>'; return; }
    tbody.innerHTML = j.data.map((m) => `<tr>
      <td style="white-space:nowrap">${A.fmtKST(m.createdAt)}</td>
      <td>${A.escHtml(m.user_name ?? '—')}</td>
      <td>${A.groupLabel(m.group_name)}</td>
      <td>${m.kind === 'query_enhance' ? '<span class="badge badge-enhance">강화</span>' : '<span class="badge">질의</span>'}</td>
      <td class="text-clip" title="${A.escHtml(m.text || '')}">${A.escHtml((m.text || '').slice(0, 120))}</td>
    </tr>`).join('');
  }

  async function loadAiSummary(regenerate) {
    const body = document.getElementById('ai-summary-body');
    const btn = document.getElementById('btn-ai-summary');
    btn.disabled = true;
    body.textContent = 'AI 요약 생성 중... (수십 초 걸릴 수 있습니다)';
    try {
      const j = await A.getJSON('/analytics/ai-summary' + range.params(regenerate ? 'regenerate=true' : ''));
      // LLM 이 마크다운으로 요약을 생성 — 원문 노출 대신 렌더링 (escHtml 선행).
      body.innerHTML = A.renderMarkdown(j.summary);
      btn.textContent = '재생성';
    } catch (e) {
      body.innerHTML = '<span class="err-text">요약 생성 실패: ' + A.escHtml(e.message) + '</span>';
    } finally {
      btn.disabled = false;
    }
  }

  /* ── 엑셀 (항목 4): 화면과 동일한 시트 구성 + 기간 비교 ────── */
  function exportExcel() {
    if (!data.daily?.length && !data.summary) { alert('데이터를 먼저 로드해주세요.'); return; }
    // 주의: 지역 변수명이 모듈 스코프 `range`(기간 필터)를 가리면 TDZ
    // ReferenceError 로 내보내기가 통째로 죽는다 (2026-08-26 버그).
    const rangeLabel = range.label();
    const wb = XLSX.utils.book_new();
    const s = data.summary || {};
    const cur = s.range || {};
    const prev = s.prev_range || {};
    const pct = (c, p) => (p ? (((c - p) / p) * 100).toFixed(1) + '%' : '');

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['항목', '값'],
      ['DAU', s.dau ?? ''], ['WAU', s.wau ?? ''], ['MAU', s.mau ?? ''],
      ['기간 질의 수', cur.queries ?? ''], ['기간 강화 수', cur.enhances ?? ''],
      ['기간 활성 사용자', cur.active_users ?? ''],
      ['전체 사용자 수', s.users_total ?? ''], ['전체 대화 수', s.conversations_total ?? ''],
      ['누적 질의 수', s.queries_total ?? ''], ['누적 강화 수', s.enhances_total ?? ''],
    ]), '요약');

    if (data.daily?.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['날짜', '질의 수', '강화 수', '활성 사용자'],
        ...data.daily.map((d) => [d.date, d.queries, d.enhances, d.active_users]),
      ]), '일별');
    }
    if (data.byModel?.length) {
      const prevMap = new Map((data.byModelPrev || []).map((m) => [m.model, m.queries]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['모델', '질의 수', '전기간', '증감률'],
        ...data.byModel.map((m) => [m.model || '(미분류)', m.queries, prevMap.get(m.model) ?? '', pct(m.queries, prevMap.get(m.model))]),
      ]), '모델별');
    }
    if (data.byGroup?.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['그룹', '질의 수', '강화 수', '활성 사용자'],
        ...data.byGroup.map((g) => [g.group_name || '', g.queries, g.enhances, g.active_users]),
      ]), '그룹별');
    }
    if (data.categories?.length) {
      const prevMap = new Map((data.categoriesPrev || []).map((c) => [c.category, c.queries]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['질문 유형', '질의 수', '전기간', '증감률'],
        ...data.categories.map((c) => [c.category, c.queries, prevMap.get(c.category) ?? '', pct(c.queries, prevMap.get(c.category))]),
      ]), '유형별');
    }
    if (data.topDocs?.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['순위', '문서', '질의 수', '인용 수'],
        ...data.topDocs.map((d, i) => [i + 1, A.displayFileName(d) || d.name || d.doc_id, d.queries, d.citations]),
      ]), 'Top문서');
    }
    if (data.byUser?.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['사용자', '이메일', '그룹', '부서', '질의', '강화', '활동일', '모델별 분해'],
        ...data.byUser.map((u) => [
          u.name || u.username || '', u.email || '',
          u.group_name || '',
          u.department || '',
          u.queries, u.enhances, u.active_days,
          (u.by_model || []).map((m) => `${m.model}:${m.queries}`).join(', '),
        ]),
      ]), '사용자별');
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['항목', '현재 기간', '직전 동일 기간', '증감률'],
      ['질의 수', cur.queries ?? '', prev.queries ?? '', pct(cur.queries, prev.queries)],
      ['강화 수', cur.enhances ?? '', prev.enhances ?? '', pct(cur.enhances, prev.enhances)],
      ['활성 사용자', cur.active_users ?? '', prev.active_users ?? '', pct(cur.active_users, prev.active_users)],
    ]), '기간 비교');

    XLSX.writeFile(wb, 'bkl_통계_' + rangeLabel + '.xlsx');
  }

  async function load() {
    await Promise.all([
      loadSummary(), loadDaily(), loadHourly(), loadModel(), loadCategories(),
      loadGroup(), loadTopDocs(), loadTopCases(), loadTopUsers(), loadRecent(),
    ]);
  }

  document.getElementById('btn-export-analytics').addEventListener('click', () => {
    try {
      exportExcel();
    } catch (e) {
      console.error('excel export failed:', e);
      alert('엑셀 내보내기 실패: ' + e.message);
    }
  });
  document.getElementById('btn-ai-summary').addEventListener('click', () => loadAiSummary(true));

  A.registerTab('analytics', { load });
})();
