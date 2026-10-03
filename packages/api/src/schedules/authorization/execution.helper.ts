import type {
  ScheduledMCPIdentity,
  ScheduledMCPTarget,
  ScheduledMCPReadOnlyPolicy,
} from 'librechat-data-provider';
import type {
  ScheduleMCPConsentStorage,
  ScheduleConsentSnapshot,
  IUser,
} from '@librechat/data-schemas';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedServerConfig } from '~/mcp/types';
import { getScheduledMCPToolDefinitionDigest, getScheduledMCPPolicyRevision } from './policy';
import { getScheduledMCPConfigurationRevision } from './configuration';
import { createScheduleMCPConsentService } from './service';
import { createScheduleMCPExecution } from './execution';

export const readTool: Tool = {
  name: 'query',
  description: 'Read a fixed resource',
  inputSchema: { type: 'object', properties: {} },
};

export async function executionFixture(
  stage: 'activation' | 'invoke' | 'resume' = 'invoke',
  tool: Tool = readTool,
  url = 'https://resource.example/mcp',
) {
  let time = 1000;
  let allowed = true;
  const identity: ScheduledMCPIdentity = {
    scheduleId: 'schedule',
    ownerId: 'owner',
    tenantId: 'tenant',
    agentId: 'root',
    invocationMode: 'delegated',
  };
  const config: ParsedServerConfig = {
    type: 'streamable-http',
    url,
  };
  const user = { id: 'owner', tenantId: 'tenant', role: 'USER' } as IUser;
  let policy: Record<string, ScheduledMCPReadOnlyPolicy> = {
    warehouse: {
      tools: {
        [tool.name]: {
          effect: 'read_only',
          definitionSha256: getScheduledMCPToolDefinitionDigest(tool),
        },
      },
    },
  };
  const target: ScheduledMCPTarget = {
    resource: {
      serverName: 'warehouse',
      url: config.url,
      credentialMode: 'anonymous',
      issuer: null,
      audience: null,
      scopes: [],
      configurationRevision: '',
    },
    permittedTools: [
      { agentId: 'root', tools: [tool.name] },
      { agentId: 'child', tools: [tool.name] },
    ],
    policyRevision: '',
  };
  target.resource.configurationRevision = getScheduledMCPConfigurationRevision(
    config,
    target.resource,
  );
  const resolveEnrollment = async () => {
    target.policyRevision = getScheduledMCPPolicyRevision(target.permittedTools, policy.warehouse);
    return structuredClone([target]);
  };
  const snapshot: ScheduleConsentSnapshot = {
    enabled: true,
    agentId: 'root',
    configRevision: 0,
    enrollment: null,
  };
  const storage: ScheduleMCPConsentStorage = {
    readScheduleMCPConsent: jest.fn(async () => structuredClone(snapshot)),
    confirmScheduleMCPConsent: jest.fn(async ({ enrollment }) => {
      snapshot.enrollment = structuredClone(enrollment);
      return true;
    }),
    revokeScheduleMCPConsent: jest.fn(async () => {
      for (const consent of snapshot.enrollment?.consents ?? []) consent.revokedAtMs = time;
      return true;
    }),
    admitScheduleMCPConsent: jest.fn(
      async (input) =>
        (input.requireEnabled === false || snapshot.enabled) &&
        snapshot.configRevision === input.expectedConfigRevision &&
        snapshot.enrollment?.revision === input.revision &&
        snapshot.enrollment.consents.every(
          (c) => c.revokedAtMs == null && c.absoluteExpiresAtMs > time,
        ),
    ),
  };
  const service = createScheduleMCPConsentService({
    storage,
    resolveEnrollment,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => allowed,
    checkToolPolicy: async () => Object.keys(policy.warehouse?.tools ?? {}).length > 0,
    now: () => time,
  });
  const offer = await service.view(identity);
  await service.confirm(identity, {
    offerDigest: offer.offer!.digest,
    expectedRevision: null,
    lifetimeHours: 1,
  });
  const loadAuthorization = jest.fn(async () => ({ authority: service.authority, policy }));
  const factory = createScheduleMCPExecution({ storage, loadAuthorization });
  const execution = (await factory.resolve(identity, stage))!;
  return {
    identity,
    config,
    user,
    target,
    snapshot,
    storage,
    service,
    execution,
    factory,
    loadAuthorization,
    policy,
    revoke: () => service.revoke(identity, snapshot.enrollment!.revision),
    expire: () => {
      time = 3_601_000;
    },
    deny: () => {
      allowed = false;
    },
    removePolicy: () => {
      policy = {};
    },
    invocation: (agentId = 'root', selection = tool.name) => execution.bind(agentId, selection),
  };
}
