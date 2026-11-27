import { AuthTypeEnum, validateAndParseOpenAPISpec } from 'librechat-data-provider';
import type { ActionAuth, ActionMetadata } from 'librechat-data-provider';

const authBoundaryFields: Array<keyof ActionAuth> = [
  'type',
  'authorization_type',
  'custom_auth_header',
  'authorization_url',
  'client_url',
  'scope',
  'token_exchange_method',
];

export type ActionMetadataUpdateResult = {
  metadata: ActionMetadata;
  targetChanged: boolean;
  requiresCredentialRefresh: boolean;
};

export type ActionMetadataUpdateParams = {
  storedMetadata: ActionMetadata;
  incomingMetadata: ActionMetadata;
};

function hasOwn<T extends object, K extends PropertyKey>(
  obj: T | null | undefined,
  key: K,
): obj is T & Record<K, unknown> {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

function normalizeUrlTarget(value: string | undefined): string {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, '');
  }
}

function normalizeDomainTarget(value: string | undefined): string {
  if (!value) {
    return '';
  }

  const urlValue = value.includes('://') ? value : `https://${value}`;
  try {
    const url = new URL(urlValue);
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, '');
  }
}

function getSpecServerTarget(rawSpec: string | undefined): string {
  if (!rawSpec) {
    return '';
  }

  const result = validateAndParseOpenAPISpec(rawSpec);
  return normalizeUrlTarget(result.serverUrl);
}

function didDomainChange(
  storedMetadata: ActionMetadata,
  incomingMetadata: ActionMetadata,
): boolean {
  if (!hasOwn(incomingMetadata, 'domain')) {
    return false;
  }

  return (
    normalizeDomainTarget(storedMetadata.domain) !== normalizeDomainTarget(incomingMetadata.domain)
  );
}

function didSpecServerChange(
  storedMetadata: ActionMetadata,
  incomingMetadata: ActionMetadata,
): boolean {
  if (!hasOwn(incomingMetadata, 'raw_spec')) {
    return false;
  }

  return (
    getSpecServerTarget(storedMetadata.raw_spec) !== getSpecServerTarget(incomingMetadata.raw_spec)
  );
}

function didAuthBoundaryChange(
  storedMetadata: ActionMetadata,
  incomingMetadata: ActionMetadata,
): boolean {
  if (!hasOwn(incomingMetadata, 'auth')) {
    return false;
  }

  return authBoundaryFields.some(
    (field) => storedMetadata.auth?.[field] !== incomingMetadata.auth?.[field],
  );
}

function getTargetChanged(
  storedMetadata: ActionMetadata,
  incomingMetadata: ActionMetadata,
): boolean {
  return (
    didDomainChange(storedMetadata, incomingMetadata) ||
    didSpecServerChange(storedMetadata, incomingMetadata) ||
    didAuthBoundaryChange(storedMetadata, incomingMetadata)
  );
}

function getNextAuthType(
  storedMetadata: ActionMetadata,
  incomingMetadata: ActionMetadata,
): AuthTypeEnum | undefined {
  return incomingMetadata.auth?.type ?? storedMetadata.auth?.type;
}

function requiresCredentialRefresh(
  storedMetadata: ActionMetadata,
  incomingMetadata: ActionMetadata,
): boolean {
  const authType = getNextAuthType(storedMetadata, incomingMetadata);

  if (authType === AuthTypeEnum.ServiceHttp) {
    return hasValue(storedMetadata.api_key) && !hasValue(incomingMetadata.api_key);
  }

  if (authType === AuthTypeEnum.OAuth) {
    return (
      (hasValue(storedMetadata.oauth_client_id) && !hasValue(incomingMetadata.oauth_client_id)) ||
      (hasValue(storedMetadata.oauth_client_secret) &&
        !hasValue(incomingMetadata.oauth_client_secret))
    );
  }

  return false;
}

function removeUnsubmittedCredentials(
  metadata: ActionMetadata,
  incomingMetadata: ActionMetadata,
): ActionMetadata {
  const sanitized = { ...metadata };

  if (!hasValue(incomingMetadata.api_key)) {
    delete sanitized.api_key;
  }

  if (!hasValue(incomingMetadata.oauth_client_id)) {
    delete sanitized.oauth_client_id;
  }

  if (!hasValue(incomingMetadata.oauth_client_secret)) {
    delete sanitized.oauth_client_secret;
  }

  return sanitized;
}

/**
 * Preserves saved credentials only while an Action continues to point at the
 * same request/auth boundary. A changed domain, OpenAPI server URL, or auth
 * endpoint must come with fresh credentials or explicitly remove auth.
 */
export function mergeActionMetadataForUpdate({
  storedMetadata,
  incomingMetadata,
}: ActionMetadataUpdateParams): ActionMetadataUpdateResult {
  const targetChanged = getTargetChanged(storedMetadata, incomingMetadata);
  const refreshRequired = targetChanged
    ? requiresCredentialRefresh(storedMetadata, incomingMetadata)
    : false;
  const mergedMetadata = { ...storedMetadata, ...incomingMetadata };

  return {
    targetChanged,
    requiresCredentialRefresh: refreshRequired,
    metadata: targetChanged
      ? removeUnsubmittedCredentials(mergedMetadata, incomingMetadata)
      : mergedMetadata,
  };
}
