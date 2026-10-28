import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { BedrockConverseInput } from 'librechat-data-provider';
import type { AwsCredentialIdentity } from '@aws-sdk/types';

/**
 * AWS credentials for Bedrock
 * Extends AWS AwsCredentialIdentity to ensure compatibility
 */
export type BedrockCredentials = Partial<AwsCredentialIdentity>;

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
