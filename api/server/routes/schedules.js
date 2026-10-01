const express = require('express');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const {
  isEnabled,
  SCHEDULE_FILE_HOLD,
  generateCheckAccess,
  createSchedulesHandlers,
} = require('@librechat/api');
const { requireJwtAuth, configMiddleware, messageIpLimiter } = require('~/server/middleware');
const {
  getLimits,
  fireScheduleNow,
  deleteScheduleForOwner,
  isUserDeleting,
} = require('~/server/services/Schedules');
const { resolveAgentFireAccess } = require('~/server/services/Schedules/access');
const methods = require('~/models');

const { getRoleByName } = methods;

const router = express.Router();
router.use(requireJwtAuth);
router.use(configMiddleware);

const checkSchedulesAccess = generateCheckAccess({
  permissionType: PermissionTypes.SCHEDULES,
  permissions: [Permissions.USE],
  getRoleByName,
});
const checkSchedulesCreate = generateCheckAccess({
  permissionType: PermissionTypes.SCHEDULES,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

const handlers = createSchedulesHandlers({
  preflightMCP: require('~/server/services/Schedules/mcp'),
  methods,
  getLimits,
  // Full fire-equivalent access check (not mere existence): the body-based agent
  // middleware is a no-op for schedule payloads (no `endpoint: 'agents'`), so
  // enforce the same role AGENTS:USE + resource VIEW (with manage:agents bypass)
  // the actual fire requires — otherwise a role without AGENTS:USE could schedule
  // runs the chat route rejects and walks toward auto-disable.
  canViewAgent: async (agentId, req) => (await resolveAgentFireAccess(agentId, req.user)) === 'ok',
  // Same scoped lookup the fire-time precheck uses, so a destination this write
  // accepts is one the next fire also accepts.
  canUseProject: async (projectId, userId) =>
    (await methods.getChatProject(userId, projectId)) != null,
  filterOwnedFileIds: async (fileIds, userId) => {
    const files = await methods.getFiles({ file_id: { $in: fileIds }, user: userId }, null, {
      file_id: 1,
    });
    return (files ?? []).map((file) => file.file_id);
  },
  markFilesUsed: async (fileIds, userId) => {
    // BOUNDED renewable hold (extendFilesTTL), not a permanent `$unset` of the upload
    // TTL: permanence made a schedule deleted before its first run, an edit that
    // replaced file_ids, or a failed creation leak the upload forever, since nothing
    // ever restored an expiry. The first fire that actually SENDS the file clears its
    // TTL through the ordinary consumption path; until then the hold is renewed at
    // create/edit and each fire preflight, and lapses when the schedule stops touching
    // it. Files already made permanent by a real send are skipped by construction.
    // Idempotent, and never touches the usage counter (a retention is not a consumption).
    // Then VERIFY every requested file still exists: one can be deleted between the
    // ownership check and here, and a silent success would persist a schedule whose
    // attachments the first fire drops. Existence is the check — not the hold's
    // modified-count, which reads 0 for an already-permanent or already-held file.
    const unique = [...new Set(fileIds)];
    await methods.extendFilesTTL(unique, SCHEDULE_FILE_HOLD, { user: userId });
    const files = await methods.getFiles({ file_id: { $in: unique }, user: userId }, null, {
      file_id: 1,
    });
    const present = (files ?? []).length;
    if (present !== unique.length) {
      throw new Error(`attachment retention incomplete: ${present}/${unique.length} files exist`);
    }
  },
  fireNow: fireScheduleNow,
  // Quiesce-then-erase delete: stops new claims, settles provably job-less runs
  // synchronously, aborts live ones, and reports honestly (see ScheduleDeleteResult);
  // a delivered abort erases on the generation's own outcome write, in any topology.
  deleteSchedule: deleteScheduleForOwner,
  // Durable account-deletion barrier. A one-shot disable scan cannot close the
  // create race, so every scheduling WRITE consults the user-level flag instead.
  isUserDeleting,
});

router.get('/', checkSchedulesAccess, handlers.listSchedules);
router.get('/:id', checkSchedulesAccess, handlers.getSchedule);
router.post('/', checkSchedulesCreate, handlers.createSchedule);
router.patch('/:id', checkSchedulesCreate, handlers.updateSchedule);
router.delete('/:id', checkSchedulesCreate, handlers.deleteSchedule);
// Run-now mutates runtime state; gate it on CREATE like the UI does (not USE).
// This is also where LIMIT_MESSAGE_IP has to apply to a manual run: the fire itself is a
// loopback POST carrying the server's address, so limiting by IP there would pool every
// user into one bucket. Here the initiating client's address is still on the request.
// The USER limiter is NOT duplicated here; the fire token carries the authenticated id,
// so the chat router applies it to the loopback exactly once.
router.post(
  '/:id/run',
  ...(isEnabled(process.env.LIMIT_MESSAGE_IP) ? [messageIpLimiter] : []),
  checkSchedulesCreate,
  handlers.runScheduleNow,
);

module.exports = router;
