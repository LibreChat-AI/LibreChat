import { RE2JS, RE2Set } from 're2js';
import { logger } from '@librechat/data-schemas';
import {
  MAX_PII_CUSTOM_REGEX_CHARACTERS,
  MAX_PII_CUSTOM_REGEX_INSTRUCTIONS,
  MAX_PII_PATTERN_ID_LENGTH,
  MAX_PII_PATTERN_LABEL_LENGTH,
  MAX_PII_PATTERN_LENGTH,
  MAX_PII_PATTERNS_PER_SOURCE,
  getPiiRegexProgramSize,
} from 'librechat-data-provider';
import type {
  FilterPiiCategory,
  MessageFilterPiiConfig,
  FilterPiiCustomPatternConfig,
} from 'librechat-data-provider';
import type { ProtectionFinding, TextContentFragment } from '../types';

interface CompiledPattern {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
  readonly category: FilterPiiCategory;
}

interface PreparedCustomPattern {
  readonly id: string;
  readonly label: string;
  readonly regex: string;
  readonly category: FilterPiiCategory;
}

interface SnapshotPatternContentInspectorConfig {
  readonly starter: readonly CompiledPattern[];
  readonly custom: readonly PreparedCustomPattern[];
  readonly regexes: readonly string[];
  readonly customPatterns: number;
  readonly regexCharacters: number;
}

interface PreparedPatternContentInspectorConfig {
  readonly starter: readonly CompiledPattern[];
  readonly custom: readonly PreparedCustomPattern[];
  readonly cost: PatternContentInspectorResourceCost;
}

export class PatternConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternConfigurationError';
  }
}

export function isPatternConfigurationError(error: unknown): error is PatternConfigurationError {
  return error instanceof PatternConfigurationError;
}

export interface PatternContentInspectorResourceCost {
  readonly customPatterns: number;
  readonly validCustomPatterns: number;
  readonly regexCharacters: number;
  readonly regexInstructions: number;
  readonly active: boolean;
}

export interface PatternContentInspectorPreflightCost {
  readonly customPatterns: number;
  readonly regexCharacters: number;
  readonly regexes: readonly string[];
}

export interface PatternTextMatch {
  readonly start: number;
  readonly end: number;
  readonly category: FilterPiiCategory;
}

export interface PatternContentInspector {
  readonly active: boolean;
  inspectFragment(fragment: TextContentFragment): ProtectionFinding | null;
  inspect(fragments: Iterable<TextContentFragment>): ProtectionFinding | null;
  /** Internal match locations, never safe to return as public finding metadata. */
  locate(text: string, maxMatches: number): readonly PatternTextMatch[];
}

export interface PatternContentInspectorConfig {
  readonly starterPatterns?: readonly string[];
  readonly customPatterns?: readonly FilterPiiCustomPatternConfig[];
}

export interface PatternContentInspectorOptions {
  readonly linearTime?: boolean;
  readonly linearSetMaxMemoryBytes?: number;
  /** Defers cache publication so callers can commit a multi-config compilation atomically. */
  readonly cacheResult?: boolean;
}

