import {
  MAX_PII_CUSTOM_PATTERNS_TOTAL,
  MAX_PII_CUSTOM_REGEX_CHARACTERS,
  MAX_PII_CUSTOM_REGEX_INSTRUCTIONS,
  MAX_PII_PATTERN_ID_LENGTH,
  MAX_PII_PATTERNS_PER_SOURCE,
  getPiiRegexProgramSize,
} from 'librechat-data-provider';
import type {
  FilterPiiAction,
  FiltersConfig,
  MessageFilterPiiConfig,
} from 'librechat-data-provider';
import type {
  PatternContentInspector,
  PatternContentInspectorConfig,
  PatternContentInspectorPreflightCost,
} from './detectors/pattern';
import type { ContentSource, ProtectionFinding, TextContentFragment } from './types';
import type { ContentTraversalLimitError } from './adapters/nested';
import {
  cachePatternContentInspector,
  createPatternContentInspector,
  getPatternContentInspectorPreflightCost,
  PatternConfigurationError,
} from './detectors/pattern';
import {
  getContentTraversalFragments,
  isContentTraversalLimitError,
  isContentTraversalProtected,
} from './adapters/nested';
import { isLegacyPiiFragment } from './legacy';
import { recordAuditFinding } from './audit';

interface CompiledFilter {
  readonly detectorId: string;
  readonly action: FilterPiiAction;
  readonly sources: ReadonlySet<ContentSource>;
  readonly fields: ReadonlySet<string> | null;
  readonly applies?: (fragment: TextContentFragment) => boolean;
  readonly inspector: PatternContentInspector;
}

export interface ContentInspectionConfig {
  readonly filters?: FiltersConfig;
  readonly legacyPii?: MessageFilterPiiConfig;
}

export interface ConfiguredContentInspector {
  readonly hasAuditRules: boolean;
  createSession(): ConfiguredContentInspectionSession;
  inspect(fragments: Iterable<TextContentFragment>): ProtectionFinding | null;
}

export interface ConfiguredContentInspectionSession {
  readonly hasAuditRules: boolean;
  inspectFragment(fragment: TextContentFragment): ProtectionFinding | null;
  inspect(fragments: Iterable<TextContentFragment>): ProtectionFinding | null;
}

export interface TraversalAwareContentInspectionConfig extends ContentInspectionConfig {
  readonly roles?: readonly (string | undefined)[];
}

export interface TraversalAwareContentInspectionResult {
  readonly finding: ProtectionFinding | null;
  readonly traversalError: ContentTraversalLimitError | null;
}

const FILTER_INSPECTOR_CACHE = new WeakMap<object, ConfiguredContentInspector>();
const LEGACY_INSPECTOR_CACHE = new WeakMap<object, ConfiguredContentInspector>();
const COMBINED_INSPECTOR_CACHE = new WeakMap<object, WeakMap<object, ConfiguredContentInspector>>();
const MAX_INSPECTION_DEDUPE_ENTRIES_PER_RULE = 4_096;
const MAX_LINEAR_REGEX_SET_MEMORY_BYTES = 8 * 1_024 * 1_024;

interface FilterCompilationPlan {
  readonly detectorId: string;
  readonly action: FilterPiiAction;
  readonly config: PatternContentInspectorConfig;
  readonly sources: readonly ContentSource[];
  readonly fields: ReadonlySet<string> | null;
  readonly applies?: (fragment: TextContentFragment) => boolean;
  readonly preflight: PatternContentInspectorPreflightCost;
  validCustomPatterns: number;
}

