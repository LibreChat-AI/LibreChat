const express = require('express');
const { getTchatCredit } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware/');

/**
 * The signed-in user's TensorGrid credit (`balance_cents`, `currency`) for the
 * mobile sidebar. LibreChat's own /api/balance is unused here; the credit lives
 * in TensorGrid and is read through the broker.
 */
const router = express.Router();

router.get('/', requireJwtAuth, async (req, res) => {
  const credit = await getTchatCredit(req);
  if (!credit) {
    return res.status(503).json({ message: 'Credit unavailable' });
  }
  res.set('Cache-Control', 'no-store').json(credit);
});

module.exports = router;
