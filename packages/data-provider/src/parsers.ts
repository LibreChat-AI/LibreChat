import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';
import type { ZodIssue } from 'zod';
import type * as a from './types/content';
import type * as s from './schemas';
import type * as t from './types';
import {
  openAISchema,
  openRouterSchema,
  googleSchema,
  EModelEndpoint,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  Providers,
  anthropicSchema,
  assistantSchema,
  // agentsSchema,
  compactAgentsSchema,
  compactGoogleSchema,
  compactAssistantSchema,
} from './schemas';
import { bedrockInputSchema } from './bedrock';
import { ContentTypes } from './types/runs';
import { alternateName } from './config';

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

type EndpointSchema =
  | typeof openAISchema
  | typeof openRouterSchema
  | typeof googleSchema
  | typeof anthropicSchema
  | typeof assistantSchema
  | typeof compactAgentsSchema
  | typeof bedrockInputSchema;

export type EndpointSchemaKey = EModelEndpoint;
type EndpointSchemaLookupKey = EModelEndpoint | Providers.OPENROUTER;

const endpointSchemas: Record<EndpointSchemaLookupKey, EndpointSchema> = {
  [EModelEndpoint.openAI]: openAISchema,
  [EModelEndpoint.azureOpenAI]: openAISchema,
  [EModelEndpoint.custom]: openAISchema,
  [Providers.OPENROUTER]: openRouterSchema,
  [EModelEndpoint.google]: googleSchema,
  [EModelEndpoint.anthropic]: anthropicSchema,
  [EModelEndpoint.assistants]: assistantSchema,
  [EModelEndpoint.azureAssistants]: assistantSchema,
  [EModelEndpoint.agents]: compactAgentsSchema,
  [EModelEndpoint.bedrock]: bedrockInputSchema,
};

const isEndpointSchemaLookupKey = (value?: string | null): value is EndpointSchemaLookupKey =>
  value != null && Object.prototype.hasOwnProperty.call(endpointSchemas, value);

const getFallbackEndpointSchema = <TSchema>(
  schemas: Record<EndpointSchemaLookupKey, TSchema>,
  endpointType?: EndpointSchemaKey | null,
  defaultParamsEndpoint?: string | null,
): TSchema | undefined => {
  if (!endpointType) {
    return undefined;
  }

  const overrideSchema = isEndpointSchemaLookupKey(defaultParamsEndpoint)
    ? schemas[defaultParamsEndpoint]
    : undefined;
  return overrideSchema ?? schemas[endpointType];
};

// const schemaCreators: Record<EModelEndpoint, (customSchema: DefaultSchemaValues) => EndpointSchema> = {
//   [EModelEndpoint.google]: createGoogleSchema,
// };

/** Get the enabled endpoints from the `ENDPOINTS` environment variable */
export function getEnabledEndpoints() {
  const defaultEndpoints: string[] = [
    EModelEndpoint.openAI,
    EModelEndpoint.agents,
    EModelEndpoint.assistants,
    EModelEndpoint.azureAssistants,
    EModelEndpoint.azureOpenAI,
    EModelEndpoint.google,
    EModelEndpoint.anthropic,
    EModelEndpoint.bedrock,
  ];

  const endpointsEnv = process.env.ENDPOINTS ?? '';
  let enabledEndpoints = defaultEndpoints;
  if (endpointsEnv) {
    enabledEndpoints = endpointsEnv
      .split(',')
      .filter((endpoint) => endpoint.trim())
      .map((endpoint) => endpoint.trim());
  }
  return enabledEndpoints;
}

