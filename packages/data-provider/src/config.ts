import { z } from 'zod';
import type { ZodError } from 'zod';
import type { TEndpointsConfig, TModelsConfig, TConfig } from './types';
import {
  filtersConfigSchema,
  MAX_PII_CUSTOM_REGEX_CHARACTERS,
  MAX_PII_CUSTOM_REGEX_INSTRUCTIONS,
  MAX_PII_PATTERN_ID_LENGTH,
  MAX_PII_PATTERN_LABEL_LENGTH,
  MAX_PII_PATTERNS_PER_SOURCE,
  MAX_PII_PATTERN_LENGTH,
} from './filters';
import {
  EModelEndpoint,
  eModelEndpointSchema,
  isAgentsEndpoint,
  eReasoningParameterFormatSchema,
  eReasoningResponseKeySchema,
} from './schemas';
import {
  REFILL_INTERVAL_UNITS,
  MIN_BALANCE_RESERVATION_TTL_MS,
  DEFAULT_BALANCE_RESERVATION_TTL_MS,
} from './balance';
import {
  MAX_SUBAGENTS,
  MAX_SUBAGENTS_CEILING,
  DEFAULT_MAX_RETAINED_TOOL_COUNT_CHARS,
} from './limits';
import { ComponentTypes, SettingTypes, OptionTypes } from './generate';
import { CODE_ENVIRONMENT_DECISION_VERSION } from './code/workspace';
import { STATEFUL_CODE_ENVIRONMENTS } from './stateful-code';
import { specsConfigSchema, TSpecsConfig } from './models';
import { isActionTool } from './types/assistants';
import { fileConfigSchema } from './file-config';
import { apiBaseUrl } from './api-endpoints';
import { FileSources } from './types/files';
import { MCPServersSchema } from './mcp';
export {
  MAX_SUBAGENTS,
  MAX_SUBAGENTS_CEILING,
  getMaxSubagents,
  setMaxSubagents,
  MAX_GRAPH_SUBAGENT_MEMBERS,
  MAX_CHAT_PROJECT_NAME_LENGTH,
  MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
  DEFAULT_MAX_RETAINED_TOOL_COUNT_CHARS,
} from './limits';

export const defaultSocialLogins = ['google', 'facebook', 'openid', 'github', 'discord', 'saml'];

/** How long a started social login may take to return to its callback before its `state` expires. */
export const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const BASE_ONLY_CONFIG_SECTIONS = ['filters'] as const;
/** Sections that may be stored in the tenant's base config document but must
 * not be overridden or tombstoned by role, group, or user config documents. */
export const BASE_PRINCIPAL_CONFIG_SECTIONS = ['langfuse'] as const;

export const defaultRetrievalModels = [
  'gpt-4o',
  'o1-preview-2024-09-12',
  'o1-preview',
  'o1-mini-2024-09-12',
  'o1-mini',
  'o3-mini',
  'chatgpt-4o-latest',
  'gpt-4o-2024-05-13',
  'gpt-4o-2024-08-06',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18',
  'gpt-4-turbo-preview',
  'gpt-3.5-turbo-0125',
  'gpt-4-0125-preview',
  'gpt-4-1106-preview',
  'gpt-3.5-turbo-1106',
  'gpt-3.5-turbo-0125',
  'gpt-4-turbo',
  'gpt-4-0125',
  'gpt-4-1106',
];

export const excludedKeys = new Set([
  'conversationId',
  'agentEventBinding',
  'agentEventActor',
  'agentEventActorCleanup',
  'agentEventActorSuspension',
  'agentEventActorReconciliations',
  'agentEventActorEpoch',
  'agentEventActorLegacyTurn',
  'subagentThread',
  'title',
  'iconURL',
  'greeting',
  'endpoint',
  'endpointType',
  'createdAt',
  'updatedAt',
  'expiredAt',
  'isTemporary',
  'messages',
  'isArchived',
  'pinned',
  'archivedAt',
  'tags',
  'user',
  '__v',
  '_id',
  'tools',
  'model',
  'files',
  'spec',
  'disableParams',
  'chatProjectId',
]);

export enum SettingsViews {
  default = 'default',
  advanced = 'advanced',
}

/** Validates any FileSources value — use for file metadata, DB records, and upload routing. */
export const fileSourceSchema = z.nativeEnum(FileSources);

/**
 * `allowedAddresses` is an SSRF exemption list scoped to private IP space.
 * Validate at config-load time:
 *  - Reject URLs, paths, CIDR ranges, bare host/IP forms, and whitespace.
 *  - Require `host:port` or `[ipv6]:port` entries so an exemption is scoped
 *    to one service port instead of every port on a private host.
 *  - Reject IPv4 literals that fall outside the private/loopback/link-local
 *    ranges. Public IPs are never SSRF targets, so listing one has no
 *    defensive purpose and must not silently grant trust.
 *  - Hostnames pass through; their resolved IP is checked at runtime by
 *    `resolveHostnameSSRF` and only a private resolved IP is meaningful.
 *
 * Mirrors a minimal subset of `isPrivateIP` from `@librechat/api` to avoid a
 * circular package dependency. The runtime helper is the authoritative check;
 * this refinement is a UX guardrail.
 */
function isPrivateIPv4Literal(value: string): boolean {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const [a, b, c] = match.slice(1).map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true; // RFC 5736 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast/reserved
  return false;
}

/**
 * Mirrors `hasPrivateEmbeddedIPv4` in `@librechat/api`'s ip helpers: 6to4, NAT64, and Teredo
 * carry an IPv4 address inside the IPv6 one, and the runtime guard blocks those when the
 * embedded address is private. Kept in sync so an operator can exempt what the runtime blocks.
 */
function hasPrivateEmbeddedIPv4Literal(value: string): boolean {
  const is6to4 = value.startsWith('2002:');
  const isNat64 = value.startsWith('64:ff9b::');
  const isTeredo = value.startsWith('2001::');
  if (!is6to4 && !isNat64 && !isTeredo) {
    return false;
  }

  const segments = value.split(':').filter((segment) => segment !== '');
  const pair = is6to4 ? segments.slice(1, 3) : segments.slice(-2);
  if (pair.length !== 2) {
    return false;
  }

  const hi = parseInt(pair[0], 16);
  const lo = parseInt(pair[1], 16);
  if (isNaN(hi) || isNaN(lo)) {
    return false;
  }

  /** RFC 4380: Teredo stores the external IPv4 as a bitwise complement. */
  const high = isTeredo ? ~hi : hi;
  const low = isTeredo ? ~lo : lo;
  const octets = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
  return isPrivateIPv4Literal(octets.join('.'));
}

function isPrivateIPv6Literal(value: string): boolean {
  if (!value.includes(':')) return false;
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
  // fe80::/10 — first hextet 0xfe80–0xfebf
  const firstHextet = value.split(':', 1)[0];
  if (/^[0-9a-f]{1,4}$/.test(firstHextet ?? '')) {
    const hextet = parseInt(firstHextet, 16);
    if ((hextet & 0xffc0) === 0xfe80) return true;
  }
  // 4-in-6: ::ffff:A.B.C.D
  const mappedMatch = value.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedMatch) return isPrivateIPv4Literal(mappedMatch[1]);
  return hasPrivateEmbeddedIPv4Literal(value);
}

/**
 * Mirrors the allowedAddresses parser in `@librechat/api`'s auth helpers.
 * Kept as a local copy because the data-provider package cannot import from
 * `@librechat/api` without creating a circular dependency. Keep the two
 * implementations in sync.
 */
function normalizePort(port: unknown): string {
  if (typeof port !== 'string' && typeof port !== 'number') return '';
  const portString = String(port).trim();
  if (!/^\d+$/.test(portString)) return '';
  const parsed = Number(portString);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return '';
  return String(parsed);
}

function parseAllowedAddressEntry(entry: string): { address: string; port: string } | null {
  const trimmed = entry.toLowerCase().trim();
  const bracketedIPv6 = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  const hostPort = bracketedIPv6 ? null : trimmed.match(/^([^:]+):(\d+)$/);
  const address = (bracketedIPv6?.[1] ?? hostPort?.[1] ?? '').replace(/^\[|\]$/g, '');
  const port = normalizePort(bracketedIPv6?.[2] ?? hostPort?.[2] ?? '');
  if (!address || !port) return null;
  return { address, port };
}

const allowedAddressEntrySchema = z
  .string()
  .refine((entry) => entry.length > 0 && entry.trim().length > 0, {
    message: 'allowedAddresses entries must be non-empty',
  })
  .refine((entry) => !entry.includes('://') && !entry.includes('/') && !/\s/.test(entry), {
    message:
      'allowedAddresses entries must be host:port pairs — no URLs, paths, CIDR ranges, or whitespace',
  })
  .refine((entry) => parseAllowedAddressEntry(entry) != null, {
    message:
      'allowedAddresses entries must include a port, for example localhost:11434 or [::1]:11434',
  })
  .refine(
    (entry) => {
      const parsed = parseAllowedAddressEntry(entry);
      if (!parsed) return false;
      const stripped = parsed.address;
      const isIPv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(stripped);
      const isIPv6 = !isIPv4 && stripped.includes(':');
      if (!isIPv4 && !isIPv6) {
        return true; // hostname — checked at runtime via DNS
      }
      return isIPv4 ? isPrivateIPv4Literal(stripped) : isPrivateIPv6Literal(stripped);
    },
    {
      message:
        'allowedAddresses is scoped to private IP space — public IP literals are not permitted (use hostname:port if it resolves to a private IP)',
    },
  );

export const allowedAddressesSchema = z.array(allowedAddressEntrySchema).optional();

/** Storage backend strategies only — use for config fields that set where files are stored. */
const FILE_STORAGE_BACKENDS = [
  FileSources.local,
  FileSources.firebase,
  FileSources.s3,
  FileSources.azure_blob,
  FileSources.cloudfront,
] as const satisfies ReadonlyArray<FileSources>;

export const fileStorageSchema = z.enum(FILE_STORAGE_BACKENDS);

export type FileStorage = z.infer<typeof fileStorageSchema>;

export const fileStrategiesSchema = z
  .object({
    default: fileStorageSchema.optional(),
    avatar: fileStorageSchema.optional(),
    image: fileStorageSchema.optional(),
    document: fileStorageSchema.optional(),
    skills: fileStorageSchema.optional(),
  })
  .optional();

const cloudfrontSigningSchema = z.enum(['none', 'cookies', 'url']);

export const cloudfrontConfigSchema = z
  .object({
    domain: z.string().url(),
    distributionId: z.string().optional(),
    invalidateOnDelete: z.boolean().default(false),
    imageSigning: cloudfrontSigningSchema.default('none'),
    urlExpiry: z.number().positive().default(3600),
    cookieExpiry: z.number().positive().max(604800).default(1800),
    cookieDomain: z
      .string()
      .min(1)
      .refine((d) => d.startsWith('.'), {
        message: 'cookieDomain must start with a dot (e.g., ".example.com") to apply to subdomains',
      })
      .optional(),
    storageRegion: z.string().min(1).optional(),
    includeRegionInPath: z.boolean().default(false),
    requireSignedAccess: z.boolean().default(false),
  })
  .refine((data) => !data.invalidateOnDelete || !!data.distributionId, {
    message: 'distributionId is required when invalidateOnDelete is true',
    path: ['distributionId'],
  })
  .refine((data) => data.imageSigning !== 'cookies' || !!data.cookieDomain, {
    message:
      'cookieDomain is required when imageSigning is "cookies" (e.g., ".example.com" for API at api.example.com and CDN at cdn.example.com)',
    path: ['cookieDomain'],
  })
  .refine((data) => !data.requireSignedAccess || data.imageSigning === 'cookies', {
    message:
      'cloudfront.requireSignedAccess=true requires cloudfront.imageSigning="cookies" (signed URL mode is not yet implemented)',
    path: ['requireSignedAccess'],
  })
  .optional();

export type CloudFrontConfig = z.infer<typeof cloudfrontConfigSchema>;

const skillSyncIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message:
      'must start with a letter or digit and contain only letters, digits, underscores, or hyphens',
  });

export const SKILL_SYNC_MIN_INTERVAL_MINUTES = 5;
export const SKILL_SYNC_MAX_INTERVAL_MINUTES = Math.floor(2147483647 / 60_000);
export const SKILL_SYNC_DEFAULT_DISCOVERY_DEPTH = 2;
export const SKILL_SYNC_MAX_DISCOVERY_DEPTH = 10;

const skillSyncGitHubOwnerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/, {
    message: 'must be a valid GitHub owner name',
  });

const skillSyncGitHubRepoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/, {
    message: 'must be a valid GitHub repository name',
  });

const invalidGitRefChars = new Set(['~', '^', ':', '?', '*', '[']);

function hasInvalidGitRefCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127 || invalidGitRefChars.has(char)) {
      return true;
    }
  }
  return false;
}

const skillSyncGitHubRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith('/') && !value.endsWith('/'), {
    message: 'must not start or end with a slash',
  })
  .refine((value) => !value.includes('..') && !value.includes('//') && !value.includes('\\'), {
    message: 'must not contain traversal segments, empty path segments, or backslashes',
  })
  .refine((value) => !value.includes('@{') && value !== '@', {
    message: 'must not contain invalid Git ref syntax',
  })
  .refine((value) => !value.endsWith('.'), {
    message: 'must not end with a dot',
  })
  .refine((value) => !hasInvalidGitRefCharacter(value), {
    message: 'must not contain invalid Git ref characters',
  })
  .refine(
    (value) =>
      value
        .split('/')
        .every((segment) => segment && !segment.startsWith('.') && !segment.endsWith('.lock')),
    {
      message: 'must contain valid Git ref path segments',
    },
  );

const skillSyncPathSchema = z
  .string()
  .max(500)
  .refine((value) => value.trim().length > 0, { message: 'must not be empty' })
  .transform((value) => {
    const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
    return trimmed === '.' ? '' : trimmed;
  })
  .refine((value) => !value.includes('\\') && !value.includes('..'), {
    message: 'must not contain traversal segments or backslashes',
  })
  .refine((value) => value === '' || /^[a-zA-Z0-9._\-/]+$/.test(value), {
    message: 'must contain only letters, digits, dots, underscores, hyphens, and slashes',
  })
  .refine(
    (value) =>
      value === '' || value.split('/').every((segment) => segment.length > 0 && segment !== '.'),
    {
      message: 'must not contain empty or dot path segments',
    },
  );

const skillSyncTokenReferenceSchema = z
  .string()
  .trim()
  .regex(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, {
    message: 'must be an environment variable reference like ${GITHUB_SKILLS_TOKEN}',
  });

/**
 * Tenant that owns the skills mirrored from a source. When set, the sync runner
 * executes that source's database writes inside the tenant's async context so
 * synced skills are created, listed, and shared within the tenant under strict
 * tenant isolation. Mirrors the request tenant-id contract: no reserved system id.
 */
const skillSyncTenantIdSchema = z
  .string()
  .max(128)
  .refine((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value), {
    message: 'must be a valid tenant id',
  })
  .refine((value) => value !== '__SYSTEM__', {
    message: 'must not be the reserved system tenant id',
  });

export const skillSyncGitHubSourceSchema = z
  .object({
    id: skillSyncIdentifierSchema,
    owner: skillSyncGitHubOwnerSchema,
    repo: skillSyncGitHubRepoSchema,
    ref: skillSyncGitHubRefSchema.default('main'),
    paths: z.array(skillSyncPathSchema).min(1),
    skillDiscoveryDepth: z.number().int().min(0).max(SKILL_SYNC_MAX_DISCOVERY_DEPTH).optional(),
    credentialKey: skillSyncIdentifierSchema.optional(),
    token: skillSyncTokenReferenceSchema.optional(),
    tenantId: skillSyncTenantIdSchema.optional(),
  })
  .superRefine((source, ctx) => {
    if (!source.credentialKey && !source.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentialKey'],
        message: 'Either credentialKey or token is required',
      });
    }
    if (source.credentialKey && source.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['token'],
        message: 'Use either credentialKey or token, not both',
      });
    }
  });

export const skillSyncConfigSchema = z
  .object({
    github: z
      .object({
        enabled: z.boolean().default(false),
        intervalMinutes: z
          .number()
          .int()
          .min(SKILL_SYNC_MIN_INTERVAL_MINUTES)
          .max(SKILL_SYNC_MAX_INTERVAL_MINUTES)
          .default(60),
        runOnStartup: z.boolean().default(false),
        sources: z.array(skillSyncGitHubSourceSchema).default([]),
      })
      .superRefine((github, ctx) => {
        if (github.enabled && github.sources.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sources'],
            message: 'At least one GitHub source is required when skill sync is enabled',
          });
        }
        const seen = new Set<string>();
        for (const source of github.sources) {
          if (seen.has(source.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['sources'],
              message: `Duplicate GitHub skill sync source id "${source.id}"`,
            });
          }
          seen.add(source.id);
        }
      })
      .optional(),
  })
  .optional();

export type SkillSyncConfig = z.infer<typeof skillSyncConfigSchema>;
export type SkillSyncGitHubSourceConfig = z.infer<typeof skillSyncGitHubSourceSchema>;

// Helper type to extract the shape of the Zod object schema
type SchemaShape<T> = T extends z.ZodObject<infer U> ? U : never;

// Helper type to determine the default value or undefined based on whether the field has a default
type DefaultValue<T> =
  T extends z.ZodDefault<z.ZodTypeAny> ? ReturnType<T['_def']['defaultValue']> : undefined;

// Extract default values or undefined from the schema shape
type ExtractDefaults<T> = {
  [P in keyof T]: DefaultValue<T[P]>;
};

export type SchemaDefaults<T> = ExtractDefaults<SchemaShape<T>>;

export type TConfigDefaults = SchemaDefaults<typeof configSchema>;

export function getSchemaDefaults<Schema extends z.AnyZodObject>(
  schema: Schema,
): ExtractDefaults<SchemaShape<Schema>> {
  const shape = schema.shape;
  const entries = Object.entries(shape).map(([key, value]) => {
    if (value instanceof z.ZodDefault) {
      // Extract default value if it exists
      return [key, value._def.defaultValue()];
    }
    return [key, undefined];
  });

  // Create the object with the right types
  return Object.fromEntries(entries) as ExtractDefaults<SchemaShape<Schema>>;
}

export const modelConfigSchema = z
  .object({
    deploymentName: z.string().optional(),
    version: z.string().optional(),
    assistants: z.boolean().optional(),
  })
  .or(z.boolean());

export type TAzureModelConfig = z.infer<typeof modelConfigSchema>;

const paramValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(paramValueSchema),
    z.record(z.string(), paramValueSchema),
  ]),
);

/** Validates addParams while keeping web_search aligned with current runtime boolean handling. */
const addParamsSchema: z.ZodType<Record<string, unknown>> = z
  .record(z.string(), paramValueSchema)
  .superRefine((params, ctx) => {
    if (params.web_search === undefined || typeof params.web_search === 'boolean') {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['web_search'],
      message: '`web_search` must be a boolean in addParams',
    });
  });

export const azureBaseSchema = z.object({
  apiKey: z.string(),
  serverless: z.boolean().optional(),
  instanceName: z.string().optional(),
  deploymentName: z.string().optional(),
  assistants: z.boolean().optional(),
  addParams: addParamsSchema.optional(),
  dropParams: z.array(z.string()).optional(),
  version: z.string().optional(),
  baseURL: z.string().optional(),
  additionalHeaders: z.record(z.string()).optional(),
});

export type TAzureBaseSchema = z.infer<typeof azureBaseSchema>;

export const azureGroupSchema = z
  .object({
    group: z.string(),
    models: z.record(z.string(), modelConfigSchema),
  })
  .required()
  .and(azureBaseSchema);

export const azureGroupConfigsSchema = z.array(azureGroupSchema).min(1);
export type TAzureGroup = z.infer<typeof azureGroupSchema>;
export type TAzureGroups = z.infer<typeof azureGroupConfigsSchema>;
export type TAzureModelMapSchema = {
  // deploymentName?: string;
  // version?: string;
  group: string;
};

export type TAzureModelGroupMap = Record<string, TAzureModelMapSchema | undefined>;
export type TAzureGroupMap = Record<
  string,
  (TAzureBaseSchema & { models: Record<string, TAzureModelConfig | undefined> }) | undefined
>;

export type TValidatedAzureConfig = {
  modelNames: string[];
  groupMap: TAzureGroupMap;
  assistantModels?: string[];
  assistantGroups?: string[];
  modelGroupMap: TAzureModelGroupMap;
};

export type TAzureConfigValidationResult = TValidatedAzureConfig & {
  isValid: boolean;
  errors: (ZodError | string)[];
};

export enum Capabilities {
  code_interpreter = 'code_interpreter',
  image_vision = 'image_vision',
  retrieval = 'retrieval',
  actions = 'actions',
  tools = 'tools',
}

export enum AgentCapabilities {
  hide_sequential_outputs = 'hide_sequential_outputs',
  programmatic_tools = 'programmatic_tools',
  end_after_tools = 'end_after_tools',
  deferred_tools = 'deferred_tools',
  execute_code = 'execute_code',
  stateful_code_sessions = 'stateful_code_sessions',
  file_search = 'file_search',
  web_search = 'web_search',
  artifacts = 'artifacts',
  subagents = 'subagents',
  actions = 'actions',
  context = 'context',
  skills = 'skills',
  memory = 'memory',
  ask_user_question = 'ask_user_question',
  tools = 'tools',
  chain = 'chain',
  ocr = 'ocr',
  run_in_background = 'run_in_background',
  tool_intents = 'tool_intents',
}

export const defaultAssistantsVersion = {
  [EModelEndpoint.assistants]: 2,
  [EModelEndpoint.azureAssistants]: 1,
};

export const baseEndpointSchema = z.object({
  /**
   * Milliseconds between visible streamed chunks. Agents SDK-backed
   * providers (openAI, custom, anthropic, google, bedrock, agents) smooth
   * adaptively at 25ms by default; set to override the cadence, 0 to
   * disable smoothing. Legacy Assistants and Ollama paths instead sleep
   * this long per provider chunk (default 1ms), with no adaptive smoothing.
   */
  streamRate: z.number().min(0).optional(),
  baseURL: z.string().optional(),
  /**
   * Custom request headers forwarded to the provider on every request. Values
   * support the same placeholder resolution as custom endpoints — env vars
   * (`${VAR}`), user fields (`{{LIBRECHAT_USER_*}}`), and request-body fields
   * (`{{LIBRECHAT_BODY_CONVERSATIONID}}`). Primarily for routing built-in
   * providers through an AI gateway / reverse proxy that consumes metadata
   * headers (provider-native request shaping is preserved).
   */
  headers: z.record(z.string()).optional(),
  titlePrompt: z.string().optional(),
  titleModel: z.string().optional(),
  titleConvo: z.boolean().optional(),
  titleMethod: z
    .union([z.literal('completion'), z.literal('functions'), z.literal('structured')])
    .optional(),
  titleEndpoint: z.string().optional(),
  titlePromptTemplate: z.string().optional(),
  /**
   * When conversation titles are generated. `immediate` (default) generates the
   * title as soon as the request is made, in parallel with the response, from the
   * user's first message. `final` defers generation until the full response
   * completes (legacy behavior).
   */
  titleTiming: z.union([z.literal('immediate'), z.literal('final')]).optional(),
  /**
   * Agent activity groups: collapse each contiguous block of reasoning and
   * tool calls under a generated one-line header. Mirrors the title options
   * above — `activityLabel` enables it (like `titleConvo`), the rest tune
   * the fast model that writes the label.
   *
   * NOTE: fields added here reach `endpoints.all` automatically (that schema
   * is `baseEndpointSchema.omit({ baseURL })`), but NOT Azure — see the
   * enumerated `.pick()` in `azureEndpointSchema` below.
   */
  activityLabel: z.boolean().optional(),
  /** Model used to write activity labels. Defaults to `titleModel`, then the agent's model. */
  activityModel: z.string().optional(),
  /** Endpoint whose credentials the label model runs on. Defaults to the agent's endpoint. */
  activityEndpoint: z.string().optional(),
  /** Overrides the system prompt used to write activity labels. */
  activityPrompt: z.string().optional(),
  /** Cost cap: maximum labels generated per run. Default 20. */
  activityMaxPerRun: z.number().int().positive().optional(),
  /** Per-entry truncation of tool input/output in the label prompt. Default 600. */
  activityCharLimit: z.number().int().positive().optional(),
  /** Generates one parent summary for each run phase containing 2+ activities. */
  activityPhaseLabel: z.boolean().optional(),
  /** Model used for phase summaries. Defaults to activityModel, titleModel, then the run model. */
  activityPhaseModel: z.string().optional(),
  /** Endpoint whose credentials the phase summary model uses. Defaults to activityEndpoint. */
  activityPhaseEndpoint: z.string().optional(),
  /** Overrides the dedicated phase-summary system prompt. */
  activityPhasePrompt: z.string().optional(),
  /** Cost cap: maximum phase summaries generated per run. Default 5. */
  activityPhaseMaxPerRun: z.number().int().positive().optional(),
  /** Generates a live orientation label for sufficiently long top-level response reasoning. */
  reasoningLabel: z.boolean().optional(),
  /** Model used for reasoning labels. Defaults to activityModel, titleModel, then run model. */
  reasoningLabelModel: z.string().optional(),
  /** Endpoint receiving the bounded visible-reasoning snapshot. Defaults to activityEndpoint. */
  reasoningLabelEndpoint: z.string().optional(),
  /** Overrides the dedicated reasoning-label system prompt. */
  reasoningLabelPrompt: z.string().optional(),
  /** Characters required before the first reasoning label. Default 500. */
  reasoningLabelMinChars: z.number().int().positive().optional(),
  /** New characters required between streaming revisions. Default 400. */
  reasoningLabelUpdateChars: z.number().int().positive().optional(),
  /** Minimum milliseconds between streaming revisions. Default 3000. */
  reasoningLabelUpdateIntervalMs: z.number().int().nonnegative().optional(),
  /** Cost cap: maximum reasoning-label provider calls attempted per run. Default 8. */
  reasoningLabelMaxPerRun: z.number().int().positive().optional(),
  /** Maximum characters allowed in a single tool result before truncation. */
  maxToolResultChars: z.number().positive().optional(),
});

export type TBaseEndpoint = z.infer<typeof baseEndpointSchema>;

export const bedrockGuardrailConfigSchema = z.object({
  guardrailIdentifier: z.string(),
  guardrailVersion: z.string(),
  trace: z.enum(['enabled', 'disabled', 'enabled_full']).optional(),
  streamProcessingMode: z.enum(['sync', 'async']).optional(),
});

export const bedrockEndpointSchema = baseEndpointSchema.merge(
  z.object({
    availableRegions: z.array(z.string()).optional(),
    models: z.array(z.string()).optional(),
    guardrailConfig: bedrockGuardrailConfigSchema.optional(),
    inferenceProfiles: z.record(z.string(), z.string()).optional(),
  }),
);

const modelItemSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
]);

export const assistantEndpointSchema = baseEndpointSchema.merge(
  z.object({
    /* assistants specific */
    disableBuilder: z.boolean().optional(),
    pollIntervalMs: z.number().optional(),
    timeoutMs: z.number().optional(),
    version: z.union([z.string(), z.number()]).default(2),
    supportedIds: z.array(z.string()).min(1).optional(),
    excludedIds: z.array(z.string()).min(1).optional(),
    privateAssistants: z.boolean().optional(),
    retrievalModels: z.array(z.string()).min(1).optional().default(defaultRetrievalModels),
    capabilities: z
      .array(z.nativeEnum(Capabilities))
      .optional()
      .default([
        Capabilities.code_interpreter,
        Capabilities.image_vision,
        Capabilities.retrieval,
        Capabilities.actions,
        Capabilities.tools,
      ]),
    /* general */
    apiKey: z.string().optional(),
    /** Masked preview of the API key, stored at write time so admin
     * reads can show which key is configured without returning the secret.
     * Shared by both `endpoints.assistants` and `endpoints.azureAssistants`,
     * which both use this schema. */
    apiKeyPreview: z.string().optional(),
    models: z
      .object({
        default: z.array(modelItemSchema).min(1),
        fetch: z.boolean().optional(),
        userIdQuery: z.boolean().optional(),
      })
      .optional(),
    headers: z.record(z.string()).optional(),
  }),
);

export type TAssistantEndpoint = z.infer<typeof assistantEndpointSchema>;

export const defaultAgentCapabilities = [
  // Commented as requires latest Code Interpreter API
  // AgentCapabilities.programmatic_tools,
  AgentCapabilities.deferred_tools,
  AgentCapabilities.execute_code,
  AgentCapabilities.file_search,
  AgentCapabilities.web_search,
  AgentCapabilities.artifacts,
  AgentCapabilities.subagents,
  AgentCapabilities.actions,
  AgentCapabilities.context,
  AgentCapabilities.skills,
  AgentCapabilities.memory,
  AgentCapabilities.ask_user_question,
  AgentCapabilities.tools,
  AgentCapabilities.chain,
  AgentCapabilities.ocr,
];

const LOCAL_REMOTE_OIDC_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isRemoteOidcUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;

    const hostname = url.hostname.toLowerCase();
    return LOCAL_REMOTE_OIDC_HOSTS.has(hostname) || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

const remoteApiOidcUrlSchema = z
  .string()
  .url()
  .refine(isRemoteOidcUrlAllowed, { message: 'must use https:// unless targeting localhost' });

const remoteApiOidcScopeSchema = z.string().refine((scope) => !scope.includes(','), {
  message: 'scopes must be space-separated',
});

const oidcAccessTokenSchema = z.object({
  enabled: z.boolean().default(false),
  issuer: remoteApiOidcUrlSchema.optional(),
  audience: z.string().min(1).optional(),
  jwksUri: remoteApiOidcUrlSchema.optional(),
});

function validateEnabledOidc(
  oidc: z.infer<typeof oidcAccessTokenSchema>,
  ctx: z.RefinementCtx,
): void {
  if (oidc.enabled === true && !oidc.issuer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['issuer'],
      message: 'issuer is required when OIDC auth is enabled',
    });
  }
  if (oidc.enabled === true && !oidc.audience) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['audience'],
      message: 'audience is required when OIDC auth is enabled',
    });
  }
}

const remoteApiOidcSchema = oidcAccessTokenSchema
  .extend({ scope: remoteApiOidcScopeSchema.optional() })
  .superRefine(validateEnabledOidc);

const remoteApiAuthSchema = z.object({
  apiKey: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional(),
  oidc: remoteApiOidcSchema.optional(),
});

const remoteApiSchema = z.object({
  auth: remoteApiAuthSchema.optional(),
});

const managementClientBindingSchema = z
  .object({
    clientId: z.string().trim().min(1).max(128),
    subject: z.string().trim().min(1).max(512).optional(),
    userId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'must be a MongoDB ObjectId')
      .transform((userId) => userId.toLowerCase()),
    tenantId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'must be a valid tenant id')
      .refine((tenantId) => tenantId !== '__SYSTEM__', 'system tenant is not allowed'),
    enabled: z.boolean().default(true),
  })
  .strict();

const managementApiOidcSchema = oidcAccessTokenSchema.strict().superRefine(validateEnabledOidc);

const managementApiAuthSchema = z
  .object({
    oidc: managementApiOidcSchema,
    clients: z.array(managementClientBindingSchema).max(100).default([]),
  })
  .strict()
  .superRefine((auth, ctx) => {
    if (auth.oidc.enabled === true && auth.clients.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clients'],
        message: 'at least one client binding is required when management auth is enabled',
      });
    }

    const clientIds = new Set<string>();
    for (let index = 0; index < auth.clients.length; index++) {
      const client = auth.clients[index];
      if (clientIds.has(client.clientId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clients', index, 'clientId'],
          message: 'client IDs must be unique',
        });
      }
      clientIds.add(client.clientId);
    }
  });

const managementApiSchema = z.object({ auth: managementApiAuthSchema.optional() }).strict();

/**
 * Permission mode applied to a tool call. Mirrors `@librechat/agents`'s
 * `ToolPolicyMode` 1:1.
 *
 * - `default`: ask the user about anything not explicitly allowed (default-on).
 * - `dontAsk`: deny anything not explicitly allowed (headless / API-key flows).
 * - `bypass`: auto-approve everything that isn't explicitly denied
 *   (the user-facing "stop asking me" toggle).
 *
 * Subagents inherit the parent's mode; this is enforced by the SDK and not
 * overridable per-subagent.
 */
export const toolApprovalModeSchema = z.enum(['default', 'dontAsk', 'bypass']);
export type ToolApprovalMode = z.infer<typeof toolApprovalModeSchema>;

/**
 * Per-endpoint tool-approval policy.
 *
 * Shape mirrors `@librechat/agents`'s `ToolPolicyConfig` so the host can map it
 * directly into `createToolPolicyHook(config)`. The SDK does the evaluation
 * (`deny → ask → allow → bypass → dontAsk → fallthrough(ask)`); this config
 * just describes the surface.
 *
 * Conventions:
 * - All list entries are matched as globs (`*`). Use `mcp:server:*` to scope
 *   a rule to every tool from a single MCP server.
 * - `deny` always wins, including under `bypass`.
 * - `enabled: false` is a LibreChat-only kill switch that disables the entire
 *   HITL machinery for this endpoint (no checkpointer, no hooks, no prompts).
 *   This is admin-level; users toggle prompting via `mode: 'bypass'` instead.
 */
/**
 * A programmatic tool-approval hook loaded from a module at startup.
 *
 * The referenced module's default export must be a builder
 * `(options?) => ToolApprovalHookFactory` (see `@librechat/api`'s `registerToolApprovalHook`).
 * Hooks compose with the static `allow`/`deny`/`ask` policy above and can only TIGHTEN it
 * (the SDK folds decisions `deny → ask → allow`). This is admin-level config — the module is
 * dynamically imported and executed in-process, so only reference trusted code.
 */
export const toolApprovalHookConfigSchema = z.object({
  /**
   * Module specifier to import: a bare package name (e.g. `@acme/approval-hooks`) or a path —
   * absolute, or relative to the app root. Its default export is the hook builder.
   */
  module: z.string().min(1),
  /** Optional regex matched against the tool name; omit to run for every tool. */
  matcher: z.string().optional(),
  /** Static options forwarded to the module's builder; the hook's own per-call config. */
  options: z.record(z.unknown()).optional(),
});

export type TToolApprovalHookConfig = z.infer<typeof toolApprovalHookConfigSchema>;

export const toolApprovalPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: toolApprovalModeSchema.optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    /** Optional reason template surfaced in the prompt; `{tool}` is interpolated. */
    reason: z.string().optional(),
    /**
     * Programmatic policy hooks loaded from modules at startup. They layer on top of the
     * static lists above for dynamic, context-aware decisions the lists can't express
     * (per-args, per-agent, per-user). See {@link toolApprovalHookConfigSchema}.
     *
     * BASE-CONFIG ONLY: hooks are imported + registered once, process-wide, at server
     * startup — they are NOT reloaded from per-role/user/tenant admin overrides. Encode
     * per-user/tenant behavior INSIDE the hook (via its runtime context), not by varying the
     * module list per override. Honored only when `enabled` is true.
     */
    hooks: z.array(toolApprovalHookConfigSchema).optional(),
  })
  .optional();

export type TToolApprovalPolicy = z.infer<typeof toolApprovalPolicySchema>;

/**
 * Durable checkpointer backing human-in-the-loop resume.
 *
 * When `toolApproval.enabled` is true, a run that pauses for review suspends its
 * LangGraph state to a checkpoint; resuming rebuilds that state on a *fresh* `Run`
 * — possibly on a different replica, or the same worker after a restart. That only
 * works if the checkpoint outlives the original request, so HITL needs a durable
 * saver, not the SDK's process-local `MemorySaver` fallback.
 *
 * Defaults are zero-config: with `toolApproval.enabled` on and no `checkpointer`
 * block, LibreChat persists checkpoints to its primary MongoDB, so resume works
 * across replicas out of the box.
 *
 * - `type: 'mongo'` (default) — persist to the app database; survives restarts and
 *   resolves on any replica. A TTL index reclaims runs that are never resolved.
 * - `type: 'memory'` — process-local only. Paused runs do NOT survive a restart and
 *   can only be resolved on the originating worker. Single-process / dev only.
 */
export const checkpointerTypeSchema = z.enum(['mongo', 'memory']);
export type TCheckpointerType = z.infer<typeof checkpointerTypeSchema>;

export const checkpointerSchema = z
  .object({
    type: checkpointerTypeSchema.optional(),
    /**
     * Approval window, in seconds: how long a paused run waits for a decision
     * before it is reclaimed. Drives both the Mongo TTL index on checkpoints and
     * the pending-action expiry, keeping the two layers in lockstep. Defaults to
     * 86400 (24h). Raise it for longer review windows.
     */
    ttl: z.number().int().positive().optional(),
    /** Advanced: override the Mongo collection names used for checkpoints. */
    checkpointCollectionName: z.string().optional(),
    checkpointWritesCollectionName: z.string().optional(),
  })
  .optional();

