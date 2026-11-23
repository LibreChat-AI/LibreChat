import { PermissionBits, hasPermissions } from 'librechat-data-provider';
import type {
  ResponseResumeAdmissionDependencies,
  ResponseResumeValidationDependencies,
} from './resume';
import type { BackgroundResponsesHost, BackgroundResponsesHostDependencies } from './host';
import { createResponseResumeValidation, createResponseResumeAdmission } from './resume';
import { createBackgroundResponseAuthority } from './authority';
import { createBackgroundResponsesHost } from './host';

interface InteractiveResponsesHostDependencies
  extends Omit<BackgroundResponsesHostDependencies, 'interactive' | 'decisions'> {
  jobs: BackgroundResponsesHostDependencies['jobs'] & ResponseResumeAdmissionDependencies['jobs'];
  projects: ResponseResumeValidationDependencies['projects'];
  content: Omit<ResponseResumeValidationDependencies['content'], 'canAccessAgent'>;
  getRemotePermissions: (
    userId: string,
    role: string | undefined,
    resourceId: string,
  ) => Promise<number>;
}

/** Install browser decisions and worker admission under the same current owner authority. */
export function createInteractiveResponsesHost(
  deps: InteractiveResponsesHostDependencies,
): BackgroundResponsesHost {
  const validation = createResponseResumeValidation({
    jobs: deps.jobs,
    findUser: deps.findUser,
    getConfig: deps.getConfig,
    projects: deps.projects,
    content: {
      ...deps.content,
      canAccessAgent: async (agent, user) => {
        if (!agent._id) return false;
        return hasPermissions(
          await deps.getRemotePermissions(user.id, user.role, agent._id),
          PermissionBits.VIEW,
        );
      },
    },
  });
  const authority = createBackgroundResponseAuthority(deps);
  const admitResume = createResponseResumeAdmission({
    storage: deps.storage,
    jobs: deps.jobs,
    now: deps.now,
    authorize: (record) => authority(record, record.agentId, record.sourceKeyId),
    validate: validation.validateResume,
  });
  return createBackgroundResponsesHost({
    ...deps,
    interactive: {
      validate: validation.validateDecision,
      admitResume: (record, _user, intentId) => admitResume(record, record.responseId, intentId),
    },
  });
}
