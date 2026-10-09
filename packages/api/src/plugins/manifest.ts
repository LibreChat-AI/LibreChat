import { z } from 'zod';
import type { PluginDiagnostic, PluginExtensionData, PluginManifest } from './types';
import { MAX_PLUGIN_NAME_LENGTH, PLUGIN_MANIFEST_SCHEMA_ID } from './constants';

/**
 * Agent Plugins §5.5: 1-64 characters, lowercase alphanumerics with hyphens and
 * periods, alphanumeric at both ends, and no `--` or `..` runs.
 */
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const MANIFEST_KEYS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const authorSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

/**
 * Metadata fields are validated by JSON type only. §5.4 forbids rejecting a
 * manifest because `version` is not semver, a URL field is not a URL, or
 * `license` is not an SPDX identifier.
 */
const manifestSchema = z
  .object({
    $schema: z.string(),
    name: z.string().min(1).max(MAX_PLUGIN_NAME_LENGTH).regex(PLUGIN_NAME_PATTERN),
    version: z.string().optional(),
    description: z.string().optional(),
    author: authorSchema.optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

export type ManifestResult =
  | { status: 'ok'; manifest: PluginManifest; diagnostics: PluginDiagnostic[] }
  | { status: 'rejected'; diagnostics: PluginDiagnostic[] };

function rejected(
  code: PluginDiagnostic['code'],
  message: string,
  diagnostics: PluginDiagnostic[] = [],
): ManifestResult {
  return {
    status: 'rejected',
    diagnostics: [...diagnostics, { code, severity: 'error', message }],
  };
}

/**
 * Splits declared extension namespaces from the manifest. A non-object
 * `extensions` field is reported and ignored (§8.1), while a non-object value
 * for an individual namespace remains a fatal schema violation (§5.2).
 */
function readExtensions(
  value: unknown,
  diagnostics: PluginDiagnostic[],
): { extensions?: Record<string, PluginExtensionData>; invalidNamespace?: string } {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    diagnostics.push({
      code: 'extensions_invalid',
      severity: 'warning',
      message: '"extensions" must be an object; the field was ignored',
    });
    return {};
  }

  const extensions: Record<string, PluginExtensionData> = {};
  for (const [namespace, contents] of Object.entries(value)) {
    if (!isPlainObject(contents)) {
      return { invalidNamespace: namespace };
    }
    /** Parsed from JSON, so the contents are JsonValue by construction; §8.1 forbids validating them further. */
    extensions[namespace] = contents as PluginExtensionData;
  }
  return { extensions };
}

/**
 * Validates a parsed `plugin.json` against the closed Agent Plugins manifest
 * schema. Unknown top-level fields and a non-object `extensions` field are
 * reported and ignored; every other violation rejects the plugin.
 */
export function validateManifest(document: unknown): ManifestResult {
  if (!isPlainObject(document)) {
    return rejected('manifest_invalid', 'plugin.json must contain a top-level JSON object');
  }

  const schemaId = document.$schema;
  if (typeof schemaId !== 'string' || schemaId.length === 0) {
    return rejected('manifest_invalid', 'plugin.json is missing the required "$schema" field');
  }
  if (schemaId !== PLUGIN_MANIFEST_SCHEMA_ID) {
    return rejected(
      'manifest_unsupported_version',
      `Unsupported Agent Plugins manifest schema "${schemaId}"; this client implements ${PLUGIN_MANIFEST_SCHEMA_ID}`,
    );
  }

  const diagnostics: PluginDiagnostic[] = [];
  const known: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (!MANIFEST_KEYS.has(key)) {
      diagnostics.push({
        code: 'manifest_unknown_field',
        severity: 'warning',
        message: `"${key}" is not a recognized plugin.json field and was ignored`,
      });
      continue;
    }
    known[key] = value;
  }

  const { extensions: extensionsValue, ...coreFields } = known;
  const { extensions, invalidNamespace } = readExtensions(extensionsValue, diagnostics);
  if (invalidNamespace !== undefined) {
    return rejected(
      'manifest_invalid',
      `"extensions.${invalidNamespace}" must be an object`,
      diagnostics,
    );
  }

  const parsed = manifestSchema.safeParse(coreFields);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'plugin.json'}: ${issue.message}`)
      .join('; ');
    return rejected('manifest_invalid', detail, diagnostics);
  }

  return {
    status: 'ok',
    manifest: { ...parsed.data, ...(extensions !== undefined && { extensions }) },
    diagnostics,
  };
}