function snapshotFilterFields(
  config: PatternContentInspectorConfig & { readonly fields?: readonly string[] },
): ReadonlySet<string> | null {
  let candidate: unknown;
  try {
    candidate = config.fields;
  } catch {
    throw new PatternConfigurationError('[messageFilter.pii] fields could not be read safely');
  }
  if (candidate == null) {
    return null;
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(candidate);
  } catch {
    throw new PatternConfigurationError('[messageFilter.pii] fields could not be inspected safely');
  }
  if (!isArray) {
    throw new PatternConfigurationError('[messageFilter.pii] fields must be an array');
  }
  const fieldValues = candidate as readonly unknown[];
  let fieldCount: number;
  try {
    fieldCount = fieldValues.length;
  } catch {
    throw new PatternConfigurationError('[messageFilter.pii] fields could not be read safely');
  }
  if (
    !Number.isSafeInteger(fieldCount) ||
    fieldCount < 0 ||
    fieldCount > MAX_PII_PATTERNS_PER_SOURCE
  ) {
    throw new PatternConfigurationError(
      `[messageFilter.pii] fields may contain at most ${MAX_PII_PATTERNS_PER_SOURCE} entries`,
    );
  }
  const fields = new Set<string>();
  for (let index = 0; index < fieldCount; index++) {
    let field: unknown;
    try {
      field = fieldValues[index];
    } catch {
      throw new PatternConfigurationError('[messageFilter.pii] fields could not be read safely');
    }
    if (
      typeof field !== 'string' ||
      field.length === 0 ||
      field.length > MAX_PII_PATTERN_ID_LENGTH
    ) {
      throw new PatternConfigurationError('[messageFilter.pii] fields contains an invalid value');
    }
    fields.add(field);
  }
  return fields;
}

function appendFilterPlan(
  plans: FilterCompilationPlan[],
  config:
    | (PatternContentInspectorConfig & {
        readonly action?: FilterPiiAction;
        readonly fields?: readonly string[];
      })
    | undefined,
  sources: readonly ContentSource[],
): void {
  if (config == null) {
    return;
  }
  plans.push({
    detectorId: 'pii-pattern',
    action: config.action ?? 'block',
    config,
    sources,
    fields: snapshotFilterFields(config),
    preflight: getPatternContentInspectorPreflightCost(config),
    validCustomPatterns: 0,
  });
}

function getFilterCompilationPlans(filters: FiltersConfig | undefined): FilterCompilationPlan[] {
  const plans: FilterCompilationPlan[] = [];
  if (filters == null) {
    return plans;
  }
  try {
    appendFilterPlan(plans, filters.messages?.pii, ['message', 'assembled_context']);
    appendFilterPlan(plans, filters.prompts?.pii, ['prompt']);
    appendFilterPlan(plans, filters.agentInstructions?.pii, ['agent_instruction']);
    appendFilterPlan(plans, filters.conversationStarters?.pii, ['conversation_starter']);
    appendFilterPlan(plans, filters.skills?.pii, ['skill']);
    appendFilterPlan(plans, filters.memories?.pii, ['memory']);
    appendFilterPlan(plans, filters.files?.pii, ['file']);
    appendFilterPlan(plans, filters.toolArguments?.pii, ['tool_argument']);
    appendFilterPlan(plans, filters.modelParameters?.pii, ['model_parameter']);
    appendFilterPlan(plans, filters.actionMetadata?.pii, ['action_metadata']);
    appendFilterPlan(plans, filters.feedback?.pii, ['feedback']);
    appendFilterPlan(plans, filters.conversationTitles?.pii, ['conversation_title']);
  } catch (error) {
    if (error instanceof PatternConfigurationError) {
      throw error;
    }
    throw new PatternConfigurationError('[messageFilter.pii] filters could not be read safely');
  }
  return plans;
}

function assertGlobalFilterPatternBudget(plans: readonly FilterCompilationPlan[]): void {
  let customPatterns = 0;
  let regexCharacters = 0;
  for (const plan of plans) {
    customPatterns += plan.preflight.customPatterns;
    regexCharacters += plan.preflight.regexCharacters;
  }
  if (customPatterns > MAX_PII_CUSTOM_PATTERNS_TOTAL) {
    throw new PatternConfigurationError(
      `[messageFilter.pii] custom patterns exceed ${MAX_PII_CUSTOM_PATTERNS_TOTAL} configured patterns`,
    );
  }
  if (regexCharacters > MAX_PII_CUSTOM_REGEX_CHARACTERS) {
    throw new PatternConfigurationError(
      `[messageFilter.pii] custom patterns exceed ${MAX_PII_CUSTOM_REGEX_CHARACTERS} regex characters`,
    );
  }
}

function measureGlobalFilterPatternInstructions(plans: readonly FilterCompilationPlan[]): void {
  let regexInstructions = 0;
  for (const plan of plans) {
    const validRegexes = new Set<string>();
    const regexes = plan.preflight.regexes;
    for (let index = 0; index < regexes.length; index++) {
      const regex = regexes[index];
      const programSize = getPiiRegexProgramSize(regex);
      if (programSize == null) {
        continue;
      }
      validRegexes.add(regex);
      regexInstructions += programSize;
      if (regexInstructions > MAX_PII_CUSTOM_REGEX_INSTRUCTIONS) {
        throw new PatternConfigurationError(
          `[messageFilter.pii] custom patterns exceed ${MAX_PII_CUSTOM_REGEX_INSTRUCTIONS} compiled instructions`,
        );
      }
    }
    plan.validCustomPatterns = validRegexes.size;
  }
}