export type TCheckpointerConfig = z.infer<typeof checkpointerSchema>;

const codeEnvironmentBaseURLSchema = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          !value.includes('?') &&
          !value.includes('#') &&
          url.search.length === 0 &&
          url.hash.length === 0
        );
      } catch {
        return false;
      }
    },
    { message: 'Code environment baseURL must be an HTTP(S) base URL without query or fragment' },
  );

export function isSecureCodeEnvironmentControlURL(baseURL: string): boolean {
  try {
    const url = new URL(baseURL.trim());
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

export const codeEnvironmentPermissionDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type CodeEnvironmentPermissionDecision = z.infer<
  typeof codeEnvironmentPermissionDecisionSchema
>;

const codeEnvironmentPermissionFieldSchema = z
  .object({
    allowed: z.array(codeEnvironmentPermissionDecisionSchema).min(1),
    default: codeEnvironmentPermissionDecisionSchema.optional().default('ask'),
  })
  .strict()
  .superRefine((field, context) => {
    if (!field.allowed.includes(field.default)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: 'Permission default must be included in allowed values',
      });
    }
  });

/** Existing attached commands used a fixed 30-second execution budget. */
export const CODE_ENVIRONMENT_COMMAND_TIMEOUT_DEFAULT_MS = 30_000;
/** Protocol-level ceiling; deployments may only lower this value. */
export const CODE_ENVIRONMENT_COMMAND_TIMEOUT_HARD_MAX_MS = 5 * 60_000;

/**
 * Typed user-tunable surface for one attached code environment. Omitted fields
 * remain fixed at LibreChat's safe baseline. Isolation, networking, mounts,
 * privileged execution, and secrets are deliberately not representable here.
 */
