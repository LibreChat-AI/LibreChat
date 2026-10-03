import type { AxiosRequestConfig } from 'axios';
import { applySSRFSafeAgentIfDirect } from '../auth/agent';
import { validateEndpointURL } from '../auth/domain';

const AZURE_SORA_HOST_SUFFIXES = [
  'openai.azure.com',
  'openai.azure.us',
  'openai.azure.cn',
] as const;
const AZURE_RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface AzureSoraCredentialFields {
  AZURE_SORA_API_KEY?: unknown;
  AZURE_SORA_ENDPOINT?: unknown;
}

export interface AzureSoraCredentials {
  apiKey: string;
  endpoint: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function toCredentialPair(
  apiKeyValue: unknown,
  endpointValue: unknown,
): AzureSoraCredentials | null {
  const apiKey = readString(apiKeyValue);
  const endpoint = readString(endpointValue).trim();
  return apiKey && endpoint ? { apiKey, endpoint } : null;
}

export function resolveAzureSoraCredentials(
  fields: AzureSoraCredentialFields,
  environment: Record<string, string | undefined>,
): AzureSoraCredentials {
  const providedApiKey = readString(fields.AZURE_SORA_API_KEY);
  const providedEndpoint = readString(fields.AZURE_SORA_ENDPOINT).trim();
  const serverApiKeys = [
    readString(environment.AZURE_SORA_API_KEY),
    readString(environment.AZURE_API_KEY),
  ];
  const serverEndpoints = [
    readString(environment.AZURE_SORA_ENDPOINT).trim(),
    readString(environment.AZURE_OPENAI_ENDPOINT).trim(),
  ];
  const providedPairUsesServerValue =
    serverApiKeys.includes(providedApiKey) || serverEndpoints.includes(providedEndpoint);
  const userCredentials =
    providedApiKey && providedEndpoint && !providedPairUsesServerValue
      ? { apiKey: providedApiKey, endpoint: providedEndpoint }
      : null;
  if (userCredentials) {
    return userCredentials;
  }

  const serverCredentialPairs = [
    toCredentialPair(environment.AZURE_SORA_API_KEY, environment.AZURE_SORA_ENDPOINT),
    toCredentialPair(environment.AZURE_API_KEY, environment.AZURE_OPENAI_ENDPOINT),
  ];
  for (const credentials of serverCredentialPairs) {
    if (credentials) {
      return credentials;
    }
  }

  return { apiKey: '', endpoint: '' };
}

function isApprovedAzureSoraHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  for (const suffix of AZURE_SORA_HOST_SUFFIXES) {
    const suffixPrefix = `.${suffix}`;
    if (!normalizedHostname.endsWith(suffixPrefix)) {
      continue;
    }
    const resourceName = normalizedHostname.slice(0, -suffixPrefix.length);
    if (AZURE_RESOURCE_NAME.test(resourceName)) {
      return true;
    }
  }
  return false;
}

function throwInvalidEndpoint(reason: string): never {
  throw new Error(`Invalid Azure Sora endpoint: ${reason}`);
}

export async function validateAzureSoraEndpoint(endpoint: string): Promise<string> {
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return throwInvalidEndpoint('the URL is malformed');
  }

  if (parsedEndpoint.protocol !== 'https:') {
    return throwInvalidEndpoint('HTTPS is required');
  }
  if (parsedEndpoint.username || parsedEndpoint.password) {
    return throwInvalidEndpoint('credentials are not permitted in the URL');
  }
  if (parsedEndpoint.port) {
    return throwInvalidEndpoint('only the default HTTPS port is permitted');
  }
  if (
    parsedEndpoint.pathname !== '/' ||
    parsedEndpoint.search.length > 0 ||
    parsedEndpoint.hash.length > 0
  ) {
    return throwInvalidEndpoint('paths, query parameters, and fragments are not permitted');
  }
  if (!isApprovedAzureSoraHostname(parsedEndpoint.hostname)) {
    return throwInvalidEndpoint('the host is not an approved Azure OpenAI host');
  }

  await validateEndpointURL(parsedEndpoint.origin, 'Azure Sora');
  return parsedEndpoint.origin;
}

export function createAzureSoraRequestConfig(
  url: string,
  config: AxiosRequestConfig,
): AxiosRequestConfig {
  return applySSRFSafeAgentIfDirect({ ...config, maxRedirects: 0, proxy: false }, url);
}
