import {
  EModelEndpoint,
  isAgentsEndpoint,
  parseCompactConvo,
  isAssistantsEndpoint,
  resolveModelCatalogKey,
  getDefaultParamsEndpoint,
} from 'librechat-data-provider';
import type {
  Agent,
  TModelSpec,
  TSpecsConfig,
  TModelsConfig,
  EModelEndpoint as EModelEndpointType,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { LoadAgentDeps, LoadAgentParams } from '../load';
import { applyModelSpecPreset, excludeHiddenModelSpecs } from '~/modelSpecs';
import { loadEphemeralAgent } from '../load';

/**
 * Personal API keys reach agents through the OpenAI-compatible remote API. A key
 * can also name a model its owner can use in the chat UI (on by default; set
 * `endpoints.agents.remoteApi.models.enabled: false` to keep keys agent-only):
 *
 * - a model spec, by its `name`, exactly as the model selector offers it;
 * - `endpoint/model` (e.g. `openAI/gpt-4o`), when `modelSpecs.enforce` is off and
 *   model selection is enabled, for a model the owner's models config lists.
 *
 * Either runs as the same ephemeral agent the chat UI builds for that selection,
 * so the spec's preset, tools and enforcement apply unchanged. Saved agents keep
 * precedence: these are only consulted when no agent has the requested id.
 */

/** Separates the endpoint from the model in `endpoint/model`; models may contain it. */
export const REMOTE_MODEL_SEPARATOR = '/';
const MAX_REMOTE_MODEL_ID_LENGTH = 512;

export type RemoteModelTarget =
  | {
      kind: 'model_spec';
      id: string;
      endpoint: string;
      endpointType?: string;
      spec: TModelSpec;
    }
  | {
      kind: 'endpoint_model';
      id: string;
      endpoint: string;
      endpointType?: string;
      model: string;
    };

export interface RemoteModelContext {
  appConfig?: AppConfig;
  /** The requesting user's endpoints config (`getEndpointsConfig(req)`). */
  endpointsConfig?: TEndpointsConfig | null;
  /**
   * The requesting user's models, keyed by endpoint as `getEndpointModelsConfig`
   * returns them. Only the endpoints a request needs have to be present; an
   * endpoint without an entry offers no models.
   */
  modelsConfig?: TModelsConfig | null;
}

/** On unless the admin sets `endpoints.agents.remoteApi.models.enabled: false`. */
export function isRemoteModelAccessEnabled(appConfig?: AppConfig): boolean {
  return appConfig?.endpoints?.[EModelEndpoint.agents]?.remoteApi?.models?.enabled !== false;
}

/** True when the endpoint runs on credentials the user supplies (`userProvide`, Bedrock's `userProvide*`). */
function usesUserCredentials(config: object): boolean {
  return Object.entries(config).some(
    ([key, value]) => key.startsWith('userProvide') && value === true,
  );
}

/** Endpoints a remote call may run as an ephemeral agent: configured for the user, not agents or
 *  assistants, and not running on credentials the user supplies. */
function isRunnableEndpoint(endpoint: string, endpointsConfig?: TEndpointsConfig | null): boolean {
  if (!endpoint || isAgentsEndpoint(endpoint) || isAssistantsEndpoint(endpoint)) {
    return false;
  }
  const config = endpointsConfig?.[endpoint];
  return config != null && !usesUserCredentials(config);
}

function endpointTypeOf(
  endpoint: string,
  endpointsConfig?: TEndpointsConfig | null,
): string | undefined {
  const type = endpointsConfig?.[endpoint]?.type;
  return type ? String(type) : undefined;
}

/** The configured specs; the loaded app config types list entries loosely. */
function specsConfig(appConfig?: AppConfig): Partial<TSpecsConfig> | undefined {
  return appConfig?.modelSpecs as Partial<TSpecsConfig> | undefined;
}

function endpointModels(endpoint: string, ctx: RemoteModelContext): string[] {
  const models = ctx.modelsConfig;
  if (!models) {
    return [];
  }
  const list = models[resolveModelCatalogKey(endpoint, models)];
  return Array.isArray(list)
    ? list.filter((m): m is string => typeof m === 'string' && m !== '')
    : [];
}

/** A spec's endpoint when it could run for this user, before its model is checked. */
function runnableSpecEndpoint(spec: TModelSpec, ctx: RemoteModelContext): string | null {
  const endpoint = spec?.preset?.endpoint;
  if (typeof spec?.name !== 'string' || spec.name === '' || typeof endpoint !== 'string') {
    return null;
  }
  return isRunnableEndpoint(endpoint, ctx.endpointsConfig) ? endpoint : null;
}

/** A spec target, only when the spec's model is in the user's models for its endpoint: the
 *  same allow-list `validateAgentModel` applies to the chat UI's ephemeral agents. */
function specTarget(spec: TModelSpec, ctx: RemoteModelContext): RemoteModelTarget | null {
  const endpoint = runnableSpecEndpoint(spec, ctx);
  const model = spec?.preset?.model;
  if (!endpoint || typeof model !== 'string' || !endpointModels(endpoint, ctx).includes(model)) {
    return null;
  }
  return {
    kind: 'model_spec',
    id: spec.name,
    endpoint,
    endpointType: endpointTypeOf(endpoint, ctx.endpointsConfig),
    spec,
  };
}

/**
 * The endpoints whose models a user may pick freely, as the chat's model selector
 * offers them: none when specs are enforced or model selection is off; only
 * `modelSpecs.addedEndpoints` when that list is set; otherwise every runnable endpoint.
 */
function freeChoiceEndpoints(ctx: RemoteModelContext): string[] {
  const appConfig = ctx.appConfig;
  if (
    appConfig?.modelSpecs?.enforce === true ||
    appConfig?.interfaceConfig?.modelSelect === false
  ) {
    return [];
  }
  const added = specsConfig(appConfig)?.addedEndpoints;
  const candidates =
    Array.isArray(added) && added.length > 0
      ? added.map(String)
      : Object.keys(ctx.endpointsConfig ?? {});
  return candidates.filter((endpoint) => isRunnableEndpoint(endpoint, ctx.endpointsConfig));
}

/** Splits `endpoint/model` at the first separator; null when either side is empty. */
function splitEndpointModel(model: string): { endpoint: string; name: string } | null {
  const at = model.indexOf(REMOTE_MODEL_SEPARATOR);
  if (at <= 0 || at === model.length - 1) {
    return null;
  }
  return { endpoint: model.slice(0, at), name: model.slice(at + 1) };
}

function isModelId(model: unknown): model is string {
  return typeof model === 'string' && model !== '' && model.length <= MAX_REMOTE_MODEL_ID_LENGTH;
}

/**
 * The endpoints whose models must be loaded to answer for `model` (or, with no
 * model, to list everything). Lets a host load only those endpoints' models.
 */
export function remoteModelEndpoints(model: unknown, ctx: RemoteModelContext): string[] {
  if (!isRemoteModelAccessEnabled(ctx.appConfig)) {
    return [];
  }
  const specs = specsConfig(ctx.appConfig)?.list ?? [];
  if (model === undefined) {
    const visible: TModelSpec[] = excludeHiddenModelSpecs(specsConfig(ctx.appConfig))?.list ?? [];
    const fromSpecs = visible.map((spec) => runnableSpecEndpoint(spec, ctx));
    return [...new Set([...fromSpecs, ...freeChoiceEndpoints(ctx)])].filter(
      (endpoint): endpoint is string => endpoint != null,
    );
  }
  if (!isModelId(model)) {
    return [];
  }
  const spec = specs.find((s) => s?.name === model);
  if (spec) {
    const endpoint = runnableSpecEndpoint(spec, ctx);
    return endpoint ? [endpoint] : [];
  }
  const parts = splitEndpointModel(model);
  return parts && freeChoiceEndpoints(ctx).includes(parts.endpoint) ? [parts.endpoint] : [];
}

/**
 * The models a key's owner may call, in the order the model selector shows them:
 * model specs first (hidden `showInMenu: false` specs are omitted, as in
 * `/api/config`), then `endpoint/model` pairs where model selection is open.
 */
export function listRemoteModels(ctx: RemoteModelContext): RemoteModelTarget[] {
  if (!isRemoteModelAccessEnabled(ctx.appConfig)) {
    return [];
  }
  const targets: RemoteModelTarget[] = [];
  const seen = new Set<string>();
  /** Resolution runs the first spec with a name, so list exactly that one: a name
   *  whose first spec is hidden is not listed, even if a later spec is visible. */
  for (const spec of specsConfig(ctx.appConfig)?.list ?? []) {
    if (typeof spec?.name !== 'string' || seen.has(spec.name)) {
      continue;
    }
    seen.add(spec.name);
    const target = spec.showInMenu === false ? null : specTarget(spec, ctx);
    if (target) {
      targets.push(target);
    }
  }
  /** Resolution tries specs first, so an `endpoint/model` id that any spec (hidden
   *  or not) is named after would run that spec: leave it out rather than mislead. */
  const specNames = new Set((specsConfig(ctx.appConfig)?.list ?? []).map((s) => s?.name));
  for (const endpoint of freeChoiceEndpoints(ctx)) {
    const endpointType = endpointTypeOf(endpoint, ctx.endpointsConfig);
    for (const model of endpointModels(endpoint, ctx)) {
      const id = `${endpoint}${REMOTE_MODEL_SEPARATOR}${model}`;
      if (!seen.has(id) && !specNames.has(id)) {
        seen.add(id);
        targets.push({ kind: 'endpoint_model', id, endpoint, endpointType, model });
      }
    }
  }
  return targets;
}

/**
 * Resolves a requested `model` to something the key's owner may call, or null.
 * A spec resolves by exact name, including a hidden one (the chat UI also
 * accepts those by name); `endpoint/model` must be one the owner's config lists.
 */
export function resolveRemoteModel(
  model: unknown,
  ctx: RemoteModelContext,
): RemoteModelTarget | null {
  if (!isRemoteModelAccessEnabled(ctx.appConfig) || !isModelId(model)) {
    return null;
  }
  const spec = specsConfig(ctx.appConfig)?.list?.find((s) => s?.name === model);
  if (spec) {
    return specTarget(spec, ctx);
  }
  const parts = splitEndpointModel(model);
  if (!parts || !freeChoiceEndpoints(ctx).includes(parts.endpoint)) {
    return null;
  }
  if (!endpointModels(parts.endpoint, ctx).includes(parts.name)) {
    return null;
  }
  return {
    kind: 'endpoint_model',
    id: model,
    endpoint: parts.endpoint,
    endpointType: endpointTypeOf(parts.endpoint, ctx.endpointsConfig),
    model: parts.name,
  };
}

/** How a stored conversation records a model run: like the chat's own model
 *  conversations (endpoint, model, spec), not under an agent id. */
export interface RemoteModelConversation {
  endpoint: string;
  endpointType?: string;
  model?: string;
  spec?: string;
}

export function toRemoteModelConversation(target: RemoteModelTarget): RemoteModelConversation {
  return {
    endpoint: target.endpoint,
    ...(target.endpointType != null && { endpointType: target.endpointType }),
    ...(target.kind === 'model_spec'
      ? { spec: target.spec.name, model: target.spec.preset?.model ?? undefined }
      : { model: target.model }),
  };
}

/**
 * Under `modelSpecs.enforce`, a spec run may continue only a conversation recorded
 * under that same spec, so stored system turns from another target (an agent's
 * instructions, say) cannot be replayed into it. Other targets continue freely.
 */
export function isRemoteModelContinuationAllowed(
  target: RemoteModelTarget,
  conversation: { spec?: string | null } | null | undefined,
  appConfig?: AppConfig,
): boolean {
  if (!conversation || target.kind !== 'model_spec' || appConfig?.modelSpecs?.enforce !== true) {
    return true;
  }
  return conversation.spec === target.spec.name;
}

/** Whether `/v1/models` lists the target (hidden specs resolve by name but are not advertised). */
export function isListedRemoteModel(target: RemoteModelTarget): boolean {
  return target.kind !== 'model_spec' || target.spec.showInMenu !== false;
}

/**
 * Request fields that would let a caller widen what a model run may use. The run
 * takes its tools, MCP servers and skills from the spec alone, so these are
 * removed once `model` resolves to a remote model.
 */
const CALLER_TOGGLE_FIELDS = ['ephemeralAgent', 'manualSkills'] as const;

export function stripCallerToggles(body: unknown): void {
  if (!body || typeof body !== 'object') {
    return;
  }
  for (const field of CALLER_TOGGLE_FIELDS) {
    delete (body as Record<string, unknown>)[field];
  }
}

export interface BuildRemoteModelAgentParams {
  /** Only identity and config are read; the API request body is deliberately not
   *  passed through, so a caller can't toggle tools or MCP servers per request. */
  req: { user?: LoadAgentParams['req']['user']; config?: AppConfig };
  target: RemoteModelTarget;
  endpointsConfig?: TEndpointsConfig | null;
}

/**
 * Builds the ephemeral agent the chat UI would run for this selection: the
 * conversation is parsed for its endpoint, a spec's preset is applied (with its
 * defaults, as under `modelSpecs.enforce`), and the result goes through
 * `loadEphemeralAgent`.
 */
export async function buildRemoteModelAgent(
  { req, target, endpointsConfig }: BuildRemoteModelAgentParams,
  deps: LoadAgentDeps,
): Promise<Agent | null> {
  const endpoint = target.endpoint as EModelEndpointType;
  const endpointType = target.endpointType as EModelEndpointType | undefined;
  const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, endpoint);
  const conversation =
    target.kind === 'model_spec'
      ? { endpoint, spec: target.spec.name }
      : { endpoint, model: target.model };
  const parsed = parseCompactConvo({ endpoint, endpointType, conversation, defaultParamsEndpoint });
  if (!parsed) {
    return null;
  }
  let parsedBody: Record<string, unknown> = parsed;
  if (target.kind === 'model_spec') {
    parsedBody = applyModelSpecPreset({
      modelSpec: target.spec,
      parsedBody: parsed,
      endpoint,
      endpointType,
      defaultParamsEndpoint,
      includePresetDefaults: true,
    }).parsedBody;
  }
  const {
    spec: _spec,
    iconURL: _iconURL,
    agent_id: _agentId,
    chatProjectId: _chatProjectId,
    ...modelParameters
  } = parsedBody;
  return loadEphemeralAgent(
    {
      req: { user: req.user, config: req.config, body: {} },
      spec: target.kind === 'model_spec' ? target.spec.name : undefined,
      endpoint,
      model_parameters: modelParameters as unknown as LoadAgentParams['model_parameters'],
    },
    deps,
  );
}

