const { toBalanceResponse } = require('@librechat/api');
const { findBalanceByUser } = require('~/models');

async function balanceController(req, res) {
  const balanceLocals = res.locals || {};

  if (balanceLocals.balanceConfigEnabled === false) {
    return res.sendStatus(204);
  }

  const balanceData = balanceLocals.balanceData ?? (await findBalanceByUser(req.user.id));

  if (!balanceData) {
    return res.status(404).json({ error: 'Balance not found' });
  }

  res.status(200).json(toBalanceResponse(balanceData));
}

module.exports = balanceController;
