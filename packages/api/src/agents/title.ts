import { EModelEndpoint } from 'librechat-data-provider';
import { Providers, TitleMethod } from '@librechat/agents';
import type { ClientOptions } from '@librechat/agents';
import type { InitializeResultBase, OpenAIConfiguration } from '~/types';
import { omitTitleOptions } from './client';

export type TitleClientOptions = ClientOptions & {
  azureOpenAIApiInstanceName?: string;
  configuration?: OpenAIConfiguration;
  maxTokens?: number;
  json?: boolean;
  modelKwargs?: Record<string, unknown>;
  clientOptions?: { defaultHeaders?: unknown };
};

/** Chat and Studio share provider configuration; each owns its title publication and billing. */
export function resolveTitleModelConfig({
  endpoint,
  options,
  fallbackProvider,
  titleMethod,
}: {
  endpoint: string;
  options: InitializeResultBase;
  fallbackProvider: string;
  titleMethod?: string;
}): { provider: string; clientOptions: TitleClientOptions } {
  let provider = options.provider ?? fallbackProvider;
  const raw = { ...(options.llmConfig ?? {}) } as TitleClientOptions;
  if (endpoint === EModelEndpoint.azureOpenAI) {
    provider = raw.azureOpenAIApiInstanceName == null ? Providers.OPENAI : Providers.AZURE;
  }
  delete raw.maxTokens;
  if (raw.modelKwargs != null) {
    raw.modelKwargs = { ...raw.modelKwargs };
    delete raw.modelKwargs.max_completion_tokens;
    delete raw.modelKwargs.max_output_tokens;
  }
  const carrier = raw.clientOptions;
  const clientOptions = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !omitTitleOptions.has(key)),
  ) as TitleClientOptions;
  // Provider factories can close over this object: headers must resolve on the same carrier.
  if (carrier != null && clientOptions.clientOptions == null) clientOptions.clientOptions = carrier;
  if (options.configOptions) clientOptions.configuration = options.configOptions;
  if (
    provider === Providers.GOOGLE &&
    (titleMethod === TitleMethod.FUNCTIONS || titleMethod === TitleMethod.STRUCTURED)
  ) {
    clientOptions.json = true;
  }
  return { provider, clientOptions };
}
