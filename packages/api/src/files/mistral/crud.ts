import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import { logger } from '@librechat/data-schemas';
import {
  FileSources,
  envVarRegex,
  extractEnvVariable,
  extractVariableName,
} from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AxiosError, AxiosRequestConfig } from 'axios';
import type {
  MistralFileUploadResponse,
  MistralSignedUrlResponse,
  MistralOCRUploadResult,
  MistralOCRError,
  OCRResultPage,
  ServerRequest,
  OCRResult,
  OCRImage,
} from '~/types';
import {
  getOutboundTimeout,
  outboundRequestBudget,
  getOutboundTimeoutMs,
  DEFAULT_OUTBOUND_TIMEOUTS_MS,
} from '~/utils/timeouts';
import { decryptConfigSecret, isEncryptedSecretPayload } from '~/admin/secrets';
import { logAxiosError, createAxiosInstance } from '~/utils/axios';
import { applySSRFSafeAgentIfDirect } from '~/auth/agent';
import { hasActiveFilePolicy } from '~/protection/files';
import { getSafeErrorMetadata } from '~/utils/errors';
import { applyAxiosProxyConfig } from '~/utils/proxy';
import { readFileAsBuffer } from '~/utils/files';
import { loadServiceKey } from '~/utils/key';

const axios = createAxiosInstance();
const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
const DEFAULT_MISTRAL_MODEL = 'mistral-ocr-latest';

/** Helper type for auth configuration */
interface AuthConfig {
  apiKey: string;
  baseURL: string;
}

/** Helper type for Google service account */
interface GoogleServiceAccount {
  client_email?: string;
  private_key?: string;
  project_id?: string;
}

/** Helper type for OCR request context */
interface OCRContext {
  req: ServerRequest;
  file: Express.Multer.File;
  loadAuthValues: (params: {
    userId: string;
    authFields: string[];
    optional?: Set<string>;
  }) => Promise<Record<string, string | undefined>>;
}

function createProtectedProviderError(
  message: string,
  error: unknown,
  contentProtected: boolean,
): Error | null {
  if (!contentProtected) {
    return null;
  }
  /** The budget message names only the config key, so it is safe to keep. */
  const timeout = getOutboundTimeout(error);
  if (timeout) {
    logger.warn(`${message} ${timeout.message}`);
  } else {
    logger.error(message, getSafeErrorMetadata(error));
  }
  return new Error(message);
}

/**
 * Uploads a document to Mistral API using file streaming to avoid loading the entire file into memory
 * @param params Upload parameters
 * @param params.filePath The path to the file on disk
 * @param params.fileName Optional filename to use (defaults to the name from filePath)
 * @param params.apiKey Mistral API key
 * @param params.baseURL Mistral API base URL
 * @returns The response from Mistral API
 */
export async function uploadDocumentToMistral({
  apiKey,
  filePath,
  baseURL = DEFAULT_MISTRAL_BASE_URL,
  fileName = '',
  allowedAddresses,
  timeout = DEFAULT_OUTBOUND_TIMEOUTS_MS.ocrMs,
}: {
  apiKey: string;
  filePath: string;
  baseURL?: string;
  fileName?: string;
  allowedAddresses?: string[] | null;
  timeout?: number;
}): Promise<MistralFileUploadResponse> {
  const form = new FormData();
  form.append('purpose', 'ocr');
  const actualFileName = fileName || path.basename(filePath);

  const config: AxiosRequestConfig = {
    ...outboundRequestBudget(timeout, 'ocrMs'),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  };

  applyAxiosProxyConfig(config, `${baseURL}/files`);
  applySSRFSafeAgentIfDirect(config, `${baseURL}/files`, allowedAddresses);

  const fileStream = fs.createReadStream(filePath);
  form.append('file', fileStream, { filename: actualFileName });

  try {
    const response = await axios.post(`${baseURL}/files`, form, config);
    return response.data;
  } finally {
    fileStream.destroy();
  }
}

