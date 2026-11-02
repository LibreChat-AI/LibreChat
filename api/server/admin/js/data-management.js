'use strict';

/**
 * 데이터 관리 탭 (ADMIN_DATA_DELETE_SPEC §5):
 * 매터/문서 검색 → preview → 확인 다이얼로그(ID 재입력) → 삭제 → 감사 로그.
 * 백엔드: /admin-api/data/* → FastAPI /admin/data/* 프록시.
 */
(function () {
  const A = window.BklAdmin;

  const STORE_LABELS = {
    qdrant_chunks: 'Qdrant chunks',
    qdrant_summaries: 'Qdrant summaries',
    qdrant_wiki_points: 'Qdrant wiki',
    opensearch_docs: 'OpenSearch',
    pg_document_tags: 'PG document_tags',
    pg_case_summaries: 'PG case_summaries',
    pg_wiki_pages: 'PG wiki_pages',
    pg_wiki_builds: 'PG wiki_builds',
  };

  /* ── 검색 ─────────────────────────────────────────────────── */
  async function runSearch() {
    const q = document.getElementById('dd-search-input').value.trim();
    const type = document.getElementById('dd-search-type').value;
    const tbody = document.getElementById('dd-results-tbody');
    const thead = document.getElementById('dd-results-thead');
    const sub = document.getElementById('dd-results-sub');
    if (!q) return;
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">검색 중...</td></tr>';
    try {
      const j = await A.getJSON('/data/search?q=' + encodeURIComponent(q) + '&type=' + type);
      sub.textContent = j.total + '건';
      if (!j.results.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="6">결과가 없습니다</td></tr>';
        return;
      }
      if (type === 'matter') {
        thead.innerHTML = '<tr><th>matter_uid</th><th>사건명</th><th>의뢰인</th><th>문서 수</th><th>기간 (BIMS)</th><th>작업</th></tr>';
        tbody.innerHTML = j.results.map((r) => `<tr>
          <td style="white-space:nowrap">${A.escHtml(r.matter_uid)}</td>
          <td class="text-clip" title="${A.escHtml(r.bims_case_name || '')}">${A.escHtml(r.bims_case_name || '—')}</td>
          <td class="text-clip">${A.escHtml(r.client || '—')}</td>
          <td>${A.fmtNum(r.doc_count)}</td>
          <td style="white-space:nowrap">${A.escHtml(r.date_range || '—')}</td>
          <td style="white-space:nowrap">
            <button class="btn-refresh" data-files="${A.escHtml(r.matter_uid)}" data-name="${A.escHtml(r.bims_case_name || '')}">파일 보기</button>
            <button class="btn-refresh btn-danger" data-kind="matter" data-id="${A.escHtml(r.matter_uid)}">삭제</button>
          </td>
        </tr>`).join('');
      } else {
        thead.innerHTML = '<tr><th>doc_id</th><th>파일명</th><th>매터</th><th>유형</th><th>날짜</th><th>작업</th></tr>';
        tbody.innerHTML = j.results.map((r) => `<tr>
          <td style="white-space:nowrap">${A.escHtml(r.doc_id)}</td>
          <td class="text-clip" title="${A.escHtml(r.file_name || '')}">${A.escHtml(A.displayFileName(r) || '—')}</td>
          <td class="text-clip" title="${A.escHtml(r.bims_case_name || '')}">${A.escHtml(r.matter_uid || '—')}</td>
          <td>${A.escHtml(r.doc_type || '—')}</td>
          <td style="white-space:nowrap">${A.escHtml(r.document_date || '—')}</td>
          <td><button class="btn-refresh btn-danger" data-kind="doc" data-id="${A.escHtml(r.doc_id)}">삭제</button></td>
        </tr>`).join('');
      }
      tbody.querySelectorAll('button[data-kind]').forEach((btn) => {
        btn.addEventListener('click', () => openConfirm(btn.dataset.kind, btn.dataset.id));
      });
      tbody.querySelectorAll('button[data-files]').forEach((btn) => {
        btn.addEventListener('click', () => loadFiles(btn.dataset.files, btn.dataset.name));
      });
    } catch (e) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6"><span class="err-text">' + A.escHtml(e.message) + '</span></td></tr>';
    }
  }

  /* ── 매터 파일 목록 (파일 단위 삭제) ─────────────────────────── */
  let filesMatter = null; // 현재 열려 있는 매터 uid

  async function loadFiles(matterUid, caseName) {
    const panel = document.getElementById('dd-files-panel');
    const tbody = document.getElementById('dd-files-tbody');
    const sub = document.getElementById('dd-files-sub');
    filesMatter = matterUid;
    panel.style.display = '';
    sub.textContent = matterUid + (caseName ? ' — ' + caseName : '');
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">로딩 중...</td></tr>';
    try {
      const j = await A.getJSON('/data/matters/' + encodeURIComponent(matterUid) + '/files');
      sub.textContent =
        matterUid + (j.bims_case_name ? ' — ' + j.bims_case_name : '') + ' · ' + A.fmtNum(j.total) + '개 파일';
      if (!j.files.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">인덱싱된 파일이 없습니다</td></tr>';
        return;
      }
      tbody.innerHTML = j.files.map((f) => `<tr>
        <td style="white-space:nowrap">${A.escHtml(f.doc_id)}</td>
        <td class="text-clip" title="${A.escHtml(f.file_name || '')}">${A.escHtml(A.displayFileName(f) || '—')}</td>
        <td style="white-space:nowrap">${A.escHtml(f.doc_type || '—')}</td>
        <td>${A.fmtNum(f.chunk_count)}</td>
        <td><button class="btn-refresh btn-danger" data-kind="doc" data-id="${A.escHtml(f.doc_id)}">삭제</button></td>
      </tr>`).join('');
      tbody.querySelectorAll('button[data-kind]').forEach((btn) => {
        btn.addEventListener('click', () => openConfirm(btn.dataset.kind, btn.dataset.id));
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5"><span class="err-text">' + A.escHtml(e.message) + '</span></td></tr>';
    }
  }

  function closeFiles() {
    filesMatter = null;
    document.getElementById('dd-files-panel').style.display = 'none';
  }

  /* ── 확인 다이얼로그 ──────────────────────────────────────── */
  let pending = null; // { kind, id }

  async function openConfirm(kind, id) {
    const overlay = document.getElementById('dd-overlay');
    const errEl = document.getElementById('dd-dialog-error');
    errEl.textContent = '';
    document.getElementById('dd-reason').value = '';
    document.getElementById('dd-requested-by').value = '';
    document.getElementById('dd-confirm-id').value = '';
    document.getElementById('dd-execute-btn').disabled = true;

    let preview;
    try {
      preview = await A.getJSON(
        kind === 'matter'
          ? '/data/matters/' + encodeURIComponent(id) + '/preview'
          : '/data/documents/' + encodeURIComponent(id) + '/preview'
      );
    } catch (e) {
      alert('preview 실패: ' + e.message);
      return;
    }
    pending = { kind, id };

    document.getElementById('dd-dialog-title').textContent =
      kind === 'matter' ? '매터 삭제 확인' : '문서 삭제 확인';
    const meta = kind === 'matter'
      ? [
          ['matter_uid', preview.matter_uid],
          ['사건명', preview.bims_case_name],
          ['의뢰인', preview.client],
        ]
      : [
          ['doc_id', preview.doc_id],
          ['파일명', preview.file_name],
          ['matter_uid', preview.matter_uid],
        ];
    document.getElementById('dd-dialog-meta').innerHTML = meta
      .map(([k, v]) => `<div><b>${A.escHtml(k)}</b>: ${A.escHtml(v || '—')}</div>`)
      .join('');

    const affected = preview.affected || {};
    let rows = Object.keys(affected)
      .map((k) => `<tr><td style="padding:4px 10px;">${A.escHtml(STORE_LABELS[k] || k)}</td><td style="padding:4px 10px; text-align:right;">${A.fmtNum(affected[k])}건</td></tr>`)
      .join('');
    if (preview.errors) {
      rows += Object.keys(preview.errors)
        .map((k) => `<tr><td style="padding:4px 10px;">${A.escHtml(STORE_LABELS[k] || k)}</td><td style="padding:4px 10px; text-align:right;"><span class="err-text">조회 실패</span></td></tr>`)
        .join('');
    }
    if (kind === 'matter' && (preview.sample_files || []).length) {
      const files = preview.sample_files
        .map((f) => A.escHtml(f.file_name || f.doc_id))
        .join('<br/>');
      rows += `<tr><td style="padding:4px 10px; vertical-align:top;">샘플 파일</td><td style="padding:4px 10px; font-size:11px; color:#6b7280;">${files}</td></tr>`;
    }
    document.getElementById('dd-dialog-affected').innerHTML = rows;
    document.getElementById('dd-confirm-hint').textContent =
      `삭제하려면 "${id}" 를 똑같이 입력하세요. 이 작업은 되돌릴 수 없습니다.`;
    overlay.style.display = 'flex';
    setTimeout(() => document.getElementById('dd-confirm-id').focus(), 50);
  }

  function closeConfirm() {
    pending = null;
    document.getElementById('dd-overlay').style.display = 'none';
  }

  async function executeDelete() {
    if (!pending) return;
    const { kind, id } = pending;
    const btn = document.getElementById('dd-execute-btn');
    const errEl = document.getElementById('dd-dialog-error');
    btn.disabled = true;
    btn.textContent = '삭제 중...';
    try {
      const j = await A.sendJSON(
        'DELETE',
        kind === 'matter'
          ? '/data/matters/' + encodeURIComponent(id)
          : '/data/documents/' + encodeURIComponent(id),
        {
          reason: document.getElementById('dd-reason').value.trim() || null,
          requested_by: document.getElementById('dd-requested-by').value.trim() || null,
        }
      );
      closeConfirm();
      const total = Object.values(j.deleted || {}).reduce((a, b) => a + (b || 0), 0);
      if (j.status === 'deleted') {
        alert('삭제 완료 — 총 ' + total.toLocaleString() + '건 (audit: ' + j.audit_id + ')');
      } else {
        const failed = Object.keys(j.failed || {}).join(', ');
        alert('부분 삭제 (' + j.status + ') — 실패 저장소: ' + failed + '\n삭제 ' + total.toLocaleString() + '건 (audit: ' + j.audit_id + ')');
      }
      runSearch().catch(() => {});
      loadAudit().catch(() => {});
      if (filesMatter) {
        if (kind === 'matter' && id === filesMatter) {
          closeFiles(); // 매터 자체가 삭제됨
        } else {
          loadFiles(filesMatter, '').catch(() => {}); // 파일 목록 갱신
        }
      }
    } catch (e) {
      errEl.textContent = '삭제 실패: ' + e.message;
    } finally {
      btn.textContent = '삭제 실행';
      btn.disabled = document.getElementById('dd-confirm-id').value.trim() !== id;
    }
  }

  /* ── 감사 로그 ────────────────────────────────────────────── */
  async function loadAudit() {
    const tbody = document.getElementById('dd-audit-tbody');
    try {
      const j = await A.getJSON('/data/audit-log?page=1&limit=50');
      if (!j.logs.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="8">삭제 이력이 없습니다</td></tr>';
        return;
      }
      tbody.innerHTML = j.logs.map((l) => {
        const counts = l.deleted_counts || {};
        const total = Object.keys(counts)
          .filter((k) => k !== '_failed')
          .reduce((a, k) => a + (counts[k] || 0), 0);
        const statusCls = l.status === 'completed' ? '' : ' class="err-text"';
        return `<tr>
          <td style="white-space:nowrap">${A.fmtKST(l.executed_at)}</td>
          <td style="white-space:nowrap">${l.action === 'delete_matter' ? '매터 삭제' : '문서 삭제'}</td>
          <td style="white-space:nowrap">${A.escHtml(l.target)}</td>
          <td class="text-clip" title="${A.escHtml(l.target_name || '')}">${A.escHtml(l.target_name || '—')}</td>
          <td title="${A.escHtml(JSON.stringify(counts))}">${A.fmtNum(total)}</td>
          <td class="text-clip">${A.escHtml(l.reason || '—')}</td>
          <td style="white-space:nowrap">${A.escHtml(l.requested_by || '—')}</td>
          <td><span${statusCls}>${A.escHtml(l.status)}</span></td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8"><span class="err-text">' + A.escHtml(e.message) + '</span></td></tr>';
    }
  }

  /* ── 이벤트 바인딩 ────────────────────────────────────────── */
  document.getElementById('dd-search-btn').addEventListener('click', runSearch);
  document.getElementById('dd-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
  document.getElementById('dd-audit-refresh').addEventListener('click', loadAudit);
  document.getElementById('dd-files-close').addEventListener('click', closeFiles);
  document.getElementById('dd-cancel-btn').addEventListener('click', closeConfirm);
  document.getElementById('dd-execute-btn').addEventListener('click', executeDelete);
  document.getElementById('dd-confirm-id').addEventListener('input', (e) => {
    document.getElementById('dd-execute-btn').disabled =
      !pending || e.target.value.trim() !== pending.id;
  });

  A.registerTab('data', { load: loadAudit });
})();