function createCompilationPlans(
  filters: FiltersConfig | undefined,
  legacyPii: MessageFilterPiiConfig | undefined,
): readonly FilterCompilationPlan[] {
  const plans = getFilterCompilationPlans(filters);
  if (legacyPii != null) {
    plans.unshift({
      detectorId: 'legacy-pattern',
      action: 'block',
      config: legacyPii,
      sources: ['message', 'assembled_context', 'tool_argument'],
      fields: null,
      applies: isLegacyPiiFragment,
      preflight: getPatternContentInspectorPreflightCost(legacyPii),
      validCustomPatterns: 0,
    });
  }
  assertGlobalFilterPatternBudget(plans);
  measureGlobalFilterPatternInstructions(plans);
  return plans;
}

function compilePlans(plans: readonly FilterCompilationPlan[]): readonly CompiledFilter[] {
  const regexSetConfigs = new Set<object>();
  for (const plan of plans) {
    if (plan.validCustomPatterns > 0) {
      regexSetConfigs.add(plan.config);
    }
  }
  const regexSetCount = regexSetConfigs.size;
  const maxMemoryBytes = Math.max(
    1,
    Math.floor(MAX_LINEAR_REGEX_SET_MEMORY_BYTES / Math.max(1, regexSetCount)),
  );
  const patternOptions = {
    linearTime: true as const,
    linearSetMaxMemoryBytes: maxMemoryBytes,
    cacheResult: false,
  };
  const compiled: CompiledFilter[] = [];
  const inspectors = new Map<object, PatternContentInspector>();
  for (const plan of plans) {
    let inspector = inspectors.get(plan.config);
    if (inspector == null) {
      inspector = createPatternContentInspector(plan.config, patternOptions);
      inspectors.set(plan.config, inspector);
    }
    if (!inspector.active) {
      continue;
    }
    compiled.push({
      detectorId: plan.detectorId,
      action: plan.action,
      sources: new Set(plan.sources),
      fields: plan.fields,
      applies: plan.applies,
      inspector,
    });
  }
  for (const [config, inspector] of inspectors) {
    cachePatternContentInspector(
      config as PatternContentInspectorConfig,
      inspector,
      patternOptions,
    );
  }
  return compiled;
}

function createInspector(rules: readonly CompiledFilter[]): ConfiguredContentInspector {
  const hasAuditRules = rules.some((rule) => rule.action === 'audit');
  const rulesBySource = new Map<ContentSource, Array<readonly [number, CompiledFilter]>>();
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex];
    for (const source of rule.sources) {
      const sourceRules = rulesBySource.get(source);
      if (sourceRules == null) {
        rulesBySource.set(source, [[ruleIndex, rule]]);
      } else {
        sourceRules.push([ruleIndex, rule]);
      }
    }
  }

  const inspectFragment = (
    fragment: TextContentFragment,
    inspectedTextByRule: Array<Set<string> | undefined>,
  ): ProtectionFinding | null => {
    const sourceRules = rulesBySource.get(fragment.source);
    if (sourceRules == null) {
      return null;
    }
    let firstBlockingFinding: ProtectionFinding | null = null;
    for (const [ruleIndex, rule] of sourceRules) {
      if (rule.fields != null && !rule.fields.has(fragment.field)) {
        continue;
      }
      if (rule.applies?.(fragment) === false) {
        continue;
      }
      const inspectedText = (inspectedTextByRule[ruleIndex] ??= new Set<string>());
      if (inspectedText.has(fragment.text)) {
        continue;
      }
      if (inspectedText.size < MAX_INSPECTION_DEDUPE_ENTRIES_PER_RULE) {
        inspectedText.add(fragment.text);
      }
      const finding = rule.inspector.inspectFragment(fragment);
      if (finding != null) {
        const configuredFinding = {
          ...finding,
          detectorId: rule.detectorId,
        };
        if (rule.action === 'audit') {
          recordAuditFinding({
            action: rule.action,
            detectorId: configuredFinding.detectorId,
            ruleId: configuredFinding.ruleId,
            label: configuredFinding.label,
            source: configuredFinding.source,
            field: configuredFinding.field,
            provenance: configuredFinding.provenance,
          });
          continue;
        }
        firstBlockingFinding ??= configuredFinding;
        if (!hasAuditRules) {
          return firstBlockingFinding;
        }
      }
    }
    return firstBlockingFinding;
  };
  const inspect = (
    fragments: Iterable<TextContentFragment>,
    inspectedTextByRule: Array<Set<string> | undefined>,
  ): ProtectionFinding | null => {
    let firstBlockingFinding: ProtectionFinding | null = null;
    for (const fragment of fragments) {
      const finding = inspectFragment(fragment, inspectedTextByRule);
      firstBlockingFinding ??= finding;
      if (firstBlockingFinding != null && !hasAuditRules) {
        break;
      }
    }
    return firstBlockingFinding;
  };
  const createSession = (): ConfiguredContentInspectionSession => {
    const inspectedTextByRule: Array<Set<string> | undefined> = new Array(rules.length);
    return {
      hasAuditRules,
      inspectFragment(fragment) {
        return inspectFragment(fragment, inspectedTextByRule);
      },
      inspect(fragments) {
        return inspect(fragments, inspectedTextByRule);
      },
    };
  };

  return {
    hasAuditRules,
    createSession,
    inspect(fragments) {
      return inspect(fragments, new Array(rules.length));
    },
  };
}

