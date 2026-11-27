const {
  checkAccess,
  handleSteerRequest,
  handleSteerCancel,
  handleSteerArm,
} = require('@librechat/api');
const { logger, ResourceCapabilityMap } = require('@librechat/data-schemas');
const {
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
  isAgentsEndpoint,
  isEphemeralAgentId,
} = require('librechat-data-provider');
const { checkPermission } = require('~/server/services/PermissionService');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const {
  GENERATION_PROTOCOL_HEADER,
  getRequestedGenerationProtocol,
  getServerGenerationProtocol,
} = require('~/server/controllers/agents/protocol');
const db = require('~/models');

/** Upper bound before the package reads the immutable live-job marker. */
const getHostGenerationProtocol = (req) =>
  Math.min(getRequestedGenerationProtocol(req), getServerGenerationProtocol());

/** The package returns its job-capped effective marker in every body. Keep the
 * header and JSON inseparable at this final serialization boundary. */
const sendProtocolResult = (res, status, body) => {
  const generationProtocolVersion = body?.generationProtocolVersion === 2 ? 2 : 1;
  res.set(GENERATION_PROTOCOL_HEADER, String(generationProtocolVersion));
  return res.status(status).json({ ...body, generationProtocolVersion });
};

const sendProtocolFailure = (res, status, code) => {
  res.set(GENERATION_PROTOCOL_HEADER, '1');
  return res.status(status).json({ code, generationProtocolVersion: 1 });
};

/**
 * Steer-time agent authorization, mirroring the chat route's middlewares
 * (`checkAgentAccess` + `canAccessAgentFromBody`) against the ORIGINATING
 * run's identity from job metadata instead of the request body:
 * - role gate: AGENTS:USE via `checkAccess`, applied exactly when chat.js
 *   would run it (`skipAgentCheck` skips non-agents endpoints);
 * - resource gate: `canAccessResource`'s capability bypass + `checkPermission`
 *   VIEW on the resolved agent, skipped for ephemeral/no-agent runs.
 *
 * @param {import('express').Request} req
 * @returns {(run: import('@librechat/api').SteerRunContext) => Promise<boolean>}
 */
const createAgentAccessCheck =
  (req) =>
  async ({ agentId, endpoint }) => {
    const hasRealAgent = agentId != null && !isEphemeralAgentId(agentId);
    const roleGateApplies = endpoint == null ? hasRealAgent : isAgentsEndpoint(endpoint);
    if (roleGateApplies) {
      const roleAllowed = await checkAccess({
        req,
        user: req.user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName: db.getRoleByName,
      });
      if (!roleAllowed) {
        return false;
      }
    }
    if (!hasRealAgent) {
      return true;
    }
    let bypass = false;
    try {
      bypass = await hasCapability(req.user, ResourceCapabilityMap[ResourceType.AGENT]);
    } catch {
      bypass = false;
    }
    if (bypass) {
      return true;
    }
    const agent = await db.getAgent({ id: agentId });
    if (!agent) {
      return false;
    }
    return checkPermission({
      userId: req.user.id,
      role: req.user.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermission: PermissionBits.VIEW,
    });
  };

/**
 * POST /api/agents/chat/steer
 *
 * Thin wrapper: the full guard ladder (validation, file sanitization,
 * capability gate, ownership/tenant checks, agent access, owner-scoped file
 * resolve, status-guarded enqueue) lives in `@librechat/api`
 * (`handleSteerRequest`), which returns the HTTP status + JSON body to
 * serialize verbatim. DB access and permission services are injected here.
 */
const runSteerController = async (req, res, requireIdempotentDelivery) => {
  const abortController = new AbortController();
  const abort = () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    const generationProtocolVersion = getHostGenerationProtocol(req);
    const checkAgentAccess = createAgentAccessCheck(req);
    const expectedAgentId = requireIdempotentDelivery ? req.body?.agentId : undefined;
    const { status, body } = await handleSteerRequest(req.user ?? {}, req.body ?? {}, {
      generationProtocolVersion,
      signal: abortController.signal,
      ...(requireIdempotentDelivery && { requireIdempotentDelivery: true }),
      getFiles: db.getFiles,
      updateFilesUsage: db.updateFilesUsage,
      checkAgentAccess: requireIdempotentDelivery
        ? async (run) =>
            typeof expectedAgentId === 'string' &&
            run.agentId === expectedAgentId &&
            isAgentsEndpoint(run.endpoint) &&
            (await checkAgentAccess(run))
        : checkAgentAccess,
    });
    if (res.destroyed || res.writableEnded) {
      return;
    }
    return sendProtocolResult(res, status, body);
  } catch (error) {
    logger.error('[SteerController] Failed to queue steer', error);
    if (res.destroyed || res.headersSent) {
      return;
    }
    return sendProtocolFailure(res, 500, 'STEER_FAILED');
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
};

const SteerController = (req, res) => runSteerController(req, res, false);

/**
 * Strict trigger-delivery endpoint. It shares the ordinary steer route's
 * authentication, limiters, PII filter, moderation, owner/tenant checks, and
 * agent ACL, while refusing any job/store path that cannot persist a durable
 * clientSteerId receipt. The dedicated path also fails closed on old replicas
 * during a rolling deploy: they return 404 instead of accepting a legacy steer.
 */
const SteerDeliveryController = (req, res) => runSteerController(req, res, true);

/**
 * POST /api/agents/chat/steer/cancel
 *
 * Removes a still-queued steer before injection. `removed: false` is not an
 * error — the cancel lost its race (already injected, or the run ended) and
 * the client defers to the events it will receive. No agent-access check:
 * a cancel injects nothing model-bound, so ownership checks suffice.
 */
const SteerCancelController = async (req, res) => {
  try {
    const generationProtocolVersion = getHostGenerationProtocol(req);
    const { status, body } = await handleSteerCancel(req.user ?? {}, req.body ?? {}, {
      generationProtocolVersion,
    });
    return sendProtocolResult(res, status, body);
  } catch (error) {
    logger.error('[SteerCancelController] Failed to cancel steer', error);
    return sendProtocolFailure(res, 500, 'STEER_CANCEL_FAILED');
  }
};

/**
 * POST /api/agents/chat/steer/arm
 *
 * Escalates a still-queued steer to an interrupt in place (the durable item
 * keeps its FIFO position). `armed: false` is not an error — the steer
 * already injected, was cancelled, or the deployment cannot seal mid-stream.
 * No agent-access check: arming injects nothing model-bound, so ownership
 * checks suffice, exactly like cancel.
 */
const SteerArmController = async (req, res) => {
  try {
    const generationProtocolVersion = getHostGenerationProtocol(req);
    const { status, body } = await handleSteerArm(req.user ?? {}, req.body ?? {}, {
      generationProtocolVersion,
    });
    return sendProtocolResult(res, status, body);
  } catch (error) {
    logger.error('[SteerArmController] Failed to arm steer', error);
    return sendProtocolFailure(res, 500, 'STEER_ARM_FAILED');
  }
};

module.exports = SteerController;
module.exports.SteerDeliveryController = SteerDeliveryController;
module.exports.SteerCancelController = SteerCancelController;
module.exports.SteerArmController = SteerArmController;
module.exports.createAgentAccessCheck = createAgentAccessCheck;
