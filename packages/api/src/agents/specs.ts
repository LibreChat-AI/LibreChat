import { createHash } from 'node:crypto';
import { Constants, EModelEndpoint, tModelSpecSchema } from 'librechat-data-provider';
import type {
  Agent,
  GraphEdge,
  TModelSpec,
  DeepPartial,
  ModelSpecHandoffTarget,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { getCustomEndpointConfig } from '../app/config';
import { applyModelSpecPreset } from '../modelSpecs';
import { collectEdgeAgentIds } from './edges';
import { loadEphemeralAgent } from './load';

const PREFIX = Constants.MODEL_SPEC_AGENT_PREFIX;

/** Stable graph identity, independent of the preset's current provider or model. */
export function modelSpecAgentId(name: string): string {
  return PREFIX + createHash('sha256').update(name).digest('hex').slice(0, 32);
}

export function isModelSpecAgentId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** Only explicitly enabled, concrete provider presets can be handoff targets. */
export function getHandoffModelSpec(
  id: string,
  specs?: DeepPartial<TModelSpec>[],
): TModelSpec | undefined {
  const candidate = specs?.find(
    (spec) => typeof spec.name === 'string' && modelSpecAgentId(spec.name) === id,
  );
  if (candidate?.handoff !== true) return undefined;
  const parsed = tModelSpecSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const spec = parsed.data;
  const { endpoint, model, agent_id } = spec.preset;
  if (
    !endpoint ||
    !model ||
    agent_id ||
    endpoint === EModelEndpoint.agents ||
    endpoint === EModelEndpoint.assistants ||
    endpoint === EModelEndpoint.azureAssistants
  )
    return undefined;
  return spec;
}

/** Intentionally excludes private instructions, credentials, and tool configuration. */
export function getModelSpecHandoffTargets(
  specs?: DeepPartial<TModelSpec>[],
): ModelSpecHandoffTarget[] {
  const targets: ModelSpecHandoffTarget[] = [];
  for (const candidate of specs ?? []) {
    if (!candidate.name) continue;
    const id = modelSpecAgentId(candidate.name);
    const spec = getHandoffModelSpec(id, [candidate]);
    if (!spec) continue;
    targets.push({
      id,
      name: spec.label || spec.name,
      provider: spec.preset.endpoint ?? '',
      model: spec.preset.model ?? null,
      avatar: spec.iconURL ? { filepath: spec.iconURL, source: 'local' } : null,
    });
  }
  return targets;
}

export function listModelSpecHandoffs(req: ServerRequest, res: Response): void {
  res.json(getModelSpecHandoffTargets(req.config?.modelSpecs?.list));
}

type ReferenceResult = { missing: string[]; unauthorized: string[] };

/** Config references are checked against the caller's effective config on every save. */
export async function validateHandoffReferences({
  edges,
  specs,
  allowedMissingIds,
  classifySavedReferences,
}: {
  edges: GraphEdge[];
  specs?: DeepPartial<TModelSpec>[];
  allowedMissingIds: Set<string>;
  classifySavedReferences: (ids: string[]) => Promise<ReferenceResult>;
}): Promise<ReferenceResult> {
  const saved: string[] = [];
  const missing: string[] = [];
  for (const id of collectEdgeAgentIds(edges)) {
    if (!isModelSpecAgentId(id)) {
      saved.push(id);
      continue;
    }
    const invalidEdge = edges.some((edge) => {
      const ids = collectEdgeAgentIds([edge]);
      return ids.has(id) && (edge.edgeType === 'direct' || Array.isArray(edge.to));
    });
    if (invalidEdge || !getHandoffModelSpec(id, specs)) missing.push(id);
  }
  const result = await classifySavedReferences(saved);
  return {
    missing: [...missing, ...result.missing.filter((id) => !allowedMissingIds.has(id))],
    unauthorized: result.unauthorized,
  };
}

/** Builds a fresh target from server config; never inherits the primary's toggles or prompt. */
export async function loadModelSpecHandoff(
  id: string,
  req: Pick<ServerRequest, 'config'> & { user?: { id?: string; name?: string; role?: string } },
): Promise<Agent | null> {
  const spec = getHandoffModelSpec(id, req.config?.modelSpecs?.list);
  if (!spec) return null;
  const endpoint = spec.preset.endpoint ?? '';
  const customConfig = getCustomEndpointConfig({ endpoint, appConfig: req.config });
  const { parsedBody } = applyModelSpecPreset({
    modelSpec: spec,
    parsedBody: {},
    endpoint,
    endpointType: EModelEndpoint.custom,
    defaultParamsEndpoint: customConfig?.customParams?.defaultParamsEndpoint,
    includePresetDefaults: true,
  });
  const agent = await loadEphemeralAgent(
    {
      req: { user: req.user, config: req.config, body: {} },
      spec: spec.name,
      endpoint,
      model_parameters: parsedBody as Agent['model_parameters'],
    },
    { getAgent: async () => null, getMCPServerTools: async () => null },
  );
  if (!agent) return null;
  agent.id = id;
  agent.name = spec.label || spec.name;
  // A target without a skills setting must not inherit the primary's skills badge.
  agent.skills_enabled ??= false;
  if (Array.isArray(spec.skills) && spec.skills.length > 0) delete agent.skills;
  return agent;
}
