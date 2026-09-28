import { createHash } from 'node:crypto';
import {
  AGENT_EVENT_ACTOR_SUMMARY_VERSION,
  MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS,
  MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH,
  MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH,
} from '@librechat/data-schemas';
import type { IAgentEventActorSummary } from '@librechat/data-schemas';

export const AGENT_CONTEXT_FINGERPRINT_VERSION = 1;
export const AGENT_GRAPH_SCHEMA_VERSION = 1;
export const AGENT_CHECKPOINT_FORMAT_VERSION = 1;

export interface AgentContextFingerprint {
  algorithm: 'sha256';
  version: number;
  digest: string;
}

export interface AgentContextSkillIdentity {
  id: string;
  name: string;
  version: number;
  contentDigest?: string;
}

export interface AgentContextMemorySnapshot {
  scope: string;
  withKeys?: string;
  withoutKeys?: string;
}

export interface AgentContextDefinition {
  id: string;
  version?: number | string;
  provider?: string;
  model?: string;
  instructions?: string;
  additionalInstructions?: string;
  modelParameters?: object;
  toolDefinitions?: readonly object[];
  toolRegistryDefinitions?: readonly object[];
  toolOptions?: object;
  execution?: object;
  skills?: readonly AgentContextSkillIdentity[];
}

export interface AgentTurnSemanticContext {
  agents: readonly AgentContextDefinition[];
  approvalPolicy?: object;
  retainedAnswers?: { enabled: boolean; maxTokens: number };
  memory?: readonly AgentContextMemorySnapshot[];
  checkpointerType?: string;
  discoveredToolNames?: readonly string[];
  checkpointFormatVersion?: number;
  graphSchemaVersion?: number;
}

export interface InitializedAgentContextSource {
  id: string;
  version?: number | string;
  provider?: string;
  model?: string;
  instructions?: string;
  additional_instructions?: string;
  model_parameters?: object;
  toolDefinitions?: readonly object[];
  toolRegistryDefinitions?: readonly object[];
  tool_options?: object;
  execution?: object;
  manualSkillPrimes?: readonly {
    _id: { toString(): string } | string;
    name: string;
    version?: number;
    body?: string;
  }[];
  alwaysApplySkillPrimes?: readonly {
    _id: { toString(): string } | string;
    name: string;
    version?: number;
    body?: string;
  }[];
}

export const MAX_AGENT_CONTEXT_SKILLS = 64;

export function normalizeAgentEventActorDiscoveredTools(
  names: readonly string[] | undefined,
): string[] {
  if (names == null) {
    return [];
  }
  const normalized = new Set<string>();
  for (const name of names) {
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH
    ) {
      throw new RangeError('Event actor discovered-tool state is invalid');
    }
    normalized.add(name);
  }
  if (normalized.size > MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS) {
    throw new RangeError(
      `Event actor discovered-tool state exceeds ${MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS}`,
    );
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * The summary a run records as event-actor state, stamped with the provenance
 * version. The version records the writer, not a judgement about this summary:
 * a build that reaches here has already filtered unusable summaries out of
 * every source it reads — the turn's own content parts, a validated restore,
 * or the formatter over the stripped payload. Stamping at the point state is
 * assembled is what keeps an inherited `{ text, tokenCount }` from the SDK
 * from being refused by the next event and forcing a cold reload.
 */
export function createAgentEventActorSummary(
  summary: { text: string; tokenCount: number } | null | undefined,
): IAgentEventActorSummary | undefined {
  if (summary == null) {
    return undefined;
  }
  return {
    text: summary.text,
    tokenCount: summary.tokenCount,
    version: AGENT_EVENT_ACTOR_SUMMARY_VERSION,
  };
}

/**
 * A stored event-actor summary a warm continuation may carry forward. Throws
 * for anything it cannot vouch for, including a state written before the
 * version existed: those kept only `{ text, tokenCount }`, so a round that
 * failed or never finished reads exactly like a checkpoint, and a warm run
 * would continue from a truncated prefix. Refusing one costs a cold
 * continuation, which rebuilds context from durable history.
 */
export function normalizeAgentEventActorSummary(
  summary: IAgentEventActorSummary | null | undefined,
): IAgentEventActorSummary | undefined {
  if (summary == null) {
    return undefined;
  }
  if (
    typeof summary.text !== 'string' ||
    summary.text.length === 0 ||
    summary.text.length > MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH ||
    !Number.isFinite(summary.tokenCount) ||
    summary.tokenCount < 0 ||
    summary.version !== AGENT_EVENT_ACTOR_SUMMARY_VERSION
  ) {
    throw new RangeError('Event actor summary state is invalid');
  }
  return createAgentEventActorSummary(summary);
}

export function createSkillContentDigest(body: string): string {
  return createHash('sha256').update(body).digest('base64url');
}

const CREDENTIAL_KEY_PATTERN =
  /^(?:authorization|password|secret)$|(?:^|[-_])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)$/i;

const REDACTED_CREDENTIAL = '[credential]';

