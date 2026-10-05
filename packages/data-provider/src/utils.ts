export const envVarRegex = /^\${(.+)}$/;

/**
 * Infrastructure env vars that must never be resolved via placeholder expansion.
 * These are internal secrets whose exposure would compromise the system —
 * they have no legitimate reason to appear in outbound headers, MCP env/args, or OAuth config.
 *
 * Intentionally excludes API keys (operators reference them in config) and
 * OAuth/session secrets (referenced in MCP OAuth config via processMCPEnv).
 */
const SENSITIVE_ENV_VARS = new Set([
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'CREDS_KEY',
  'CREDS_IV',
  'MEILI_MASTER_KEY',
  'MONGO_URI',
  'REDIS_URI',
  'REDIS_PASSWORD',
]);

/** Returns true when `varName` refers to an infrastructure secret that must not leak. */
export function isSensitiveEnvVar(varName: string): boolean {
  return SENSITIVE_ENV_VARS.has(varName);
}

/** Extracts the environment variable name from a template literal string */
export function extractVariableName(value: string): string | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(envVarRegex);
  return match ? match[1] : null;
}

/** Extracts the value of an environment variable from a string. */
export function extractEnvVariable(
  value: string,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!value) {
    return value;
  }

  const trimmed = value.trim();

  const singleMatch = trimmed.match(envVarRegex);
  if (singleMatch) {
    const varName = singleMatch[1];
    if (isSensitiveEnvVar(varName)) {
      return trimmed;
    }
    return environment[varName] || trimmed;
  }

  const regex = /\${([^}]+)}/g;
  let result = trimmed;

  const matches = [];
  let match;
  while ((match = regex.exec(trimmed)) !== null) {
    matches.push({
      fullMatch: match[0],
      varName: match[1],
      index: match.index,
    });
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, varName, index } = matches[i];
    if (isSensitiveEnvVar(varName)) {
      continue;
    }
    const envValue = environment[varName] || fullMatch;
    result = result.substring(0, index) + envValue + result.substring(index + fullMatch.length);
  }

  return result;
}

/**
 * Normalize the endpoint name to system-expected value.
 * @param name
 */
export function normalizeEndpointName(name = ''): string {
  return name.toLowerCase() === 'ollama' ? 'ollama' : name;
}

/** Provider roots exclude credentials, query strings, and completion resource paths. */
export function isValidProviderBaseURL(value: string): boolean {
  try {
    const root = new URL(value);
    return (
      ['http:', 'https:'].includes(root.protocol) &&
      !root.username &&
      !root.password &&
      !root.search &&
      !root.hash &&
      !/\/(chat\/completions|responses)\/?$/.test(root.pathname)
    );
  } catch {
    return false;
  }
}