export async function getSignedUrl({
  apiKey,
  fileId,
  expiry = 24,
  baseURL = DEFAULT_MISTRAL_BASE_URL,
  allowedAddresses,
  timeout = DEFAULT_OUTBOUND_TIMEOUTS_MS.ocrMs,
  contentProtected = false,
}: {
  apiKey: string;
  fileId: string;
  expiry?: number;
  baseURL?: string;
  allowedAddresses?: string[] | null;
  timeout?: number;
  contentProtected?: boolean;
}): Promise<MistralSignedUrlResponse> {
  const config: AxiosRequestConfig = {
    ...outboundRequestBudget(timeout, 'ocrMs'),
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };

  const signedUrlTarget = `${baseURL}/files/${fileId}/url?expiry=${expiry}`;
  applyAxiosProxyConfig(config, signedUrlTarget);
  applySSRFSafeAgentIfDirect(config, signedUrlTarget, allowedAddresses);

  return axios
    .get(`${baseURL}/files/${fileId}/url?expiry=${expiry}`, config)
    .then((res) => res.data)
    .catch((error) => {
      const protectedError = createProtectedProviderError(
        'Error fetching signed URL.',
        error,
        contentProtected,
      );
      if (protectedError) {
        throw protectedError;
      }
      logger.error('Error fetching signed URL:', error.message);
      throw error;
    });
}

/**
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} params.url - The document or image URL
 * @param {string} [params.documentType='document_url'] - 'document_url' or 'image_url'
 * @param {string} [params.model]
 * @param {string} [params.baseURL]
 * @returns {Promise<OCRResult>}
 */
export async function performOCR({
  url,
  apiKey,
  model = DEFAULT_MISTRAL_MODEL,
  baseURL = DEFAULT_MISTRAL_BASE_URL,
  documentType = 'document_url',
  allowedAddresses,
  timeout = DEFAULT_OUTBOUND_TIMEOUTS_MS.ocrMs,
  contentProtected = false,
}: {
  url: string;
  apiKey: string;
  model?: string;
  baseURL?: string;
  documentType?: 'document_url' | 'image_url';
  allowedAddresses?: string[] | null;
  timeout?: number;
  contentProtected?: boolean;
}): Promise<OCRResult> {
  const documentKey = documentType === 'image_url' ? 'image_url' : 'document_url';

  const config: AxiosRequestConfig = {
    ...outboundRequestBudget(timeout, 'ocrMs'),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  };

  const ocrURL = baseURL.endsWith('/ocr') ? baseURL : `${baseURL}/ocr`;
  applyAxiosProxyConfig(config, ocrURL);
  applySSRFSafeAgentIfDirect(config, ocrURL, allowedAddresses);

  return axios
    .post(
      ocrURL,
      {
        model,
        image_limit: 0,
        include_image_base64: false,
        document: {
          type: documentType,
          [documentKey]: url,
        },
      },
      config,
    )
    .then((res) => res.data)
    .catch((error) => {
      const protectedError = createProtectedProviderError(
        'Error performing OCR.',
        error,
        contentProtected,
      );
      if (protectedError) {
        throw protectedError;
      }
      logger.error('Error performing OCR:', error.message);
      throw error;
    });
}

/**
 * Deletes a file from Mistral API
 * @param params Delete parameters
 * @param params.fileId The file ID to delete
 * @param params.apiKey Mistral API key
 * @param params.baseURL Mistral API base URL
 * @returns Promise that resolves when the file is deleted
 */
export async function deleteMistralFile({
  fileId,
  apiKey,
  baseURL = DEFAULT_MISTRAL_BASE_URL,
  allowedAddresses,
  timeout = DEFAULT_OUTBOUND_TIMEOUTS_MS.ocrMs,
  contentProtected = false,
}: {
  fileId: string;
  apiKey: string;
  baseURL?: string;
  allowedAddresses?: string[] | null;
  timeout?: number;
  contentProtected?: boolean;
}): Promise<void> {
  const config: AxiosRequestConfig = {
    ...outboundRequestBudget(timeout, 'ocrMs'),
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };

  applyAxiosProxyConfig(config, `${baseURL}/files/${fileId}`);
  applySSRFSafeAgentIfDirect(config, `${baseURL}/files/${fileId}`, allowedAddresses);

  try {
    const result = await axios.delete(`${baseURL}/files/${fileId}`, config);
    if (contentProtected) {
      logger.debug(`Mistral file ${fileId} deleted successfully`);
    } else {
      logger.debug(`Mistral file ${fileId} deleted successfully:`, result.data);
    }
  } catch (error) {
    const message = `Error deleting Mistral file ${fileId}.`;
    if (!createProtectedProviderError(message, error, contentProtected)) {
      logger.error(`Error deleting Mistral file ${fileId}:`, error);
    }
  }
}

