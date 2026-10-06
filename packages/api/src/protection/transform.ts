import {
  DEFAULT_PII_REDACTION_MAX_CHARACTERS,
  DEFAULT_PII_REDACTION_MAX_MATCHES,
  MAX_PII_PATTERNS_PER_SOURCE,
} from 'librechat-data-provider';
import type { FilterPiiAction, FilterPiiCategory } from 'librechat-data-provider';
import type { PatternContentInspectorConfig, PatternTextMatch } from './detectors/pattern';
import type { TextContentFragment } from './types';
import { createPatternContentInspector, PatternConfigurationError } from './detectors/pattern';

export type PiiPlaceholderType = Uppercase<FilterPiiCategory>;

export interface PiiRedactionConfig extends PatternContentInspectorConfig {
  readonly action?: FilterPiiAction;
  readonly fields?: readonly string[];
  readonly maxCharacters?: number;
  readonly maxMatches?: number;
}

export interface PiiRedactionMetadata {
  readonly category: PiiPlaceholderType;
  readonly count: number;
}

export interface PiiTransformationResult {
  readonly version: 1;
  readonly content: string;
  readonly replacements: number;
  readonly categories: readonly PiiRedactionMetadata[];
}

export class PiiTransformationError extends Error {
  constructor(reason: 'limit' | 'unreplaceable' | 'inspection') {
    super(`PII transformation failed: ${reason}`);
    this.name = 'PiiTransformationError';
  }
}

export interface PiiTransformationSession {
  /** Applies this rule to selected text fields; the caller must still enforce all other policies. */
  transform(fragment: TextContentFragment): PiiTransformationResult;
}

function readLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value == null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new PatternConfigurationError('Invalid PII transformation limit');
  }
  return value;
}

function mergedMatches(matches: readonly PatternTextMatch[]): PatternTextMatch[] {
  const sorted = [...matches].sort(
    (left, right) =>
      left.start - right.start ||
      right.end - left.end ||
      left.category.localeCompare(right.category),
  );
  const merged: PatternTextMatch[] = [];
  for (const match of sorted) {
    const previous = merged[merged.length - 1];
    if (previous == null || match.start >= previous.end) {
      merged.push(match);
    } else if (match.end > previous.end) {
      merged[merged.length - 1] = { ...previous, end: match.end };
    }
  }
  return merged;
}

/**
 * Explicit, opt-in transformation. Legacy inspectors still reject `redact` findings
 * until the authenticated submission and storage pipeline consumes this API.
 * A session owns only ephemeral, bounded mappings; never log or persist it.
 */
export function createPiiTextTransformer(config: PiiRedactionConfig): {
  createSession(): PiiTransformationSession;
} {
  if (config.action !== 'redact') {
    throw new PatternConfigurationError('PII transformation requires the redact action');
  }
  const maxCharacters = readLimit(
    config.maxCharacters,
    DEFAULT_PII_REDACTION_MAX_CHARACTERS,
    262_144,
  );
  const maxMatches = readLimit(config.maxMatches, DEFAULT_PII_REDACTION_MAX_MATCHES, 4_096);
  let fields: ReadonlySet<string> | undefined;
  if (config.fields != null) {
    try {
      if (!Array.isArray(config.fields) || config.fields.length > MAX_PII_PATTERNS_PER_SOURCE) {
        throw new PatternConfigurationError('Invalid PII transformation fields');
      }
      fields = new Set(config.fields);
      if (fields.size === 0 || [...fields].some((field) => typeof field !== 'string')) {
        throw new PatternConfigurationError('Invalid PII transformation fields');
      }
    } catch {
      throw new PatternConfigurationError('Invalid PII transformation fields');
    }
  }
  const inspector = createPatternContentInspector(config, { linearTime: true });

  return {
    createSession() {
      const placeholders = new Map<string, string>();
      const issued = new Set<string>();
      const reserved = new Set<string>();
      const nextByCategory = new Map<PiiPlaceholderType, number>();
      let remainingCharacters = maxCharacters;
      let remainingMatches = maxMatches;
      return {
        transform(fragment) {
          let matches: readonly PatternTextMatch[];
          try {
            if (fields != null && !fields.has(fragment.field)) {
              return { version: 1, content: fragment.text, replacements: 0, categories: [] };
            }
            if (typeof fragment.text !== 'string' || fragment.text.length > remainingCharacters) {
              throw new PiiTransformationError('limit');
            }
            remainingCharacters -= fragment.text.length;
            for (const marker of fragment.text.matchAll(
              /\[(?:EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_[1-9]\d*\]/g,
            )) {
              reserved.add(marker[0]);
              if (issued.has(marker[0])) {
                throw new PiiTransformationError('inspection');
              }
            }
            matches = inspector.locate(fragment.text, remainingMatches);
          } catch (error) {
            if (error instanceof PiiTransformationError) {
              throw error;
            }
            throw new PiiTransformationError('inspection');
          }
          if (matches.length === 0) {
            return { version: 1, content: fragment.text, replacements: 0, categories: [] };
          }
          if (
            fragment.treatment !== 'replaceable' ||
            !['plain', 'markdown'].includes(fragment.format)
          ) {
            throw new PiiTransformationError('unreplaceable');
          }
          const merged = mergedMatches(matches);
          remainingMatches -= matches.length;
          const categories = new Map<PiiPlaceholderType, number>();
          const parts: string[] = [];
          let offset = 0;
          for (const { start, end, category } of merged) {
            const type = category.toUpperCase() as PiiPlaceholderType;
            const value = fragment.text.slice(start, end);
            const key = JSON.stringify([type, value]);
            let placeholder = placeholders.get(key);
            if (placeholder == null) {
              let next = nextByCategory.get(type) ?? 0;
              do {
                next++;
                placeholder = `[${type}_${next}]`;
              } while (reserved.has(placeholder) || issued.has(placeholder));
              nextByCategory.set(type, next);
              placeholders.set(key, placeholder);
              issued.add(placeholder);
            }
            categories.set(type, (categories.get(type) ?? 0) + 1);
            parts.push(fragment.text.slice(offset, start), placeholder);
            offset = end;
          }
          parts.push(fragment.text.slice(offset));
          return {
            version: 1,
            content: parts.join(''),
            replacements: merged.length,
            categories: [...categories].map(([category, count]) => ({ category, count })),
          };
        },
      };
    },
  };
}
