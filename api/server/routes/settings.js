const express = require('express');
const { CacheKeys } = require('librechat-data-provider');
const {
  createToolFavoritesHandlers,
  createPinnedOrderHandlers,
  invalidateCachedAuthUserDoc,
} = require('@librechat/api');
const {
  updateFavoritesController,
  getFavoritesController,
} = require('~/server/controllers/FavoritesController');
const {
  getSkillStatesController,
  updateSkillStatesController,
} = require('~/server/controllers/SkillStatesController');
const { requireJwtAuth } = require('~/server/middleware');
const { getLogStores } = require('~/cache');
const {
  getToolFavorites,
  addToolFavorite,
  removeToolFavorite,
  getUserById,
  updateUser,
} = require('~/models');

const router = express.Router();

const toolFavorites = createToolFavoritesHandlers({
  getToolFavorites,
  addToolFavorite,
  removeToolFavorite,
});

const authUserDocCacheStore = getLogStores(CacheKeys.AUTH_USER_DOC);
const pinnedOrder = createPinnedOrderHandlers({
  getUserById,
  updateUser,
  invalidateCachedAuthUserDoc: (userId) =>
    invalidateCachedAuthUserDoc(authUserDocCacheStore, { userId }),
});

router.get('/favorites/tools', requireJwtAuth, toolFavorites.listToolFavorites);
router.put('/favorites/tools/:itemType/:itemId', requireJwtAuth, toolFavorites.addToolFavorite);
router.delete(
  '/favorites/tools/:itemType/:itemId',
  requireJwtAuth,
  toolFavorites.removeToolFavorite,
);
router.get('/favorites', requireJwtAuth, getFavoritesController);
router.post('/favorites', requireJwtAuth, updateFavoritesController);
router.get('/pinned-order', requireJwtAuth, pinnedOrder.getPinnedOrder);
router.post('/pinned-order', requireJwtAuth, pinnedOrder.updatePinnedOrder);
router.get('/skills/active', requireJwtAuth, getSkillStatesController);
router.post('/skills/active', requireJwtAuth, updateSkillStatesController);

module.exports = router;