/**
 * Determines if a value needs to be loaded from environment
 */
function needsEnvLoad(value: string): boolean {
  return envVarRegex.test(value) || !value.trim();
}

/**
 * Gets the environment variable name for a config value
 */
function getEnvVarName(configValue: string, defaultName: string): string {
  if (!envVarRegex.test(configValue)) {
    return defaultName;
  }
  return extractVariableName(configValue) || defaultName;
}

/** The variable that names OCR's default destination, the one `OCR_API_KEY` belongs with. */
const DEFAULT_OCR_BASEURL_VAR = 'OCR_BASEURL';

/** Whether a base URL is OCR's default destination: unset, or `${OCR_BASEURL}`. */
function isDefaultOCRDestination(baseURL: string): boolean {
  const trimmed = baseURL.trim();
  return trimmed === '' || extractVariableName(trimmed) === DEFAULT_OCR_BASEURL_VAR;
}

/**
 * Resolves a configuration value from either hardcoded or environment
 */
async function resolveConfigValue(
  configValue: string,
  defaultEnvName: string,
  authValues: Record<string, string | undefined>,
  defaultValue?: string,
): Promise<string> {
  // If it's a hardcoded value (not env var and not empty), use it directly
  if (!needsEnvLoad(configValue)) {
    return configValue;
  }

  // Otherwise, get from auth values
  const envVarName = getEnvVarName(configValue, defaultEnvName);
  return authValues[envVarName] || defaultValue || '';
}

/**
 * Loads authentication configuration from OCR config.
 *
 * An empty API key falls back to the deployment's `OCR_API_KEY` only while the base URL is the
 * deployment's default OCR destination too: unset, or `${OCR_BASEURL}`. With any other base URL,
 * a literal or a reference to another variable, an empty key stays empty: the deployment's key is
 * never sent to a host a config override chose, including when the override's inherited key was
 * dropped for pointing OCR elsewhere.
 */
async function loadAuthConfig(context: OCRContext): Promise<AuthConfig> {
  const appConfig = context.req.config;
  const ocrConfig = appConfig?.ocr;
  const rawApiKeyConfig = ocrConfig?.apiKey || '';
  const apiKeyConfig = isEncryptedSecretPayload(rawApiKeyConfig)
    ? (decryptConfigSecret(rawApiKeyConfig) ?? '')
    : rawApiKeyConfig;
  const baseURLConfig = ocrConfig?.baseURL || '';
  const baseURLFromEnv = needsEnvLoad(baseURLConfig);
  const apiKeyBlank = !apiKeyConfig.trim();
  const defaultDestination = isDefaultOCRDestination(baseURLConfig);
  const apiKeyFromEnv = envVarRegex.test(apiKeyConfig) || (apiKeyBlank && defaultDestination);
  const literalApiKey = apiKeyBlank ? '' : apiKeyConfig;

  if (apiKeyBlank && !defaultDestination) {
    logger.warn(
      '[loadAuthConfig] OCR has a configured base URL and no API key; the default OCR_API_KEY is only used with the default OCR base URL',
    );
  }

  if (!apiKeyFromEnv && !baseURLFromEnv) {
    return {
      apiKey: literalApiKey,
      baseURL: baseURLConfig,
    };
  }

  const authFields: string[] = [];

  if (baseURLFromEnv) {
    authFields.push(getEnvVarName(baseURLConfig, DEFAULT_OCR_BASEURL_VAR));
  }

  if (apiKeyFromEnv) {
    authFields.push(getEnvVarName(apiKeyConfig, 'OCR_API_KEY'));
  }

  const authValues = await context.loadAuthValues({
    userId: context.req.user?.id || '',
    authFields,
    optional: new Set([DEFAULT_OCR_BASEURL_VAR]),
  });

  const apiKey = apiKeyFromEnv
    ? await resolveConfigValue(apiKeyConfig, 'OCR_API_KEY', authValues)
    : literalApiKey;
  const baseURL = await resolveConfigValue(
    baseURLConfig,
    DEFAULT_OCR_BASEURL_VAR,
    authValues,
    DEFAULT_MISTRAL_BASE_URL,
  );

  return { apiKey, baseURL };
}

/**
 * Gets the model configuration
 */
