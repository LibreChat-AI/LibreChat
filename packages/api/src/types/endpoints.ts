import type { ClientOptions, OpenAIClientOptions } from '@librechat/agents';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { TConfig } from 'librechat-data-provider';
import type { RequestBody, ServerRequest } from './http';
import type { EndpointTokenConfig } from './tokens';
import type { AzureOptions } from './azure';

export type TCustomEndpointsConfig = Partial<{ [key: string]: Omit<TConfig, 'order'> }>;

/**
 * Interface for user key values retrieved from the database
 */
export interface UserKeyValues {
  apiKey?: string;
  baseURL?: string;
}

/**
 * Function type for getting user key (single decrypted value)
 */
export type GetUserKeyFunction = (params: { userId: string; name: string }) => Promise<string>;

/**
 * Function type for getting user key values (parsed JSON object with apiKey/baseURL)
 */
export type GetUserKeyValuesFunction = (params: {
  userId: string;
  name: string;
}) => Promise<UserKeyValues>;

/**
 * Database methods required for endpoint initialization
 * These are passed in at invocation time to allow for dependency injection
 */
export interface EndpointDbMethods {
  /** Get single decrypted key value (used for simple API keys) */
  getUserKey: GetUserKeyFunction;
  /** Get parsed key values object (used for apiKey + baseURL combinations) */
  getUserKeyValues: GetUserKeyValuesFunction;
}

/** Transport-free state consumed while resolving provider credentials and configuration. */
export interface EndpointRuntimeContext {
  appConfig?: AppConfig;
  user?: IUser;
  requestBody: RequestBody;
}

/**
 * Base parameters for all endpoint initialization functions
 */
interface InitializeParamsBase {
  /** The endpoint name/identifier (e.g., 'openAI', 'anthropic', 'custom-endpoint-name') */
  endpoint: string;
  /** Model parameters from the request (includes model, temperature, topP, etc.) */
  model_parameters?: Record<string, unknown>;
  /** Database methods for user key operations */
  db: EndpointDbMethods;
}

/** Request-backed compatibility contract retained for existing endpoint callers. */
export interface BaseInitializeParams extends InitializeParamsBase {
  req: ServerRequest;
  runtime?: never;
}

/** Request-free provider initialization contract used by Agent execution hosts. */
export interface RuntimeInitializeParams extends InitializeParamsBase {
  runtime: EndpointRuntimeContext;
  req?: never;
}

export type ProviderInitializeParams = BaseInitializeParams | RuntimeInitializeParams;

export function resolveEndpointRuntime(params: ProviderInitializeParams): EndpointRuntimeContext {
  if ('runtime' in params && params.runtime != null) {
    return params.runtime;
  }
  return {
    appConfig: params.req.config,
    user: params.req.user,
    requestBody: params.req.body,
  };
}

/**
 * Base result type that all initialize functions return
 * Using a more permissive type to accommodate different provider-specific results
 */
export interface InitializeResultBase {
  /** Request-resolved Azure identity, retained when Responses removes the Azure client fields. */
  azureOptions?: AzureOptions;
  llmConfig: ClientOptions;
  configOptions?: OpenAIClientOptions['configuration'];
  endpointTokenConfig?: EndpointTokenConfig;
  useLegacyContent?: boolean;
  provider?: string;
  tools?: unknown[];
}
