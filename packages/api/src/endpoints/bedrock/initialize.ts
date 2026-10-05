import { NodeHttpHandler } from '@smithy/node-http-handler';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  EModelEndpoint,
  extractEnvVariable,
  bedrockInputParser,
  bedrockOutputParser,
  removeNullishValues,
} from 'librechat-data-provider';
import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime';
import type {
  InitializeResultBase,
  BedrockCredentials,
  GuardrailConfiguration,
  InferenceProfileConfig,
  ProviderInitializeParams,
} from '~/types';
import { resolveBedrockCredentials } from './credentials';
import { getHttpsProxyAgent } from '~/utils/proxy';
import { resolveEndpointRuntime } from '~/types';
import { checkUserKeyExpiry } from '~/utils';

function getBedrockProxyTarget(region?: string, reverseProxy?: string): string | undefined {
  const trimmedReverseProxy = reverseProxy?.trim();
  if (trimmedReverseProxy) return `https://${trimmedReverseProxy}`;

  const trimmedRegion = region?.trim();
  if (!trimmedRegion) return undefined;

  return `https://bedrock-runtime.${trimmedRegion}.amazonaws.com`;
}

/**
 * Initializes Bedrock endpoint configuration.
 *
 * This module handles configuration for AWS Bedrock endpoints, including support for
 * HTTP/HTTPS proxies and reverse proxies.
 *
 * Proxy Support:
 * - When proxy env vars are set, creates a custom BedrockRuntimeClient
 *   with an HttpsProxyAgent to route Bedrock API calls through the resolved proxy
 * - The custom client is fully configured with credentials, region, and endpoint,
 *   and is passed directly to ChatBedrockConverse via the 'client' parameter
 *
 * Reverse Proxy Support:
 * - When BEDROCK_REVERSE_PROXY is set, routes Bedrock API calls through a custom endpoint
 * - Works with or without the PROXY setting
 *
 * Without Proxy:
 * - Credentials and endpoint configuration are passed separately to ChatBedrockConverse,
 *   which creates its own BedrockRuntimeClient internally
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to Bedrock configuration options
 * @throws Error if credentials are not provided when required
 */