const STARTER_PATTERNS: readonly CompiledPattern[] = [
  {
    id: 'sk_prefix',
    label: 'sk- prefix token',
    pattern: /\b(sk-)[a-zA-Z0-9_-]+/,
    category: 'credential',
  },
  {
    id: 'bearer_header',
    label: 'Bearer token',
    pattern: /\b(Bearer )[^\s"']+/i,
    category: 'credential',
  },
  {
    id: 'api_key_header',
    label: 'api-key header',
    pattern: /\b(api-key:?\s+)[^\s"']+/i,
    category: 'credential',
  },
];

const STARTER_BY_ID = new Map(STARTER_PATTERNS.map((pattern) => [pattern.id, pattern]));
const SNAPSHOT_CONFIG_CACHE = new WeakMap<object, SnapshotPatternContentInspectorConfig>();
const PREPARED_CONFIG_CACHE = new WeakMap<object, PreparedPatternContentInspectorConfig>();
const NATIVE_INSPECTOR_CACHE = new WeakMap<object, PatternContentInspector>();
const LINEAR_INSPECTOR_CACHE = new WeakMap<object, Map<number, PatternContentInspector>>();
const DEFAULT_LINEAR_SET_MAX_MEMORY_BYTES = 8 * 1_024 * 1_024;
/** Runtime normally retains one configured inspector. Keep only a tiny number
 * of alternate DFA ceilings for direct callers or shared configs reused by a
 * differently-shaped top-level filter graph. */
const MAX_LINEAR_CACHE_OPTIONS_PER_CONFIG = 2;

function configurationError(message: string): PatternConfigurationError {
  return new PatternConfigurationError(`[messageFilter.pii] ${message}`);
}

function isArraySafely(candidate: unknown, name: string): candidate is readonly unknown[] {
  try {
    return Array.isArray(candidate);
  } catch {
    throw configurationError(`${name} could not be inspected safely`);
  }
}

function readBoundedArray(
  candidate: unknown,
  name: string,
): { readonly values: readonly unknown[]; readonly length: number } | null {
  if (candidate == null) {
    return null;
  }
  if (!isArraySafely(candidate, name)) {
    throw configurationError(`${name} must be an array`);
  }
  let length: number;
  try {
    length = candidate.length;
  } catch {
    throw configurationError(`${name} could not be read safely`);
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PII_PATTERNS_PER_SOURCE) {
    throw configurationError(`${name} may contain at most ${MAX_PII_PATTERNS_PER_SOURCE} entries`);
  }
  return { values: candidate, length };
}

function selectStarter(candidate: unknown): readonly CompiledPattern[] {
  const bounded = readBoundedArray(candidate, 'starterPatterns');
  if (bounded == null) {
    return STARTER_PATTERNS;
  }
  const selected: CompiledPattern[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < bounded.length; index++) {
    let id: unknown;
    try {
      id = bounded.values[index];
    } catch {
      throw configurationError('starterPatterns could not be read safely');
    }
    if (typeof id !== 'string' || id.length > MAX_PII_PATTERN_ID_LENGTH) {
      throw configurationError('starterPatterns contains an invalid identifier');
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const pattern = STARTER_BY_ID.get(id);
    if (pattern != null) {
      selected.push(pattern);
    }
  }
  return selected;
}

function readCustomPattern(candidate: unknown, index: number): FilterPiiCustomPatternConfig {
  if (
    candidate == null ||
    typeof candidate !== 'object' ||
    isArraySafely(candidate, `customPatterns[${index}]`)
  ) {
    throw configurationError(`customPatterns[${index}] must be an object`);
  }
  let id: unknown;
  let label: unknown;
  let regex: unknown;
  try {
    const value = candidate as {
      readonly id?: unknown;
      readonly label?: unknown;
      readonly regex?: unknown;
    };
    id = value.id;
    label = value.label;
    regex = value.regex;
  } catch {
    throw configurationError(`customPatterns[${index}] could not be read safely`);
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PII_PATTERN_ID_LENGTH) {
    throw configurationError(`customPatterns[${index}].id is invalid`);
  }
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    label.length > MAX_PII_PATTERN_LABEL_LENGTH
  ) {
    throw configurationError(`customPatterns[${index}].label is invalid`);
  }
  if (typeof regex !== 'string' || regex.length === 0 || regex.length > MAX_PII_PATTERN_LENGTH) {
    throw configurationError(`customPatterns[${index}].regex is invalid`);
  }
  let category: unknown;
  try {
    category = (candidate as FilterPiiCustomPatternConfig).category;
  } catch {
    throw configurationError(`customPatterns[${index}] could not be read safely`);
  }
  if (
    category != null &&
    (typeof category !== 'string' ||
      !['email', 'phone', 'name', 'credential', 'custom'].includes(category))
  ) {
    throw configurationError(`customPatterns[${index}].category is invalid`);
  }
  return {
    id,
    label,
    regex,
    ...(category == null ? {} : { category: category as FilterPiiCategory }),
  };
}

function snapshotConfig(
  config: PatternContentInspectorConfig | MessageFilterPiiConfig,
): SnapshotPatternContentInspectorConfig {
  if (config == null || typeof config !== 'object') {
    throw configurationError('configuration must be an object');
  }
  const cached = SNAPSHOT_CONFIG_CACHE.get(config);
  if (cached != null) {
    return cached;
  }

  let starterCandidate: unknown;
  let customCandidate: unknown;
  try {
    starterCandidate = config.starterPatterns;
    customCandidate = config.customPatterns;
  } catch {
    throw configurationError('configuration could not be read safely');
  }

  const starter = selectStarter(starterCandidate);
  const boundedCustom = readBoundedArray(customCandidate, 'customPatterns');
  const custom: PreparedCustomPattern[] = [];
  const regexes: string[] = [];
  let customPatterns = 0;
  let regexCharacters = 0;
  if (boundedCustom != null) {
    customPatterns = boundedCustom.length;
    for (let index = 0; index < boundedCustom.length; index++) {
      let patternCandidate: unknown;
      try {
        patternCandidate = boundedCustom.values[index];
      } catch {
        throw configurationError('customPatterns could not be read safely');
      }
      const pattern = readCustomPattern(patternCandidate, index);
      custom.push({ ...pattern, category: pattern.category ?? 'custom' });
      regexes.push(pattern.regex);
      regexCharacters += pattern.regex.length;
      if (regexCharacters > MAX_PII_CUSTOM_REGEX_CHARACTERS) {
        throw configurationError(
          `custom patterns exceed ${MAX_PII_CUSTOM_REGEX_CHARACTERS} regex characters`,
        );
      }
    }
  }

  const snapshot: SnapshotPatternContentInspectorConfig = {
    starter,
    custom,
    regexes,
    customPatterns,
    regexCharacters,
  };
  SNAPSHOT_CONFIG_CACHE.set(config, snapshot);
  return snapshot;
}

function prepareConfig(
  config: PatternContentInspectorConfig | MessageFilterPiiConfig,
): PreparedPatternContentInspectorConfig {
  const cached = PREPARED_CONFIG_CACHE.get(config);
  if (cached != null) {
    return cached;
  }
  const snapshot = snapshotConfig(config);
  const custom: PreparedCustomPattern[] = [];
  const programSizeByRegex = new Map<string, number | null>();
  let regexInstructions = 0;
  for (const pattern of snapshot.custom) {
    if (!programSizeByRegex.has(pattern.regex)) {
      const programSize = getPiiRegexProgramSize(pattern.regex);
      if (programSize != null) {
        custom.push(pattern);
      } else {
        logger.warn(
          `[messageFilter.pii] dropping invalid customPattern ${JSON.stringify(pattern.id)}: not compatible with the RE2 engine`,
        );
      }
      programSizeByRegex.set(pattern.regex, programSize);
    }
    regexInstructions += programSizeByRegex.get(pattern.regex) ?? 0;
    if (regexInstructions > MAX_PII_CUSTOM_REGEX_INSTRUCTIONS) {
      throw configurationError(
        `custom patterns exceed ${MAX_PII_CUSTOM_REGEX_INSTRUCTIONS} compiled instructions`,
      );
    }
  }

  const prepared: PreparedPatternContentInspectorConfig = {
    starter: snapshot.starter,
    custom,
    cost: {
      customPatterns: snapshot.customPatterns,
      validCustomPatterns: custom.length,
      regexCharacters: snapshot.regexCharacters,
      regexInstructions,
      active: snapshot.starter.length > 0 || custom.length > 0,
    },
  };
  PREPARED_CONFIG_CACHE.set(config, prepared);
  return prepared;
}

export function getPatternContentInspectorPreflightCost(
  config: PatternContentInspectorConfig | MessageFilterPiiConfig,
): PatternContentInspectorPreflightCost {
  const snapshot = snapshotConfig(config);
  return {
    customPatterns: snapshot.customPatterns,
    regexCharacters: snapshot.regexCharacters,
    regexes: snapshot.regexes,
  };
}

export function getPatternContentInspectorResourceCost(
  config: PatternContentInspectorConfig | MessageFilterPiiConfig,
): PatternContentInspectorResourceCost {
  return prepareConfig(config).cost;
}

function findingFor(
  pattern: Pick<CompiledPattern, 'id' | 'label'>,
  fragment: TextContentFragment,
): ProtectionFinding {
  return {
    detectorId: 'legacy-pattern',
    ruleId: pattern.id,
    label: pattern.label,
    source: fragment.source,
    field: fragment.field,
    provenance: fragment.provenance,
    fragmentId: fragment.id,
    fragmentPath: fragment.path,
  };
}

function createSequentialInspector(patterns: readonly CompiledPattern[]): PatternContentInspector {
  const inspectFragment = (fragment: TextContentFragment): ProtectionFinding | null => {
    for (const pattern of patterns) {
      if (pattern.pattern.test(fragment.text)) {
        return findingFor(pattern, fragment);
      }
    }
    return null;
  };

  return createInspector(patterns.length > 0, inspectFragment);
}

function createInspector(
  active: boolean,
  inspectFragment: (fragment: TextContentFragment) => ProtectionFinding | null,
  locate?: (text: string, maxMatches: number) => readonly PatternTextMatch[],
): PatternContentInspector {
  return {
    active,
    inspectFragment,
    locate(text, maxMatches) {
      if (locate == null) {
        throw configurationError('redaction requires a linear-time pattern inspector');
      }
      return locate(text, maxMatches);
    },
    inspect(fragments) {
      for (const fragment of fragments) {
        const finding = inspectFragment(fragment);
        if (finding != null) {
          return finding;
        }
      }
      return null;
    },
  };
}

function createLinearInspector(
  prepared: PreparedPatternContentInspectorConfig,
  maxMemoryBytes: number | undefined,
): PatternContentInspector {
  if (maxMemoryBytes != null && (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes <= 0)) {
    throw configurationError('linear regex-set memory limit must be a positive safe integer');
  }
  let customSet: RE2Set | undefined;
  if (prepared.custom.length > 0) {
    try {
      customSet = new RE2Set(RE2Set.UNANCHORED, 0, maxMemoryBytes);
      for (const pattern of prepared.custom) {
        customSet.add(pattern.regex);
      }
      customSet.compile();
    } catch (error) {
      throw configurationError(
        `custom pattern set could not be compiled: ${(error as Error).message}`,
      );
    }
  }

  const inspectFragment = (fragment: TextContentFragment): ProtectionFinding | null => {
    for (const pattern of prepared.starter) {
      if (pattern.pattern.test(fragment.text)) {
        return findingFor(pattern, fragment);
      }
    }
    if (customSet == null) {
      return null;
    }
    const matches = customSet.match(fragment.text);
    let firstMatch = Number.POSITIVE_INFINITY;
    for (let index = 0; index < matches.length; index++) {
      const candidate = matches[index];
      if (candidate < firstMatch) {
        firstMatch = candidate;
      }
    }
    const pattern = prepared.custom[firstMatch];
    return pattern == null ? null : findingFor(pattern, fragment);
  };

  const compiled = new Map<string, RE2JS>();
  const locate = (text: string, maxMatches: number): readonly PatternTextMatch[] => {
    if (!Number.isSafeInteger(maxMatches) || maxMatches < 0) {
      throw configurationError('redaction match limit must be a non-negative safe integer');
    }
    const matches: PatternTextMatch[] = [];
    const selected = customSet == null ? [] : customSet.match(text);
    const candidates: Array<readonly [string, FilterPiiCategory]> = prepared.starter.map(
      (pattern) => [
        `${pattern.pattern.ignoreCase ? '(?i)' : ''}${pattern.pattern.source}`,
        pattern.category,
      ],
    );
    for (const index of selected) {
      const pattern = prepared.custom[index];
      if (pattern != null) {
        candidates.push([pattern.regex, pattern.category]);
      }
    }
    for (const [expression, category] of candidates) {
      let regex = compiled.get(expression);
      if (regex == null) {
        regex = RE2JS.compile(expression);
        compiled.set(expression, regex);
      }
      const matcher = regex.matcher(text);
      while (matcher.find()) {
        const start = matcher.start();
        const end = matcher.end();
        if (end <= start || matches.length >= maxMatches) {
          throw configurationError('redaction match limit or empty match encountered');
        }
        matches.push({ start, end, category });
      }
    }
    return matches;
  };
  return createInspector(prepared.cost.active, inspectFragment, locate);
}

function cacheLinearInspector(
  config: PatternContentInspectorConfig | MessageFilterPiiConfig,
  maxMemoryBytes: number,
  inspector: PatternContentInspector,
): void {
  let byMemoryLimit = LINEAR_INSPECTOR_CACHE.get(config);
  if (byMemoryLimit == null) {
    byMemoryLimit = new Map<number, PatternContentInspector>();
    LINEAR_INSPECTOR_CACHE.set(config, byMemoryLimit);
  }
  if (byMemoryLimit.size >= MAX_LINEAR_CACHE_OPTIONS_PER_CONFIG) {
    const oldest = byMemoryLimit.keys().next().value;
    if (oldest != null) {
      byMemoryLimit.delete(oldest);
    }
  }
  byMemoryLimit.set(maxMemoryBytes, inspector);
}

export function cachePatternContentInspector(
  config: PatternContentInspectorConfig | MessageFilterPiiConfig,
  inspector: PatternContentInspector,
  options: PatternContentInspectorOptions = {},
): void {
  if (options.linearTime === true) {
    cacheLinearInspector(
      config,
      options.linearSetMaxMemoryBytes ?? DEFAULT_LINEAR_SET_MAX_MEMORY_BYTES,
      inspector,
    );
    return;
  }
  NATIVE_INSPECTOR_CACHE.set(config, inspector);
}

export function createPatternContentInspector(
  config: PatternContentInspectorConfig | MessageFilterPiiConfig,
  options: PatternContentInspectorOptions = {},
): PatternContentInspector {
  const prepared = prepareConfig(config);
  if (options.linearTime === true) {
    const maxMemoryBytes = options.linearSetMaxMemoryBytes ?? DEFAULT_LINEAR_SET_MAX_MEMORY_BYTES;
    const byMemoryLimit = LINEAR_INSPECTOR_CACHE.get(config);
    const cached = byMemoryLimit?.get(maxMemoryBytes);
    if (cached != null) {
      return cached;
    }
    const inspector = createLinearInspector(prepared, maxMemoryBytes);
    if (options.cacheResult !== false) {
      cacheLinearInspector(config, maxMemoryBytes, inspector);
    }
    return inspector;
  }
  const cached = NATIVE_INSPECTOR_CACHE.get(config);
  if (cached != null) {
    return cached;
  }
  const custom: CompiledPattern[] = prepared.custom.map((pattern) => ({
    id: pattern.id,
    label: pattern.label,
    pattern: new RegExp(pattern.regex),
    category: pattern.category,
  }));
  const inspector = createSequentialInspector([...prepared.starter, ...custom]);
  if (options.cacheResult !== false) {
    NATIVE_INSPECTOR_CACHE.set(config, inspector);
  }
  return inspector;
}
