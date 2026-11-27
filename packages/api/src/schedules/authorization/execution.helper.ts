import type {
  MCPGrantIdentity,
  MCPGrantEnrollment,
  ScheduledMCPIdentity,
  ScheduledMCPTarget,
} from 'librechat-data-provider';
import type {
  MCPConsentStorage,
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

/** What admission checks in its write: no tool in use is marked or pinned to another digest. */
export function admitsDefinitions(
  enrollment: MCPGrantEnrollment<MCPGrantIdentity> | null | undefined,
  consentId: string,
  definitions: Readonly<Record<string, string>> = {},
): boolean {
  const consent = enrollment?.consents.find((item) => item.id === consentId);
  return Object.entries(definitions).every(
    ([tool, digest]) =>
      !consent?.changedTools?.includes(tool) &&
      !consent?.definitions?.some((pin) => pin.tool === tool && pin.digest !== digest),
  );
}

/** What a confirmation checks in its write: no pin or mark was added to the grant it read. */
export function untouchedSince(
  enrollment: MCPGrantEnrollment<MCPGrantIdentity> | null | undefined,
  basis: MCPGrantEnrollment<MCPGrantIdentity> | null | undefined,
): boolean {
  return (basis?.consents ?? []).every((seen) => {
    const stored = enrollment?.consents.find((item) => item.id === seen.id);
    return (
      stored != null &&
      (stored.definitions?.length ?? 0) === (seen.definitions?.length ?? 0) &&
      (stored.changedTools?.length ?? 0) === (seen.changedTools?.length ?? 0)
    );
  });
}

/** The two pin writes over an enrollment a fake keeps in memory, with the real fences. */
export function pinStorage<Identity extends MCPGrantIdentity = ScheduledMCPIdentity>(
  current: () => MCPGrantEnrollment<Identity> | null | undefined,
): Pick<MCPConsentStorage<Identity>, 'pinScheduleMCPToolDefinition' | 'flagScheduleMCPToolChange'> {
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
  /**
   * `offered` adds tools the agents select; `allow` is what the owner picks (default: `tool`);
   * `ask` are the allowed tools the owner approves call by call; `approvedToolCalls` are the
   * calls the owner approved in the request that resumed the run. `tools` are the agents' tools
   * that are not MCP tools, and `allowTools` the ones of those the owner picks (default: none).
   * `coversTools: false` is a grant that limits MCP tools only, as an API key's does.
   * `everything` is a grant of the whole agent, with nothing chosen one by one.
   * `detaches: false` is a grant whose completion turns cannot find it again, as a key's.
   */
  choice: {
    offered?: string[];
    allow?: string[];
    ask?: string[];
    approvedToolCalls?: string[];
    tools?: string[];
    allowTools?: string[];
    coversTools?: boolean;
    everything?: boolean;
    detaches?: boolean;
  } = {},
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
      if (snapshot.enrollment) snapshot.enrollment.revokedAtMs = time;
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
        ) &&
        admitsDefinitions(snapshot.enrollment, input.consentId, input.definitions),
    ),
    ...pinStorage(() => snapshot.enrollment),
  };
  const service = createScheduleMCPConsentService({
    storage,
    resolveEnrollment,
    resolveTools: async () =>
      choice.tools?.length
        ? ['child', 'root'].map((agentId) => ({ agentId, tools: [...choice.tools!].sort() }))
        : [],
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => allowed,
    canPause: async () => true,
    now: () => time,
  });
  const offer = await service.view(identity);
  await service.confirm(identity, {
    offerDigest: offer.offer!.digest,
    expectedRevision: null,
    lifetimeHours: 1,
    allow: choice.everything ? {} : { warehouse: choice.allow ?? [tool.name] },
    ...(choice.ask && { ask: { warehouse: choice.ask } }),
    ...(choice.allowTools && { tools: choice.allowTools }),
    ...(choice.everything && { everything: true as const }),
  });
  const loadAuthorization = jest.fn(async () => ({ authority: service.authority }));
  const factory = createScheduleMCPExecution({
    storage,
    loadAuthorization,
    coversTools: choice.coversTools ?? true,
    detaches: choice.detaches ?? true,
    now: () => time,
  });
  const execution = (await factory.resolve(identity, stage, {
    approvedToolCalls: choice.approvedToolCalls,
  }))!;
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
