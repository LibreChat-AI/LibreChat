import type {
  ScheduledMCPIdentity,
  ScheduledMCPTarget,
  ScheduledMCPEnrollment,
} from 'librechat-data-provider';
import type {
  ScheduleMCPConsentStorage,
  ScheduleConsentSnapshot,
  IUser,
} from '@librechat/data-schemas';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ParsedServerConfig } from '~/mcp/types';
import { getScheduledMCPConfigurationRevision } from './configuration';
import { createScheduleMCPConsentService } from './service';
import { getScheduledMCPPolicyRevision } from './policy';
import { createScheduleMCPExecution } from './execution';

/** The owner's choice in tests that are not about choosing: every tool on offer. */
export function allowOffered(targets: readonly ScheduledMCPTarget[]): Record<string, string[]> {
  return Object.fromEntries(
    targets.map((target) => [
      target.resource.serverName,
      [...new Set(target.permittedTools.flatMap((selection) => selection.tools))],
    ]),
  );
}

/** The two pin writes over an enrollment a fake keeps in memory, with the real fences. */
export function pinStorage(
  current: () => ScheduledMCPEnrollment | null | undefined,
): Pick<ScheduleMCPConsentStorage, 'pinScheduleMCPToolDefinition' | 'flagScheduleMCPToolChange'> {
  const find = (revision: string, consentId: string) => {
    const enrollment = current();
    if (enrollment?.revision !== revision) return;
    return enrollment.consents.find((consent) => consent.id === consentId);
  };
  return {
    pinScheduleMCPToolDefinition: async ({ revision, consentId, tool, digest }) => {
      const consent = find(revision, consentId);
      if (
        !consent ||
        consent.revokedAtMs != null ||
        consent.definitions?.some((pin) => pin.tool === tool)
      )
        return false;
      consent.definitions = [...(consent.definitions ?? []), { tool, digest }];
      return true;
    },
    flagScheduleMCPToolChange: async ({ revision, consentId, tool }) => {
      const consent = find(revision, consentId);
      if (!consent?.definitions?.some((pin) => pin.tool === tool)) return false;
      consent.changedTools = [...new Set([...(consent.changedTools ?? []), tool])];
      return true;
    },
  };
}

export const readTool: Tool = {
  name: 'query',
  description: 'Read a fixed resource',
  inputSchema: { type: 'object', properties: {} },
};

export async function executionFixture(
  stage: 'activation' | 'invoke' | 'resume' = 'invoke',
  tool: Tool = readTool,
  url = 'https://resource.example/mcp',
  /** `offered` adds tools the agents select; `allow` is what the owner picks (default: `tool`). */
  choice: { offered?: string[]; allow?: string[] } = {},
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
      { agentId: 'root', tools: [tool.name, ...(choice.offered ?? [])] },
      { agentId: 'child', tools: [tool.name, ...(choice.offered ?? [])] },
    ],
    policyRevision: '',
  };
  target.resource.configurationRevision = getScheduledMCPConfigurationRevision(
    config,
    target.resource,
  );
  const resolveEnrollment = async () => {
    target.policyRevision = getScheduledMCPPolicyRevision(target.permittedTools);
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
    ...pinStorage(() => snapshot.enrollment),
  };
  const service = createScheduleMCPConsentService({
    storage,
    resolveEnrollment,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => allowed,
    now: () => time,
  });
  const offer = await service.view(identity);
  await service.confirm(identity, {
    offerDigest: offer.offer!.digest,
    expectedRevision: null,
    lifetimeHours: 1,
    allow: { warehouse: choice.allow ?? [tool.name] },
  });
  const loadAuthorization = jest.fn(async () => ({ authority: service.authority }));
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
    revoke: () => service.revoke(identity, snapshot.enrollment!.revision),
    expire: () => {
      time = 3_601_000;
    },
    deny: () => {
      allowed = false;
    },
    invocation: (agentId = 'root', selection = tool.name) => execution.bind(agentId, selection),
  };
}