export interface RemoteOpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  permission: never[];
  root: string;
  parent: null;
  name: string;
  description: string | null;
  provider: string;
  /** Tells callers this is not an agent, and which kind it is. */
  librechat: { type: RemoteModelTarget['kind'] };
}

/** The `/v1/models` entry for a remote model target. */
export function toOpenAIModel(target: RemoteModelTarget): RemoteOpenAIModel {
  const label = target.kind === 'model_spec' ? target.spec.label || target.spec.name : target.model;
  return {
    id: target.id,
    object: 'model',
    created: 0,
    owned_by: 'librechat',
    permission: [],
    root: target.id,
    parent: null,
    name: label,
    description: target.kind === 'model_spec' ? (target.spec.description ?? null) : null,
    provider: target.endpoint,
    librechat: { type: target.kind },
  };
}

/** What the service reads from a request: who is asking, and their resolved app config. */
export interface RemoteModelRequest {
  user?: LoadAgentParams['req']['user'];
  config?: AppConfig;
}

export interface RemoteModelServiceDeps extends LoadAgentDeps {
  /** The user's endpoints config, as the chat UI receives it. */
  getEndpointsConfig: (req: RemoteModelRequest) => Promise<TEndpointsConfig | null | undefined>;
  /** The user's models for one endpoint, keyed by endpoint (`getEndpointModelsConfig`). */
  getEndpointModels: (
    req: RemoteModelRequest,
    endpoint: string,
  ) => Promise<TModelsConfig | null | undefined>;
  /** Told when model listing degrades to agents only because a catalog failed to load. */
  onListError?: (error: unknown) => void;
}

