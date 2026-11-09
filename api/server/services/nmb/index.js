const {
  loadNmbConfig,
  createScannerClient,
  createNmbChatGateway,
  createNmbUploadGate,
  createNmbHandlers,
} = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const db = require('~/models');

/**
 * Wiring for the NMB secure gateway. All behaviour lives in `packages/api/src/nmb`; this binds it
 * to this workspace's models and capability checks. Built once, on first use, from the environment.
 */
let instance;

const getFilesForUser = async (fileIds, userId) => {
  const files = await db.getFiles({ file_id: { $in: fileIds }, user: userId }, null, {
    file_id: 1,
    filename: 1,
  });
  return (files ?? []).map((f) => ({ file_id: f.file_id, filename: f.filename }));
};

const getUserLabels = async (ids) => {
  const out = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const u = await db.findUser({ _id: id }, 'name username email');
        out[id] = u?.name || u?.username || u?.email || id;
      } catch {
        out[id] = id;
      }
    }),
  );
  return out;
};

const recordAudit = (entry) => db.recordAuditEntry(entry);

function getNmb() {
  if (instance) {
    return instance;
  }
  const config = loadNmbConfig(process.env);
  const scanner = createScannerClient(config);
  instance = {
    config,
    scanner,
    chatGateway: createNmbChatGateway({ config, scanner, getFiles: getFilesForUser }),
    uploadGate: createNmbUploadGate({
      config,
      scanner,
      createNmbFileHold: db.createNmbFileHold,
      findNmbFileHolds: db.findNmbFileHolds,
      consumeNmbFileHold: db.consumeNmbFileHold,
    }),
    handlers: createNmbHandlers({
      config,
      scanner,
      isReviewer: (user) => hasCapability(user, SystemCapabilities.REVIEW_PROMPTS),
      recordAudit,
      getUserLabels,
    }),
  };
  return instance;
}

/** Mount-time middleware: resolves the singleton lazily so env is read after dotenv. */
const chatGateway = (req, res, next) => getNmb().chatGateway(req, res, next);
const uploadGate = (req, res) => getNmb().uploadGate(req, res);

/** The OpenAI-compatible API authenticates with API keys and would bypass the gateway entirely. */
const blockBypassRoutes = (req, res, next) => {
  if (!getNmb().config.enabled) {
    return next();
  }
  return res.status(403).json({
    type: 'nmb_forbidden',
    message: 'This interface is disabled while the data-protection gateway is active.',
  });
};

/** Images cannot be inspected (no OCR), so they cannot be attached while the gateway is on. */
const blockImageUploads = (req, res, next) => {
  if (!getNmb().config.enabled) {
    return next();
  }
  return res.status(422).json({
    type: 'nmb_rejected',
    message: 'Images cannot be attached while data protection is active.',
  });
};

module.exports = { getNmb, chatGateway, uploadGate, blockBypassRoutes, blockImageUploads };
