const express = require('express');
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { requireAdminToken } = require('./middleware');
const { getDb } = require('./helpers');

const router = express.Router();

/* health 는 인증 없이 (컨테이너 프로브용) */
router.get('/health', async (_req, res) => {
  try {
    res.json({ status: 'ok', mongo: await getDb().command({ ping: 1 }) });
  } catch (err) {
    res.status(500).json({ status: 'error', detail: String(err.message) });
  }
});

/* 토큰 검증용 (UI 최초 진입 시 사용) */
router.get('/auth/check', requireAdminToken, (_req, res) => {
  res.json({ ok: true });
});

router.use(requireAdminToken);

router.use(require('./stats'));
router.use(require('./sessions'));
router.use(require('./deleted'));
router.use(require('./shares'));
router.use(require('./notices'));
router.use(require('./surveys'));
router.use(require('./settings'));

/**
 * FastAPI analytics 프록시: /admin-api/analytics/* → ai-api /analytics/*
 * (Top 문서/케이스, 질문 유형, 그룹 인사이트, AI 통계 요약 — Postgres 기반).
 * nginx 설정 변경 없이 어드민 토큰 검사 후 서버측 IRE 토큰으로 위임한다.
 */
router.use('/analytics', async (req, res) => {
  const baseUrl = process.env.BKL_API_BASE_URL || 'http://bkl-api:8000';
  const targetUrl = `${baseUrl}/analytics${req.url}`;
  const headers = { Accept: 'application/json' };
  if (process.env.IRE_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.IRE_API_TOKEN}`;
  }
  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? undefined : req.body,
      headers: req.method === 'GET' ? headers : { ...headers, 'Content-Type': 'application/json' },
      timeout: 120_000,
      validateStatus: () => true,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    logger.error('[bklAdmin/analytics] upstream error', err?.message || err);
    res.status(502).json({ error: 'analytics upstream error', detail: String(err?.message || err) });
  }
});

/**
 * 대화 출처 프록시: /admin-api/sources/:conversationId → ai-api /v1/sources/by-conversation/:id
 *
 * 사용자 탭·질의 이력에서 답변의 [N] 인용을 청크 본문으로 펼쳐 보기 위한 것.
 * 채팅 우측 패널과 같은 데이터(bkl_chat_sources). 어드민은 모든 사건을 봐야
 * 하므로 X-LC-User-Role: ADMIN 으로 BIMS 사건 ACL 을 bypass 한다 — 이 라우터는
 * requireAdminToken 뒤에 있어 어드민 토큰 소지자만 도달한다.
 */
router.get('/sources/:conversationId', async (req, res) => {
  const baseUrl = process.env.BKL_API_BASE_URL || 'http://bkl-api:8000';
  const targetUrl = `${baseUrl}/v1/sources/by-conversation/${encodeURIComponent(req.params.conversationId)}`;
  const headers = { Accept: 'application/json', 'X-LC-User-Role': 'ADMIN' };
  if (process.env.IRE_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.IRE_API_TOKEN}`;
  }
  try {
    const response = await axios({
      method: 'GET',
      url: targetUrl,
      headers,
      timeout: 60_000,
      validateStatus: () => true,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    logger.error('[bklAdmin/sources] upstream error', err?.message || err);
    res.status(502).json({ error: 'sources upstream error', detail: String(err?.message || err) });
  }
});

/**
 * FastAPI 데이터 삭제 프록시: /admin-api/data/* → ai-api /admin/data/*
 * (매터/문서 preview·삭제·검색·감사 로그 — ADMIN_DATA_DELETE_SPEC).
 * OpenSearch _delete_by_query 가 느릴 수 있어 timeout 을 넉넉히 잡는다.
 */
router.use('/data', async (req, res) => {
  const baseUrl = process.env.BKL_API_BASE_URL || 'http://bkl-api:8000';
  const targetUrl = `${baseUrl}/admin/data${req.url}`;
  const headers = { Accept: 'application/json' };
  if (process.env.IRE_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.IRE_API_TOKEN}`;
  }
  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? undefined : req.body,
      headers:
        req.method === 'GET' ? headers : { ...headers, 'Content-Type': 'application/json' },
      timeout: 300_000,
      validateStatus: () => true,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    logger.error('[bklAdmin/data] upstream error', err?.message || err);
    res.status(502).json({ error: 'data upstream error', detail: String(err?.message || err) });
  }
});

/**
 * FastAPI 일배치 동기화 프록시: /admin-api/sync/* → ai-api /admin/sync/*
 * (BIMS/iManage daily-changes 트리거·진행 상태·이력 — DAILY_SYNC_DESIGN).
 * 트리거 자체는 즉시 job_id 를 반환하므로 timeout 은 넉넉하게만 잡는다.
 */
router.use('/sync', async (req, res) => {
  const baseUrl = process.env.BKL_API_BASE_URL || 'http://bkl-api:8000';
  const targetUrl = `${baseUrl}/admin/sync${req.url}`;
  const headers = { Accept: 'application/json' };
  if (process.env.IRE_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.IRE_API_TOKEN}`;
  }
  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? undefined : req.body,
      headers:
        req.method === 'GET' ? headers : { ...headers, 'Content-Type': 'application/json' },
      timeout: 300_000,
      validateStatus: () => true,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    logger.error('[bklAdmin/sync] upstream error', err?.message || err);
    res.status(502).json({ error: 'sync upstream error', detail: String(err?.message || err) });
  }
});

router.use((err, _req, res, _next) => {
  logger.error('[bkl-admin-api] request failed', err);
  res.status(500).json({ error: String(err.message || err) });
});

module.exports = router;
