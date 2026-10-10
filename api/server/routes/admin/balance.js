const express = require('express');
const { createAdminBalanceHandlers } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadBalances = requireCapability(SystemCapabilities.READ_BALANCES);
const requireManageBalances = requireCapability(SystemCapabilities.MANAGE_BALANCES);

const handlers = createAdminBalanceHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  getUserById: db.getUserById,
  findBalancesByUsers: db.findBalancesByUsers,
  findPendingBalanceRequestsByUsers: db.findPendingBalanceRequestsByUsers,
  findAllPendingBalanceRequests: db.findAllPendingBalanceRequests,
  countPendingBalanceRequests: db.countPendingBalanceRequests,
  applyIdempotentCredit: db.applyIdempotentCredit,
  claimAuditRecording: db.claimAuditRecording,
  markAuditRecorded: db.markAuditRecorded,
  releaseAuditRecordingLease: db.releaseAuditRecordingLease,
  claimBalanceRequestResolution: db.claimBalanceRequestResolution,
  releaseBalanceRequestResolutionLease: db.releaseBalanceRequestResolutionLease,
  resolveBalanceRequestIfPending: db.resolveBalanceRequestIfPending,
  recordAuditEntry: db.recordAuditEntry,
  getAppConfig,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadBalances, handlers.listUsersWithBalance);
router.post('/:userId/credit', requireManageBalances, handlers.addCredit);

module.exports = router;