/** Orders an existing EndpointsConfig object based on enabled endpoint/custom ordering */
export function orderEndpointsConfig(endpointsConfig: t.TEndpointsConfig) {
  if (!endpointsConfig) {
    return {};
  }
  const enabledEndpoints = getEnabledEndpoints();
  const endpointKeys = Object.keys(endpointsConfig);
  const defaultCustomIndex = enabledEndpoints.indexOf(EModelEndpoint.custom);
  return endpointKeys.reduce(
    (accumulatedConfig: Record<string, t.TConfig | null | undefined>, currentEndpointKey) => {
      const isCustom = !(currentEndpointKey in EModelEndpoint);
      const isEnabled = enabledEndpoints.includes(currentEndpointKey);
      if (!isEnabled && !isCustom) {
        return accumulatedConfig;
      }

      const index = enabledEndpoints.indexOf(currentEndpointKey);

      if (isCustom) {
        accumulatedConfig[currentEndpointKey] = {
          order: defaultCustomIndex >= 0 ? defaultCustomIndex : 9999,
          ...(endpointsConfig[currentEndpointKey] as Omit<t.TConfig, 'order'> & { order?: number }),
        };
      } else if (endpointsConfig[currentEndpointKey]) {
        accumulatedConfig[currentEndpointKey] = {
          ...endpointsConfig[currentEndpointKey],
          order: index,
        };
      }
      return accumulatedConfig;
    },
    {},
  );
}

/** Converts an array of Zod issues into a string. */
export function errorsToString(errors: ZodIssue[]) {
  return errors
    .map((error) => {
      const field = error.path.join('.');
      const message = error.message;

      return `${field}: ${message}`;
    })
    .join(' ');
}

export function getFirstDefinedValue(possibleValues: string[]) {
  let returnValue;
  for (const value of possibleValues) {
    if (value) {
      returnValue = value;
      break;
    }
  }
  return returnValue;
}

