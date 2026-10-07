const express = require('express');
const {
  updateUserPluginsController,
  resendVerificationController,
  getTermsStatusController,
  acceptTermsController,
  acceptSecondTermsController,
  saveFarmerProfileController,
  updateFarmerPlatformController,
  verifyEmailController,
  deleteUserController,
  getUserController,
  updateFarmerLastActiveAtController,
  getUserByIdController,
} = require('~/server/controllers/UserController');
const {
  verifyEmailLimiter,
  configMiddleware,
  canDeleteAccount,
  requireJwtAuth,
  requireInternalAuth,
} = require('~/server/middleware');

const settings = require('./settings');

const router = express.Router();

router.use('/settings', settings);
router.get('/', requireJwtAuth, getUserController);
router.get('/terms', requireJwtAuth, getTermsStatusController);
router.post('/terms/accept', requireJwtAuth, acceptTermsController);
router.post('/second-terms/accept', requireJwtAuth, acceptSecondTermsController);
router.post('/profile/farmer', requireJwtAuth, saveFarmerProfileController);
router.patch('/profile/farmer/platform', requireJwtAuth, updateFarmerPlatformController);
router.post('/plugins', requireJwtAuth, updateUserPluginsController);
router.delete('/delete', requireJwtAuth, canDeleteAccount, configMiddleware, deleteUserController);
router.post('/verify', verifyEmailController);
router.post('/verify/resend', verifyEmailLimiter, resendVerificationController);
router.patch('/profile/farmer/last-active-at', requireJwtAuth, updateFarmerLastActiveAtController);
router.get('/:id', requireInternalAuth, getUserByIdController);

module.exports = router;
