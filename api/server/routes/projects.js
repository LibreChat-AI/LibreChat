const express = require('express');
const { Permissions } = require('librechat-data-provider');
const { createProjectHandlers, requireProjectsPermission } = require('@librechat/api');
const { configMiddleware, requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const handlers = createProjectHandlers({
  listChatProjects: db.listChatProjects,
  createChatProject: db.createChatProject,
  getChatProject: db.getChatProject,
  updateChatProject: db.updateChatProject,
  deleteChatProject: db.deleteChatProject,
  assignConversationToProject: db.assignConversationToProject,
  addChatProjectFile: db.addChatProjectFile,
  removeChatProjectFile: db.removeChatProjectFile,
  getProjectFiles: db.getProjectFiles,
  getAvailableProjectFiles: db.getAvailableProjectFiles,
});
const checkProjectsUse = requireProjectsPermission(Permissions.USE, db);
const checkProjectsCreate = requireProjectsPermission(Permissions.CREATE, db);

router.use(requireJwtAuth);
router.use(checkProjectsUse);
router.get('/', handlers.listProjects);
router.post('/', checkProjectsCreate, configMiddleware, handlers.createProject);
router.put('/conversations/:conversationId', handlers.assignConversationToProject);
router.get('/:projectId/files/available', handlers.listAvailableProjectFiles);
router.get('/:projectId/files', handlers.listProjectFiles);
router.post('/:projectId/files', configMiddleware, handlers.addProjectFile);
router.delete('/:projectId/files/:fileId', handlers.removeProjectFile);
router.get('/:projectId', handlers.getProject);
router.patch('/:projectId', configMiddleware, handlers.updateProject);
router.delete('/:projectId', handlers.deleteProject);

module.exports = router;