export const codeEnvironmentUserConfigSchema = z
  .object({
    permissions: z
      .object({
        fileWrite: codeEnvironmentPermissionFieldSchema.optional(),
        commandExecution: codeEnvironmentPermissionFieldSchema.optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        /** Maximum timeout a Bash invocation may request. Omission preserves
         * the historical 30-second command budget. */
        maxCommandTimeoutMs: z
          .number()
          .int()
          .min(1)
          .max(CODE_ENVIRONMENT_COMMAND_TIMEOUT_HARD_MAX_MS)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CodeEnvironmentUserConfigSchema = z.infer<typeof codeEnvironmentUserConfigSchema>;

export const codeEnvironmentUserSettingsSchema = z
  .object({
    permissions: z
      .object({
        fileWrite: codeEnvironmentPermissionDecisionSchema.optional(),
        commandExecution: codeEnvironmentPermissionDecisionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CodeEnvironmentUserSettings = z.infer<typeof codeEnvironmentUserSettingsSchema>;

export type CodeWorkerEnrollmentPolicy = NonNullable<
  NonNullable<z.infer<typeof agentsEndpointSchema>['statefulCodeSessions']>['principalWorkers']
>;

export const agentsEndpointSchema = baseEndpointSchema
  .omit({ baseURL: true })
  .merge(
    z.object({
      /* agents specific */
      recursionLimit: z.number().optional(),
      disableBuilder: z.boolean().optional().default(false),
      maxRecursionLimit: z.number().optional(),
      /** Max cumulative bytes a single streamed tool call's arguments may reach before the run
       * aborts. Defaults to 64 KiB in the agents SDK; `0` disables the guard. */
      maxToolCallArgBytes: z.number().optional(),
      /** Max streamed chunk events per model generation before the run aborts. Off by default. */
      maxDeltaEventsPerTurn: z.number().optional(),
      /** Per-tool overrides of `maxToolCallArgBytes`, keyed by model-facing tool name; `0`
       * disables the guard for that tool only. Merged over LibreChat's shipped default of
       * `{ create_file: 131072 }`. */
      maxToolCallArgBytesByTool: z.record(z.number()).optional(),
      /** Characters of retained tool output the save path may tokenize exactly for the
       * context gauge when a turn stops at the tool-call limit (see
       * `retainedToolTokens`). Tokenizing costs ~60 ms/MB and runs once per stopped
       * turn; past this ceiling the figure is withdrawn rather than estimated, so the
       * gauge under-reports that turn instead of blocking the save. Raise it for
       * deployments whose tools legitimately return more, lower it on slow hardware. */
      maxRetainedToolCountChars: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(DEFAULT_MAX_RETAINED_TOOL_COUNT_CHARS),
      maxCitations: z.number().min(1).max(50).optional().default(30),
      maxCitationsPerFile: z.number().min(1).max(10).optional().default(7),
      minRelevanceScore: z.number().min(0.0).max(1.0).optional().default(0.45),
      /** Maximum explicit subagents per agent (`agent_ids` and `graphs`); raised from
       * the shipped default of 10 for orchestration-heavy deployments, bounded by
       * `MAX_SUBAGENTS_CEILING`. */
      maxSubagents: z
        .number()
        .int()
        .min(1)
        .max(MAX_SUBAGENTS_CEILING)
        .optional()
        .default(MAX_SUBAGENTS),
      /** Run-scoped file access for explicitly opted-in subagent delegations. */
      fileSharing: z
        .object({
          enabled: z.boolean().optional().default(false),
          allowSiblingSharing: z.boolean().optional().default(false),
          maxFiles: z.number().int().min(1).max(1_000).optional().default(100),
          /** Aggregate disk budget for private output versions retained during a run. */
          maxPrivateBytes: z
            .number()
            .int()
            .min(1)
            .max(10_737_418_240)
            .optional()
            .default(268_435_456),
          ttlMs: z.number().int().min(1).max(86_400_000).optional().default(3_600_000),
        })
        .optional(),
      /** Maximum concurrent Code API uploads per route and authenticated principal. */
      codeApiUploadConcurrency: z.number().int().min(1).max(100).optional().default(3),
      /** Maximum wall-clock time spent waiting on Code API rate limits per operation. */
      codeApiMaxRetryWaitMs: z.number().int().min(0).max(300_000).optional().default(20_000),
      allowedProviders: z.array(z.union([z.string(), eModelEndpointSchema])).optional(),
      capabilities: z
        .array(z.nativeEnum(AgentCapabilities))
        .optional()
        .default(defaultAgentCapabilities),
      /** Controls which workspace-sharing scopes users may select for stateful code sessions.
       *  Omit this block to preserve the legacy behavior of allowing every scope. */
      statefulCodeSessions: z
        .object({
          allowedEnvironments: z.array(z.enum(STATEFUL_CODE_ENVIRONMENTS)).min(1),
          /** Server-only personal worker enrollment policy. Effective principal
           * policy may tighten, but never raise, the deployment ceiling. */
          principalWorkers: z
            .object({
              enabled: z.boolean().optional(),
              /** Defaults to five. Zero disables enrollment; existing machines remain usable. */
              maxPerUser: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
            })
            .optional(),
          /** Operator-managed execution environments. Attached entries route to a
           * Code API deployment backed by an outbound librechat-code worker. */
          environments: z
            .array(
              z.object({
                id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
                name: z.string().min(1).max(100),
                type: z.enum(['managed', 'attached']),
                baseURL: codeEnvironmentBaseURLSchema,
                default: z.boolean().optional(),
                /** Server-only outbound worker route. Removed from public config. */
                workerId: z
                  .string()
                  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
                  .optional(),
                /** Distinguishes operator policy from a principal-authorized
                 * environment merged into request-scoped server config. */
                owner: z.enum(['deployment', 'principal']).optional().default('deployment'),
                /** Administrator-controlled user-tunable settings. Only fields
                 * represented here may be changed by a principal. */
                configSchema: codeEnvironmentUserConfigSchema.optional(),
                /** Request-scoped effective settings for a principal-owned environment.
                 * Deployment config should define defaults through configSchema instead. */
                settings: codeEnvironmentUserSettingsSchema.optional(),
                /** Server-only enrollment metadata. `tokenEnv` names an
                 * environment variable and never contains the token itself. */
                pairing: z
                  .object({
                    workerId: z
                      .string()
                      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
                      .optional(),
                    allowPrincipalWorkers: z.boolean().optional().default(false),
                    tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                  })
                  .superRefine((pairing, pairingContext) => {
                    if (pairing.workerId != null || pairing.allowPrincipalWorkers === true) {
                      return;
                    }
                    pairingContext.addIssue({
                      code: z.ZodIssueCode.custom,
                      message: 'Pairing requires a workerId or principal workers',
                    });
                  })
                  .optional(),
              }),
            )
            .optional(),
        })
        .superRefine((value, context) => {
          if (!value?.environments) return;
          const ids = new Set<string>();
          let defaults = 0;
          let executableEnvironments = 0;
          for (const environment of value.environments) {
            const pairingOnly =
              environment.pairing?.allowPrincipalWorkers === true &&
              environment.pairing.workerId == null &&
              environment.workerId == null;
            if (environment.pairing != null && environment.type !== 'attached') {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Only attached code environments may configure pairing',
                path: ['environments', environment.id, 'pairing'],
              });
            }
            if (environment.pairing != null && environment.owner !== 'deployment') {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Only deployment-owned code environments may configure pairing',
                path: ['environments', environment.id, 'pairing'],
              });
            }
            if (
              environment.pairing != null &&
              !isSecureCodeEnvironmentControlURL(environment.baseURL)
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Paired code environments require HTTPS outside loopback development',
                path: ['environments', environment.id, 'baseURL'],
              });
            }
            if (
              environment.workerId != null &&
              environment.pairing?.workerId != null &&
              environment.workerId !== environment.pairing.workerId
            ) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Code environment workerId must match pairing.workerId',
                path: ['environments', environment.id, 'workerId'],
              });
            }
            if (pairingOnly && environment.default === true) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Pairing-only code control planes cannot be execution defaults',
                path: ['environments', environment.id, 'default'],
              });
            }
            if (ids.has(environment.id)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Duplicate code environment id: ${environment.id}`,
                path: ['environments'],
              });
            }
            ids.add(environment.id);
            if (!pairingOnly) {
              executableEnvironments += 1;
              if (environment.default === true) defaults += 1;
            }
          }
          if (executableEnvironments > 0 && defaults !== 1) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Exactly one stateful code environment must be the default',
              path: ['environments'],
            });
          }
        })
        .optional(),
      /** Optional trusted origin for in-process agent event delivery. */
      eventDriven: z
        .object({
          selfUrl: z.string().url().optional(),
        })
        .optional(),
      /** Conversational background-task delivery policy. Automatic completion wakeups are
       * enabled unless an administrator explicitly restores poll-only behavior. */
      backgroundTasks: z
        .object({
          completionWakeups: z.boolean().optional().default(true),
          /** Cooperative cancellation for process-local ordinary tools. Off
           * by default so existing deployments opt into the new control. */
          ordinaryToolCancellation: z.boolean().optional().default(false),
        })
        .optional(),
      skills: z
        .object({
          maxCatalogSkills: z.number().int().min(1).max(100).optional(),
        })
        .optional(),
      managementApi: managementApiSchema.optional(),
      remoteApi: remoteApiSchema.optional(),
      /** Human-in-the-loop tool approval policy. Off by default. */
      toolApproval: toolApprovalPolicySchema,
      /** Durable checkpointer backing tool-approval and Ask User resume.
       *  Defaults to the app's MongoDB when either flow needs it. */
      checkpointer: checkpointerSchema,
    }),
  )
  .default({
    disableBuilder: false,
    capabilities: defaultAgentCapabilities,
    maxCitations: 30,
    maxCitationsPerFile: 7,
    minRelevanceScore: 0.45,
    maxSubagents: MAX_SUBAGENTS,
  });

export type TAgentsEndpoint = z.infer<typeof agentsEndpointSchema>;

export const paramDefinitionSchema = z.object({
  key: z.string(),
  description: z.string().optional(),
  type: z.nativeEnum(SettingTypes).optional(),
  default: z.union([z.number(), z.boolean(), z.string(), z.array(z.string())]).optional(),
  showLabel: z.boolean().optional(),
  showDefault: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  range: z
    .object({
      min: z.number(),
      max: z.number(),
      step: z.number().optional(),
      positiveMin: z.number().optional(),
    })
    /** A floor above the ceiling admits nothing but the sentinel, while the
     *  clamp maps every non-negative input onto a maximum the generated schema
     *  then rejects. */
    .refine((value) => value.positiveMin == null || value.positiveMin <= value.max, {
      message: 'range.positiveMin cannot exceed range.max',
      path: ['positiveMin'],
    })
    .optional(),
  enumMappings: z.record(z.union([z.number(), z.boolean(), z.string()])).optional(),
  component: z.nativeEnum(ComponentTypes).optional(),
  optionType: z.nativeEnum(OptionTypes).optional(),
  columnSpan: z.number().int().nonnegative().optional(),
  columns: z.number().int().min(1).max(4).optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  labelCode: z.boolean().optional(),
  placeholderCode: z.boolean().optional(),
  descriptionCode: z.boolean().optional(),
  minText: z.number().optional(),
  maxText: z.number().optional(),
  minTags: z.number().min(0).optional(),
  maxTags: z.number().min(0).optional(),
  includeInput: z.boolean().optional(),
  descriptionSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
  searchPlaceholder: z.string().optional(),
  selectPlaceholder: z.string().optional(),
  searchPlaceholderCode: z.boolean().optional(),
  selectPlaceholderCode: z.boolean().optional(),
});

export const endpointSchema = baseEndpointSchema.merge(
  z.object({
    name: z.string().refine((value) => !eModelEndpointSchema.safeParse(value).success, {
      message: `Value cannot be one of the default endpoint (EModelEndpoint) values: ${Object.values(
        EModelEndpoint,
      ).join(', ')}`,
    }),
    apiKey: z.string(),
    /** Masked preview of the API key, stored at write time so admin
     * reads can show which key is configured without returning the secret. */
    apiKeyPreview: z.string().optional(),
    baseURL: z.string(),
    models: z.object({
      default: z.array(modelItemSchema).min(1),
      fetch: z.boolean().optional(),
      userIdQuery: z.boolean().optional(),
    }),
    iconURL: z.string().optional(),
    modelDisplayLabel: z.string().optional(),
    /**
     * Forces the endpoint to use a provider's native client / request format
     * instead of the default OpenAI-compatible client. Currently supports
     * `anthropic`, for endpoints that speak the Anthropic `/v1/messages` API
     * (Anthropic itself or Anthropic-compatible gateways). Omit for
     * OpenAI-compatible endpoints.
     */
    provider: z.literal(EModelEndpoint.anthropic).optional(),
    headers: z.record(z.string()).optional(),
    addParams: addParamsSchema.optional(),
    dropParams: z.array(z.string()).optional(),
    customParams: z
      .object({
        defaultParamsEndpoint: z.string().default('custom'),
        reasoningFormat: eReasoningParameterFormatSchema.optional(),
        reasoningKey: eReasoningResponseKeySchema.optional(),
        /** Replays `reasoning_content` within a run's tool-call turns (e.g. Xiaomi MiMo, Kimi). */
        includeReasoningContent: z.boolean().optional(),
        /** Also reconstructs `reasoning_content` from persisted history across turns (implies `includeReasoningContent`). */
        includeReasoningHistory: z.boolean().optional(),
        paramDefinitions: z.array(paramDefinitionSchema).optional(),
      })
      .strict()
      .optional(),
    directEndpoint: z.boolean().optional(),
    titleMessageRole: z.enum(['system', 'user', 'assistant']).optional(),
    /** Static per-model token config: context window and per-million-token rates */
    tokenConfig: z
      .record(
        z.object({
          prompt: z.number(),
          completion: z.number(),
          context: z.number(),
          cacheRead: z.number().optional(),
          cacheWrite: z.number().optional(),
        }),
      )
      .optional(),
  }),
);

export type TEndpoint = z.infer<typeof endpointSchema>;

export const azureEndpointSchema = z
  .object({
    groups: azureGroupConfigsSchema,
    assistants: z.boolean().optional(),
  })
  .and(
    /**
     * Azure carries only the base-endpoint fields enumerated here. This is a
     * `.pick()`, NOT an omit, so a field added to `baseEndpointSchema` is
     * silently unavailable on Azure endpoints until it is listed below —
     * unlike `endpoints.all`, which omits and therefore inherits new fields
     * automatically. Keep this list in sync when adding endpoint options.
     */
    endpointSchema
      .pick({
        streamRate: true,
        titleConvo: true,
        titleMethod: true,
        titleModel: true,
        titlePrompt: true,
        titleTiming: true,
        titlePromptTemplate: true,
        activityLabel: true,
        activityModel: true,
        activityEndpoint: true,
        activityPrompt: true,
        activityMaxPerRun: true,
        activityCharLimit: true,
        activityPhaseLabel: true,
        activityPhaseModel: true,
        activityPhaseEndpoint: true,
        activityPhasePrompt: true,
        activityPhaseMaxPerRun: true,
        reasoningLabel: true,
        reasoningLabelModel: true,
        reasoningLabelEndpoint: true,
        reasoningLabelPrompt: true,
        reasoningLabelMinChars: true,
        reasoningLabelUpdateChars: true,
        reasoningLabelUpdateIntervalMs: true,
        reasoningLabelMaxPerRun: true,
      })
      .partial(),
  );

export type TAzureConfig = Omit<z.infer<typeof azureEndpointSchema>, 'groups'> &
  TAzureConfigValidationResult;

/**
 * Vertex AI model configuration - similar to Azure model config
 * Allows specifying deployment name for each model
 */
export const vertexModelConfigSchema = z
  .object({
    /** The actual model ID/deployment name used by Vertex AI API */
    deploymentName: z.string().optional(),
  })
  .or(z.boolean());

export type TVertexModelConfig = z.infer<typeof vertexModelConfigSchema>;

/**
 * Vertex AI configuration schema for Anthropic models served via Google Cloud Vertex AI.
 * Similar to Azure configuration, this allows running Anthropic models through Google Cloud.
 */
export const vertexAISchema = z.object({
  /** Enable Vertex AI mode for Anthropic (defaults to true when vertex config is present) */
  enabled: z.boolean().optional(),
  /** Google Cloud Project ID (optional - auto-detected from service key file if not provided) */
  projectId: z.string().optional(),
  /** Vertex AI region (e.g., 'us-east5', 'europe-west1') */
  region: z.string().default('us-east5'),
  /** Optional: Path to service account key file */
  serviceKeyFile: z.string().optional(),
  /** Optional: Default deployment name for all models (can be overridden per model) */
  deploymentName: z.string().optional(),
  /** Optional: Available models - can be string array or object with deploymentName mapping */
  models: z.union([z.array(z.string()), z.record(z.string(), vertexModelConfigSchema)]).optional(),
});

export type TVertexAISchema = z.infer<typeof vertexAISchema>;

export type TVertexModelMap = Record<string, string>;

/**
 * Validated Vertex AI configuration result
 */
export type TVertexAIConfig = TVertexAISchema & {
  isValid: boolean;
  errors: string[];
  modelNames?: string[];
  modelDeploymentMap?: TVertexModelMap;
};

/**
 * Anthropic endpoint schema with optional Vertex AI configuration.
 * Extends baseEndpointSchema with Vertex AI support.
 */
export const anthropicEndpointSchema = baseEndpointSchema.merge(
  z.object({
    /** Vertex AI configuration for running Anthropic models on Google Cloud */
    vertex: vertexAISchema.optional(),
    /** Optional: List of available models */
    models: z.array(z.string()).optional(),
  }),
);

export type TAnthropicEndpoint = z.infer<typeof anthropicEndpointSchema>;

/** Masked preview of the API key, stored at write time so admin
 * reads can show which key is configured without returning the secret. */
const apiKeyPreviewSchema = z.string().optional();

const ttsOpenaiSchema = z.object({
  url: z.string().optional(),
  apiKey: z.string(),
  apiKeyPreview: apiKeyPreviewSchema,
  model: z.string(),
  voices: z.array(z.string()),
});

const ttsAzureOpenAISchema = z.object({
  instanceName: z.string(),
  apiKey: z.string(),
  apiKeyPreview: apiKeyPreviewSchema,
  deploymentName: z.string(),
  apiVersion: z.string(),
  model: z.string(),
  voices: z.array(z.string()),
});

const ttsElevenLabsSchema = z.object({
  url: z.string().optional(),
  websocketUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyPreview: apiKeyPreviewSchema,
  model: z.string(),
  voices: z.array(z.string()),
  voice_settings: z
    .object({
      similarity_boost: z.number().optional(),
      stability: z.number().optional(),
      style: z.number().optional(),
      use_speaker_boost: z.boolean().optional(),
    })
    .optional(),
  pronunciation_dictionary_locators: z.array(z.string()).optional(),
});

const ttsLocalaiSchema = z.object({
  url: z.string(),
  apiKey: z.string().optional(),
  apiKeyPreview: apiKeyPreviewSchema,
  voices: z.array(z.string()),
  backend: z.string(),
});

const ttsSchema = z.object({
  allowedAddresses: allowedAddressesSchema,
  openai: ttsOpenaiSchema.optional(),
  azureOpenAI: ttsAzureOpenAISchema.optional(),
  elevenlabs: ttsElevenLabsSchema.optional(),
  localai: ttsLocalaiSchema.optional(),
});

const sttOpenaiSchema = z.object({
  url: z.string().optional(),
  apiKey: z.string(),
  apiKeyPreview: apiKeyPreviewSchema,
  model: z.string(),
});

const sttAzureOpenAISchema = z.object({
  instanceName: z.string(),
  apiKey: z.string(),
  apiKeyPreview: apiKeyPreviewSchema,
  deploymentName: z.string(),
  apiVersion: z.string(),
});

const sttSchema = z.object({
  allowedAddresses: allowedAddressesSchema,
  openai: sttOpenaiSchema.optional(),
  azureOpenAI: sttAzureOpenAISchema.optional(),
});

/**
 * The speech providers a schema actually configures. `allowedAddresses` is transport
 * policy rather than a provider, and a provider key present but empty configures
 * nothing. The speech services accept a schema only when exactly one survives here, so
 * the upload router reads availability from the same list and never routes audio to a
 * transcription that cannot run.
 */
export function listConfiguredSpeechProviders(
  schema?: Record<string, unknown> | null,
): Array<[string, Record<string, unknown>]> {
  if (schema == null) {
    return [];
  }
  return Object.entries(schema).filter(
    ([key, value]) =>
      key !== 'allowedAddresses' &&
      value != null &&
      typeof value === 'object' &&
      Object.keys(value).length > 0,
  ) as Array<[string, Record<string, unknown>]>;
}

/** Whether a speech schema names exactly one usable provider. */
export function isSpeechProviderConfigured(schema?: Record<string, unknown> | null): boolean {
  return listConfiguredSpeechProviders(schema).length === 1;
}

const speechTab = z
  .object({
    conversationMode: z.boolean().optional(),
    advancedMode: z.boolean().optional(),
    speechToText: z
      .boolean()
      .optional()
      .or(
        z.object({
          /** Provider names remain valid for backward compatibility and are normalized for clients. */
          engineSTT: z.enum(['browser', 'external', 'openai', 'azureOpenAI']).optional(),
          languageSTT: z.string().optional(),
          autoTranscribeAudio: z.boolean().optional(),
          decibelValue: z.number().optional(),
          autoSendText: z.number().optional(),
        }),
      )
      .optional(),
    textToSpeech: z
      .boolean()
      .optional()
      .or(
        z.object({
          /** Provider names remain valid for backward compatibility and are normalized for clients. */
          engineTTS: z
            .enum(['browser', 'external', 'openai', 'azureOpenAI', 'elevenlabs', 'localai'])
            .optional(),
          voice: z.string().optional(),
          languageTTS: z.string().optional(),
          automaticPlayback: z.boolean().optional(),
          playbackRate: z.number().min(0.25).max(4).optional(),
          cacheTTS: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .optional();

export enum RateLimitPrefix {
  FILE_UPLOAD = 'FILE_UPLOAD',
  IMPORT = 'IMPORT',
  TTS = 'TTS',
  STT = 'STT',
}

export const rateLimitSchema = z.object({
  agentEvents: z
    .object({
      userMax: z.number().int().positive().optional(),
      userWindowInMinutes: z.number().positive().optional(),
    })
    .optional(),
  fileUploads: z
    .object({
      ipMax: z.number().optional(),
      ipWindowInMinutes: z.number().optional(),
      userMax: z.number().optional(),
      userWindowInMinutes: z.number().optional(),
    })
    .optional(),
  conversationsImport: z
    .object({
      ipMax: z.number().optional(),
      ipWindowInMinutes: z.number().optional(),
      userMax: z.number().optional(),
      userWindowInMinutes: z.number().optional(),
    })
    .optional(),
  tts: z
    .object({
      ipMax: z.number().optional(),
      ipWindowInMinutes: z.number().optional(),
      userMax: z.number().optional(),
      userWindowInMinutes: z.number().optional(),
    })
    .optional(),
  stt: z
    .object({
      ipMax: z.number().optional(),
      ipWindowInMinutes: z.number().optional(),
      userMax: z.number().optional(),
      userWindowInMinutes: z.number().optional(),
    })
    .optional(),
});

export enum EImageOutputType {
  PNG = 'png',
  WEBP = 'webp',
  JPEG = 'jpeg',
}

const termsOfServiceSchema = z.object({
  externalUrl: z.string().optional(),
  openNewTab: z.boolean().optional(),
  modalAcceptance: z.boolean().optional(),
  modalTitle: z.string().optional(),
  modalContent: z.string().or(z.array(z.string())).optional(),
});

export type TTermsOfService = z.infer<typeof termsOfServiceSchema>;

// Schema for localized string (either simple string or language-keyed object)
const localizedStringSchema = z.union([z.string(), z.record(z.string())]);
export type LocalizedString = z.infer<typeof localizedStringSchema>;

export const mcpRefreshDefaults = {
  toolsRefreshInterval: 5 * 60 * 1000,
  statusRefreshInterval: 30 * 1000,
};

const mcpServersSchema = z
  .object({
    /** Foreground polling intervals in milliseconds; 0 disables polling. */
    toolsRefreshInterval: z.number().int().nonnegative().max(2_147_483_647).optional(),
    statusRefreshInterval: z.number().int().nonnegative().max(2_147_483_647).optional(),
    placeholder: z.string().optional(),
    use: z.boolean().optional(),
    create: z.boolean().optional(),
    share: z.boolean().optional(),
    public: z.boolean().optional(),
    configureObo: z.boolean().optional(),
    trustCheckbox: z
      .object({
        label: localizedStringSchema.optional(),
        subLabel: localizedStringSchema.optional(),
      })
      .optional(),
  })
  .optional();

export type TMcpServersConfig = z.infer<typeof mcpServersSchema>;

/** Values the trace viewer uses for any `interface.traceViewer` field left unset. */
export const traceViewerDefaults = {
  enabled: false,
  showInputOutput: false,
  maxRecords: 1000,
  maxContentLength: 50_000,
  requestsPerMinute: 30,
  requestTimeoutMs: 10_000,
} as const;

type TraceViewerLimitField =
  | 'maxRecords'
  | 'maxContentLength'
  | 'requestsPerMinute'
  | 'requestTimeoutMs';

/** Inclusive bounds for the numeric `interface.traceViewer` fields. */
export const traceViewerLimits: Readonly<
  Record<TraceViewerLimitField, { readonly min: number; readonly max: number }>
> = {
  maxRecords: { min: 1, max: 10_000 },
  maxContentLength: { min: 1, max: 1_000_000 },
  requestsPerMinute: { min: 1, max: 1000 },
  requestTimeoutMs: { min: 1000, max: 300_000 },
};

const boundedIntegerSchema = (field: TraceViewerLimitField) =>
  z.number().int().min(traceViewerLimits[field].min).max(traceViewerLimits[field].max).optional();

const traceViewerSchema = z.object({
  /** Shows the conversation trace control for traces this deployment exported. */
  enabled: z.boolean().optional(),
  /** Returns observation input, output and metadata in the record inspector. */
  showInputOutput: z.boolean().optional(),
  /** Observations read from the tracing backend per request. */
  maxRecords: boundedIntegerSchema('maxRecords'),
  /** Characters kept from each input, output and metadata value before truncation. */
  maxContentLength: boundedIntegerSchema('maxContentLength'),
  /** Trace reads one user may start per minute. */
  requestsPerMinute: boundedIntegerSchema('requestsPerMinute'),
  /** Budget for each round trip to the tracing backend, in milliseconds. */
  requestTimeoutMs: boundedIntegerSchema('requestTimeoutMs'),
});

export type TTraceViewerConfig = z.infer<typeof traceViewerSchema>;
export type TResolvedTraceViewerConfig = {
  enabled: boolean;
  showInputOutput: boolean;
} & Record<TraceViewerLimitField, number>;

function boundedInteger(value: unknown, field: TraceViewerLimitField): number {
  const { min, max } = traceViewerLimits[field];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
    ? Math.min(value, max)
    : traceViewerDefaults[field];
}

/**
 * Fills unset or invalid `interface.traceViewer` fields from
 * {@link traceViewerDefaults}. Admin config overrides reach runtime without
 * schema validation, so every consumer reads the section through this.
 */
export function resolveTraceViewerConfig(
  config?: Partial<Record<keyof TTraceViewerConfig, unknown>> | null,
): TResolvedTraceViewerConfig {
  return {
    enabled: config?.enabled === true,
    showInputOutput: config?.showInputOutput === true,
    maxRecords: boundedInteger(config?.maxRecords, 'maxRecords'),
    maxContentLength: boundedInteger(config?.maxContentLength, 'maxContentLength'),
    requestsPerMinute: boundedInteger(config?.requestsPerMinute, 'requestsPerMinute'),
    requestTimeoutMs: boundedInteger(config?.requestTimeoutMs, 'requestTimeoutMs'),
  };
}

export enum RetentionMode {
  ALL = 'all',
  TEMPORARY = 'temporary',
}

export const interfaceSchema = z
  .object({
    privacyPolicy: z
      .object({
        externalUrl: z.string().optional(),
        openNewTab: z.boolean().optional(),
      })
      .optional(),
    termsOfService: termsOfServiceSchema.optional(),
    customWelcome: z.string().optional(),
    mcpServers: mcpServersSchema.optional(),
    modelSelect: z.boolean().optional(),
    parameters: z.boolean().optional(),
    multiConvo: z.boolean().optional(),
    bookmarks: z.boolean().optional(),
    memories: z.boolean().optional(),
    presets: z.boolean().optional(),
    prompts: z
      .union([
        z.boolean(),
        z.object({
          use: z.boolean().optional(),
          create: z.boolean().optional(),
          share: z.boolean().optional(),
          public: z.boolean().optional(),
        }),
      ])
      .optional(),
    agents: z
      .union([
        z.boolean(),
        z.object({
          use: z.boolean().optional(),
          create: z.boolean().optional(),
          share: z.boolean().optional(),
          public: z.boolean().optional(),
        }),
      ])
      .optional(),
    temporaryChat: z.boolean().optional(),
    temporaryChatRetention: z.number().min(1).max(8760).optional(),
    generalChatRetention: z.number().min(1).max(8760).optional(),
    autoSubmitFromUrl: z.boolean().optional(),
    retentionMode: z.nativeEnum(RetentionMode).default(RetentionMode.TEMPORARY),
    retainAgentFiles: z.boolean().optional(),
    runCode: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    contextUsage: z.boolean().optional(),
    contextCost: z.boolean().optional(),
    feedback: z.boolean().optional(),
    currency: z
      .object({
        code: z.string(),
        rate: z.number().positive(),
      })
      .optional(),
    peoplePicker: z
      .object({
        users: z.boolean().optional(),
        groups: z.boolean().optional(),
        roles: z.boolean().optional(),
      })
      .optional(),
    marketplace: z
      .object({
        use: z.boolean().optional(),
      })
      .optional(),
    fileSearch: z.boolean().optional(),
    fileCitations: z.boolean().optional(),
    traceViewer: traceViewerSchema.optional(),
    /** Tool keys (and `'mcp'` or an MCP server name) pinned to the prompt bar by default */
    defaultPinnedTools: z.array(z.string()).optional(),
    buildInfo: z.boolean().optional(),
    remoteAgents: z
      .object({
        use: z.boolean().optional(),
        create: z.boolean().optional(),
        share: z.boolean().optional(),
        public: z.boolean().optional(),
      })
      .optional(),
    skills: z
      .union([
        z.boolean(),
        z.object({
          use: z.boolean().optional(),
          create: z.boolean().optional(),
          share: z.boolean().optional(),
          public: z.boolean().optional(),
          defaultActiveOnShare: z.boolean().optional(),
        }),
      ])
      .optional(),
    sharedLinks: z
      .union([
        z.boolean(),
        z.object({
          create: z.boolean().optional(),
          share: z.boolean().optional(),
          public: z.boolean().optional(),
          snapshotFiles: z.boolean().optional(),
        }),
      ])
      .optional(),
    schedules: z
      .union([
        z.boolean(),
        z.object({
          use: z.boolean().optional(),
          create: z.boolean().optional(),
          maxPerUser: z.number().int().min(0).optional(),
          minIntervalMinutes: z.number().int().min(1).optional(),
          autoDisableAfterFailures: z.number().int().min(1).optional(),
          admissionConcurrency: z.number().int().min(1).max(100).optional(),
          fireConcurrency: z.number().int().min(1).optional(),
          mcpPreflightConcurrency: z.number().int().min(1).max(10).optional(),
          mcpPreflightTimeoutMs: z.number().int().min(1000).max(600000).optional(),
          /** Refuse schedules that are not filed under a chat project. Enforced on
           *  create/update AND at every fire, so raising it later stops schedules
           *  that predate the policy instead of grandfathering them. */
          requireProject: z.boolean().optional(),
          /** Pins every scheduled run to ONE chat project, ignoring any client
           *  choice. Implies `requireProject`. The project must belong to the
           *  schedule's owner, so a deployment-wide value only makes sense with a
           *  per-user/per-role config override. */
          projectId: z.string().trim().min(1).optional(),
        }),
      ])
      .optional(),
  })
  .default({
    modelSelect: true,
    parameters: true,
    presets: true,
    multiConvo: true,
    bookmarks: true,
    memories: true,
    prompts: {
      use: true,
      create: true,
      share: false,
      public: false,
    },
    agents: {
      use: true,
      create: true,
      share: false,
      public: false,
    },
    temporaryChat: true,
    autoSubmitFromUrl: true,
    runCode: true,
    webSearch: true,
    contextUsage: true,
    contextCost: false,
    feedback: true,
    peoplePicker: {
      users: true,
      groups: true,
      roles: true,
    },
    marketplace: {
      use: false,
    },
    mcpServers: {
      use: true,
      create: true,
      share: false,
      public: false,
    },
    fileSearch: true,
    fileCitations: true,
    buildInfo: true,
    remoteAgents: {
      use: false,
      create: false,
      share: false,
      public: false,
    },
    skills: {
      use: true,
      create: true,
      share: false,
      public: false,
      defaultActiveOnShare: false,
    },
    sharedLinks: {
      create: true,
      share: true,
      public: true,
      snapshotFiles: true,
    },
    // `schedules` is deliberately ABSENT from this default. It is experimental and
    // default-off in v1, and zod applies this whole object when `interface` is omitted
    // from librechat.yaml — including it would silently enable the feature (and permit
    // billable scheduled runs) on every deployment that never opted in. The PERMISSION
    // defaults live in updateInterfacePermissions, which is a separate concern.
  });

export type TInterfaceConfig = z.infer<typeof interfaceSchema>;
export type TBalanceConfig = z.infer<typeof balanceSchema>;
export type TTransactionsConfig = z.infer<typeof transactionsSchema>;

export const turnstileOptionsSchema = z
  .object({
    language: z.string().default('auto'),
    size: z.enum(['normal', 'compact', 'flexible', 'invisible']).default('normal'),
  })
  .default({
    language: 'auto',
    size: 'normal',
  });

export const turnstileSchema = z.object({
  siteKey: z.string(),
  options: turnstileOptionsSchema.optional(),
});

export type TTurnstileConfig = z.infer<typeof turnstileSchema>;

export type TRumConfig = {
  provider: 'hyperdx';
  enabled: boolean;
  url: string;
  serviceName: string;
  authMode: 'publicToken' | 'proxy';
  publicToken?: string;
  tracePropagationTargets?: string[];
  consoleCapture?: boolean;
  disableReplay?: boolean;
  advancedNetworkCapture?: boolean;
  sampleRate?: number;
  environment?: string;
};

export type StartupConfigContext = 'share';

/**
 * Per-endpoint dropParams for the startup config. Most endpoints (e.g. `custom`) map a
 * provider name directly to its dropParams. `azureOpenAI` instead maps a provider name to
 * a per-model dropParams lookup, since each Azure group can drop different parameters.
 */
export type EndpointsDropParamsMap = Record<string, string[] | Record<string, string[]>>;

export type TStartupConfig = {
  appTitle: string;
  socialLogins?: string[];
  langfuseFanoutEnabled?: boolean;
  langfuseConnectionAccess?: boolean;
  insightsEnabled?: boolean;
  /** Manual context compaction, gated by the same `summarization.enabled`
   *  switch that governs the automatic detour. */
  compactionEnabled?: boolean;
  /** Conversation-owned code-environment decision protocol supported by the API.
   * Clients must not emit selection-less decisions unless this is advertised. */
  codeEnvironmentDecisionVersion?: typeof CODE_ENVIRONMENT_DECISION_VERSION;
  interface?: TInterfaceConfig;
  turnstile?: TTurnstileConfig;
  balance?: TBalanceConfig;
  transactions?: TTransactionsConfig;
  discordLoginEnabled: boolean;
  facebookLoginEnabled: boolean;
  githubLoginEnabled: boolean;
  googleLoginEnabled: boolean;
  openidLoginEnabled: boolean;
  appleLoginEnabled: boolean;
  samlLoginEnabled: boolean;
  openidLabel: string;
  openidImageUrl: string;
  openidAutoRedirect: boolean;
  samlLabel: string;
  samlImageUrl: string;
  /** LDAP Auth Configuration */
  ldap?: {
    /** LDAP enabled */
    enabled: boolean;
    /** Whether LDAP uses username vs. email */
    username?: boolean;
  };
  serverDomain: string;
  emailLoginEnabled: boolean;
  registrationEnabled: boolean;
  socialLoginEnabled: boolean;
  passwordResetEnabled: boolean;
  emailEnabled: boolean;
  showBirthdayIcon: boolean;
  helpAndFaqURL: string;
  /** Admin panel link, only present for users with admin access */
  adminPanelURL?: string;
  customFooter?: string;
  modelSpecs?: TSpecsConfig;
  modelDescriptions?: Record<string, Record<string, string>>;
  sharedLinksEnabled: boolean;
  publicSharedLinksEnabled: boolean;
  /** Whether shared links snapshot conversation files (gates the per-link "share files" checkbox). */
  sharedLinksSnapshotFilesEnabled?: boolean;
  /** Effective default timing for when conversation titles become fetchable.
   * `immediate` = fetch in parallel with the active stream (default);
   * `final` = fetch only after the stream completes (legacy). */
  titleGenerationTiming?: 'immediate' | 'final';
  analyticsGtmId?: string;
  rum?: TRumConfig;
  bundlerURL?: string;
  staticBundlerURL?: string;
  sharePointFilePickerEnabled?: boolean;
  sharePointBaseUrl?: string;
  sharePointPickerGraphScope?: string;
  sharePointPickerSharePointScope?: string;
  openidReuseTokens?: boolean;
  allowAccountDeletion: boolean;
  minPasswordLength?: number;
  webSearch?: {
    searchProvider?: SearchProviders;
    scraperProvider?: ScraperProviders;
    rerankerType?: RerankerTypes;
  };
  cloudFront?: {
    cookieRefresh?: {
      endpoint: string;
      domain: string;
    };
  };
  mcpServers?: Record<
    string,
    {
      customUserVars: Record<
        string,
        {
          title: string;
          description: string;
        }
      >;
      chatMenu?: boolean;
      isOAuth?: boolean;
      startup?: boolean;
      iconPath?: string;
    }
  >;
  mcpPlaceholder?: string;
  conversationImportMaxFileSize?: number;
  buildInfo?: {
    commit?: string | null;
    commitShort?: string | null;
    branch?: string | null;
    buildDate?: string | null;
  };
  fileUploadSseEnabled?: boolean;
  endpointsDropParamsMap?: EndpointsDropParamsMap;
};

export type TSharedLinkStartupInterface = Pick<
  Partial<TInterfaceConfig>,
  'privacyPolicy' | 'termsOfService'
>;

export type TSharedLinkStartupConfig = Pick<TStartupConfig, 'appTitle'> &
  Pick<
    Partial<TStartupConfig>,
    'analyticsGtmId' | 'bundlerURL' | 'customFooter' | 'staticBundlerURL'
  > & {
    interface?: TSharedLinkStartupInterface;
  };

export enum OCRStrategy {
  MISTRAL_OCR = 'mistral_ocr',
  CUSTOM_OCR = 'custom_ocr',
  AZURE_MISTRAL_OCR = 'azure_mistral_ocr',
  VERTEXAI_MISTRAL_OCR = 'vertexai_mistral_ocr',
  DOCUMENT_PARSER = 'document_parser',
}

export enum SearchCategories {
  PROVIDERS = 'providers',
  SCRAPERS = 'scrapers',
  RERANKERS = 'rerankers',
}

export enum SearchProviders {
  SERPER = 'serper',
  SEARXNG = 'searxng',
  TAVILY = 'tavily',
  KEENABLE = 'keenable',
}

export enum ScraperProviders {
  FIRECRAWL = 'firecrawl',
  SERPER = 'serper',
  TAVILY = 'tavily',
  KEENABLE = 'keenable',
}

export enum RerankerTypes {
  JINA = 'jina',
  COHERE = 'cohere',
  NONE = 'none',
}

export enum SafeSearchTypes {
  OFF = 0,
  MODERATE = 1,
  STRICT = 2,
}

/**
 * Normalizes a SearXNG engine list into the comma-separated form the API expects.
 * Accepts the YAML list or comma-separated string an operator may write, and is
 * applied both at the schema boundary and when loading the runtime config, since
 * `loadCustomConfig` returns the raw YAML object rather than the parsed result.
 */
export function normalizeSearxngEngines(engines?: string | string[]): string | undefined {
  if (engines == null) {
    return undefined;
  }
  const normalized = (Array.isArray(engines) ? engines : engines.split(','))
    .map((engine) => engine.trim())
    .filter(Boolean);
  return normalized.length ? normalized.join(',') : undefined;
}

export const webSearchSchema = z.object({
  allowedAddresses: allowedAddressesSchema,
  serperApiKey: z.string().optional().default('${SERPER_API_KEY}'),
  serperApiKeyPreview: apiKeyPreviewSchema,
  searxngInstanceUrl: z.string().optional().default('${SEARXNG_INSTANCE_URL}'),
  searxngApiKey: z.string().optional().default('${SEARXNG_API_KEY}'),
  searxngApiKeyPreview: apiKeyPreviewSchema,
  firecrawlApiKey: z.string().optional().default('${FIRECRAWL_API_KEY}'),
  firecrawlApiKeyPreview: apiKeyPreviewSchema,
  firecrawlApiUrl: z.string().optional().default('${FIRECRAWL_API_URL}'),
  firecrawlVersion: z.string().optional().default('${FIRECRAWL_VERSION}'),
  tavilyApiKey: z.string().optional().default('${TAVILY_API_KEY}'),
  tavilyApiKeyPreview: apiKeyPreviewSchema,
  tavilySearchUrl: z.string().optional().default('${TAVILY_SEARCH_URL}'),
  tavilyExtractUrl: z.string().optional().default('${TAVILY_EXTRACT_URL}'),
  keenableApiKey: z.string().optional().default('${KEENABLE_API_KEY}'),
  keenableApiUrl: z.string().optional().default('${KEENABLE_API_URL}'),
  jinaApiKey: z.string().optional().default('${JINA_API_KEY}'),
  jinaApiKeyPreview: apiKeyPreviewSchema,
  jinaApiUrl: z.string().optional().default('${JINA_API_URL}'),
  cohereApiKey: z.string().optional().default('${COHERE_API_KEY}'),
  cohereApiKeyPreview: apiKeyPreviewSchema,
  searchProvider: z.nativeEnum(SearchProviders).optional(),
  scraperProvider: z.nativeEnum(ScraperProviders).optional(),
  rerankerType: z.nativeEnum(RerankerTypes).optional(),
  scraperTimeout: z.number().int().nonnegative().optional(),
  safeSearch: z.nativeEnum(SafeSearchTypes).default(SafeSearchTypes.MODERATE),
  firecrawlOptions: z
    .object({
      formats: z.array(z.string()).optional(),
      includeTags: z.array(z.string()).optional(),
      excludeTags: z.array(z.string()).optional(),
      headers: z.record(z.string()).optional(),
      waitFor: z.number().optional(),
      timeout: z.number().int().nonnegative().optional(),
      maxAge: z.number().optional(),
      mobile: z.boolean().optional(),
      skipTlsVerification: z.boolean().optional(),
      blockAds: z.boolean().optional(),
      removeBase64Images: z.boolean().optional(),
      parsePDF: z.boolean().optional(),
      storeInCache: z.boolean().optional(),
      zeroDataRetention: z.boolean().optional(),
      location: z
        .object({
          country: z.string().optional(),
          languages: z.array(z.string()).optional(),
        })
        .optional(),
      onlyMainContent: z.boolean().optional(),
      changeTrackingOptions: z
        .object({
          modes: z.array(z.string()).optional(),
          schema: z.record(z.unknown()).optional(),
          prompt: z.string().optional(),
          tag: z.string().nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  searxngSearchOptions: z
    .object({
      engines: z
        .union([z.string(), z.array(z.string())])
        .transform(normalizeSearxngEngines)
        .optional(),
      language: z.string().optional(),
      timeRange: z.enum(['day', 'month', 'year']).optional(),
      timeout: z.number().int().positive().max(120000).optional(),
    })
    .optional(),
  tavilySearchOptions: z
    .object({
      searchDepth: z.enum(['basic', 'advanced', 'fast', 'ultra-fast']).optional(),
      maxResults: z.number().int().min(1).max(20).optional(),
      includeImages: z.boolean().optional(),
      includeAnswer: z.union([z.boolean(), z.enum(['basic', 'advanced'])]).optional(),
      includeRawContent: z.union([z.boolean(), z.enum(['markdown', 'text'])]).optional(),
      includeDomains: z.array(z.string()).optional(),
      excludeDomains: z.array(z.string()).optional(),
      topic: z.enum(['general', 'news', 'finance']).optional(),
      timeRange: z.enum(['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y']).optional(),
      includeImageDescriptions: z.boolean().optional(),
      includeFavicon: z.boolean().optional(),
      chunksPerSource: z.number().int().min(1).max(3).optional(),
      safeSearch: z.boolean().optional(),
      timeout: z.number().int().nonnegative().max(120000).optional(),
    })
    .optional(),
  tavilyScraperOptions: z
    .object({
      extractDepth: z.enum(['basic', 'advanced']).optional(),
      includeImages: z.boolean().optional(),
      includeFavicon: z.boolean().optional(),
      format: z.enum(['markdown', 'text']).optional(),
      timeout: z.number().int().nonnegative().max(120000).optional(),
    })
    .optional(),
  keenableSearchOptions: z
    .object({
      maxResults: z.number().int().min(1).max(20).optional(),
      site: z.string().optional(),
      attributionTitle: z.string().optional(),
      timeout: z.number().int().nonnegative().max(120000).optional(),
    })
    .optional(),
  keenableScraperOptions: z
    .object({
      attributionTitle: z.string().optional(),
      timeout: z.number().int().nonnegative().max(120000).optional(),
    })
    .optional(),
});

export type TWebSearchConfig = DeepPartial<z.infer<typeof webSearchSchema>>;

export const ocrSchema = z.object({
  allowedAddresses: allowedAddressesSchema,
  mistralModel: z.string().optional(),
  apiKey: z.string().optional().default('${OCR_API_KEY}'),
  apiKeyPreview: apiKeyPreviewSchema,
  baseURL: z.string().optional().default('${OCR_BASEURL}'),
  strategy: z.nativeEnum(OCRStrategy).default(OCRStrategy.MISTRAL_OCR),
});

export const balanceSchema = z.object({
  enabled: z.boolean().optional().default(false),
  startBalance: z.number().optional().default(20000),
  autoRefillEnabled: z.boolean().optional().default(false),
  refillIntervalValue: z.number().optional().default(30),
  refillIntervalUnit: z.enum(REFILL_INTERVAL_UNITS).optional().default('days'),
  refillAmount: z.number().optional().default(10000),
  reservationTtlMs: z
    .number()
    .int()
    .min(MIN_BALANCE_RESERVATION_TTL_MS)
    .optional()
    .default(DEFAULT_BALANCE_RESERVATION_TTL_MS),
});

export const transactionsSchema = z.object({
  enabled: z.boolean().optional().default(true),
});

export const DEFAULT_MEMORY_MAX_INPUT_TOKENS = 12000;

export const memorySchema = z.object({
  disabled: z.boolean().optional(),
  validKeys: z.array(z.string()).optional(),
  tokenLimit: z.number().optional(),
  charLimit: z.number().optional().default(10000),
  maxInputTokens: z.number().int().positive().optional().default(DEFAULT_MEMORY_MAX_INPUT_TOKENS),
  personalize: z.boolean().default(true),
  messageWindowSize: z.number().optional().default(5),
  agent: z
    .union([
      z.object({
        enabled: z.boolean().optional(),
        id: z.string(),
      }),
      z.object({
        enabled: z.boolean().optional(),
        provider: z.string(),
        model: z.string(),
        instructions: z.string().optional(),
        model_parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      }),
    ])
    .optional(),
});

export type TMemoryConfig = DeepPartial<z.infer<typeof memorySchema>>;

export const summarizationTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('token_ratio'),
    value: z.number().finite().min(0).max(1),
  }),
  z.object({
    type: z.literal('remaining_tokens'),
    value: z.number().finite().int().positive(),
  }),
  z.object({
    type: z.literal('messages_to_refine'),
    value: z.number().finite().int().positive(),
  }),
]);

export const contextPruningSchema = z.object({
  enabled: z.boolean().optional(),
  keepLastAssistants: z.number().min(0).max(10).optional(),
  softTrimRatio: z.number().min(0).max(1).optional(),
  hardClearRatio: z.number().min(0).max(1).optional(),
  minPrunableToolChars: z.number().min(0).optional(),
});

export const retainRecentConfigSchema = z.object({
  turns: z.number().min(0).max(20).optional(),
  tokens: z.number().positive().optional(),
});

export const summarizationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  parameters: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  trigger: summarizationTriggerSchema.optional(),
  prompt: z.string().optional(),
  updatePrompt: z.string().optional(),
  reserveRatio: z.number().min(0).max(1).optional(),
  maxSummaryTokens: z.number().positive().optional(),
  contextPruning: contextPruningSchema.optional(),
  retainRecent: retainRecentConfigSchema.optional(),
});

export type SummarizationConfig = z.infer<typeof summarizationConfigSchema>;

const customEndpointsSchema = z.array(endpointSchema.partial()).optional();

/**
 * Validates a messageFilter PII regex at config load. Defaults to native RegExp so browser
 * builds add no extra engine; the server injects a check backed by the linear-time runtime
 * engine (RE2) via setMessageFilterRegexValidator, so a pattern the runtime cannot compile
 * (backreferences, lookaround, control escapes, and so on) is rejected at load rather than
 * silently dropped at request time.
 */
interface MessageFilterRegexValidation {
  readonly supported: boolean;
  readonly programSize?: number;
}

type MessageFilterRegexValidationResult = boolean | MessageFilterRegexValidation;

let messageFilterRegexValidator: (pattern: string) => MessageFilterRegexValidationResult = (
  value,
) => {
  try {
    new RegExp(value, 'g');
    return true;
  } catch {
    return false;
  }
};

export const setMessageFilterRegexValidator = (
  validate: (pattern: string) => MessageFilterRegexValidationResult,
): void => {
  messageFilterRegexValidator = validate;
};

const messageFilterPiiCustomPatternSchema = z.object({
  id: z.string().min(1).max(MAX_PII_PATTERN_ID_LENGTH),
  label: z.string().min(1).max(MAX_PII_PATTERN_LABEL_LENGTH),
  regex: z.string().min(1).max(MAX_PII_PATTERN_LENGTH),
});

export const messageFilterPiiSchema = z
  .object({
    starterPatterns: z
      .array(z.string().max(MAX_PII_PATTERN_ID_LENGTH))
      .max(MAX_PII_PATTERNS_PER_SOURCE)
      .optional(),
    customPatterns: z
      .array(messageFilterPiiCustomPatternSchema)
      .max(MAX_PII_PATTERNS_PER_SOURCE)
      .optional(),
  })
  .superRefine((pii, context) => {
    let regexCharacters = 0;
    let regexInstructions = 0;
    for (let index = 0; index < (pii.customPatterns?.length ?? 0); index++) {
      const pattern = pii.customPatterns?.[index];
      if (pattern == null) {
        continue;
      }
      regexCharacters += pattern.regex.length;
      const result = messageFilterRegexValidator(pattern.regex);
      const supported = typeof result === 'boolean' ? result : result.supported;
      if (!supported) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['customPatterns', index, 'regex'],
          message:
            'Unsupported regex: not compatible with the RE2 engine (no backreferences, lookaround, or control escapes)',
        });
        continue;
      }
      if (typeof result !== 'boolean' && result.programSize != null) {
        regexInstructions += result.programSize;
      }
    }
    if (regexCharacters > MAX_PII_CUSTOM_REGEX_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customPatterns'],
        message: `Custom PII regexes may contain at most ${MAX_PII_CUSTOM_REGEX_CHARACTERS} characters in total`,
      });
    }
    if (regexInstructions > MAX_PII_CUSTOM_REGEX_INSTRUCTIONS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customPatterns'],
        message: `Custom PII regexes may compile to at most ${MAX_PII_CUSTOM_REGEX_INSTRUCTIONS} instructions in total`,
      });
    }
  });

export type MessageFilterPiiConfig = z.infer<typeof messageFilterPiiSchema>;

export const messageFilterSchema = z.object({
  pii: messageFilterPiiSchema.optional(),
});

export type MessageFilterConfig = z.infer<typeof messageFilterSchema>;

/** User fields a deployment may select as the Langfuse trace `userId`. */
export const LANGFUSE_TRACE_USER_ID_FIELDS = [
  'id',
  'email',
  'username',
  'name',
  'openidId',
  'samlId',
  'ldapId',
  'googleId',
  'githubId',
  'discordId',
  'appleId',
  'facebookId',
] as const;
export type LangfuseTraceUserIdField = (typeof LANGFUSE_TRACE_USER_ID_FIELDS)[number];

/** User fields a deployment may copy into Langfuse trace metadata. */
export const LANGFUSE_TRACE_USER_METADATA_FIELDS = [
  ...LANGFUSE_TRACE_USER_ID_FIELDS,
  'role',
  'provider',
] as const;
export type LangfuseTraceUserMetadataField = (typeof LANGFUSE_TRACE_USER_METADATA_FIELDS)[number];

/** Request fields a deployment may copy into Langfuse trace metadata. */
export const LANGFUSE_TRACE_CONVERSATION_METADATA_FIELDS = [
  'conversationId',
  'endpoint',
  'endpointType',
  'provider',
  'model',
  'modelLabel',
  'spec',
] as const;
export type LangfuseTraceConversationMetadataField =
  (typeof LANGFUSE_TRACE_CONVERSATION_METADATA_FIELDS)[number];

/**
 * What a deployment attaches to every Langfuse trace beyond the defaults.
 * Nothing here is exported unless explicitly listed, so the default trace
 * carries only the internal user id and no user or request metadata.
 */
export const langfuseTraceConfigSchema = z.object({
  /**
   * Which user field becomes the trace `userId`. Defaults to the internal user
   * id; a user with no value for the chosen field keeps the internal id.
   */
  userIdField: z.enum(LANGFUSE_TRACE_USER_ID_FIELDS).optional(),
  /** User fields exported as `librechat.user.<field>` trace metadata. */
  userMetadataFields: z.array(z.enum(LANGFUSE_TRACE_USER_METADATA_FIELDS)).optional(),
  /**
   * Request fields exported as trace metadata: `librechat.conversation.id`,
   * `librechat.endpoint`, `librechat.endpoint.type`, `librechat.provider`,
   * `librechat.model`, `librechat.model.label`, and `librechat.spec`.
   */
  conversationMetadataFields: z
    .array(z.enum(LANGFUSE_TRACE_CONVERSATION_METADATA_FIELDS))
    .optional(),
});

export type LangfuseTraceConfig = z.infer<typeof langfuseTraceConfigSchema>;

export const langfuseConfigSchema = z.object({
  enabled: z.boolean().optional(),
  publicKey: z.string().optional(),
  secretKey: z.string().optional(),
  /** Stable Langfuse project identity returned when credentials are verified. */
  projectId: z.string().optional(),
  /** Masked preview of the secret key, stored at write time so
   * admin reads can show which secret key is configured without returning the secret. */
  secretKeyPreview: z.string().optional(),
  /** Routing key for one of the deployment-configured tenant Langfuse destinations. */
  destination: z.string().optional(),
  /**
   * Custom request headers sent on every outbound Langfuse request — trace and
   * media export, feedback scores, and credential verification — for
   * self-hosted instances behind an authenticating proxy or gateway. Values
   * support `${ENV_VAR}` interpolation.
   *
   * Deployment-level only. Trace export batches spans from every user through
   * one exporter, so unlike endpoint headers these cannot carry per-user
   * placeholders. Headers referencing an unset variable, naming an
   * infrastructure secret, or carrying an invalid HTTP field name are dropped
   * with a warning rather than sent.
   *
   * Sent only when the deployment configures exactly one Langfuse origin, and
   * only to that origin. The map cannot say which endpoint it authenticates
   * to, so with several configured origins any choice of recipient would risk
   * disclosing a gateway credential to the others; a warning is logged instead.
   * Multi-destination deployments need per-destination headers, which this
   * schema does not yet express — and note the fanout collector forwards only
   * `Authorization` upstream regardless.
   */
  headers: z.record(z.string()).optional(),
  /** Trace user identity and allowlisted user/request metadata. */
  trace: langfuseTraceConfigSchema.optional(),
});

export type LangfuseConfig = z.infer<typeof langfuseConfigSchema>;

export const openIdDiscoverySchema = z.object({
  /** Discovery attempts made before startup continues; `0` retries only in the background. */
  startupAttempts: z.number().int().min(0).max(100).default(1),
  /** Milliseconds between startup and background discovery attempts. */
  retryDelayMs: z.number().int().min(100).max(3_600_000).default(5000),
});

export type TOpenIdDiscoveryConfig = z.infer<typeof openIdDiscoverySchema>;

export const configSchema = z.object({
  version: z.string(),
  cache: z.boolean().default(true),
  ocr: ocrSchema.optional(),
  webSearch: webSearchSchema.optional(),
  langfuse: langfuseConfigSchema.optional(),
  memory: memorySchema.optional(),
  summarization: summarizationConfigSchema.optional(),
  skillSync: skillSyncConfigSchema,
  secureImageLinks: z.boolean().optional(),
  imageOutputType: z.nativeEnum(EImageOutputType).default(EImageOutputType.PNG),
  includedTools: z.array(z.string()).optional(),
  filteredTools: z.array(z.string()).optional(),
  mcpServers: MCPServersSchema.optional(),
  mcpSettings: z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      allowedAddresses: allowedAddressesSchema,
      catalogRecovery: z
        .object({
          discoveryBackoffMs: z
            .array(
              z
                .number()
                .int()
                .positive()
                .max(24 * 60 * 60_000),
            )
            .min(1)
            .max(8)
            .default([5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000]),
          discoveryTimeoutMs: z
            .number()
            .int()
            .positive()
            .max(5 * 60_000)
            .default(3_000),
          /** How long past `discoveryTimeoutMs` a stalled discovery may hold its catalog slot and
           * coalesced requests. It is never cancelled, so OAuth tokens it redeemed still persist,
           * and no other discovery for the same server state starts until it settles. */
          discoverySettleGraceMs: z
            .number()
            .int()
            .nonnegative()
            .max(5 * 60_000)
            .default(10_000),
          reauthRetryMs: z
            .number()
            .int()
            .positive()
            .max(24 * 60 * 60_000)
            .default(30 * 60_000),
          maxStateEntries: z.number().int().positive().max(1_000_000).default(10_000),
          /** Process-wide: how many discoveries released past `discoverySettleGraceMs` may still be
           * running before recovery starts no new discovery until one settles. The default matches
           * the three catalog slots a stalled dependency could hold before discoveries were released. */
          maxDetachedDiscoveries: z.number().int().positive().max(1_000).default(3),
          generationReadTimeoutMs: z.number().int().positive().max(10_000).default(500),
          authorizationFenceRetryMs: z
            .array(z.number().int().nonnegative().max(60_000))
            .min(1)
            .max(8)
            .default([0, 50, 200]),
          authorizationFenceTimeoutMs: z.number().int().positive().max(30_000).default(1_000),
          authorizationFenceRetryIntervalMs: z
            .number()
            .int()
            .positive()
            .max(60 * 60_000)
            .default(30_000),
          authorizationFenceRetryBatchSize: z.number().int().positive().max(10_000).default(100),
        })
        .default({}),
    })
    .optional(),
  interface: interfaceSchema,
  turnstile: turnstileSchema.optional(),
  fileStrategy: fileStorageSchema.default(FileSources.local),
  fileStrategies: fileStrategiesSchema,
  cloudfront: cloudfrontConfigSchema,
  actions: z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      allowedAddresses: allowedAddressesSchema,
    })
    .optional(),
  registration: z
    .object({
      socialLogins: z.array(z.string()).optional(),
      allowedDomains: z.array(z.string()).optional(),
      /** Milliseconds a started social login may take to reach its callback; defaults to `DEFAULT_OAUTH_STATE_TTL_MS`. */
      oauthStateTtlMs: z.number().int().min(60_000).max(3_600_000).optional(),
      /** OpenID discovery retries; an unset field falls back to its `OPENID_DISCOVERY_RETRY_*` env var, then the schema default. */
      openidDiscovery: openIdDiscoverySchema.partial().optional(),
    })
    .default({ socialLogins: defaultSocialLogins }),
  balance: balanceSchema.optional(),
  transactions: transactionsSchema.optional(),
  speech: z
    .object({
      tts: ttsSchema.optional(),
      stt: sttSchema.optional(),
      speechTab: speechTab.optional(),
    })
    .optional(),
  rateLimits: rateLimitSchema.optional(),
  fileConfig: fileConfigSchema.optional(),
  modelSpecs: specsConfigSchema.optional(),
  filters: filtersConfigSchema.optional(),
  messageFilter: messageFilterSchema.optional(),
  endpoints: z
    .object({
      allowedAddresses: allowedAddressesSchema,
      /**
       * Defaults applied to every endpoint. Omit-based, so options added to
       * `baseEndpointSchema` are inherited here automatically — no list to
       * maintain (contrast `azureEndpointSchema`, which enumerates via
       * `.pick()`). Resolution order at read sites is `all` > the named
       * endpoint > a custom endpoint's own config.
       */
      all: baseEndpointSchema.omit({ baseURL: true }).optional(),
      [EModelEndpoint.openAI]: baseEndpointSchema.optional(),
      [EModelEndpoint.google]: baseEndpointSchema.optional(),
      [EModelEndpoint.anthropic]: anthropicEndpointSchema.optional(),
      [EModelEndpoint.azureOpenAI]: azureEndpointSchema.optional(),
      [EModelEndpoint.azureAssistants]: assistantEndpointSchema.optional(),
      [EModelEndpoint.assistants]: assistantEndpointSchema.optional(),
      [EModelEndpoint.agents]: agentsEndpointSchema.optional(),
      [EModelEndpoint.custom]: customEndpointsSchema.optional(),
      [EModelEndpoint.bedrock]: bedrockEndpointSchema.optional(),
    })
    .strict()
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one `endpoints` field must be provided.',
    })
    .optional(),
});

/**
 * Recursively makes all properties of T optional, including nested objects.
 * Handles arrays, primitives, functions, and Date objects correctly.
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepPartial<U>>
    : // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      T extends Function
      ? T
      : T extends Date
        ? T
        : T extends object
          ? {
              [P in keyof T]?: DeepPartial<T[P]>;
            }
          : T;

export const getConfigDefaults = () => getSchemaDefaults(configSchema);
export type TCustomConfig = DeepPartial<z.infer<typeof configSchema>>;

/**
 * Shape of the `webSearch` block as written in `librechat.yaml`, where
 * `searxngSearchOptions.engines` may still be the YAML list or untrimmed string an
 * operator wrote. `loadCustomConfig` returns the raw YAML object rather than the
 * parsed result, so the runtime loader receives this shape, not the parsed one.
 */
export type TWebSearchConfigInput = Omit<
  NonNullable<TCustomConfig['webSearch']>,
  'searxngSearchOptions'
> & {
  searxngSearchOptions?: z.input<typeof webSearchSchema>['searxngSearchOptions'];
};
export type TCustomEndpoints = z.infer<typeof customEndpointsSchema>;

export type TProviderSchema =
  | z.infer<typeof ttsOpenaiSchema>
  | z.infer<typeof ttsElevenLabsSchema>
  | z.infer<typeof ttsLocalaiSchema>
  | undefined;

export enum KnownEndpoints {
  anyscale = 'anyscale',
  apipie = 'apipie',
  cohere = 'cohere',
  fireworks = 'fireworks',
  deepseek = 'deepseek',
  moonshot = 'moonshot',
  groq = 'groq',
  helicone = 'helicone',
  huggingface = 'huggingface',
  lemonade = 'lemonade',
  mistral = 'mistral',
  mlx = 'mlx',
  ollama = 'ollama',
  openrouter = 'openrouter',
  perplexity = 'perplexity',
  shuttleai = 'shuttleai',
  'together.ai' = 'together.ai',
  unify = 'unify',
  vercel = 'vercel',
  xai = 'xai',
}

export enum FetchTokenConfig {
  openrouter = KnownEndpoints.openrouter,
  helicone = KnownEndpoints.helicone,
}

export const defaultEndpoints: EModelEndpoint[] = [
  EModelEndpoint.openAI,
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.agents,
  EModelEndpoint.google,
  EModelEndpoint.anthropic,
  EModelEndpoint.custom,
  EModelEndpoint.bedrock,
];

export const alternateName = {
  [EModelEndpoint.openAI]: 'OpenAI',
  [EModelEndpoint.assistants]: 'Assistants',
  [EModelEndpoint.agents]: 'My Agents',
  [EModelEndpoint.azureAssistants]: 'Azure Assistants',
  [EModelEndpoint.azureOpenAI]: 'Azure OpenAI',
  [EModelEndpoint.google]: 'Google',
  [EModelEndpoint.anthropic]: 'Anthropic',
  [EModelEndpoint.custom]: 'Custom',
  [EModelEndpoint.bedrock]: 'AWS Bedrock',
  [KnownEndpoints.lemonade]: 'AMD Lemonade',
  [KnownEndpoints.ollama]: 'Ollama',
  [KnownEndpoints.deepseek]: 'DeepSeek',
  [KnownEndpoints.moonshot]: 'Moonshot',
  [KnownEndpoints.xai]: 'xAI',
  [KnownEndpoints.vercel]: 'Vercel',
  [KnownEndpoints.helicone]: 'Helicone',
};

/**
 * Models the Assistants endpoints cannot run. GPT-6 Astra serves tool calls only
 * from the Responses API, and the Assistants surface does not route through
 * `getOpenAILLMConfig`, so listing it there would offer a configuration the
 * provider rejects. Kept out of `sharedOpenAIModels`, which both Assistants
 * catalogs consume.
 */
const responsesOnlyOpenAIModels = ['gpt-6-astra'];

const sharedOpenAIModels = [
  'gpt-5.6',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'chat-latest',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'gpt-4o',
];

const sharedAnthropicModels = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-opus-4-5',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-0',
  'claude-opus-4-20250514',
  'claude-opus-4-0',
  'claude-3-7-sonnet-latest',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-sonnet-latest',
];

/**
 * Claude 4+ models are not invocable on-demand by their bare foundation-model
 * ID on the Converse path — Bedrock rejects those with "Invocation of model ID
 * ... with on-demand throughput isn't supported. Retry your request with the ID
 * or ARN of an inference profile that contains this model." Default to the
 * `global.` cross-region profile (no regional pricing premium, widest
 * availability); Opus 4.1 has no global profile, so it uses `us.`.
 */
export const bedrockModels = [
  'global.anthropic.claude-fable-5-1',
  'global.anthropic.claude-fable-5',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-opus-4-7',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-4-6-v1',
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-opus-4-1-20250805-v1:0',
  // 'cohere.command-text-v14', // no conversation history
  // 'cohere.command-light-text-v14', // no conversation history
  'cohere.command-r-v1:0',
  'cohere.command-r-plus-v1:0',
  'meta.llama2-13b-chat-v1',
  'meta.llama2-70b-chat-v1',
  'meta.llama3-8b-instruct-v1:0',
  'meta.llama3-70b-instruct-v1:0',
  'meta.llama3-1-8b-instruct-v1:0',
  'meta.llama3-1-70b-instruct-v1:0',
  'meta.llama3-1-405b-instruct-v1:0',
  'mistral.mistral-7b-instruct-v0:2',
  'mistral.mixtral-8x7b-instruct-v0:1',
  'mistral.mistral-large-2402-v1:0',
  'mistral.mistral-large-2407-v1:0',
  'mistral.mistral-small-2402-v1:0',
  'ai21.jamba-instruct-v1:0',
  // 'ai21.j2-mid-v1', // no streaming
  // 'ai21.j2-ultra-v1', no conversation history
  'amazon.titan-text-lite-v1',
  'amazon.titan-text-express-v1',
  'amazon.titan-text-premier-v1:0',
];

export const defaultModels = {
  [EModelEndpoint.azureAssistants]: sharedOpenAIModels,
  [EModelEndpoint.assistants]: [...sharedOpenAIModels, 'chatgpt-4o-latest'],
  // TODO: Add agent models (agentsModels)
  [EModelEndpoint.agents]: [...responsesOnlyOpenAIModels, ...sharedOpenAIModels],
  [EModelEndpoint.google]: [
    // Gemini 3.8 Models
    'gemini-3.8-flash',
    // Gemini 3.7 Models
    'gemini-3.7-flash',
    // Gemini 3.6 Models
    'gemini-3.6-flash',
    // Gemini 3.5 Models
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    // Gemini 3.1 Models
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
    'gemini-3.1-flash-lite-preview',
    // Gemini 3 Models
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    // Gemini 2.5 Models
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
  [EModelEndpoint.anthropic]: sharedAnthropicModels,
  [EModelEndpoint.openAI]: [
    ...responsesOnlyOpenAIModels,
    ...sharedOpenAIModels,
    'chatgpt-4o-latest',
    'gpt-4-vision-preview',
    'gpt-3.5-turbo-instruct-0914',
    'gpt-3.5-turbo-instruct',
  ],
  [EModelEndpoint.bedrock]: bedrockModels,
};

const fitlerAssistantModels = (str: string) => {
  return /gpt-4|gpt-3\\.5/i.test(str) && !/vision|instruct/i.test(str);
};

const openAIModels = defaultModels[EModelEndpoint.openAI];

/**
 * The OpenAI catalog without the models only the first-party OpenAI endpoint
 * can run. Azure OpenAI shares this list, but Astra is neither routed to the
 * Responses API nor given its request constraints there, and listing it first
 * would let it become the default selection.
 */
const nonResponsesOnlyOpenAIModels = openAIModels.filter(
  (model) => !responsesOnlyOpenAIModels.includes(model),
);

export const initialModelsConfig: TModelsConfig = {
  initial: [],
  [EModelEndpoint.openAI]: openAIModels,
  [EModelEndpoint.assistants]: openAIModels.filter(fitlerAssistantModels),
  [EModelEndpoint.agents]: openAIModels, // TODO: Add agent models (agentsModels)
  [EModelEndpoint.azureOpenAI]: nonResponsesOnlyOpenAIModels,
  [EModelEndpoint.google]: defaultModels[EModelEndpoint.google],
  [EModelEndpoint.anthropic]: defaultModels[EModelEndpoint.anthropic],
  [EModelEndpoint.bedrock]: defaultModels[EModelEndpoint.bedrock],
};

export const EndpointURLs = {
  [EModelEndpoint.assistants]: `${apiBaseUrl()}/api/assistants/v2/chat`,
  [EModelEndpoint.azureAssistants]: `${apiBaseUrl()}/api/assistants/v1/chat`,
  [EModelEndpoint.agents]: `${apiBaseUrl()}/api/${EModelEndpoint.agents}/chat`,
} as const;

export const modularEndpoints = new Set<EModelEndpoint | string>([
  EModelEndpoint.anthropic,
  EModelEndpoint.google,
  EModelEndpoint.openAI,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.custom,
  EModelEndpoint.agents,
  EModelEndpoint.bedrock,
]);

export const supportsBalanceCheck = {
  [EModelEndpoint.custom]: true,
  [EModelEndpoint.openAI]: true,
  [EModelEndpoint.anthropic]: true,
  [EModelEndpoint.assistants]: true,
  [EModelEndpoint.agents]: true,
  [EModelEndpoint.azureAssistants]: true,
  [EModelEndpoint.azureOpenAI]: true,
  [EModelEndpoint.bedrock]: true,
  [EModelEndpoint.google]: true,
};

export const visionModels = [
  'qwen-vl',
  'grok-vision',
  'grok-2-vision',
  'grok-3',
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4-vision',
  'o4-mini',
  'o3',
  'o1',
  'gpt-5',
  'gpt-4.1',
  'gpt-4.5',
  'llava',
  'llava-13b',
  'gemini-pro-vision',
  'claude-3',
  'gemma',
  'gemini-exp',
  'gemini-1.5',
  'gemini-2',
  'gemini-2.5',
  'gemini-3',
  'moondream',
  'llama3.2-vision',
  'llama-3.2-11b-vision',
  'llama-3-2-11b-vision',
  'llama-3.2-90b-vision',
  'llama-3-2-90b-vision',
  'llama-4',
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
];
export enum VisionModes {
  generative = 'generative',
  agents = 'agents',
}

export function validateVisionModel({
  model,
  additionalModels = [],
  availableModels,
}: {
  model: string;
  additionalModels?: string[];
  availableModels?: string[];
}) {
  if (!model) {
    return false;
  }

  if (model.includes('gpt-4-turbo-preview') || model.includes('o1-mini')) {
    return false;
  }

  if (availableModels && !availableModels.includes(model)) {
    return false;
  }

  return visionModels.concat(additionalModels).some((visionModel) => model.includes(visionModel));
}

export const imageGenTools = new Set([
  'dalle',
  'dall-e',
  'stable-diffusion',
  'flux',
  'gemini_image_gen',
]);

/**
 * Enum for collections using infinite queries
 */
export enum InfiniteCollections {
  /**
   * Collection for Prompt Groups
   */
  PROMPT_GROUPS = 'promptGroups',
  /**
   * Collection for Shared Links
   */
  SHARED_LINKS = 'sharedLinks',
}

/**
 * Enum for time intervals
 */
export enum Time {
  ONE_DAY = 86400000,
  TWELVE_HOURS = 43200000,
  ONE_HOUR = 3600000,
  THIRTY_MINUTES = 1800000,
  TEN_MINUTES = 600000,
  FIVE_MINUTES = 300000,
  THREE_MINUTES = 180000,
  TWO_MINUTES = 120000,
  ONE_MINUTE = 60000,
  THIRTY_SECONDS = 30000,
}

/**
 * Enum for cache keys.
 */
export enum CacheKeys {
  /**
   * Key for the config store namespace.
   */
  CONFIG_STORE = 'CONFIG_STORE',
  /**
   * Key for the tool cache namespace (plugins, MCP tools, tool definitions).
   */
  TOOL_CACHE = 'TOOL_CACHE',
  /**
   * Key for the roles cache.
   */
  ROLES = 'ROLES',
  /**
   * Key for cached group memberships used to resolve ACL user principals.
   */
  USER_PRINCIPALS = 'USER_PRINCIPALS',
  /**
   * Key for cached prompt group access ID sets (accessible, public, owned).
   */
  PROMPT_GROUPS_ACCESS = 'PROMPT_GROUPS_ACCESS',
  /**
   * Key for per-conversation stateful code sandbox prewarm/warm state.
   */
  SANDBOX_PREWARM = 'SANDBOX_PREWARM',
  /**
   * Key for the title generation cache.
   */
  GEN_TITLE = 'GEN_TITLE',
  /**
   * Key for the tools cache.
   */
  TOOLS = 'TOOLS',
  /**
   * Key for the model config cache.
   */
  MODELS_CONFIG = 'MODELS_CONFIG',
  /**
   * Key for the model queries cache.
   */
  MODEL_QUERIES = 'MODEL_QUERIES',
  /**
   * Key for the default startup config cache.
   */
  STARTUP_CONFIG = 'STARTUP_CONFIG',
  /**
   * Key for the default endpoint config cache.
   */
  ENDPOINT_CONFIG = 'ENDPOINT_CONFIG',
  /**
   * Key for accessing the model token config cache.
   */
  TOKEN_CONFIG = 'TOKEN_CONFIG',
  /**
   * Key for the app config namespace.
   */
  APP_CONFIG = 'APP_CONFIG',
  /**
   * Key for accessing Abort Keys
   */
  ABORT_KEYS = 'ABORT_KEYS',
  /**
   * Key for the bans cache.
   */
  BANS = 'BANS',
  /**
   * Key for the encoded domains cache.
   * Used by Azure OpenAI Assistants.
   */
  ENCODED_DOMAINS = 'ENCODED_DOMAINS',
  /**
   * Key for the cached audio run Ids.
   */
  AUDIO_RUNS = 'AUDIO_RUNS',
  /**
   * Key for in-progress messages.
   */
  MESSAGES = 'MESSAGES',
  /**
   * Key for in-progress flow states.
   */
  FLOWS = 'FLOWS',
  /**
   * Key for pending chat requests (concurrency check)
   */
  PENDING_REQ = 'PENDING_REQ',
  /**
   * Key for s3 check intervals per user
   */
  S3_EXPIRY_INTERVAL = 'S3_EXPIRY_INTERVAL',
  /**
   * key for open id exchanged tokens
   */
  OPENID_EXCHANGED_TOKENS = 'OPENID_EXCHANGED_TOKENS',
  /**
   * Key for cached authenticated user documents.
   */
  AUTH_USER_DOC = 'AUTH_USER_DOC',
  /**
   * Key for OpenID session.
   */
  OPENID_SESSION = 'OPENID_SESSION',
  /**
   * Key for SAML session.
   */
  SAML_SESSION = 'SAML_SESSION',
  /**
   * Key for admin panel OAuth exchange codes (one-time-use, short TTL).
   */
  ADMIN_OAUTH_EXCHANGE = 'ADMIN_OAUTH_EXCHANGE',
}

export const AUTH_USER_DOC_BY_ID_PREFIX = 'auth-user-doc-byid';

/**
 * Enum for violation types, used to identify, log, and cache violations.
 */
export enum ViolationTypes {
  /**
   * File Upload Violations (exceeding limit).
   */
  FILE_UPLOAD_LIMIT = 'file_upload_limit',
  /**
   * Illegal Model Request (not available).
   */
  ILLEGAL_MODEL_REQUEST = 'illegal_model_request',
  /**
   * Token Limit Violation.
   */
  TOKEN_BALANCE = 'token_balance',
  /**
   * An issued ban.
   */
  BAN = 'ban',
  /**
   * TTS Request Limit Violation.
   */
  TTS_LIMIT = 'tts_limit',
  /**
   * STT Request Limit Violation.
   */
  STT_LIMIT = 'stt_limit',
  /**
   * Reset Password Limit Violation.
   */
  RESET_PASSWORD_LIMIT = 'reset_password_limit',
  /**
   * Verify Email Limit Violation.
   */
  VERIFY_EMAIL_LIMIT = 'verify_email_limit',
  /**
   * Verify Conversation Access violation.
   */
  CONVO_ACCESS = 'convo_access',
  /**
   * Tool Call Limit Violation.
   */
  TOOL_CALL_LIMIT = 'tool_call_limit',
  /**
   * General violation (catch-all).
   */
  GENERAL = 'general',
  /**
   * Login attempt violations.
   */
  LOGINS = 'logins',
  /**
   * Concurrent request violations.
   */
  CONCURRENT = 'concurrent',
  /**
   * Non-browser access violations.
   */
  NON_BROWSER = 'non_browser',
  /**
   * Message limit violations.
   */
  MESSAGE_LIMIT = 'message_limit',
  /**
   * Registration violations.
   */
  REGISTRATIONS = 'registrations',
  /**
   * Shared link retrieval limit violations.
   */
  SHARE_LIMIT = 'share_limit',
}

/**
 * Enum for error message types that are not "violations" as above, used to identify client-facing errors.
 */
export enum ErrorTypes {
  /**
   * No User-provided Key.
   */
  NO_USER_KEY = 'no_user_key',
  /**
   * Expired User-provided Key.
   */
  EXPIRED_USER_KEY = 'expired_user_key',
  /**
   * Invalid User-provided Key.
   */
  INVALID_USER_KEY = 'invalid_user_key',
  /**
   * No Base URL Provided.
   */
  NO_BASE_URL = 'no_base_url',
  /**
   * Base URL targets a restricted or invalid address (SSRF protection).
   */
  INVALID_BASE_URL = 'invalid_base_url',
  /**
   * Moderation error
   */
  MODERATION = 'moderation',
  /**
   * Prompt exceeds max length
   */
  INPUT_LENGTH = 'INPUT_LENGTH',
  /**
   * Invalid request error, API rejected request
   */
  INVALID_REQUEST = 'invalid_request_error',
  /**
   * Invalid action request error, likely not on list of allowed domains
   */
  INVALID_ACTION = 'invalid_action_error',
  /**
   * Invalid request error, API rejected request
   */
  NO_SYSTEM_MESSAGES = 'no_system_messages',
  /**
   * Google provider returned an error
   */
  GOOGLE_ERROR = 'google_error',
  /**
   * Google provider does not allow custom tools with built-in tools
   */
  GOOGLE_TOOL_CONFLICT = 'google_tool_conflict',
  /**
   * Google provider could not process a linked video (most often longer than the model accepts)
   */
  GOOGLE_VIDEO_UNPROCESSABLE = 'google_video_unprocessable',
  /**
   * Required CodeAPI resources could not be restored before model invocation.
   */
  RESOURCE_RECOVERY_REQUIRED = 'resource_recovery_required',
  /**
   * Agent selected a stateful Code API workspace scope disabled by the deployment.
   */
  STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED = 'stateful_code_environment_not_allowed',
  /**
   * A conversation's selected attached workspace cannot be used as requested.
   */
  CODE_WORKSPACE_UNAVAILABLE = 'code_workspace_unavailable',
  /**
   * Invalid Agent Provider (excluded by Admin)
   */
  INVALID_AGENT_PROVIDER = 'invalid_agent_provider',
  /**
   * Missing model selection
   */
  MISSING_MODEL = 'missing_model',
  /**
   * Models configuration not loaded
   */
  MODELS_NOT_LOADED = 'models_not_loaded',
  /**
   * Endpoint models not loaded
   */
  ENDPOINT_MODELS_NOT_LOADED = 'endpoint_models_not_loaded',
  /**
   * Generic Authentication failure
   */
  AUTH_FAILED = 'auth_failed',
  /**
   * Authentication rejected by a rate limiter
   */
  AUTH_RATE_LIMITED = 'auth_rate_limited',
  /**
   * Authentication rejected because the account or IP is banned
   */
  AUTH_BANNED = 'auth_banned',
  /**
   * Authentication request was not sent from this application's origin
   */
  AUTH_CROSS_ORIGIN = 'auth_cross_origin',
  /**
   * Model refused to respond (content policy violation)
   */
  REFUSAL = 'refusal',
  /**
   * SSE stream 404 — job completed, expired, or was deleted before the subscriber connected
   */
  STREAM_EXPIRED = 'stream_expired',
  /**
   * Provider does not serve the requested model
   */
  MODEL_NOT_FOUND = 'model_not_found',
  /**
   * Provider throttled or refused the request for exceeding a rate/spend allowance
   */
  MODEL_RATE_LIMIT = 'model_rate_limit',
  /**
   * An agent model provider failed and the run could not recover.
   */
  UPSTREAM_MODEL_ERROR = 'upstream_model_error',
  /**
   * Context pruning removed every message; nothing fits the configured context window
   */
  EMPTY_MESSAGES = 'empty_messages',
  /**
   * Formatted provider payload exceeded the context budget before invocation
   */
  FINAL_CONTEXT_OVERFLOW = 'final_context_overflow',
  /**
   * A manual compaction the graph could not attempt; `reason` says why
   */
  COMPACTION_SKIPPED = 'compaction_skipped',
  /**
   * A manual compaction whose summarizer produced nothing; history is untouched
   */
  COMPACTION_FAILED = 'compaction_failed',
}

/**
 * Enum for authentication keys.
 */
export enum AuthKeys {
  /**
   * Key for the Service Account to use Vertex AI.
   */
  GOOGLE_SERVICE_KEY = 'GOOGLE_SERVICE_KEY',
  /**
   * API key to use Google Generative AI.
   *
   * Note: this is not for Environment Variables, but to access encrypted object values.
   */
  GOOGLE_API_KEY = 'GOOGLE_API_KEY',
  /**
   * API key to use Anthropic.
   *
   * Note: this is not for Environment Variables, but to access encrypted object values.
   */
  ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY',
}

/**
 * Enum for Image Detail Cost.
 *
 * **Low Res Fixed Cost:** `85`
 *
 * **High Res Calculation:**
 *
 * Number of `512px` Tiles * `170` + `85` (Additional Cost)
 */
export enum ImageDetailCost {
  /**
   * Low resolution is a fixed value.
   */
  LOW = 85,
  /**
   * High resolution Cost Per Tile
   */
  HIGH = 170,
  /**
   * Additional Cost added to High Resolution Total Cost
   */
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  ADDITIONAL = 85,
}

/**
 * Tab values for Settings Dialog
 */
export enum SettingsTabValues {
  /**
   * Tab for General Settings
   */
  GENERAL = 'general',
  /**
   * Tab for Chat Settings
   */
  CHAT = 'chat',
  /**
   * Tab for Speech Settings
   */
  SPEECH = 'speech',
  /**
   * Tab for Langfuse Settings
   */
  LANGFUSE = 'langfuse',
  /**
   * Tab for Beta Features
   */
  BETA = 'beta',
  /**
   * Tab for Data Controls
   */
  DATA = 'data',
  /**
   * Tab for Balance Settings
   */
  BALANCE = 'balance',
  /**
   * Tab for Account Settings
   */
  ACCOUNT = 'account',
  /**
   * Chat input commands
   */
  COMMANDS = 'commands',
  /**
   * Tab for Personalization Settings
   */
  PERSONALIZATION = 'personalization',
  /**
   * Tab for About / Build Info
   */
  ABOUT = 'about',
}

export enum STTProviders {
  /**
   * Provider for OpenAI STT
   */
  OPENAI = 'openai',
  /**
   * Provider for Microsoft Azure STT
   */
  AZURE_OPENAI = 'azureOpenAI',
}

export enum TTSProviders {
  /**
   * Provider for OpenAI TTS
   */
  OPENAI = 'openai',
  /**
   * Provider for Microsoft Azure OpenAI TTS
   */
  AZURE_OPENAI = 'azureOpenAI',
  /**
   * Provider for ElevenLabs TTS
   */
  ELEVENLABS = 'elevenlabs',
  /**
   * Provider for LocalAI TTS
   */
  LOCALAI = 'localai',
}

/** Enum for app-wide constants */
export enum Constants {
  /**
   * Key for the app's version. The placeholder `__LIBRECHAT_VERSION__` is
   * swapped in by `@rollup/plugin-replace` during `npm run build:data-provider`
   * using the value of the root `package.json`'s `version` field. Consumers
   * always import this via the built dist bundle (see `main` field in
   * `packages/data-provider/package.json`), so production and UI code get the
   * substituted value. Only tests that import the TypeScript source directly
   * would observe the raw placeholder.
   */
  VERSION = '__LIBRECHAT_VERSION__',
  /** Key for the Custom Config's version (librechat.yaml). */
  CONFIG_VERSION = '1.3.16',
  /** Standard value for the first message's `parentMessageId` value, to indicate no parent exists. */
  NO_PARENT = '00000000-0000-0000-0000-000000000000',
  /** Standard value to use whatever the submission prelim. `responseMessageId` is */
  USE_PRELIM_RESPONSE_MESSAGE_ID = 'USE_PRELIM_RESPONSE_MESSAGE_ID',
  /** Standard value for the initial conversationId before a request is sent */
  NEW_CONVO = 'new',
  /** Standard value for the temporary conversationId after a request is sent and before the server responds */
  PENDING_CONVO = 'PENDING',
  /** Standard value for the conversationId used for search queries */
  SEARCH = 'search',
  /** Fixed, encoded domain length for Azure OpenAI Assistants Function name parsing. */
  ENCODED_DOMAIN_LENGTH = 10,
  /** Identifier for using current_model in multi-model requests. */
  CURRENT_MODEL = 'current_model',
  /** Common divider for text values */
  COMMON_DIVIDER = '__',
  /** Max length for commands */
  COMMANDS_MAX_LENGTH = 56,
  /** Default Stream Rate (ms) */
  DEFAULT_STREAM_RATE = 1,
  /** Saved Tag */
  SAVED_TAG = 'Saved',
  /** Max number of Conversation starters for Agents/Assistants */
  MAX_CONVO_STARTERS = 4,
  /** Delimiter for MCP tools */
  mcp_delimiter = '_mcp_',
  /** Prefix for MCP plugins */
  mcp_prefix = 'mcp_',
  /** Unique value to indicate all MCP servers. For backend use only. */
  mcp_all = 'sys__all__sys',
  /** Unique value to indicate clearing MCP servers from UI state. For frontend use only. */
  mcp_clear = 'sys__clear__sys',
  /** Key suffix for non-spec user default tool storage */
  spec_defaults_key = '__defaults__',
  /**
   * Unique value to indicate the MCP tool was added to an agent.
   * This helps inform the UI if the mcp server was previously added.
   * */
  mcp_server = 'sys__server__sys',
  /**
   * Handoff Tool Name Prefix
   */
  LC_TRANSFER_TO_ = 'lc_transfer_to_',
  /** Placeholder Agent ID for Ephemeral Agents */
  EPHEMERAL_AGENT_ID = 'ephemeral',
  /** Programmatic Tool Calling tool name */
  PROGRAMMATIC_TOOL_CALLING = 'run_tools_with_code',
  /** Bash Programmatic Tool Calling tool name */
  BASH_PROGRAMMATIC_TOOL_CALLING = 'run_tools_with_bash',
  /** Subagent spawn tool name (must match `@librechat/agents` `Constants.SUBAGENT`). */
  SUBAGENT = 'subagent',
  /** Poll tool for retrieving the status/result of a backgrounded tool call. */
  CHECK_BACKGROUND_TASK = 'check_background_task',
  /**
   * `finish_reason` stamped on an assistant message whose turn ended because the
   * agent exhausted its per-turn graph step budget (`recursionLimit`) rather than
   * because the model chose to stop. Distinct from a user abort: nothing failed and
   * nothing was cancelled, the turn simply ran out of room. The UI keys its
   * "tool call limit reached" notice off this value. The hover Continue control
   * is withheld for this reason because the notice already offers the way forward.
   */
  TOOL_CALL_LIMIT_FINISH_REASON = 'tool_call_limit',
}

/**
 * Normalizes a server name into the character set tool keys are built from.
 * Tool keys embed this output, so any candidate list matched against a key must
 * be normalized the same way.
 */
export function normalizeServerName(serverName: string): string {
  if (/^[a-zA-Z0-9_.-]+$/.test(serverName)) {
    return serverName;
  }

  const normalized = serverName.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '');
  if (normalized) {
    return normalized;
  }

  /** All characters were stripped; hash the original so the name stays unique. */
  let hash = 0;
  for (let i = 0; i < serverName.length; i++) {
    hash = (hash << 5) - hash + serverName.charCodeAt(i);
    hash |= 0;
  }
  return `server_${Math.abs(hash)}`;
}

/**
 * Splits a combined MCP tool key (`${rawToolName}${mcp_delimiter}${serverName}`)
 * back into its two parts.
 *
 * Both halves can legitimately contain the delimiter, so position alone cannot
 * identify the boundary. Raw tool names come from the upstream server and are
 * untrusted (`get_mcp_server_version`, or a gateway-prefixed
 * `gitlab-get_mcp_server_version`), and `normalizeServerName` preserves
 * underscores, so a configured server may be named `Google_mcp_Workspace`.
 *
 * When `knownServerNames` is supplied the boundary is resolved against it: the
 * longest configured name the key actually ends with wins. Otherwise this falls
 * back to the last delimiter, which is correct whenever only the tool half
 * contains one and matches `.split()` when neither does.
 *
 * One case stays undecidable from the key alone: if both `bar` and `foo_mcp_bar`
 * are configured, `tool_mcp_foo_mcp_bar` is a valid key for either. Longest match
 * is the deterministic tiebreak; resolving it properly needs the tool/server
 * mapping carried alongside the key rather than re-derived from the string.
 */
/**
 * Maps each configured server name's normalized form back to the raw config
 * name. Model-facing tool keys embed `normalizeServerName(server)`, while the
 * registry, config maps, tool cache, and plugin-auth rows are keyed by the raw
 * name — any consumer that parses a server out of a tool key must resolve it
 * through this map before those lookups. Identity entries are included so
 * `aliases.get(name) ?? name` works uniformly.
 *
 * When two configured names normalize to the same value their tool keys are
 * inherently ambiguous; the FIRST configured name wins deterministically here,
 * and `resolveMCPServerContext` warns about the collision so the operator can
 * rename one server.
 */
export function buildServerNameAliases(rawServerNames: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  /** Identity entries claim their slot FIRST regardless of configuration
   *  order: a server literally named `foo` must never have its keys rerouted
   *  to a `foo!` whose normalized form collides with it. */
  for (const raw of rawServerNames) {
    if (raw && normalizeServerName(raw) === raw) {
      aliases.set(raw, raw);
    }
  }
  for (const raw of rawServerNames) {
    if (!raw) {
      continue;
    }
    const normalized = normalizeServerName(raw);
    if (!aliases.has(normalized)) {
      aliases.set(normalized, raw);
    }
  }
  return aliases;
}

/**
 * Rewrites a tool key's server segment into the normalized form model-facing
 * keys carry, resolving the boundary against the configured raw names (longest
 * suffix wins, mirroring {@link splitMCPToolKey}). Returns the key unchanged
 * when no configured raw name matches — already-normalized keys, placeholder
 * tokens, and keys for servers that are no longer configured all pass through.
 * Idempotent: a normalized segment never matches a raw candidate that needs
 * rewriting.
 */
export function normalizeMCPToolKey(toolKey: string, rawServerNames: readonly string[]): string {
  let matched: string | undefined;
  for (let i = 0; i < rawServerNames.length; i++) {
    const raw = rawServerNames[i];
    if (!raw || raw.length <= (matched?.length ?? 0)) {
      continue;
    }
    if (toolKey.endsWith(`${Constants.mcp_delimiter}${raw}`)) {
      matched = raw;
    }
  }
  if (matched == null) {
    return toolKey;
  }
  const normalized = normalizeServerName(matched);
  if (normalized === matched) {
    return toolKey;
  }
  return `${toolKey.slice(0, toolKey.length - matched.length)}${normalized}`;
}

/**
 * Strips a redundant leading server-name prefix from a raw upstream tool name
 * before it is embedded into a model-facing key, so the key doesn't carry the
 * server twice (`acme_trace_..._mcp_acme`) and push long tool names
 * past provider function-name limits (64 chars). The match is case-insensitive
 * because display-cased server names ("Acme") conventionally prefix their
 * tools in lowercase. Ingestion that strips must record the original name
 * (`serverToolName` on the cached definition) — tool calls send THAT name back
 * to the server, never the stripped one. Catalog producers must not call this
 * directly: only {@link stripServerNamePrefixes} sees the whole sibling set and
 * can keep colliding results apart.
 */
export function stripServerNamePrefix(toolName: string, normalizedServerName: string): string {
  const prefixLength = normalizedServerName.length + 1;
  if (toolName.length <= prefixLength) {
    return toolName;
  }
  const prefix = toolName.slice(0, prefixLength).toLowerCase();
  if (prefix !== `${normalizedServerName.toLowerCase()}_`) {
    return toolName;
  }
  const stripped = toolName.slice(prefixLength);
  if (isReservedMCPToolName(stripped)) {
    return toolName;
  }
  /** `isActionTool` classifies keys by the RELATIVE position of `_action_`
   *  and `_mcp_`; stripping moves the first `_mcp_` earlier, so a server
   *  whose normalized name contains `_action_` could see a real MCP tool
   *  reclassified as an OpenAPI action (bypassing MCP authorization). Never
   *  produce a key whose classification differs from the raw key's. */
  const keySuffix = `${Constants.mcp_delimiter}${normalizedServerName}`;
  if (isActionTool(`${stripped}${keySuffix}`) !== isActionTool(`${toolName}${keySuffix}`)) {
    return toolName;
  }
  return stripped;
}

/**
 * Synthetic markers consumed by prefix (`isMCPAllPlaceholder`, the server-pin
 * skip, the client's OAuth stream classification), so each reserves BOTH its
 * exact name and its `${marker}${mcp_delimiter}` namespace: a stripped
 * remainder inside any of them would turn a real upstream tool into the
 * server-wide wildcard, the UI pin placeholder, or a synthetic OAuth call.
 */
const RESERVED_MCP_TOOL_MARKERS: readonly string[] = [
  `${Constants.mcp_all}`,
  `${Constants.mcp_server}`,
  'oauth',
];

function isReservedMCPToolName(toolName: string): boolean {
  /** `mcp_` opens the server-scoped pluginKey namespace (`mcp_${serverName}`),
   *  and `lc_transfer_to_` opens the agent-handoff namespace (the client
   *  renders such calls as handoffs; the background and intent passes exclude
   *  them) — pre-strip tool keys could never enter either, since they always
   *  began with the server name itself. */
  if (
    toolName.startsWith(`${Constants.mcp_prefix}`) ||
    toolName.startsWith(`${Constants.LC_TRANSFER_TO_}`)
  ) {
    return true;
  }
  return RESERVED_MCP_TOOL_MARKERS.some(
    (marker) => toolName === marker || toolName.startsWith(`${marker}${Constants.mcp_delimiter}`),
  );
}

/**
 * Maps every raw tool name in a server's catalog to its model-facing name,
 * stripping redundant server-name prefixes collision-free: when two names
 * yield the same result — a bare `foo` next to `<server>_foo`, or the
 * case-variant pair `<server>_Foo` / `<Server>_Foo` under the case-insensitive
 * prefix match — every collider keeps its raw name, so two distinct upstream
 * tools can never collapse onto one key. Unprefixed names count against the
 * result set through their identity mapping, which is what makes the bare-name
 * case fall out of the same counter.
 */
export function stripServerNamePrefixes(
  toolNames: readonly string[],
  normalizedServerName: string,
): Map<string, string> {
  const rawNames = new Set(toolNames);
  const finalNames = new Map<string, string>(
    toolNames.map((name) => {
      const stripped = stripServerNamePrefix(name, normalizedServerName);
      /** Every sibling's RAW name is reserved even when that sibling itself
       *  strips away: keys persisted BEFORE stripping embed raw names, so a
       *  stripped result landing on another sibling's raw name would route
       *  that sibling's legacy references to the wrong upstream tool. */
      return [name, stripped !== name && rawNames.has(stripped) ? name : stripped];
    }),
  );
  /** Reverting a collider to its raw name can itself collide with ANOTHER
   *  sibling's stripped result (`foo` / `acme_foo` / `acme_acme_foo`), so the
   *  guard iterates to a fixpoint. Each pass converts at least one stripped
   *  result back to its unique raw name, so it terminates within the catalog
   *  size. */
  let changed = true;
  while (changed) {
    changed = false;
    const counts = new Map<string, number>();
    finalNames.forEach((result) => {
      counts.set(result, (counts.get(result) ?? 0) + 1);
    });
    finalNames.forEach((result, raw) => {
      if (result !== raw && (counts.get(result) ?? 0) > 1) {
        finalNames.set(raw, raw);
        changed = true;
      }
    });
  }
  return finalNames;
}

export function splitMCPToolKey(
  toolKey: string,
  knownServerNames?: readonly string[],
): [string, string | undefined] {
  if (knownServerNames?.length) {
    let matched: string | undefined;
    for (let i = 0; i < knownServerNames.length; i++) {
      const serverName = knownServerNames[i];
      if (!serverName || serverName.length <= (matched?.length ?? 0)) {
        continue;
      }
      if (toolKey.endsWith(`${Constants.mcp_delimiter}${serverName}`)) {
        matched = serverName;
      }
    }
    if (matched != null) {
      return [
        toolKey.slice(0, toolKey.length - matched.length - Constants.mcp_delimiter.length),
        matched,
      ];
    }
  }

  const idx = toolKey.lastIndexOf(Constants.mcp_delimiter);
  if (idx === -1) {
    return [toolKey, undefined];
  }
  return [toolKey.slice(0, idx), toolKey.slice(idx + Constants.mcp_delimiter.length)];
}

/**
 * Splits a tool-call name for display, where the key may be a synthetic MCP OAuth
 * call (`oauth${mcp_delimiter}${serverName}`) rather than a real tool key.
 *
 * A configured server name is authoritative when one matches, because a real tool key
 * always ends in its server. Only when none matches does the `oauth` prefix decide,
 * which keeps a genuine upstream tool named `oauth${mcp_delimiter}...` from being read
 * as a synthetic call while still resolving OAuth prompts for unconfigured servers.
 */
export function splitToolCallName(
  toolCallName: string,
  knownServerNames?: readonly string[],
): [string, string | undefined] {
  if (knownServerNames?.length) {
    const [toolName, serverName] = splitMCPToolKey(toolCallName, knownServerNames);
    if (serverName != null && knownServerNames.includes(serverName)) {
      return [toolName, serverName];
    }
  }

  const oauthPrefix = `oauth${Constants.mcp_delimiter}`;
  if (toolCallName.startsWith(oauthPrefix)) {
    return ['oauth', toolCallName.slice(oauthPrefix.length)];
  }
  return splitMCPToolKey(toolCallName, knownServerNames);
}

/** Maximum explicit subagent hops allowed from any root agent at runtime. */
export const MAX_SUBAGENT_DEPTH = 5;

/** Maximum unique explicit subagent targets that may be loaded at runtime. */
export const MAX_SUBAGENT_GRAPH_NODES = 50;

/** Maximum expanded SubagentConfig entries embedded into one run request. */
export const MAX_SUBAGENT_RUN_CONFIGS = 100;

export enum LocalStorageKeys {
  /** Key for the admin defined App Title */
  APP_TITLE = 'appTitle',
  /** Key for the last conversation setup. */
  LAST_CONVO_SETUP = 'lastConversationSetup',
  /** Key for the last selected model. */
  LAST_MODEL = 'lastSelectedModel',
  /** Key for the last selected tools. */
  LAST_TOOLS = 'lastSelectedTools',
  /** Key for the last selected spec by name*/
  LAST_SPEC = 'lastSelectedSpec',
  /** Key for temporary files to delete */
  FILES_TO_DELETE = 'filesToDelete',
  /** Prefix key for the last selected assistant ID by index */
  ASST_ID_PREFIX = 'assistant_id__',
  /** Prefix key for the last selected agent ID by index */
  AGENT_ID_PREFIX = 'agent_id__',
  /** Key for the last selected fork setting */
  FORK_SETTING = 'forkSetting',
  /** Key for remembering the last selected option, instead of manually selecting */
  REMEMBER_FORK_OPTION = 'rememberDefaultFork',
  /** Key for remembering the split at target fork option modifier */
  FORK_SPLIT_AT_TARGET = 'splitAtTarget',
  /** Key for saving text drafts */
  TEXT_DRAFT = 'textDraft_',
  /** Key for saving file drafts */
  FILES_DRAFT = 'filesDraft_',
  /** Key for last Selected Prompt Category */
  LAST_PROMPT_CATEGORY = 'lastPromptCategory',
  /** Key for rendering User Messages as Markdown */
  ENABLE_USER_MSG_MARKDOWN = 'enableUserMsgMarkdown',
  /** Key for auto-expanding tool call details */
  AUTO_EXPAND_TOOLS = 'autoExpandTools',
  /** Last selected MCP values per conversation ID */
  LAST_MCP_ = 'LAST_MCP_',
  /** Last checked toggle for Code Interpreter API per conversation ID */
  LAST_CODE_TOGGLE_ = 'LAST_CODE_TOGGLE_',
  /** Last checked toggle for Web Search per conversation ID */
  LAST_WEB_SEARCH_TOGGLE_ = 'LAST_WEB_SEARCH_TOGGLE_',
  /** Last checked toggle for File Search per conversation ID */
  LAST_FILE_SEARCH_TOGGLE_ = 'LAST_FILE_SEARCH_TOGGLE_',
  /** Last checked toggle for Artifacts per conversation ID */
  LAST_ARTIFACTS_TOGGLE_ = 'LAST_ARTIFACTS_TOGGLE_',
  /** Last checked toggle for Skills per conversation ID */
  LAST_SKILLS_TOGGLE_ = 'LAST_SKILLS_TOGGLE_',
  /** Last checked toggle for Memory per conversation ID */
  LAST_MEMORY_TOGGLE_ = 'LAST_MEMORY_TOGGLE_',
  /** Key for the last selected agent provider */
  LAST_AGENT_PROVIDER = 'lastAgentProvider',
  /** Key for the last selected agent model */
  LAST_AGENT_MODEL = 'lastAgentModel',
  /** Pin state for MCP tools per conversation ID */
  PIN_MCP_ = 'PIN_MCP_',
  /** Pin state for Web Search per conversation ID */
  PIN_WEB_SEARCH_ = 'PIN_WEB_SEARCH_',
  /** Pin state for Code Interpreter per conversation ID */
  PIN_CODE_INTERPRETER_ = 'PIN_CODE_INTERPRETER_',
}

export enum ForkOptions {
  /** Key for direct path option */
  DIRECT_PATH = 'directPath',
  /** Key for including branches */
  INCLUDE_BRANCHES = 'includeBranches',
  /** Key for target level fork (default) */
  TARGET_LEVEL = 'targetLevel',
  /** Default option */
  DEFAULT = 'default',
}

/**
 * Enum for Cohere related constants
 */
export enum CohereConstants {
  /**
   * Cohere API Endpoint, for special handling
   */
  API_URL = 'https://api.cohere.ai/v1',
  /**
   * Role for "USER" messages
   */
  ROLE_USER = 'USER',
  /**
   * Role for "SYSTEM" messages
   */
  ROLE_SYSTEM = 'SYSTEM',
  /**
   * Role for "CHATBOT" messages
   */
  ROLE_CHATBOT = 'CHATBOT',
  /**
   * Title message as required by Cohere
   */
  TITLE_MESSAGE = 'TITLE:',
}

export enum SystemCategories {
  ALL = 'sys__all__sys',
  MY_PROMPTS = 'sys__my__prompts__sys',
  NO_CATEGORY = 'sys__no__category__sys',
  SHARED_PROMPTS = 'sys__shared__prompts__sys',
}

export const providerEndpointMap = {
  [EModelEndpoint.openAI]: EModelEndpoint.openAI,
  [EModelEndpoint.bedrock]: EModelEndpoint.bedrock,
  [EModelEndpoint.anthropic]: EModelEndpoint.anthropic,
  [EModelEndpoint.azureOpenAI]: EModelEndpoint.azureOpenAI,
};

export const specialVariables = {
  current_date: true,
  current_user: true,
  iso_datetime: true,
  current_datetime: true,
};

export type TSpecialVarLabel = `com_ui_special_var_${keyof typeof specialVariables}`;

/**
 * Retrieves a specific field from the endpoints configuration for a given endpoint key.
 * Does not infer or default any endpoint type when absent.
 */
export function getEndpointField<
  K extends TConfig[keyof TConfig] extends never ? never : keyof TConfig,
>(
  endpointsConfig: TEndpointsConfig | undefined | null,
  endpoint: EModelEndpoint | string | null | undefined,
  property: K,
): TConfig[K] | undefined {
  if (!endpointsConfig || endpoint === null || endpoint === undefined) {
    return undefined;
  }
  const config = endpointsConfig[endpoint];
  if (!config) {
    return undefined;
  }
  return config[property];
}

/**
 * Resolves the effective endpoint type:
 * - Non-agents endpoint: config.type || endpoint
 * - Agents + provider: config[provider].type || provider
 * - Agents, no provider: EModelEndpoint.agents
 *
 * Returns `undefined` when endpoint is null/undefined.
 */
export function resolveEndpointType(
  endpointsConfig: TEndpointsConfig | undefined | null,
  endpoint: string | null | undefined,
  agentProvider?: string | null,
): EModelEndpoint | string | undefined {
  if (!endpoint) {
    return undefined;
  }

  if (!isAgentsEndpoint(endpoint)) {
    return getEndpointField(endpointsConfig, endpoint, 'type') || endpoint;
  }

  if (agentProvider) {
    const providerType = getEndpointField(endpointsConfig, agentProvider, 'type');
    if (providerType) {
      return providerType;
    }
    return agentProvider;
  }

  return EModelEndpoint.agents;
}

/** Resolves the `defaultParamsEndpoint` for a given endpoint from its custom params config */
export function getDefaultParamsEndpoint(
  endpointsConfig: TEndpointsConfig | undefined | null,
  endpoint: string | null | undefined,
): string | undefined {
  if (!endpointsConfig || !endpoint) {
    return undefined;
  }
  return endpointsConfig[endpoint]?.customParams?.defaultParamsEndpoint;
}