function getModelConfig(ocrConfig?: TCustomConfig['ocr']): string {
  const modelConfig = ocrConfig?.mistralModel || '';

  if (!modelConfig.trim()) {
    return DEFAULT_MISTRAL_MODEL;
  }

  if (envVarRegex.test(modelConfig)) {
    return extractEnvVariable(modelConfig) || DEFAULT_MISTRAL_MODEL;
  }

  return modelConfig.trim();
}

/**
 * Determines document type based on file
 */
function getDocumentType(file: Express.Multer.File): 'image_url' | 'document_url' {
  const mimetype = (file.mimetype || '').toLowerCase();
  const originalname = file.originalname || '';
  const isImage =
    mimetype.startsWith('image') || /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(originalname);

  return isImage ? 'image_url' : 'document_url';
}

/**
 * Processes OCR result pages into aggregated text and images
 */
function processOCRResult(ocrResult: OCRResult): { text: string; images: string[] } {
  let aggregatedText = '';
  const images: string[] = [];

  ocrResult.pages.forEach((page: OCRResultPage, index: number) => {
    if (ocrResult.pages.length > 1) {
      aggregatedText += `# PAGE ${index + 1}\n`;
    }

    aggregatedText += page.markdown + '\n\n';

    if (!page.images || page.images.length === 0) {
      return;
    }

    page.images.forEach((image: OCRImage) => {
      if (image.image_base64) {
        images.push(image.image_base64);
      }
    });
  });

  return { text: aggregatedText, images };
}

/**
 * Creates an error message for OCR operations
 */
function createOCRError(error: unknown, baseMessage: string, contentProtected: boolean): Error {
  const protectedError = createProtectedProviderError(baseMessage, error, contentProtected);
  if (protectedError) {
    return protectedError;
  }
  const axiosError = error as AxiosError<MistralOCRError>;
  const detail = axiosError?.response?.data?.detail;
  const message = detail || baseMessage;

  const responseMessage = axiosError?.response?.data?.message;
  const errorLog = logAxiosError({ error: axiosError, message });
  const fullMessage = responseMessage ? `${errorLog} - ${responseMessage}` : errorLog;

  return new Error(fullMessage);
}

/**
 * Uploads a file to the Mistral OCR API and processes the OCR result.
 *
 * @param params - The params object.
 * @param params.req - The request object from Express. It should have a `user` property with an `id`
 *                       representing the user
 * @param params.file - The file object, which is part of the request. The file object should
 *                                     have a `mimetype` property that tells us the file type
 * @param params.loadAuthValues - Function to load authentication values
 * @returns - The result object containing the processed `text` and `images` (not currently used),
 *                       along with the `filename` and `bytes` properties.
 */
export const uploadMistralOCR = async (context: OCRContext): Promise<MistralOCRUploadResult> => {
  let mistralFileId: string | undefined;
  let apiKey: string | undefined;
  let baseURL: string | undefined;
  const contentProtected = hasActiveFilePolicy(context.req.config?.filters);

  const allowedAddresses = context.req.config?.ocr?.allowedAddresses;
  const timeout = getOutboundTimeoutMs(context.req.config, 'ocrMs');

  try {
    const authConfig = await loadAuthConfig(context);
    apiKey = authConfig.apiKey;
    baseURL = authConfig.baseURL;
    const model = getModelConfig(context.req.config?.ocr);

    const mistralFile = await uploadDocumentToMistral({
      filePath: context.file.path,
      fileName: context.file.originalname,
      apiKey,
      baseURL,
      allowedAddresses,
      timeout,
    });

    mistralFileId = mistralFile.id;

    const signedUrlResponse = await getSignedUrl({
      apiKey,
      baseURL,
      fileId: mistralFile.id,
      allowedAddresses,
      timeout,
      contentProtected,
    });

    const documentType = getDocumentType(context.file);
    const ocrResult = await performOCR({
      url: signedUrlResponse.url,
      documentType,
      baseURL,
      apiKey,
      model,
      allowedAddresses,
      timeout,
      contentProtected,
    });

    if (!ocrResult || !ocrResult.pages || ocrResult.pages.length === 0) {
      throw new Error(
        'No OCR result returned from service, may be down or the file is not supported.',
      );
    }
    const { text, images } = processOCRResult(ocrResult);

    if (mistralFileId && apiKey && baseURL) {
      await deleteMistralFile({
        fileId: mistralFileId,
        apiKey,
        baseURL,
        allowedAddresses,
        timeout,
        contentProtected,
      });
    }

    return {
      filename: context.file.originalname,
      bytes: text.length * 4,
      filepath: FileSources.mistral_ocr,
      text,
      images,
    };
  } catch (error) {
    if (mistralFileId && apiKey && baseURL) {
      await deleteMistralFile({
        fileId: mistralFileId,
        apiKey,
        baseURL,
        allowedAddresses,
        timeout,
        contentProtected,
      });
    }
    throw createOCRError(error, 'Error uploading document to Mistral OCR API:', contentProtected);
  }
};

