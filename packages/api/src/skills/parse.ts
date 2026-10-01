import yaml from 'js-yaml';
import { normalizeSkillFrontmatterKeys } from '@librechat/data-schemas';
import type { SkillBooleanFlag, SkillBooleanColumn } from '@librechat/data-schemas';

type SchemaWithTypes = yaml.Schema & { implicit: yaml.Type[]; explicit: yaml.Type[] };

const defaultYamlSchema = yaml.DEFAULT_SCHEMA as SchemaWithTypes;
const explicitYamlNull = new yaml.Type('tag:yaml.org,2002:null', {
  kind: 'scalar',
  resolve: () => true,
  construct: (value) => ({ explicitYamlNull: value }),
});
/** Keep implicit scalar text while accepting standard explicit YAML tags. */
const AUTHORED_YAML_SCHEMA = yaml.FAILSAFE_SCHEMA.extend({
  explicit: [
    ...defaultYamlSchema.explicit,
    ...defaultYamlSchema.implicit.filter(
      (type) => (type as yaml.Type & { tag: string }).tag !== 'tag:yaml.org,2002:null',
    ),
    explicitYamlNull,
  ],
});

/**
 * Boolean frontmatter flags mirrored onto first-class skill columns, declared
 * locally on purpose. Several suites replace `@librechat/data-schemas` with a
 * partial mock, and reading this value export from it at module scope resolves
 * to `undefined` and throws before any test runs. The type is still imported
 * (erased at compile time), and `parse.test.ts` asserts this table matches
 * `SKILL_BOOLEAN_FLAGS` in data-schemas so the two cannot drift.
 */
export const SKILL_BOOLEAN_FLAGS: readonly SkillBooleanFlag[] = [
  { column: 'alwaysApply', key: 'always-apply', aliases: ['alwaysApply'] },
  { column: 'userInvocable', key: 'user-invocable', aliases: [] },
  { column: 'disableModelInvocation', key: 'disable-model-invocation', aliases: [] },
];

export type ParsedSkillMarkdown = {
  name: string;
  description: string;
  alwaysApply?: boolean;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  frontmatter?: Record<string, unknown>;
  invalidBooleans: string[];
  parseError?: string;
};

const SKILL_BOOLEAN_FLAG_BY_KEY = new Map<string, SkillBooleanFlag>(
  SKILL_BOOLEAN_FLAGS.flatMap((flag) =>
    [flag.key, ...flag.aliases].map((key) => [key, flag] as const),
  ),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFrontmatterBlock(raw: string): string | null {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const firstContentIndex = normalized.search(/\S/);
  if (firstContentIndex === -1) {
    return null;
  }
  const content = normalized.slice(firstContentIndex);
  const opening = /^---[ \t]*\n/.exec(content);
  if (!opening) {
    return null;
  }
  const body = content.slice(opening[0].length);
  const closingFence = /(?:^|\n)---[ \t]*(?:\n|$)/.exec(body);
  if (!closingFence) {
    return null;
  }
  return body.slice(0, closingFence.index);
}

function getCaseInsensitive(frontmatter: Record<string, unknown>, key: string): unknown {
  const target = key.toLowerCase();
  const entry = Object.entries(frontmatter).find(
    ([candidate]) => candidate.toLowerCase() === target,
  );
  return entry?.[1];
}

function hasCaseInsensitive(frontmatter: Record<string, unknown>, key: string): boolean {
  const target = key.toLowerCase();
  return Object.keys(frontmatter).some((candidate) => candidate.toLowerCase() === target);
}

/**
 * Recover the text a key carried on its own line so an empty/comment-only
 * placeholder can be distinguished from an invalid scalar. Matching is
 * anchored at the mapping's base indentation so a nested mapping that reuses a
 * flag name (`metadata:` → `  user-invocable: ...`) can't shadow the top-level
 * key while a mapping indented as a whole still works. YAML aliases and tags
 * are resolved by the parser itself, so their raw spelling is deliberately not
 * used to second-guess a resolved boolean.
 */
function getRawFrontmatterValue(block: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = block.split('\n');
  const contentLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });
  const baseIndent = contentLines.reduce((minimum, line) => {
    const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0;
    return Math.min(minimum, indentation);
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(baseIndent)) {
    return undefined;
  }
  const pattern = new RegExp(
    `^[ \\t]{${baseIndent}}(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')\\s*:\\s*(.*)$`,
    'i',
  );
  const lineIndex = lines.findIndex((candidate) => pattern.test(candidate));
  if (lineIndex === -1) {
    return undefined;
  }
  const sameLineValue = lines[lineIndex].match(pattern)?.[1];
  if (!hasBooleanPlaceholder(sameLineValue)) {
    return sameLineValue;
  }
  for (let index = lineIndex + 1; index < lines.length; index++) {
    const candidate = lines[index];
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const indentation = candidate.match(/^[ \\t]*/)?.[0].length ?? 0;
    return indentation > baseIndent ? trimmed : sameLineValue;
  }
  return sameLineValue;
}

function stripInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (char === '#' && !quote) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

/** Strip one layer of matching YAML quotes, if present. */
function unquoteScalar(value: string): string {
  if (
    value.length >= 2 &&
    ((value[0] === '"' && value[value.length - 1] === '"') ||
      (value[0] === "'" && value[value.length - 1] === "'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}
function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const lowered = value.trim().toLowerCase();
  if (lowered === 'true') {
    return true;
  }
  if (lowered === 'false') {
    return false;
  }
  return undefined;
}

/**
 * Whether a flag line carries no value yet — `user-invocable:`, a
 * comment-only value, or empty quotes. All are mid-edit states rather than
 * malformed booleans, so they are treated as if the key were absent.
 */
function hasBooleanPlaceholder(rawValue?: string): boolean {
  if (rawValue === undefined) {
    return false;
  }
  const stripped = stripInlineComment(rawValue);
  return stripped.length === 0 || unquoteScalar(stripped).length === 0;
}

type ResolvedBooleanFlag = { value?: boolean; invalidKey?: string };

/**
 * Read a flag key already known to be present. A value that is neither
 * `true` nor `false` is reported on `invalidKey` — under the key's authored
 * spelling — rather than silently collapsing to "off", except for an empty
 * value (`user-invocable:` with nothing after it), which is a mid-edit
 * placeholder and treated as absent.
 */
function readPresentBooleanFlag(
  frontmatter: Record<string, unknown>,
  authoredFrontmatter: Record<string, unknown> | undefined,
  block: string,
  key: string,
): ResolvedBooleanFlag {
  const rawValue = getRawFrontmatterValue(block, key);
  const parsedValue = getCaseInsensitive(frontmatter, key);
  const value = parseBoolean(parsedValue);
  if (value !== undefined) {
    return { value };
  }
  if (parsedValue === '') {
    return {};
  }
  if (parsedValue === null) {
    /* A failsafe parse preserves explicit `null` / `~` as strings but leaves
       a genuinely empty/comment-only value as null. This works for flow-style,
       indented, quoted-key, and alias forms where a line-based check cannot
       reliably recover the authored scalar. The raw line is only a fallback
       when an unrelated explicit YAML tag makes the failsafe parse unavailable. */
    if (
      (authoredFrontmatter &&
        hasCaseInsensitive(authoredFrontmatter, key) &&
        getCaseInsensitive(authoredFrontmatter, key) === null) ||
      (!authoredFrontmatter && rawValue !== undefined && hasBooleanPlaceholder(rawValue))
    ) {
      return {};
    }
  }
  return { invalidKey: key };
}

function resolveBooleanFlag(
  frontmatter: Record<string, unknown>,
  authoredFrontmatter: Record<string, unknown> | undefined,
  block: string,
  flag: SkillBooleanFlag,
): ResolvedBooleanFlag {
  if (hasCaseInsensitive(frontmatter, flag.key)) {
    return readPresentBooleanFlag(frontmatter, authoredFrontmatter, block, flag.key);
  }
  const alias = flag.aliases.find((candidate) => hasCaseInsensitive(frontmatter, candidate));
  if (alias !== undefined) {
    return readPresentBooleanFlag(frontmatter, authoredFrontmatter, block, alias);
  }
  return {};
}

function toScalarString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const block = extractFrontmatterBlock(raw);
  if (!block) {
    return { name: '', description: '', invalidBooleans: [] };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(block);
  } catch (error) {
    return {
      name: '',
      description: '',
      invalidBooleans: [],
      parseError: error instanceof Error ? error.message : 'Invalid YAML frontmatter',
    };
  }
  let frontmatter: Record<string, unknown> = {};
  let authoredFrontmatter: Record<string, unknown> | undefined;
  if (isPlainObject(parsed)) {
    const normalized = normalizeSkillFrontmatterKeys(parsed);
    if ('error' in normalized) {
      return {
        name: '',
        description: '',
        invalidBooleans: [],
        parseError: normalized.error,
      };
    }
    frontmatter = normalized.frontmatter;
  }
  try {
    const authoredParsed = yaml.load(block, { schema: AUTHORED_YAML_SCHEMA });
    if (isPlainObject(authoredParsed)) {
      const authoredNormalized = normalizeSkillFrontmatterKeys(authoredParsed);
      if ('frontmatter' in authoredNormalized) {
        authoredFrontmatter = authoredNormalized.frontmatter;
      }
    }
  } catch {
    /* The default parse above remains authoritative. This second parse exists
       only to distinguish implicit empty values from explicit YAML nulls. */
  }
  const nameValue = getCaseInsensitive(frontmatter, 'name');
  const descriptionValue = getCaseInsensitive(frontmatter, 'description');
  const whenToUseValue = getCaseInsensitive(frontmatter, 'when-to-use');
  const name = toScalarString(nameValue);
  let description = '';
  if (descriptionValue !== undefined) {
    description = toScalarString(descriptionValue);
  } else if (whenToUseValue !== undefined) {
    description = toScalarString(whenToUseValue);
  }
  const flagValues: Partial<Record<SkillBooleanColumn, boolean>> = {};
  const invalidBooleans: string[] = [];
  for (const flag of SKILL_BOOLEAN_FLAGS) {
    const { value, invalidKey } = resolveBooleanFlag(frontmatter, authoredFrontmatter, block, flag);
    if (invalidKey !== undefined) {
      invalidBooleans.push(invalidKey);
      continue;
    }
    if (value !== undefined) {
      flagValues[flag.column] = value;
    }
  }
  return {
    name,
    description,
    alwaysApply: flagValues.alwaysApply,
    userInvocable: flagValues.userInvocable,
    disableModelInvocation: flagValues.disableModelInvocation,
    frontmatter,
    invalidBooleans,
  };
}

/**
 * Reduce a parsed frontmatter bag to what a skill document should persist:
 * `name`/`description` live in their own columns, and every boolean flag is
 * rewritten from the parser's resolved value under its canonical key.
 *
 * That rewrite is what keeps the bag honest. Recognized values such as quoted
 * `"true"` are persisted as canonical booleans, while placeholders and invalid
 * values never reach the document as-is. The bag therefore passes strict
 * frontmatter validation and agrees with the columns
 * `deriveStructuredFrontmatterFields` derives from it. The legacy
 * `alwaysApply` spelling is folded into `always-apply`.
 *
 * Key order is preserved: a flag is rewritten in place rather than appended,
 * so re-cleaning an unchanged SKILL.md is byte-identical for callers that
 * detect drift by comparing serialized bags.
 */
export function toCleanFrontmatter(parsed: ParsedSkillMarkdown): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.frontmatter ?? {})) {
    if (key === 'name' || key === 'description') {
      continue;
    }
    const flag = SKILL_BOOLEAN_FLAG_BY_KEY.get(key);
    if (!flag) {
      clean[key] = value;
      continue;
    }
    const resolved = parsed[flag.column];
    if (resolved !== undefined && !(flag.key in clean)) {
      clean[flag.key] = resolved;
    }
  }
  return clean;
}
