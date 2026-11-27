import { AuthTypeEnum } from 'librechat-data-provider';

import { validateEndpointURL } from '~/auth';

type ActionOAuthEndpointField = 'authorization_url' | 'client_url';

interface ActionOAuthAuthMetadata {
  type?: AuthTypeEnum | string | null;
  authorization_url?: string | null;
  client_url?: string | null;
}

function invalidActionOAuth(fieldName: ActionOAuthEndpointField, message: string): never {
  throw new Error(`Invalid action OAuth ${fieldName}: ${message}`);
}

function parseEndpointError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'endpoint URL is not permitted.';
  }

  try {
    const parsed = JSON.parse(error.message) as { message?: unknown };
    if (typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    return error.message;
  }

  return error.message;
}

export async function validateActionOAuthEndpoint(
  url: string | null | undefined,
  fieldName: ActionOAuthEndpointField,
  allowedAddresses?: string[] | null,
): Promise<void> {
  if (!url || typeof url !== 'string') {
    invalidActionOAuth(fieldName, 'endpoint URL is required.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    invalidActionOAuth(fieldName, 'unable to parse endpoint URL.');
  }

  if (parsedUrl.protocol !== 'https:') {
    invalidActionOAuth(fieldName, 'only HTTPS endpoint URLs are permitted.');
  }

  try {
    await validateEndpointURL(url, `action OAuth ${fieldName}`, allowedAddresses);
  } catch (error) {
    invalidActionOAuth(fieldName, parseEndpointError(error));
  }
}

export async function validateActionOAuthMetadata(
  auth?: ActionOAuthAuthMetadata | null,
  allowedAddresses?: string[] | null,
): Promise<void> {
  if (!auth || auth.type !== AuthTypeEnum.OAuth) {
    return;
  }

  await validateActionOAuthEndpoint(auth.authorization_url, 'authorization_url', allowedAddresses);
  await validateActionOAuthEndpoint(auth.client_url, 'client_url', allowedAddresses);
}
