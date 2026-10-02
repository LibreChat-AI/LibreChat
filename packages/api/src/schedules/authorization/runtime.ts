import {
  normalizeServerName,
  stripServerNamePrefix,
  scheduledMCPReadOnlyPolicySchema,
} from 'librechat-data-provider';
import type { ScheduledMCPIdentity, ScheduledMCPReadOnlyPolicy } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { ScheduleMCPEnrollmentDeps } from './enrollment';
import type { ScheduledTokenContext } from '../context';
import { createScheduleMCPExecution, scheduledMCPIdentity } from './execution';
import { readScheduleFireContext, isScheduleFireRequest } from '../trigger';
import { createScheduleMCPEnrollmentResolver } from './enrollment';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { createScheduleMCPConsentHost } from './host';
import { ScheduledMCPPolicyError } from './policy';

type RuntimeRequest = Parameters<typeof readScheduleFireContext>[0] & { user: IUser };

export function createScheduleMCPRuntimeHost(
  deps: Omit<
    Parameters<typeof createScheduleMCPConsentHost>[0],
    'resolveEnrollment' | 'checkToolPolicy'
  > & {
    enrollment: ScheduleMCPEnrollmentDeps;
  },
): {
  consent: ReturnType<typeof createScheduleMCPConsentHost>;
  execution: ReturnType<typeof createScheduleMCPExecution>;
  prepare: (input: {
    req: RuntimeRequest;
    context?: RequestScopedMCPConnectionStore;
    restoredContext?: ScheduledTokenContext;
    restoredJob?: { scheduleId?: string };
  }) => Promise<void>;
} {
  const resolveEnrollment = createScheduleMCPEnrollmentResolver(deps.enrollment);
  const getReadOnlyPolicy = async (
    identity: ScheduledMCPIdentity,
  ): Promise<Record<string, ScheduledMCPReadOnlyPolicy> | undefined> => {
    const user = await deps.findUser(identity.ownerId);
    if (!user || (user.tenantId ?? null) !== identity.tenantId) return;
    user.id = identity.ownerId;
    const config = await deps.enrollment.getAppConfig({
      ...getAppConfigOptionsFromUser(user),
      failClosed: true,
    });
    const schedules = config?.interfaceConfig?.schedules;
    const configured =
      typeof schedules === 'object' ? schedules.mcpConsent?.readOnlyPolicy : undefined;
    if (!configured) return;
    const policy: Record<string, ScheduledMCPReadOnlyPolicy> = {};
    for (const [name, value] of Object.entries(configured)) {
      const parsed = scheduledMCPReadOnlyPolicySchema.safeParse(value);
      if (parsed.success) policy[name] = parsed.data;
    }
    return policy;
  };
  const consent = createScheduleMCPConsentHost({
    ...deps,
    resolveEnrollment,
    checkToolPolicy: async (request) => {
      const policy = (await getReadOnlyPolicy(request.identity))?.[request.resource.serverName];
      if (!policy) return false;
      return request.selection.tools.every(
        (selection) =>
          Object.keys(policy.tools).filter(
            (name) =>
              name === selection ||
              stripServerNamePrefix(name, normalizeServerName(request.resource.serverName)) ===
                selection,
          ).length === 1,
      );
    },
  });
  const execution = createScheduleMCPExecution({
    storage: deps.methods,
    authority: consent.service.authority,
    getReadOnlyPolicy,
  });
  return {
    consent,
    execution,
    async prepare({ req, context, restoredContext, restoredJob }) {
      if (!isScheduleFireRequest(req)) return;
      const fire = readScheduleFireContext(req);
      const scheduleId = restoredContext?.scheduleId ?? fire?.scheduleId ?? restoredJob?.scheduleId;
      if (!scheduleId || !context) throw new ScheduledMCPPolicyError('binding_mismatch', '');
      const row = await deps.methods.getScheduleById(scheduleId, req.user.id);
      if (!row || (row.tenantId ?? null) !== (req.user.tenantId ?? null))
        throw new ScheduledMCPPolicyError('binding_mismatch', '');
      if (!row.mcpConsent) return;
      const rootId = restoredContext?.agentId ?? (fire ? req.body?.agent_id : undefined);
      if (typeof rootId !== 'string' || rootId !== row.agent_id)
        throw new ScheduledMCPPolicyError('binding_mismatch', '');
      const identity = scheduledMCPIdentity({
        scheduleId,
        ownerId: req.user.id,
        tenantId: req.user.tenantId,
        agentId: rootId,
        invocationMode: 'delegated',
      });
      if (
        restoredContext &&
        (restoredContext.ownerId !== req.user.id ||
          (restoredContext.tenantId ?? null) !== (req.user.tenantId ?? null))
      )
        throw new ScheduledMCPPolicyError('binding_mismatch', '');
      await execution.attach(context, identity, restoredContext ? 'resume' : 'invoke', true);
    },
  };
}

/** Ordinary chats do not construct scheduling dependencies or perform schedule reads. */
export async function prepareScheduleMCPExecution(
  input: Parameters<ReturnType<typeof createScheduleMCPRuntimeHost>['prepare']>[0],
  getHost: () => Pick<ReturnType<typeof createScheduleMCPRuntimeHost>, 'prepare'>,
): Promise<void> {
  if (!isScheduleFireRequest(input.req)) return;
  await getHost().prepare(input);
}
