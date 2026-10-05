const accessPermissions = require('./accessPermissions');
const assistants = require('./assistants');
const categories = require('./categories');
const locations = require('./locations');
const endpoints = require('./endpoints');
const staticRoute = require('./static');
const messages = require('./messages');
const memories = require('./memories');
const presets = require('./presets');
const prompts = require('./prompts');
const balance = require('./balance');
const actions = require('./actions');
const banner = require('./banner');
const search = require('./search');
const models = require('./models');
const convos = require('./convos');
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
const langgraph = require('./langgraph');
const webhooks = require('./webhooks');
const feedbacks = require('./feedbacks');
const push = require('./push');
const notifications = require('./notifications');
const diagnostics = require('./diagnostics');
const crops = require('./crop');
const answers = require('./answers');

module.exports = {
  mcp,
  langgraph,
  auth,
  keys,
  user,
  tags,
  roles,
  oauth,
  files,
  share,
  banner,
  agents,
  convos,
  search,
  config,
  models,
  prompts,
  actions,
  presets,
  balance,
  messages,
  memories,
  endpoints,
  assistants,
  categories,
  locations,
  staticRoute,
  accessPermissions,
  webhooks,
  feedbacks,
  push,
  notifications,
  diagnostics,
  crops,
  answers,
};
