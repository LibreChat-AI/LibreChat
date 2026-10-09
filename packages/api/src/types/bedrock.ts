import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import type { BedrockConverseInput } from 'librechat-data-provider';

/**
 * AWS credentials for Bedrock
 * Extends AWS AwsCredentialIdentity to ensure compatibility
 */
export type BedrockCredentials = Partial<AwsCredentialIdentity>;

/**
 * User-provided Bedrock credentials can be either AWS credentials or an API key.
 */
export type BedrockUserCredentials = BedrockCredentials & {
  bearerToken?: string;
};

/**
 * AWS Bedrock Guardrail configuration
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailConfiguration.html
 */
export interface GuardrailConfiguration {
  /** The identifier for the guardrail (ID or ARN) */
  guardrailIdentifier: string;
  /** The version of the guardrail (version number or "DRAFT") */
  guardrailVersion: string;
  /** The trace behavior for the guardrail */
  trace?: 'enabled' | 'disabled' | 'enabled_full';
  /** The processing mode for guardrail; 'sync' is the default guardrail behavior if unset */
  streamProcessingMode?: 'sync' | 'async';
}

/**
 * AWS Bedrock Inference Profile configuration
 * Maps model IDs to their inference profile ARNs
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html
 */
export type InferenceProfileConfig = Record<string, string>;

/**
 * Configuration options for Bedrock LLM
 */
export interface BedrockConfigOptions {
  modelOptions?: Partial<BedrockConverseInput>;
  /** AWS region for Bedrock */
  region?: string;
  /** Optional pre-configured Bedrock client (used with proxy) */
  client?: BedrockRuntimeClient;
  /** AWS credentials */
  credentials?: BedrockCredentials;
  /** AWS shared config profile for the SDK credential provider chain */
  profile?: string;
  /** Custom endpoint host for reverse proxy */
  endpointHost?: string;
  /** Guardrail configuration for content filtering */
  guardrailConfig?: GuardrailConfiguration;
  /** Inference profile ARNs keyed by model ID / friendly name */
  inferenceProfiles?: InferenceProfileConfig;
}

/**
 * Return type for Bedrock getOptions function
 */
export interface BedrockLLMConfigResult {
  llmConfig: BedrockConverseInput & {
    region?: string;
    client?: BedrockRuntimeClient;
    credentials?: BedrockCredentials;
    profile?: string;
    endpointHost?: string;
    guardrailConfig?: GuardrailConfiguration;
    applicationInferenceProfile?: string;
  };
  configOptions: Record<string, unknown>;
}