function redactModelParameterCredentials(value: object | undefined): object | undefined {
  if (value == null) {
    return undefined;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      redacted[key] = REDACTED_CREDENTIAL;
      continue;
    }
    if (key.toLowerCase() === 'headers' && item != null && typeof item === 'object') {
      redacted[key] = Object.fromEntries(
        Object.entries(item).map(([header, headerValue]) => [
          header,
          CREDENTIAL_KEY_PATTERN.test(header) ? REDACTED_CREDENTIAL : headerValue,
        ]),
      );
      continue;
    }
    redacted[key] = item;
  }
  return redacted;
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, seen)).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  if (seen.has(value)) {
    throw new TypeError('Agent semantic context cannot contain circular references');
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = canonicalize(record[key], seen);
    if (item !== undefined) {
      normalized[key] = item;
    }
  }
  seen.delete(value);
  return normalized;
}

function sortSkillIdentities(
  skills: readonly AgentContextSkillIdentity[] | undefined,
): AgentContextSkillIdentity[] | undefined {
  if (skills == null) {
    return undefined;
  }
  const unique = new Map<string, AgentContextSkillIdentity>();
  for (const skill of skills) {
    unique.set(skill.id, skill);
  }
  if (unique.size > MAX_AGENT_CONTEXT_SKILLS) {
    throw new RangeError(`Agent context exceeds ${MAX_AGENT_CONTEXT_SKILLS} Skills`);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.name.localeCompare(right.name) ||
      left.version - right.version,
  );
}

/** Hashes only semantic, model-bound context; request and delivery metadata never enter this module. */
export function createAgentContextFingerprint(
  input: AgentTurnSemanticContext,
): AgentContextFingerprint {
  const semanticContext = {
    version: AGENT_CONTEXT_FINGERPRINT_VERSION,
    graphSchemaVersion: input.graphSchemaVersion ?? AGENT_GRAPH_SCHEMA_VERSION,
    checkpointFormatVersion: input.checkpointFormatVersion ?? AGENT_CHECKPOINT_FORMAT_VERSION,
    checkpointerType: input.checkpointerType,
    discoveredToolNames: normalizeAgentEventActorDiscoveredTools(input.discoveredToolNames),
    approvalPolicy: input.approvalPolicy,
    retainedAnswers: input.retainedAnswers,
    agents: input.agents.map((agent) => ({
      ...agent,
      modelParameters: redactModelParameterCredentials(agent.modelParameters),
      skills: sortSkillIdentities(agent.skills),
    })),
    memory:
      input.memory == null
        ? undefined
        : [...input.memory].sort((left, right) => left.scope.localeCompare(right.scope)),
  };
  const canonical = JSON.stringify(canonicalize(semanticContext, new WeakSet()));
  return Object.freeze({
    algorithm: 'sha256' as const,
    version: AGENT_CONTEXT_FINGERPRINT_VERSION,
    digest: createHash('sha256').update(canonical).digest('base64url'),
  });
}

export function agentContextFingerprintsMatch(
  stored: AgentContextFingerprint | undefined,
  current: AgentContextFingerprint,
): boolean {
  return (
    stored?.algorithm === current.algorithm &&
    stored.version === current.version &&
    stored.digest === current.digest
  );
}

function skillIdentities(agent: InitializedAgentContextSource): AgentContextSkillIdentity[] {
  const skills = [...(agent.manualSkillPrimes ?? []), ...(agent.alwaysApplySkillPrimes ?? [])];
  const unique = new Map<string, AgentContextSkillIdentity>();
  for (const skill of skills) {
    const id = skill._id.toString();
    unique.set(id, {
      id,
      name: skill.name,
      version: skill.version ?? 0,
      ...(skill.body == null ? {} : { contentDigest: createSkillContentDigest(skill.body) }),
    });
  }
  return [...unique.values()];
}

/** Projects initialized runtime facts into the single semantic compatibility module. */
export function createInitializedAgentContextFingerprint(input: {
  agents: readonly InitializedAgentContextSource[];
  invokedSkills?: readonly AgentContextSkillIdentity[];
  approvalPolicy?: object;
  retainedAnswers?: { enabled: boolean; maxTokens: number };
  memory?: readonly AgentContextMemorySnapshot[];
  checkpointerType?: string;
  discoveredToolNames?: readonly string[];
}): AgentContextFingerprint {
  return createAgentContextFingerprint({
    checkpointerType: input.checkpointerType,
    approvalPolicy: input.approvalPolicy,
    retainedAnswers: input.retainedAnswers,
    memory: input.memory,
    discoveredToolNames: input.discoveredToolNames,
    agents: input.agents.map((agent, index) => ({
      id: agent.id,
      version: agent.version,
      provider: agent.provider,
      model: agent.model,
      instructions: agent.instructions,
      additionalInstructions: agent.additional_instructions,
      modelParameters: agent.model_parameters,
      toolDefinitions: agent.toolDefinitions,
      toolRegistryDefinitions: agent.toolRegistryDefinitions,
      toolOptions: agent.tool_options,
      execution: agent.execution,
      skills:
        index === 0
          ? [...skillIdentities(agent), ...(input.invokedSkills ?? [])]
          : skillIdentities(agent),
    })),
  });
}
