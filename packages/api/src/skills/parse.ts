import yaml from 'js-yaml';
import { normalizeSkillFrontmatterKeys } from '@librechat/data-schemas';

export type ParsedSkillMarkdown = {
  name: string;
  description: string;
  alwaysApply?: boolean;
  frontmatter?: Record<string, unknown>;
  invalidBooleans: string[];
  parseError?: string;
};

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
  const entry = Object.entries(frontmatter).find(([candidate]) => candidate.toLowerCase() === key);
  return entry?.[1];
}

function hasCaseInsensitive(frontmatter: Record<string, unknown>, key: string): boolean {
  return Object.keys(frontmatter).some((candidate) => candidate.toLowerCase() === key);
}

function getRawFrontmatterValue(block: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*:\\s*(.*)$`, 'i');
  const line = block.split('\n').find((candidate) => pattern.test(candidate));
  const match = line?.match(pattern);
  return match?.[1];
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

function parseBoolean(value: unknown, rawValue?: string): boolean | undefined {
  const raw = rawValue === undefined ? undefined : stripInlineComment(rawValue).toLowerCase();
  if (typeof value === 'boolean') {
    return raw === 'true' || raw === 'false' ? value : undefined;
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

function hasBooleanPlaceholder(rawValue?: string): boolean {
  return rawValue !== undefined && stripInlineComment(rawValue).length === 0;
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
  const nameValue = getCaseInsensitive(frontmatter, 'name');
  const descriptionValue = getCaseInsensitive(frontmatter, 'description');
  const whenToUseValue = getCaseInsensitive(frontmatter, 'when-to-use');
  const hasCanonicalAlwaysApply = hasCaseInsensitive(frontmatter, 'always-apply');
  const hasAliasAlwaysApply = hasCaseInsensitive(frontmatter, 'alwaysapply');
  const canonicalAlwaysApplyValue = getCaseInsensitive(frontmatter, 'always-apply');
  const aliasAlwaysApplyValue = getCaseInsensitive(frontmatter, 'alwaysapply');
  const rawCanonicalAlwaysApplyValue = getRawFrontmatterValue(block, 'always-apply');
  const rawAliasAlwaysApplyValue = getRawFrontmatterValue(block, 'alwaysApply');
  const name = toScalarString(nameValue);
  let description = '';
  if (descriptionValue !== undefined) {
    description = toScalarString(descriptionValue);
  } else if (whenToUseValue !== undefined) {
    description = toScalarString(whenToUseValue);
  }
  let alwaysApply: boolean | undefined;
  const invalidBooleans: string[] = [];
  if (hasCanonicalAlwaysApply) {
    alwaysApply = parseBoolean(canonicalAlwaysApplyValue, rawCanonicalAlwaysApplyValue);
    if (alwaysApply === undefined && !hasBooleanPlaceholder(rawCanonicalAlwaysApplyValue)) {
      invalidBooleans.push('always-apply');
    }
  } else if (hasAliasAlwaysApply) {
    alwaysApply = parseBoolean(aliasAlwaysApplyValue, rawAliasAlwaysApplyValue);
    if (alwaysApply === undefined && !hasBooleanPlaceholder(rawAliasAlwaysApplyValue)) {
      invalidBooleans.push('alwaysApply');
    }
  }
  return {
    name,
    description,
    alwaysApply,
    frontmatter,
    invalidBooleans,
  };
}