export interface RemoteModelService {
  /** A model the requester may call, or null (feature off, unknown, or not theirs). */
  resolve: (req: RemoteModelRequest, model: unknown) => Promise<RemoteModelTarget | null>;
  /** The `/v1/models/{model}` entry, or null; hidden specs are not described. */
  describe: (req: RemoteModelRequest, model: unknown) => Promise<RemoteOpenAIModel | null>;
  /** `/v1/models` entries for the models the requester may call. */
  list: (req: RemoteModelRequest) => Promise<RemoteOpenAIModel[]>;
  /** The ephemeral agent that runs `target` for the requester. */
  buildAgent: (req: RemoteModelRequest, target: RemoteModelTarget) => Promise<Agent | null>;
}

interface RequestCache {
  endpoints?: Promise<TEndpointsConfig | null | undefined>;
  models: Map<string, Promise<TModelsConfig | null | undefined>>;
}

/**
 * Binds the remote-model functions to the host's config and agent loaders. Per
 * request object, the endpoints config is read once and each endpoint's models
 * at most once, only for the endpoints the request names, so the access check
 * and the run share reads and an unknown `model` loads no model catalog.
 */
export function createRemoteModelService(deps: RemoteModelServiceDeps): RemoteModelService {
  const caches = new WeakMap<RemoteModelRequest, RequestCache>();

  const cacheFor = (req: RemoteModelRequest): RequestCache => {
    let cache = caches.get(req);
    if (!cache) {
      cache = { models: new Map() };
      caches.set(req, cache);
    }
    return cache;
  };

  const endpointsFor = (req: RemoteModelRequest) => {
    const cache = cacheFor(req);
    cache.endpoints ??= deps.getEndpointsConfig(req);
    return cache.endpoints;
  };

  const modelsFor = async (
    req: RemoteModelRequest,
    endpoints: string[],
  ): Promise<TModelsConfig> => {
    const cache = cacheFor(req);
    const loaded = await Promise.all(
      endpoints.map((endpoint) => {
        let models = cache.models.get(endpoint);
        if (!models) {
          models = deps.getEndpointModels(req, endpoint);
          cache.models.set(endpoint, models);
        }
        return models;
      }),
    );
    return Object.assign({}, ...loaded.map((models) => models ?? {}));
  };

  /** The context needed for `model` (undefined: everything listable), or null when off. */
  const contextFor = async (
    req: RemoteModelRequest,
    model: unknown,
  ): Promise<RemoteModelContext | null> => {
    if (!isRemoteModelAccessEnabled(req.config)) {
      return null;
    }
    const base: RemoteModelContext = {
      appConfig: req.config,
      endpointsConfig: await endpointsFor(req),
    };
    const endpoints = remoteModelEndpoints(model, base);
    return { ...base, modelsConfig: await modelsFor(req, endpoints) };
  };

  const resolve = async (req: RemoteModelRequest, model: unknown) => {
    if (!isModelId(model)) {
      return null;
    }
    const context = await contextFor(req, model);
    return context ? resolveRemoteModel(model, context) : null;
  };

  return {
    resolve,
    async describe(req, model) {
      const target = await resolve(req, model);
      return target && isListedRemoteModel(target) ? toOpenAIModel(target) : null;
    },
    async list(req) {
      try {
        const context = await contextFor(req, undefined);
        return context ? listRemoteModels(context).map(toOpenAIModel) : [];
      } catch (error) {
        deps.onListError?.(error);
        return [];
      }
    },
    async buildAgent(req, target) {
      return buildRemoteModelAgent(
        { req, target, endpointsConfig: (await endpointsFor(req)) ?? null },
        deps,
      );
    },
  };
}