export function createConfiguredContentInspector(
  config: ContentInspectionConfig,
): ConfiguredContentInspector | null {
  const { filters, legacyPii } = config;
  if (filters == null && legacyPii == null) {
    return null;
  }

  if (filters != null && legacyPii != null) {
    let byLegacy = COMBINED_INSPECTOR_CACHE.get(filters);
    const cached = byLegacy?.get(legacyPii);
    if (cached != null) {
      return cached;
    }
    const rules = compilePlans(createCompilationPlans(filters, legacyPii));
    if (rules.length === 0) {
      return null;
    }
    const inspector = createInspector(rules);
    if (byLegacy == null) {
      byLegacy = new WeakMap<object, ConfiguredContentInspector>();
      COMBINED_INSPECTOR_CACHE.set(filters, byLegacy);
    }
    byLegacy.set(legacyPii, inspector);
    return inspector;
  }

  if (filters != null) {
    const cached = FILTER_INSPECTOR_CACHE.get(filters);
    if (cached != null) {
      return cached;
    }
    const rules = compilePlans(createCompilationPlans(filters, undefined));
    if (rules.length === 0) {
      return null;
    }
    const inspector = createInspector(rules);
    FILTER_INSPECTOR_CACHE.set(filters, inspector);
    return inspector;
  }

  const legacy = legacyPii as MessageFilterPiiConfig;
  const cached = LEGACY_INSPECTOR_CACHE.get(legacy);
  if (cached != null) {
    return cached;
  }
  const rules = compilePlans(createCompilationPlans(undefined, legacy));
  if (rules.length === 0) {
    return null;
  }
  const inspector = createInspector(rules);
  LEGACY_INSPECTOR_CACHE.set(legacy, inspector);
  return inspector;
}

export function inspectContent(
  fragments: Iterable<TextContentFragment>,
  config: ContentInspectionConfig,
): ProtectionFinding | null {
  return createConfiguredContentInspector(config)?.inspect(fragments) ?? null;
}

/** Inspects bounded extraction fragments before enforcing a protected traversal failure. */
export function inspectContentWithTraversal(
  extract: () => Iterable<TextContentFragment>,
  config: TraversalAwareContentInspectionConfig,
): TraversalAwareContentInspectionResult {
  const inspector = createConfiguredContentInspector(config);
  if (inspector == null) {
    return { finding: null, traversalError: null };
  }

  try {
    return { finding: inspector.inspect(extract()), traversalError: null };
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    const finding = inspector.inspect(getContentTraversalFragments(error));
    if (finding != null) {
      return { finding, traversalError: null };
    }
    const traversalError = isContentTraversalProtected({
      error,
      filters: config.filters,
      legacyPii: config.legacyPii,
      roles: config.roles,
    })
      ? error
      : null;
    return { finding: null, traversalError };
  }
}
