import { AuthType } from 'librechat-data-provider';
import type { BedrockCredentials } from '~/types';

export interface BedrockCredentialEnvironment {
  [name: string]: string | undefined;
  BEDROCK_AWS_SECRET_ACCESS_KEY?: string;
  BEDROCK_AWS_ACCESS_KEY_ID?: string;
  BEDROCK_AWS_SESSION_TOKEN?: string;
  BEDROCK_AWS_PROFILE?: string;
  BEDROCK_AWS_BEARER_TOKEN?: string;
}
export interface ResolvedBedrockCredentials {
  credentials?: BedrockCredentials;
  bearerToken?: string;
  profile?: string;
}

const BEDROCK_CREDENTIALS_ERROR = 'Bedrock credentials not provided. Please provide them again.';

type UserCredentialKey = 'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'bearerToken';
type UserCredentialValue = string | number | boolean | object | null;
type ParsedBedrockUserCredentials = Partial<Record<UserCredentialKey, UserCredentialValue>> & {
  apiKey?: string;
};

function isParsedBedrockUserCredentials(value: unknown): value is ParsedBedrockUserCredentials {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseBedrockUserCredentials(userKey: string): ParsedBedrockUserCredentials {
  const storedCredentials = JSON.parse(userKey) as unknown;
  if (!isParsedBedrockUserCredentials(storedCredentials)) {
    throw new Error(BEDROCK_CREDENTIALS_ERROR);
  }

  if (typeof storedCredentials.apiKey !== 'string') {
    return storedCredentials;
  }

  const nestedCredentials = JSON.parse(storedCredentials.apiKey) as unknown;
  if (!isParsedBedrockUserCredentials(nestedCredentials)) {
    throw new Error(BEDROCK_CREDENTIALS_ERROR);
  }

  return nestedCredentials;
}

function getUserCredentialValue(
  credentials: ParsedBedrockUserCredentials,
  key: UserCredentialKey,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(credentials, key)) {
    return undefined;
  }

  const value = credentials[key];
  if (value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(BEDROCK_CREDENTIALS_ERROR);
  }

  return value;
}

/** Shared AWS credential selection; SDK clients own signing, role refresh and transport. */
export async function resolveBedrockCredentials({
  environment,
  readUserKey,
  expiresAt,
  checkExpiry,
}: {
  environment: BedrockCredentialEnvironment;
  readUserKey(): Promise<string | null | undefined>;
  expiresAt?: string | null;
  checkExpiry(expiresAt: string): void;
}): Promise<ResolvedBedrockCredentials> {
  const {
    BEDROCK_AWS_SECRET_ACCESS_KEY,
    BEDROCK_AWS_ACCESS_KEY_ID,
    BEDROCK_AWS_SESSION_TOKEN,
    BEDROCK_AWS_BEARER_TOKEN,
  } = environment;
  const userProvidesAccessKeyId = BEDROCK_AWS_ACCESS_KEY_ID === AuthType.USER_PROVIDED;
  const userProvidesSecretAccessKey = BEDROCK_AWS_SECRET_ACCESS_KEY === AuthType.USER_PROVIDED;
  const userProvidesSessionToken = BEDROCK_AWS_SESSION_TOKEN === AuthType.USER_PROVIDED;
  const userProvidesBearerToken = BEDROCK_AWS_BEARER_TOKEN === AuthType.USER_PROVIDED;
  const isUserProvided =
    userProvidesAccessKeyId ||
    userProvidesSecretAccessKey ||
    userProvidesSessionToken ||
    userProvidesBearerToken;
  const staticAccessKeyId = userProvidesAccessKeyId ? undefined : BEDROCK_AWS_ACCESS_KEY_ID;
  const staticSecretAccessKey = userProvidesSecretAccessKey
    ? undefined
    : BEDROCK_AWS_SECRET_ACCESS_KEY;
  const staticSessionToken = userProvidesSessionToken ? undefined : BEDROCK_AWS_SESSION_TOKEN;
  const staticBearerToken = userProvidesBearerToken ? undefined : BEDROCK_AWS_BEARER_TOKEN;

  const hasAccessKey = staticAccessKeyId != null && staticAccessKeyId !== '';
  const hasSecretKey = staticSecretAccessKey != null && staticSecretAccessKey !== '';

  let credentials: BedrockCredentials | undefined;
  let bearerToken: string | undefined;

  if (isUserProvided) {
    const userKey = await readUserKey();

    if (!userKey) {
      throw new Error(BEDROCK_CREDENTIALS_ERROR);
    }

    let userCredentials: ParsedBedrockUserCredentials;
    try {
      userCredentials = parseBedrockUserCredentials(userKey);
    } catch {
      throw new Error(BEDROCK_CREDENTIALS_ERROR);
    }

    const userBearerToken = userProvidesBearerToken
      ? getUserCredentialValue(userCredentials, 'bearerToken')
      : undefined;

    if (userBearerToken) {
      bearerToken = userBearerToken;
    } else {
      const canUseAccessKeys =
        userProvidesAccessKeyId || userProvidesSecretAccessKey || userProvidesSessionToken;
      const accessKeyId = userProvidesAccessKeyId
        ? getUserCredentialValue(userCredentials, 'accessKeyId')
        : staticAccessKeyId;
      const secretAccessKey = userProvidesSecretAccessKey
        ? getUserCredentialValue(userCredentials, 'secretAccessKey')
        : staticSecretAccessKey;
      const sessionToken = userProvidesSessionToken
        ? getUserCredentialValue(userCredentials, 'sessionToken')
        : staticSessionToken;

      if (!canUseAccessKeys || !accessKeyId || !secretAccessKey) {
        throw new Error(BEDROCK_CREDENTIALS_ERROR);
      }

      credentials = {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken && { sessionToken }),
      };
    }

    if (expiresAt) {
      checkExpiry(expiresAt);
    }
  } else if (staticBearerToken) {
    bearerToken = staticBearerToken;
  } else if (hasAccessKey !== hasSecretKey) {
    throw new Error(
      'Both BEDROCK_AWS_ACCESS_KEY_ID and BEDROCK_AWS_SECRET_ACCESS_KEY must be provided together.',
    );
  } else if (hasAccessKey && hasSecretKey) {
    credentials = {
      accessKeyId: staticAccessKeyId,
      secretAccessKey: staticSecretAccessKey,
      ...(staticSessionToken && { sessionToken: staticSessionToken }),
    };
  }

  return { credentials, bearerToken, profile: environment.BEDROCK_AWS_PROFILE };
}
