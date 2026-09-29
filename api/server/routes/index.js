const accessPermissions = require('./accessPermissions');
const assistants = require('./assistants');
const categories = require('./categories');
const adminAuth = require('./admin/auth');
const adminConfig = require('./admin/config');
const adminCodeEnvironments = require('./admin/code');
const codeEnvironments = require('./code-environments');
const adminLangfuse = require('./admin/langfuse');
const adminGrants = require('./admin/grants');
const adminGroups = require('./admin/groups');
const adminRoles = require('./admin/roles');
const adminSkills = require('./admin/skills');
const adminUsers = require('./admin/users');
const adminAuditLog = require('./admin/audit');
const endpoints = require('./endpoints');
const staticRoute = require('./static');
const messages = require('./messages');
const memories = require('./memories');
const presets = require('./presets');
const projects = require('./projects');
const prompts = require('./prompts');
const schedules = require('./schedules');
const skills = require('./skills');
const balance = require('./balance');
const actions = require('./actions');
const apiKeys = require('./apiKeys');
const banner = require('./banner');
const search = require('./search');
const models = require('./models');
const convos = require('./convos');
const traces = require('./traces');
const config = require('./config');
const agents = require('./agents');
const roles = require('./roles');
const oauth = require('./oauth');
const files = require('./files');
const share = require('./share');
const tags = require('./tags');
const auth = require('./auth');
const keys = require('./keys');
const user = require('./user');
const mcp = require('./mcp');
const rum = require('./rum');
const insights = require('./insights');

module.exports = {
  insights,
  rum,
  mcp,
  auth,
  adminAuth,
  adminConfig,
  adminCodeEnvironments,
  codeEnvironments,
  adminLangfuse,
  adminGrants,
  adminGroups,
  adminRoles,
  adminSkills,
  adminUsers,
  adminAuditLog,
  keys,
  apiKeys,
  user,
  tags,
  roles,
  oauth,
  files,
  share,
  banner,
  agents,
  convos,
  traces,
  search,
  config,
  models,
  prompts,
  projects,
  schedules,
  skills,
  actions,
  presets,
  balance,
  messages,
  memories,
  endpoints,
  assistants,
  categories,
  staticRoute,
  accessPermissions,
};
