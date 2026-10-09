const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  MAX_SKILL_STATES,
  toSkillStatesRecord,
  validateSkillStatesPayload,
  pruneOrphanSkillStates,
  getDeploymentSkillIds,
  mergeDeploymentSkillIds,
} = require('@librechat/api');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { updateUser, getUserById } = require('~/models');

/** Builds the injected deps for `pruneOrphanSkillStates` from live models. */
function buildPruneDeps(user) {
  return {
    findExistingSkillIds: async (validIds) => {
      const Skill = mongoose.models.Skill;
      if (!Skill) {
        return validIds;
      }
      const existing = await Skill.find({ _id: { $in: validIds } })
        .select('_id')
        .lean();
      const deploymentIds = getDeploymentSkillIds()
        .map((id) => id.toString())
        .filter((id) => validIds.includes(id));
      return [...existing.map((doc) => doc._id.toString()), ...deploymentIds];
    },
    findAccessibleSkillIds: async () =>
      mergeDeploymentSkillIds(
        await findAccessibleResources({
          userId: user.id,
          role: user.role,
          resourceType: ResourceType.SKILL,
          requiredPermissions: PermissionBits.VIEW,
        }),
      ),
  };
}

const getSkillStatesController = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await getUserById(userId, 'skillStates');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const states = toSkillStatesRecord(user.skillStates);
    const pruned = await pruneOrphanSkillStates(states, buildPruneDeps(req.user));
    return res.status(200).json(pruned);
  } catch (error) {
    logger.error('[SkillStatesController] Error fetching skill states:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

const updateSkillStatesController = async (req, res) => {
  try {
    const { skillStates } = req.body;

    const validationError = validateSkillStatesPayload(skillStates);
    if (validationError) {
      const { message, code, limit } = validationError;
      const payload = { message };
      if (code) payload.code = code;
      if (limit != null) payload.limit = limit;
      return res.status(400).json(payload);
    }

    const pruned = await pruneOrphanSkillStates(skillStates, buildPruneDeps(req.user));

    if (Object.keys(pruned).length > MAX_SKILL_STATES) {
      return res.status(400).json({
        code: 'MAX_SKILL_STATES_EXCEEDED',
        message: `Maximum ${MAX_SKILL_STATES} skill state overrides allowed`,
        limit: MAX_SKILL_STATES,
      });
    }

    const user = await updateUser(req.user.id, { skillStates: pruned });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.status(200).json(toSkillStatesRecord(user.skillStates));
  } catch (error) {
    logger.error('[SkillStatesController] Error updating skill states:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = {
  getSkillStatesController,
  updateSkillStatesController,
};