/**
 * Use Azure Mistral OCR API to processe the OCR result.
 *
 * @param params - The params object.
 * @param params.req - The request object from Express. It should have a `user` property with an `id`
 *                       representing the user
 * @param params.appConfig - Application configuration object
 * @param params.file - The file object, which is part of the request. The file object should
 *                                     have a `mimetype` property that tells us the file type
 * @param params.loadAuthValues - Function to load authentication values
 * @returns - The result object containing the processed `text` and `images` (not currently used),
 *                       along with the `filename` and `bytes` properties.
 */
export const uploadAzureMistralOCR = async (
  context: OCRContext,
): Promise<MistralOCRUploadResult> => {
  const contentProtected = hasActiveFilePolicy(context.req.config?.filters);
  try {
    const { apiKey, baseURL } = await loadAuthConfig(context);
    const model = getModelConfig(context.req.config?.ocr);
    const allowedAddresses = context.req.config?.ocr?.allowedAddresses;
    const timeout = getOutboundTimeoutMs(context.req.config, 'ocrMs');

    const { content: buffer } = await readFileAsBuffer(context.file.path, {
      fileSize: context.file.size,
    });
    const base64 = buffer.toString('base64');
    /** Uses actual mimetype of the file, 'image/jpeg' as fallback since it seems to be accepted regardless of mismatch */
    const base64Prefix = `data:${context.file.mimetype || 'image/jpeg'};base64,`;

    const documentType = getDocumentType(context.file);
    const ocrResult = await performOCR({
      apiKey,
      baseURL,
      model,
      url: `${base64Prefix}${base64}`,
      documentType,
      allowedAddresses,
      timeout,
      contentProtected,
    });

    if (!ocrResult || !ocrResult.pages || ocrResult.pages.length === 0) {
      throw new Error(
        'No OCR result returned from service, may be down or the file is not supported.',
      );
    }

    const { text, images } = processOCRResult(ocrResult);

    return {
      filename: context.file.originalname,
      bytes: text.length * 4,
      filepath: FileSources.azure_mistral_ocr,
      text,
      images,
    };
  } catch (error) {
    throw createOCRError(
      error,
      'Error uploading document to Azure Mistral OCR API:',
      contentProtected,
    );
  }
};

/**
 * Loads Google service account configuration
 */
async function loadGoogleAuthConfig(timeout: number): Promise<{
  serviceAccount: GoogleServiceAccount;
  accessToken: string;
}> {
  /** Path from environment variable or default location */
  const serviceKeyPath =
    process.env.GOOGLE_SERVICE_KEY_FILE ||
    path.join(__dirname, '..', '..', '..', 'api', 'data', 'auth.json');

  const serviceKey = await loadServiceKey(serviceKeyPath);

  if (!serviceKey) {
    throw new Error(
      `Google service account not found or could not be loaded from ${serviceKeyPath}`,
    );
  }

  if (!serviceKey.client_email || !serviceKey.private_key || !serviceKey.project_id) {
    throw new Error('Invalid Google service account configuration');
  }

  const jwt = await createJWT(serviceKey as GoogleServiceAccount);
  const accessToken = await exchangeJWTForAccessToken(jwt, timeout);

  return {
    serviceAccount: serviceKey as GoogleServiceAccount,
    accessToken,
  };
}

/**
 * Creates a JWT token manually
 */
async function createJWT(serviceKey: GoogleServiceAccount): Promise<string> {
  const crypto = await import('crypto');

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceKey.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  sign.end();

  const signature = sign.sign(serviceKey.private_key!, 'base64url');

  return `${signatureInput}.${signature}`;
}

/**
 * Exchanges JWT for access token
 */
async function exchangeJWTForAccessToken(jwt: string, timeout: number): Promise<string> {
  const config: AxiosRequestConfig = {
    ...outboundRequestBudget(timeout, 'ocrMs'),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };

  applyAxiosProxyConfig(config, 'https://oauth2.googleapis.com/token');

  const response = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    config,
  );

  if (!response.data?.access_token) {
    throw new Error('No access token in response');
  }

  return response.data.access_token;
}

