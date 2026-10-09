import { z } from 'zod';
import { AuthKeys, googleBaseSchema } from 'librechat-data-provider';

export type GoogleParameters = z.infer<typeof googleBaseSchema>;

export type GoogleCredentials = {
  [AuthKeys.GOOGLE_SERVICE_KEY]?: string | Record<string, unknown>;
  [AuthKeys.GOOGLE_API_KEY]?: string;
};

/**
 * Configuration options for the getLLMConfig function
 */
export interface GoogleConfigOptions {
  modelOptions?: Partial<GoogleParameters>;
  reverseProxyUrl?: string;
  defaultQuery?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  proxy?: string;
  streaming?: boolean;
  authHeader?: boolean;
  /** Default parameters to apply only if fields are undefined */
  defaultParams?: Record<string, unknown>;
  addParams?: Record<string, unknown>;
  dropParams?: string[];
  /** Stream rate delay for controlling token streaming speed */
  streamRate?: number;
  /** Model to use for title generation */
  titleModel?: string;
  /** Force Vertex AI auth semantics even when a Google API key is configured */
  forceVertex?: boolean;
  /** GCP project id for Vertex AI ADC/service-account authentication */
  projectId?: string;
}