export function getNonEmptyValue(possibleValues: string[]) {
  for (const value of possibleValues) {
    if (value && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

export type TPossibleValues = {
  models: string[];
};

export const parseConvo = ({
  endpoint,
  endpointType,
  conversation,
  possibleValues,
  defaultParamsEndpoint,
}: {
  endpoint: EndpointSchemaKey;
  endpointType?: EndpointSchemaKey | null;
  conversation: Partial<s.TConversation | s.TPreset> | null;
  possibleValues?: TPossibleValues;
  defaultParamsEndpoint?: string | null;
}) => {
  const primarySchema = endpointSchemas[endpoint] as EndpointSchema | undefined;

  if (!primarySchema && !endpointType) {
    throw new Error(`Unknown endpoint: ${endpoint}`);
  }

  const schema =
    primarySchema ??
    getFallbackEndpointSchema(endpointSchemas, endpointType, defaultParamsEndpoint);
  const convo = schema?.parse(conversation) as s.TConversation | undefined;
  const { models } = possibleValues ?? {};

  if (models && convo) {
    convo.model = getFirstDefinedValue(models) ?? convo.model;
  }

  return convo;
};

/** Match GPT followed by digit, optional decimal, and optional suffix
 *
 * Examples: gpt-4, gpt-4o, gpt-4.5, gpt-5a, etc. */
const extractGPTVersion = (modelStr: string): string => {
  const gptMatch = modelStr.match(/gpt-(\d+(?:\.\d+)?)([a-z])?/i);
  if (gptMatch) {
    const version = gptMatch[1];
    const suffix = gptMatch[2] || '';
    return `GPT-${version}${suffix}`;
  }
  return '';
};

/** Match omni models (o1, o3, etc.), "o" followed by a digit, possibly with decimal */
const extractOmniVersion = (modelStr: string): string => {
  const omniMatch = modelStr.match(/\bo(\d+(?:\.\d+)?)\b/i);
  if (omniMatch) {
    const version = omniMatch[1];
    return `o${version}`;
  }
  return '';
};

export const getResponseSender = (endpointOption: Partial<t.TEndpointOption>): string => {
  const {
    model: _m,
    endpoint: _e,
    endpointType,
    modelDisplayLabel: _mdl,
    chatGptLabel: _cgl,
    modelLabel: _ml,
  } = endpointOption;

  const endpoint = _e as EModelEndpoint;

  const model = _m ?? '';
  const modelDisplayLabel = _mdl ?? '';
  const chatGptLabel = _cgl ?? '';
  const modelLabel = _ml ?? '';
  if (
    [EModelEndpoint.openAI, EModelEndpoint.bedrock, EModelEndpoint.azureOpenAI].includes(endpoint)
  ) {
    if (modelLabel) {
      return modelLabel;
    } else if (chatGptLabel) {
      // @deprecated - prefer modelLabel
      return chatGptLabel;
    } else if (model && extractOmniVersion(model)) {
      return extractOmniVersion(model);
    } else if (model && (model.includes('mistral') || model.includes('codestral'))) {
      return 'Mistral';
    } else if (model && model.includes('deepseek')) {
      return 'Deepseek';
    } else if (model && model.includes('kimi')) {
      return 'Kimi';
    } else if (model && model.includes('moonshot')) {
      return 'Moonshot';
    } else if (model && model.includes('gpt-')) {
      const gptVersion = extractGPTVersion(model);
      return gptVersion || 'GPT';
    }
    return (alternateName[endpoint] as string | undefined) ?? 'AI';
  }

  if (endpoint === EModelEndpoint.anthropic) {
    return modelLabel || 'Claude';
  }

  if (endpoint === EModelEndpoint.bedrock) {
    return modelLabel || alternateName[endpoint];
  }

  if (endpoint === EModelEndpoint.google) {
    if (modelLabel) {
      return modelLabel;
    } else if (model?.toLowerCase().includes('gemma') === true) {
      return 'Gemma';
    }

    return 'Gemini';
  }

  if (endpoint === EModelEndpoint.custom || endpointType === EModelEndpoint.custom) {
    if (modelLabel) {
      return modelLabel;
    } else if (chatGptLabel) {
      // @deprecated - prefer modelLabel
      return chatGptLabel;
    } else if (model && extractOmniVersion(model)) {
      return extractOmniVersion(model);
    } else if (model && (model.includes('mistral') || model.includes('codestral'))) {
      return 'Mistral';
    } else if (model && model.includes('deepseek')) {
      return 'Deepseek';
    } else if (model && model.includes('kimi')) {
      return 'Kimi';
    } else if (model && model.includes('moonshot')) {
      return 'Moonshot';
    } else if (model && model.includes('gpt-')) {
      const gptVersion = extractGPTVersion(model);
      return gptVersion || 'GPT';
    } else if (modelDisplayLabel) {
      return modelDisplayLabel;
    }

    return 'AI';
  }

  return '';
};

type CompactEndpointSchema =
  | typeof openAISchema
  | typeof compactAssistantSchema
  | typeof compactAgentsSchema
  | typeof compactGoogleSchema
  | typeof openRouterSchema
  | typeof anthropicSchema
  | typeof bedrockInputSchema;

const compactEndpointSchemas: Record<EndpointSchemaLookupKey, CompactEndpointSchema> = {
  [EModelEndpoint.openAI]: openAISchema,
  [EModelEndpoint.azureOpenAI]: openAISchema,
  [EModelEndpoint.custom]: openAISchema,
  [Providers.OPENROUTER]: openRouterSchema,
  [EModelEndpoint.assistants]: compactAssistantSchema,
  [EModelEndpoint.azureAssistants]: compactAssistantSchema,
  [EModelEndpoint.agents]: compactAgentsSchema,
  [EModelEndpoint.google]: compactGoogleSchema,
  [EModelEndpoint.bedrock]: bedrockInputSchema,
  [EModelEndpoint.anthropic]: anthropicSchema,
};

export const parseCompactConvo = ({
  endpoint,
  endpointType,
  conversation,
  possibleValues,
  defaultParamsEndpoint,
}: {
  endpoint?: EndpointSchemaKey;
  endpointType?: EndpointSchemaKey | null;
  conversation: Partial<s.TConversation | s.TPreset>;
  possibleValues?: TPossibleValues;
  defaultParamsEndpoint?: string | null;
}): Omit<s.TConversation, 'iconURL'> | null => {
  if (!endpoint) {
    throw new Error(`undefined endpoint: ${endpoint}`);
  }

  const primarySchema = compactEndpointSchemas[endpoint] as CompactEndpointSchema | undefined;

  if (!primarySchema && !endpointType) {
    throw new Error(`Unknown endpoint: ${endpoint}`);
  }

  const schema =
    primarySchema ??
    getFallbackEndpointSchema(compactEndpointSchemas, endpointType, defaultParamsEndpoint);

  if (!schema) {
    throw new Error(`Unknown endpointType: ${endpointType}`);
  }

  // Strip iconURL from input before parsing - it should only be derived server-side
  // from model spec configuration, not accepted from client requests
  const { iconURL: _clientIconURL, ...conversationWithoutIconURL } = conversation;

  const convo = schema.parse(conversationWithoutIconURL) as s.TConversation | null;
  const { models } = possibleValues ?? {};

  if (models && convo) {
    convo.model = getFirstDefinedValue(models) ?? convo.model;
  }

  return convo;
};

export function parseTextParts(
  contentParts: Array<a.TMessageContentParts | undefined>,
  skipReasoning: boolean = false,
  options?: { includeSteer?: boolean },
): string {
  let result = '';
  const append = (textValue: string) => {
    if (
      result.length > 0 &&
      textValue.length > 0 &&
      result[result.length - 1] !== ' ' &&
      textValue[0] !== ' '
    ) {
      result += ' ';
    }
    result += textValue;
  };

  for (const part of contentParts) {
    if (!part?.type) {
      continue;
    }
    if (part.type === ContentTypes.TEXT) {
      append((typeof part.text === 'string' ? part.text : part.text?.value) || '');
    } else if (part.type === ContentTypes.STEER && options?.includeSteer === true) {
      /** Mid-run user speech: excluded by default so generic extraction (TTS
       *  reading assistant output) never speaks the user's own words — the
       *  full-record surfaces (search indexing, persisted abort text) opt in. */
      append(typeof part.steer === 'string' ? part.steer : '');
    } else if (part.type === ContentTypes.THINK && !skipReasoning) {
      append(typeof part.think === 'string' ? part.think : '');
    }
  }

  return result;
}

export const SEPARATORS = ['.', '?', '!', '۔', '。', '‥', ';', '¡', '¿', '\n', '```'];

export function findLastSeparatorIndex(text: string, separators = SEPARATORS): number {
  let lastIndex = -1;
  for (const separator of separators) {
    const index = text.lastIndexOf(separator);
    if (index > lastIndex) {
      lastIndex = index;
    }
  }
  return lastIndex;
}

/**
 * Anchors a dayjs instant to the user's IANA timezone when one is supplied,
 * so local-time special vars reflect the user's wall clock rather than the
 * server's. Falls back to the original instant for missing or invalid zones.
 */
function applyTimezone(value: dayjs.Dayjs, timezone?: string): dayjs.Dayjs {
  if (!timezone) {
    return value;
  }
  try {
    const zoned = value.tz(timezone);
    return zoned.isValid() ? zoned : value;
  } catch {
    return value;
  }
}

export function replaceSpecialVars({
  text,
  user,
  now: inputNow,
  timezone,
}: {
  text: string;
  user?: t.TUser | null;
  now?: string | number | Date;
  timezone?: string;
}) {
  let result = text;
  if (!result) {
    return result;
  }

  const now = applyTimezone(inputNow != null ? dayjs(inputNow) : dayjs(), timezone);
  const weekdayName = now.format('dddd');

  const currentDate = now.format('YYYY-MM-DD');
  result = result.replace(/{{\s*current_date\s*}}/gi, `${currentDate} (${weekdayName})`);

  const currentDatetime = now.format('YYYY-MM-DD HH:mm:ss Z');
  result = result.replace(/{{\s*current_datetime\s*}}/gi, `${currentDatetime} (${weekdayName})`);

  const isoDatetime = now.toISOString();
  result = result.replace(/{{\s*iso_datetime\s*}}/gi, isoDatetime);

  if (user && user.name) {
    result = result.replace(/{{\s*current_user\s*}}/gi, user.name);
  }

  return result;
}

/**
 * Parsed ephemeral agent ID result
 */
export type ParsedEphemeralAgentId = {
  endpoint: string;
  model: string;
  sender?: string;
  index?: number;
};

/**
 * Resolves the display label ("sender") for an ephemeral agent:
 * `modelLabel` (user/preset) → model spec's `label` → endpoint config's
 * `modelDisplayLabel` → `''` (lets consumers fall back to the model name).
 */
export function getEphemeralSender({
  modelLabel,
  specLabel,
  modelDisplayLabel,
}: {
  modelLabel?: string | null;
  specLabel?: string | null;
  modelDisplayLabel?: string | null;
}): string {
  return modelLabel ?? specLabel ?? modelDisplayLabel ?? '';
}

/** Built-in endpoints; anything else in `endpoint` is a custom endpoint's own name. */
const builtInEndpoints = new Set<string>(Object.values(EModelEndpoint));

/**
 * Whether a persisted `sender` is a label someone configured rather than the
 * model-derived name `getResponseSender` produces.
 *
 * The sender is the one thing that records which it was: `resolveSender` writes an
 * agent's name, then the `getEphemeralSender` chain (`modelLabel` → a model spec's
 * `label` → an endpoint's `modelDisplayLabel`), and falls back to `getResponseSender`
 * only when none of those is set. Asking the message rather than the conversation
 * settles three things a settings lookup cannot: labels that live in config a caller
 * may not hold, labels an endpoint ignores (Anthropic keeps reading `Claude` whatever
 * `chatGptLabel` says, and matches here), and labels changed since the message was
 * written — its header still shows the sender it was written under.
 *
 * Equality is the test, so the only way to be wrong is a stored name that no longer
 * matches what the current heuristics produce, which withholds a model rather than
 * revealing one.
 */
export const isConfiguredSender = ({
  sender,
  endpoint,
  endpointType,
  model,
  isCreatedByUser,
}: {
  sender?: string | null;
  endpoint?: EModelEndpoint | string | null;
  endpointType?: EModelEndpoint | string | null;
  model?: string | null;
  isCreatedByUser?: boolean | null;
}): boolean => {
  /** A user turn is headed by the person who wrote it, so it has no model to withhold
   *  and its `User` sender would never match a derived name. */
  if (isCreatedByUser === true) {
    return false;
  }
  /** Agents and assistants are named by whoever authored them: the header shows that
   *  name whether or not the response stored a sender, and `getResponseSender` has no
   *  branch to derive one. */
  if (isAgentsEndpoint(endpoint) || isAssistantsEndpoint(endpoint)) {
    return true;
  }
  if (sender == null || sender === '') {
    return false;
  }
  /** A custom endpoint carries its own configured name in `endpoint`, which
   *  `getResponseSender` recognizes only through `endpointType`. */
  const resolvedType =
    endpointType ??
    (endpoint != null && !builtInEndpoints.has(endpoint) ? EModelEndpoint.custom : undefined);
  const derived = getResponseSender({
    endpoint: endpoint as EModelEndpoint,
    endpointType: resolvedType as EModelEndpoint,
    model,
  });
  /** An endpoint this cannot name — an older message stored without one, say — says
   *  nothing either way, and reading that silence as "configured" would withhold the
   *  model from every unlabelled row it reached. */
  if (derived === '') {
    return false;
  }
  return sender !== derived;
};

/**
 * Encodes an ephemeral agent ID from endpoint, model, optional sender, and optional index.
 * Uses __ to replace : (reserved in graph node names) and ___ to separate sender.
 *
 * Format: endpoint__model___sender or endpoint__model___sender____index (if index provided)
 *
 * @example
 * encodeEphemeralAgentId({ endpoint: 'openAI', model: 'gpt-4o', sender: 'GPT-4o' })
 * // => 'openAI__gpt-4o___GPT-4o'
 *
 * @example
 * encodeEphemeralAgentId({ endpoint: 'openAI', model: 'gpt-4o', sender: 'GPT-4o', index: 1 })
 * // => 'openAI__gpt-4o___GPT-4o____1'
 */
export function encodeEphemeralAgentId({
  endpoint,
  model,
  sender,
  index,
}: {
  endpoint: string;
  model: string;
  sender?: string;
  index?: number;
}): string {
  const base = `${endpoint}:${model}`.replace(/:/g, '__');
  let result = base;
  if (sender) {
    // Use ___ as separator before sender to distinguish from __ in model names
    result = `${base}___${sender.replace(/:/g, '__')}`;
  }
  if (index != null) {
    // Use ____ (4 underscores) as separator for index
    result = `${result}____${index}`;
  }
  return result;
}

/**
 * Parses an ephemeral agent ID back into its components.
 * Returns undefined if the ID doesn't match the expected format.
 *
 * Format: endpoint__model___sender or endpoint__model___sender____index
 * - ____ (4 underscores) separates optional index suffix
 * - ___ (triple underscore) separates model from optional sender
 * - __ (double underscore) replaces : in endpoint/model names
 *
 * @example
 * parseEphemeralAgentId('openAI__gpt-4o___GPT-4o')
 * // => { endpoint: 'openAI', model: 'gpt-4o', sender: 'GPT-4o' }
 *
 * @example
 * parseEphemeralAgentId('openAI__gpt-4o___GPT-4o____1')
 * // => { endpoint: 'openAI', model: 'gpt-4o', sender: 'GPT-4o', index: 1 }
 */
export function parseEphemeralAgentId(agentId: string): ParsedEphemeralAgentId | undefined {
  if (!agentId.includes('__')) {
    return undefined;
  }

  // First check for index suffix (separated by ____)
  let index: number | undefined;
  let workingId = agentId;
  if (agentId.includes('____')) {
    const lastIndexSep = agentId.lastIndexOf('____');
    const indexStr = agentId.slice(lastIndexSep + 4);
    const parsedIndex = parseInt(indexStr, 10);
    if (!isNaN(parsedIndex)) {
      index = parsedIndex;
      workingId = agentId.slice(0, lastIndexSep);
    }
  }

  // Check for sender (separated by ___)
  let sender: string | undefined;
  let mainPart = workingId;
  if (workingId.includes('___')) {
    const [before, after] = workingId.split('___');
    mainPart = before;
    // Restore colons in sender if any
    sender = after?.replace(/__/g, ':');
  }

  const [endpoint, ...modelParts] = mainPart.split('__');
  if (!endpoint || modelParts.length === 0) {
    return undefined;
  }
  // Restore colons in model name (model names can contain colons like claude-3:opus)
  const model = modelParts.join(':');
  return { endpoint, model, sender, index };
}

/**
 * Checks if an agent ID represents an ephemeral (non-saved) agent.
 * Real agent IDs always start with "agent_", so anything else is ephemeral.
 */
export function isEphemeralAgentId(agentId: string | null | undefined): boolean {
  return !agentId?.startsWith('agent_');
}

/**
 * Strips the index suffix (____N) from an agent ID if present.
 * Works with both ephemeral and real agent IDs.
 *
 * @example
 * stripAgentIdSuffix('agent_abc123____1') // => 'agent_abc123'
 * stripAgentIdSuffix('openAI__gpt-4o___GPT-4o____1') // => 'openAI__gpt-4o___GPT-4o'
 * stripAgentIdSuffix('agent_abc123') // => 'agent_abc123' (unchanged)
 */
export function stripAgentIdSuffix(agentId: string): string {
  return agentId.replace(/____\d+$/, '');
}

/**
 * Appends an index suffix (____N) to an agent ID.
 * Used to distinguish parallel agents with the same base ID.
 *
 * @example
 * appendAgentIdSuffix('agent_abc123', 1) // => 'agent_abc123____1'
 * appendAgentIdSuffix('openAI__gpt-4o___GPT-4o', 1) // => 'openAI__gpt-4o___GPT-4o____1'
 */
export function appendAgentIdSuffix(agentId: string, index: number): string {
  return `${agentId}____${index}`;
}