/**
 * Performs OCR using Google Vertex AI
 */
async function performGoogleVertexOCR({
  url,
  accessToken,
  projectId,
  model,
  documentType = 'document_url',
  contentProtected = false,
  timeout = DEFAULT_OUTBOUND_TIMEOUTS_MS.ocrMs,
}: {
  url: string;
  accessToken: string;
  projectId: string;
  model: string;
  documentType?: 'document_url' | 'image_url';
  contentProtected?: boolean;
  timeout?: number;
}): Promise<OCRResult> {
  const location = process.env.GOOGLE_LOC || 'us-central1';
  const modelId = model || 'mistral-ocr-2505';

  let baseURL: string;
  if (location === 'global') {
    baseURL = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/mistralai/models/${modelId}:rawPredict`;
  } else {
    baseURL = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/mistralai/models/${modelId}:rawPredict`;
  }

  const documentKey = documentType === 'image_url' ? 'image_url' : 'document_url';

  const requestBody = {
    model: modelId,
    document: {
      type: documentType,
      [documentKey]: url,
    },
    include_image_base64: true,
  };

  logger.debug('Sending request to Google Vertex AI:', {
    url: baseURL,
    body: {
      ...requestBody,
      document: { ...requestBody.document, [documentKey]: 'base64_data_hidden' },
    },
  });

  const config: AxiosRequestConfig = {
    ...outboundRequestBudget(timeout, 'ocrMs'),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  };

  applyAxiosProxyConfig(config, baseURL);

  return axios
    .post(baseURL, requestBody, config)
    .then((res) => {
      logger.debug('Google Vertex AI response received');
      return res.data;
    })
    .catch((error) => {
      const protectedError = createProtectedProviderError(
        'Error calling Google Vertex AI Mistral OCR.',
        error,
        contentProtected,
      );
      if (protectedError) {
        throw protectedError;
      }
      if (error.response?.data) {
        logger.error('Vertex AI error response: ' + JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(
        logAxiosError({
          error: error as AxiosError,
          message: 'Error calling Google Vertex AI Mistral OCR',
        }),
      );
    });
}

/**
 * Use Google Vertex AI Mistral OCR API to process the OCR result.
 *
 * @param params - The params object.
 * @param params.req - The request object from Express. It should have a `user` property with an `id`
 *                       representing the user
 * @param params.appConfig - Application configuration object
 * @param params.file - The file object, which is part of the request. The file object should
 *                                     have a `mimetype` property that tells us the file type
 * @param params.loadAuthValues - Function to load authentication values
 * @returns - The result object containing the processed `text` and `images` (not currently used),
 *                       along with the `filename` and `bytes` properties.
 */
export const uploadGoogleVertexMistralOCR = async (
  context: OCRContext,
): Promise<MistralOCRUploadResult> => {
  const contentProtected = hasActiveFilePolicy(context.req.config?.filters);
  try {
    const timeout = getOutboundTimeoutMs(context.req.config, 'ocrMs');
    const { serviceAccount, accessToken } = await loadGoogleAuthConfig(timeout);
    const model = getModelConfig(context.req.config?.ocr);

    const { content: buffer } = await readFileAsBuffer(context.file.path, {
      fileSize: context.file.size,
    });
    const base64 = buffer.toString('base64');
    const base64Prefix = `data:${context.file.mimetype || 'application/pdf'};base64,`;

    const documentType = getDocumentType(context.file);
    const ocrResult = await performGoogleVertexOCR({
      url: `${base64Prefix}${base64}`,
      accessToken,
      projectId: serviceAccount.project_id!,
      model,
      documentType,
      contentProtected,
      timeout,
    });

    if (!ocrResult || !ocrResult.pages || ocrResult.pages.length === 0) {
      throw new Error(
        'No OCR result returned from service, may be down or the file is not supported.',
      );
    }

    const { text, images } = processOCRResult(ocrResult);

    return {
      filename: context.file.originalname,
      bytes: text.length * 4,
      filepath: FileSources.vertexai_mistral_ocr as string,
      text,
      images,
    };
  } catch (error) {
    throw createOCRError(
      error,
      'Error uploading document to Google Vertex AI Mistral OCR:',
      contentProtected,
    );
  }
};
