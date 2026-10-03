import mongoose from 'mongoose';
import { logger, webSearchKeys } from '@librechat/data-schemas';
import { Constants, extractVariableName } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { CredentialFingerprintRecord } from '~/credentials';
import {
  credentialMetadataCollection,
  credentialMetadataId,
  credentialNames,
  getCredentialFingerprints,
  getCredentialRuntimeState,
  getLegacyCredentialNames,
} from '~/credentials';
import { isEnabled, checkEmailConfig } from '~/utils';
import { handleRateLimits } from './limits';

interface CredentialMetadata {
  _id: string;
  fingerprints: Partial<CredentialFingerprintRecord>;
  createdAt: Date;
}

const deprecatedVariables = [
  {
    key: 'CHECK_BALANCE',
    description:
      'Please use the `balance` field in the `librechat.yaml` config file instead.\nMore info: https://librechat.ai/docs/configuration/librechat_yaml/object_structure/balance#overview',
  },
  {
    key: 'START_BALANCE',
    description:
      'Please use the `balance` field in the `librechat.yaml` config file instead.\nMore info: https://librechat.ai/docs/configuration/librechat_yaml/object_structure/balance#overview',
  },
  {
    key: 'GOOGLE_API_KEY',
    description:
      'Please use the `GOOGLE_SEARCH_API_KEY` environment variable for the Google Search Tool instead.',
  },
];

export const deprecatedAzureVariables: {
  key: string;
  description: string;
}[] = [
  /* "related to" precedes description text */
  { key: 'AZURE_OPENAI_DEFAULT_MODEL', description: 'setting a default model' },
  { key: 'AZURE_OPENAI_MODELS', description: 'setting models' },
  {
    key: 'AZURE_USE_MODEL_AS_DEPLOYMENT_NAME',
    description: 'using model names as deployment names',
  },
  { key: 'AZURE_API_KEY', description: 'setting a single Azure API key' },
  { key: 'AZURE_OPENAI_API_INSTANCE_NAME', description: 'setting a single Azure instance name' },
  {
    key: 'AZURE_OPENAI_API_DEPLOYMENT_NAME',
    description: 'setting a single Azure deployment name',
  },
  { key: 'AZURE_OPENAI_API_VERSION', description: 'setting a single Azure API version' },
  {
    key: 'AZURE_OPENAI_API_COMPLETIONS_DEPLOYMENT_NAME',
    description: 'setting a single Azure completions deployment name',
  },
  {
    key: 'AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME',
    description: 'setting a single Azure embeddings deployment name',
  },
  {
    key: 'PLUGINS_USE_AZURE',
    description: 'using Azure for Plugins',
  },
];

export const conflictingAzureVariables: {
  key: string;
}[] = [
  {
    key: 'INSTANCE_NAME',
  },
  {
    key: 'DEPLOYMENT_NAME',
  },
];

/**
 * Checks the password reset configuration for security issues.
 */
function checkPasswordReset() {
  const emailEnabled = checkEmailConfig();
  const passwordResetAllowed = isEnabled(process.env.ALLOW_PASSWORD_RESET);

  if (!emailEnabled && passwordResetAllowed) {
    logger.warn(
      `❗❗❗

      Password reset is enabled with \`ALLOW_PASSWORD_RESET\` but email service is not configured.
      
      This setup is insecure as password reset links will be issued with a recognized email.
      
      Please configure email service for secure password reset functionality.
      
      https://www.librechat.ai/docs/configuration/authentication/email

      ❗❗❗`,
    );
  }
}

/**
 * Checks environment variables for default secrets and deprecated variables.
 * Logs warnings for any default secret values being used and for usage of deprecated variables.
 * Advises on replacing default secrets and updating deprecated variables.
 * @param {Object} options
 * @param {Function} options.isEnabled - Function to check if a feature is enabled
 * @param {Function} options.checkEmailConfig - Function to check email configuration
 */
export function checkVariables(): void {
  const legacyNames = getLegacyCredentialNames();
  for (const key of legacyNames) {
    logger.warn(
      `Legacy default value for ${key} is being used. Generate and configure a unique value.`,
    );
  }

  if (legacyNames.length > 0) {
    logger.info(
      'Replace legacy credential defaults before exposing this instance to untrusted users.',
    );
    logger.info(`\u200B

    Generate unique values with a cryptographically secure random source, for example:
    openssl rand -hex 32
    openssl rand -hex 16 for CREDS_IV

    For more guidance, see:
    https://www.librechat.ai/toolkit/creds_generator

    \u200B`);
  }

  const runtimeState = getCredentialRuntimeState();
  if (runtimeState?.missingFromEnvironment.length && !runtimeState.persistenceFailed) {
    const temporaryNames = runtimeState.missingFromEnvironment.filter(
      (name) => runtimeState.sources[name] === 'temporary',
    );
    if (temporaryNames.length > 0) {
      logger.warn(
        `[credentials] No configured value was found for ${temporaryNames.join(', ')}. ` +
          `Temporary credentials from ${runtimeState.filePath} are being used.`,
      );
    }
  }

  if (runtimeState?.persistenceFailed) {
    logger.warn(
      '[credentials] Temporary credentials could not be persisted. Existing sessions and encrypted data may become inaccessible after restart.',
    );
  }

  deprecatedVariables.forEach(({ key, description }) => {
    if (process.env[key]) {
      logger.warn(`The \`${key}\` environment variable is deprecated. ${description}`);
    }
  });

  checkPasswordReset();
}