export async function initializeBedrock(
  params: ProviderInitializeParams,
): Promise<InitializeResultBase> {
  const { endpoint, model_parameters, db } = params;
  const { appConfig, user, requestBody } = resolveEndpointRuntime(params);
  void endpoint;
  const bedrockConfig = appConfig?.endpoints?.[EModelEndpoint.bedrock] as
    | ({
        guardrailConfig?: GuardrailConfiguration;
        inferenceProfiles?: InferenceProfileConfig;
      } & Record<string, unknown>)
    | undefined;

  const { BEDROCK_AWS_PROFILE, BEDROCK_REVERSE_PROXY, BEDROCK_AWS_DEFAULT_REGION } = process.env;

  const { credentials, bearerToken } = await resolveBedrockCredentials({
    environment: process.env,
    readUserKey: () => db.getUserKey({ userId: user?.id ?? '', name: EModelEndpoint.bedrock }),
    expiresAt: requestBody.key,
    checkExpiry: (expiresAt) => checkUserKeyExpiry(expiresAt, EModelEndpoint.bedrock),
  });

  const requestOptions: Record<string, unknown> = {
    model: model_parameters?.model as string | undefined,
    region: BEDROCK_AWS_DEFAULT_REGION,
  };

  const configOptions: Record<string, unknown> = {};

  const llmConfig = bedrockOutputParser(
    bedrockInputParser.parse(
      removeNullishValues({
        ...requestOptions,
        ...(model_parameters ?? {}),
      }),
    ),
  ) as InitializeResultBase['llmConfig'] & {
    model?: string;
    region?: string;
    client?: BedrockRuntimeClient;
    credentials?: BedrockCredentials;
    endpointHost?: string;
    profile?: string;
    guardrailConfig?: GuardrailConfiguration;
    applicationInferenceProfile?: string;
  };

  if (bedrockConfig?.guardrailConfig) {
    llmConfig.guardrailConfig = {
      ...bedrockConfig.guardrailConfig,
      guardrailIdentifier: extractEnvVariable(bedrockConfig.guardrailConfig.guardrailIdentifier),
      guardrailVersion: extractEnvVariable(bedrockConfig.guardrailConfig.guardrailVersion),
    };
  }

  const model = model_parameters?.model as string | undefined;
  if (model && bedrockConfig?.inferenceProfiles?.[model]) {
    const applicationInferenceProfile = extractEnvVariable(bedrockConfig.inferenceProfiles[model]);
    llmConfig.applicationInferenceProfile = applicationInferenceProfile;
  }

  /** Only include credentials if they're complete (accessKeyId and secretAccessKey are both set) */
  const hasCompleteCredentials =
    credentials &&
    typeof credentials.accessKeyId === 'string' &&
    credentials.accessKeyId !== '' &&
    typeof credentials.secretAccessKey === 'string' &&
    credentials.secretAccessKey !== '';
  const hasBearerToken = typeof bearerToken === 'string' && bearerToken !== '';

  const bedrockRegion = typeof llmConfig.region === 'string' ? llmConfig.region : undefined;
  const proxyAgent = getHttpsProxyAgent(
    getBedrockProxyTarget(bedrockRegion, BEDROCK_REVERSE_PROXY),
  );
  if (proxyAgent || hasBearerToken) {
    const credentialProvider =
      !hasCompleteCredentials && !hasBearerToken && BEDROCK_AWS_PROFILE
        ? fromNodeProviderChain({ profile: BEDROCK_AWS_PROFILE })
        : undefined;

    // Create a custom BedrockRuntimeClient for proxy routing or Bedrock API keys.
    // ChatBedrockConverse will use this pre-configured client directly instead of
    // creating its own. Credentials are only set if explicitly provided; otherwise
    // the AWS SDK's default credential provider chain is used (instance profiles,
    // AWS profiles, environment variables, etc.)
    const customClientConfig: BedrockRuntimeClientConfig = {
      region: (llmConfig.region as string) ?? BEDROCK_AWS_DEFAULT_REGION,
    };

    if (hasBearerToken && bearerToken) {
      customClientConfig.token = { token: bearerToken };
      customClientConfig.authSchemePreference = ['httpBearerAuth'];
    } else if (hasCompleteCredentials) {
      customClientConfig.credentials = credentials as {
        accessKeyId: string;
        secretAccessKey: string;
      };
    } else if (credentialProvider) {
      customClientConfig.credentials = credentialProvider;
    }

    if (proxyAgent) {
      customClientConfig.requestHandler = new NodeHttpHandler({
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
      });
    }

    if (BEDROCK_REVERSE_PROXY) {
      customClientConfig.endpoint = `https://${BEDROCK_REVERSE_PROXY}`;
    }

    const customClient = new BedrockRuntimeClient(customClientConfig);

    llmConfig.client = customClient;
  } else {
    // When not using a proxy, let ChatBedrockConverse create its own client
    // by providing credentials and endpoint separately
    if (credentials) {
      llmConfig.credentials = credentials;
    }

    if (!credentials && BEDROCK_AWS_PROFILE) {
      llmConfig.profile = BEDROCK_AWS_PROFILE;
    }

    if (BEDROCK_REVERSE_PROXY) {
      llmConfig.endpointHost = BEDROCK_REVERSE_PROXY;
    }
  }

  const streamRate =
    appConfig?.endpoints?.all?.streamRate != null
      ? appConfig.endpoints.all.streamRate
      : (bedrockConfig?.streamRate as number | undefined);
  if (streamRate != null) {
    llmConfig._lc_stream_delay = streamRate;
  }

  return {
    llmConfig,
    configOptions,
  };
}
