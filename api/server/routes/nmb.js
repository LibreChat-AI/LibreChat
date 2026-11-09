const express = require('express');
const { getNmb } = require('~/server/services/nmb');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
router.use(requireJwtAuth);

const h = (name) => (req, res, next) => getNmb().handlers[name](req, res, next);

/** Any authenticated user */
router.get('/me', h('me'));
router.get('/submissions/:id', h('mySubmission'));
router.post('/unmask', h('unmask'));

/** Reviewers only: capability `review:prompts`, then self-review is refused per review. */
const reviewer = h('requireReviewer');
router.get('/reviews', reviewer, h('listReviews'));
router.get('/reviews/:id', reviewer, h('getReview'));
router.get('/reviews/:id/original', reviewer, h('getOriginal'));
router.post('/reviews/:id/approve', reviewer, h('approve'));
router.post('/reviews/:id/reject', reviewer, h('reject'));
router.get('/blocklist', reviewer, h('getBlocklist'));
router.post('/blocklist', reviewer, h('addBlocklist'));

module.exports = router;