/**
 * Compares active credential fingerprints with the database marker. The marker contains hashes
 * only, allowing a new instance to establish its identity without storing secret values.
 */
export async function checkCredentialDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return;
  }

  const User = mongoose.models.User;
  if (!User) {
    return;
  }

  try {
    const collection = mongoose.connection.db.collection<CredentialMetadata>(
      credentialMetadataCollection,
    );
    const [existingUser, existingMetadata] = await Promise.all([
      User.exists({}).exec(),
      collection.findOne({ _id: credentialMetadataId }),
    ]);
    const hasUsers = existingUser !== null;
    let metadata = existingMetadata;

    if (!metadata) {
      if (!hasUsers) {
        const activeFingerprints = getCredentialFingerprints();
        const result = await collection.updateOne(
          { _id: credentialMetadataId },
          {
            $setOnInsert: {
              _id: credentialMetadataId,
              fingerprints: activeFingerprints,
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        metadata = await collection.findOne({ _id: credentialMetadataId });
        if (result.upsertedCount === 1) {
          logger.info(
            '[credentials] New database detected. Credential fingerprints were recorded for future key-drift checks.',
          );
        }
      } else {
        logger.warn(
          '[credentials] Existing database has no credential fingerprint record. The active credentials may not match existing JWTs or encrypted records; provide the original values or use a controlled credential migration before rotating them.',
        );
        return;
      }
    }

    const fingerprints = metadata?.fingerprints ?? {};
    const activeFingerprints = getCredentialFingerprints();
    const mismatchedNames: string[] = [];
    const matchingNames: string[] = [];
    for (const name of credentialNames) {
      if (!fingerprints[name]) {
        mismatchedNames.push(name);
        continue;
      }
      if (fingerprints[name] === activeFingerprints[name]) {
        matchingNames.push(name);
      } else {
        mismatchedNames.push(name);
      }
    }

    if (mismatchedNames.length === 0) {
      return;
    }

    let mismatchDetail = ' Another startup instance may be using different temporary credentials.';
    if (matchingNames.length > 0) {
      mismatchDetail = ` ${matchingNames.join(', ')} still match, which indicates mixed credential versions.`;
    } else if (hasUsers) {
      mismatchDetail = ' Existing encrypted records or JWTs may require the previous values.';
    }

    logger.warn(
      `[credentials] Active fingerprints for ${mismatchedNames.join(', ')} do not match the database credential record.` +
        mismatchDetail +
        ' Do not overwrite the database marker; migrate the affected records and rotate all credentials together.',
    );
  } catch (error) {
    logger.warn('[credentials] Unable to inspect database credential metadata:', error);
  }
}

/**
 * Checks the health of auxiliary API's by attempting a fetch request to their respective `/health` endpoints.
 * Logs information or warning based on the API's availability and response.
 */
export async function checkHealth(): Promise<void> {
  try {
    const response = await fetch(`${process.env.RAG_API_URL}/health`);
    if (response?.ok && response?.status === 200) {
      logger.info(`RAG API is running and reachable at ${process.env.RAG_API_URL}.`);
    }
  } catch {
    logger.warn(
      `RAG API is either not running or not reachable at ${process.env.RAG_API_URL}, you may experience errors with file uploads.`,
    );
  }
}

/**
 * Checks for the usage of deprecated and conflicting Azure variables.
 * Logs warnings for any deprecated or conflicting environment variables found, indicating potential issues with `azureOpenAI` endpoint configuration.
 */
function checkAzureVariables() {
  deprecatedAzureVariables.forEach(({ key, description }) => {
    if (process.env[key]) {
      logger.warn(
        `The \`${key}\` environment variable (related to ${description}) should not be used in combination with the \`azureOpenAI\` endpoint configuration, as you will experience conflicts and errors.`,
      );
    }
  });

  conflictingAzureVariables.forEach(({ key }) => {
    if (process.env[key]) {
      logger.warn(
        `The \`${key}\` environment variable should not be used in combination with the \`azureOpenAI\` endpoint configuration, as you may experience with the defined placeholders for mapping to the current model grouping using the same name.`,
      );
    }
  });
}

export function checkInterfaceConfig(appConfig: AppConfig): void {
  const interfaceConfig = appConfig.interfaceConfig;
  let i = 0;
  const logSettings = () => {
    // log interface object and model specs object (without list) for reference
    logger.warn(`\`interface\` settings:\n${JSON.stringify(interfaceConfig, null, 2)}`);
    logger.warn(
      `\`modelSpecs\` settings:\n${JSON.stringify(
        { ...(appConfig?.modelSpecs ?? {}), list: undefined },
        null,
        2,
      )}`,
    );
  };

  // warn about config.modelSpecs.prioritize if true and presets are enabled, that default presets will conflict with prioritizing model specs.
  if (appConfig?.modelSpecs?.prioritize && interfaceConfig?.presets) {
    logger.warn(
      "Note: Prioritizing model specs can conflict with default presets if a default preset is set. It's recommended to disable presets from the interface or disable use of a default preset.",
    );
    if (i === 0) i++;
  }

  // warn about config.modelSpecs.enforce if true and if any of these, modelSelect, presets, or parameters are enabled, that enforcing model specs can conflict with these options.
  if (
    appConfig?.modelSpecs?.enforce &&
    (interfaceConfig?.modelSelect || interfaceConfig?.presets || interfaceConfig?.parameters)
  ) {
    logger.warn(
      "Note: Enforcing model specs can conflict with the interface options: modelSelect, presets, and parameters. It's recommended to disable these options from the interface or disable enforcing model specs.",
    );
    if (i === 0) i++;
  }
  // warn if enforce is true and prioritize is not, that enforcing model specs without prioritizing them can lead to unexpected behavior.
  if (appConfig?.modelSpecs?.enforce && !appConfig?.modelSpecs?.prioritize) {
    logger.warn(
      "Note: Enforcing model specs without prioritizing them can lead to unexpected behavior. It's recommended to enable prioritizing model specs if enforcing them.",
    );
    if (i === 0) i++;
  }

  if (i > 0) {
    logSettings();
  }
}

/**
 * Performs startup checks including environment variable validation and health checks.
 * This should be called during application startup before initializing services.
 * @param [appConfig] - The application configuration object.
 */
export async function performStartupChecks(appConfig?: AppConfig): Promise<void> {
  checkVariables();
  await checkCredentialDatabase();
  if (appConfig?.endpoints?.azureOpenAI) {
    checkAzureVariables();
  }
  if (appConfig) {
    checkInterfaceConfig(appConfig);
  }
  if (appConfig?.config) {
    checkConfig(appConfig.config);
  }
  if (appConfig?.config?.webSearch) {
    checkWebSearchConfig(appConfig.config.webSearch);
  }
  if (appConfig?.config?.rateLimits) {
    handleRateLimits(appConfig.config.rateLimits);
  }
  await checkHealth();
}

/**
 * Performs basic checks on the loaded config object.
 * @param config - The loaded custom configuration.
 */
export function checkConfig(config: Partial<TCustomConfig>): void {
  if (config.version !== Constants.CONFIG_VERSION) {
    logger.info(
      `\nOutdated Config version: ${config.version}
Latest version: ${Constants.CONFIG_VERSION}

      Check out the Config changelogs for the latest options and features added.

      https://www.librechat.ai/changelog\n\n`,
    );
  }
}

/**
 * Checks web search configuration values to ensure they are environment variable references.
 * Warns if actual API keys or URLs are used instead of environment variable references.
 * Logs debug information for properly configured environment variable references.
 * @param webSearchConfig - The loaded web search configuration object.
 */
export function checkWebSearchConfig(
  webSearchConfig?: Partial<TCustomConfig['webSearch']> | null,
): void {
  if (!webSearchConfig) {
    return;
  }

  webSearchKeys.forEach((key) => {
    const value = webSearchConfig[key as keyof typeof webSearchConfig];

    if (typeof value === 'string') {
      const varName = extractVariableName(value);

      if (varName) {
        // This is a proper environment variable reference
        const actualValue = process.env[varName];
        if (actualValue) {
          logger.debug(`Web search ${key}: Using environment variable ${varName} with value set`);
        } else {
          logger.debug(
            `Web search ${key}: Using environment variable ${varName} (not set in environment, user provided value)`,
          );
        }
      } else {
        // This is not an environment variable reference - warn user
        logger.warn(
          `❗ Web search configuration error: ${key} contains an actual value instead of an environment variable reference.
          
          Current value: "${value.substring(0, 10)}..."
          
          This is incorrect! You should use environment variable references in your librechat.yaml file, such as:
          ${key}: "\${YOUR_ENV_VAR_NAME}"
          
          Then set the actual API key in your .env file or environment variables.
          
          More info: https://www.librechat.ai/docs/configuration/librechat_yaml/web_search`,
        );
      }
    }
  });
}
